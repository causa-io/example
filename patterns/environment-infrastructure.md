# Environment infrastructure

The per-environment backend Terraform project (`infrastructure/backend/`): it turns every domain's schemas into one running environment — Pub/Sub topics, Spanner databases, Firestore, and a public API router — mostly by wiring Causa-published modules to generated artefacts.

## The reason

An environment (dev, prod) is a single GCP project holding everything the services need at runtime: the event topics they publish and consume, the databases they own, the Firestore database behind the read models, and the load balancer that exposes their APIs. All of it is deployed by one Terraform project — `infrastructure/backend/` — applied once per environment, each into its own Terraform workspace and its own GCP project so their states never mix (`cs environment prepare|deploy -e dev`).

The project is deliberately thin. The domain schemas (events, databases, Firestore security rules) are the source of truth: a pipeline of Causa processors regenerates artefacts under `.causa/` before every plan, and the Terraform just wires published modules to those artefacts. Nobody hand-lists a topic, a table, or a subscription — changing a schema is what changes the infrastructure.

## The solution

### Schemas in, artefacts out: the processor pipeline

[`causa.yaml`](../infrastructure/backend/causa.yaml) declares an ordered processor pipeline that runs before each plan/apply, each writing generated inputs into `.causa/`:

```yaml
infrastructure:
  processors:
    - name: GoogleServicesEnable          # enable the APIs under `google.services`
    - name: GoogleFirestoreMergeRules     # merge domain *.rules → .causa/firestore.rules
    - name: ProjectWriteConfigurations    # per-project config JSON consumed by the modules
    - name: GoogleSpannerWriteDatabases   # Spanner DDL bundles → .causa/spanner-databases
    - name: GooglePubSubWriteTopics       # topic configs → .causa/pubsub-topics
```

The same file's `externalFiles` lists the schema globs (events, Firestore rules, Spanner DDL, per-domain modules, service `causa.yaml`) that must re-plan the project when they change. That is the link that makes a schema change in a pull request surface as an infrastructure diff in CI.

### Causa-published Terraform modules

The heavy lifting is done by modules published to the Terraform registry under the `causa-io` namespace, each consuming the generated artefacts. [`main.tf`](../infrastructure/backend/main.tf) wires them:

```hcl
module "spanner_databases" {
  source  = "causa-io/spanner-databases/google"
  version = "0.4.0"
  # one database per domain, applying that domain's DDL bundle
}

module "topics" {
  source  = "causa-io/event-topics-pubsub/google"
  version = "0.2.2"
  # one Pub/Sub topic per event / topic schema, and the automatic piping to BigQuery
}
```

Reaching for a published module instead of raw `google_*` resources means the non-obvious wiring lives in one versioned, tested place: a Spanner database *plus* its ordered DDL migrations, a topic *plus* its BigQuery archive and subscription conventions, a load balancer *plus* its URL map and managed certificate. [`domains.tf`](../infrastructure/backend/domains.tf) then imports each domain's own service module, handing it `module.topics.topic_ids` and the relevant `module.spanner_databases.ddls[...]`, and re-exports the domains' routes.

### The API router and its DNS

A single global HTTPS load balancer fronts every domain's public API. [`api-router.tf`](../infrastructure/backend/api-router.tf) builds it from three hand-written resources plus the router module:

- a **static global IP** the load balancer listens on;
- a **DNS A record** pointing the API hostname at that IP — created in the **shared managed zone**, which lives in the *common* project, not this environment's project. One zone holds the record for every environment;
- a **TLS-1.2 SSL policy** (`RESTRICTED` profile), which the module attaches to the HTTPS proxy.

The module provisions a Google-managed certificate for that hostname and routes each domain's path prefixes to its Cloud Run service:

```hcl
module "api_router" {
  source  = "causa-io/api-router/google"
  version = "0.3.2"

  ip_address  = google_compute_global_address.api_load_balancer.id
  domain_name = local.domain_name
  ssl_policy  = google_compute_ssl_policy.restricted.id
  services    = local.service_routes   # merged from every domain, in domains.tf
}
```

`local.service_routes` is a `merge()` of each domain's `service_routes` output, so exposing a new domain's API is one line in [`domains.tf`](../infrastructure/backend/domains.tf). Where those route maps are produced is the [service infrastructure](service-infrastructure.md) pattern.

### Firestore, and why a service account is impersonated

The Firestore database and its security rules are provisioned by a local [`./firestore`](../infrastructure/backend/firestore/) submodule. The rules are deployed with the Firebase Rules API (`google_firebaserules_ruleset` / `_release`), and that API is the reason for the second provider in [`providers.tf`](../infrastructure/backend/providers.tf):

```hcl
# Default provider, recommended to authenticate in CI via workload identity
# federation (no service-account keys).
provider "google" {
  project = var.gcp_backend_project_id
  region  = var.gcp_region
}

# Firebase resources reject federated credentials, so this aliased provider
# impersonates a real service account just for them.
provider "google" {
  alias = "firebase"
  # ...
  user_project_override       = true
  billing_project             = var.gcp_backend_project_id
  impersonate_service_account = "some-sa@${var.gcp_common_project_id}.iam.gserviceaccount.com"
}
```

The recommended way to authenticate to GCP is using **workload identity federation**: no long-lived service-account keys to store or rotate. But the Firebase Rules API does not accept a federated identity. It requires the call to come from an actual service account. Rather than reintroduce a key, the federated identity **impersonates** a dedicated service account for those resources only, through the aliased `google.firebase` provider (passed explicitly into the submodule).

### Environment differences come from configuration

Almost everything that differs between environments — GCP project ids, DNS names, Spanner sizing — lives in [`causa.environments.yaml`](../causa.environments.yaml), not in the Terraform. Selecting an environment with `-e <env>` in the Causa CLI merges that environment's `configuration` block on top of the workspace configuration, and the backend's Terraform variables are filled from the result. So the same `causa.yaml` yields dev or prod values depending only on `-e`:

```yaml
# infrastructure/backend/causa.yaml
variables:
  gcp_backend_project_id:
    $format: ${ configuration('google.project') }   # → bookshop-example-dev / -prod
  base_dns_name:
    $format: ${ configuration('dns.base') }         # → dev.bookshop.example / bookshop.example
  # ...
```

The one thing *not* driven through configuration is a coarse production flag: `local.is_production = terraform.workspace == "prod"` (the Terraform workspace is the selected environment). It flags whether the current environment is production-grade — here the single `prod` workspace, though a real setup may run several environments of each grade — and gates only the few settings not worth exposing as per-environment config: deletion protection on the Pub/Sub topics and the Firestore database, and longer DNS TTLs.

## In this repository

**The backend project:**

- Processor pipeline, `externalFiles`, config-sourced variables, enabled GCP services —
  [backend/causa.yaml](../infrastructure/backend/causa.yaml).
- The published-module wiring (Spanner databases, Pub/Sub topics) —
  [backend/main.tf](../infrastructure/backend/main.tf).
- Domain imports + the `service_routes` merge —
  [backend/domains.tf](../infrastructure/backend/domains.tf).
- The API router, static IP, cross-project DNS record, SSL policy —
  [backend/api-router.tf](../infrastructure/backend/api-router.tf).
- Firestore database + rules (submodule) and the impersonating Firebase provider —
  [backend/firestore/](../infrastructure/backend/firestore/),
  [backend/providers.tf](../infrastructure/backend/providers.tf).
- Provider pins and per-environment variables —
  [backend/versions.tf](../infrastructure/backend/versions.tf),
  [backend/variables.tf](../infrastructure/backend/variables.tf).

**Related:**

- The per-domain service module: the [service infrastructure](service-infrastructure.md) pattern.
- The org-wide, environment-independent resources (Artifact Registry, the DNS managed zone) live in `infrastructure/common/`: the registry side is covered by the [private npm package](private-npm-package.md) pattern.
