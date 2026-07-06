# Service infrastructure

Terraform for a single deployable service: a Cloud Run public API and — when the domain handles events — an internal event-handler twin, both from the same image. This page is about the per-domain service module; the environment that hosts it is the [environment infrastructure](environment-infrastructure.md) pattern.

## The reason

A domain's service is not runnable until something provisions it: a Cloud Run service reachable by clients, the Pub/Sub push subscriptions and Cloud Scheduler jobs behind its triggers, a service account with the right IAM, and a deploy ordered *after* its database schema. Writing that by hand for every domain is repetitive and easy to get subtly wrong (an unfiltered subscription, a public event handler, a service that rolls out before its table exists).

Causa removes almost all of it. The service already declares its shape — endpoints, triggers, what it owns — in its `causa.yaml`. An infrastructure processor turns that declaration into a generated JSON config, and a published Terraform module (`causa-io/service-container-cloud-run/google`) turns the config into the actual Cloud Run service and its triggers. Each domain then writes only a *thin* module: instantiate the published module, create a service account, export its routes.

## The solution

### The service declares its surface; the module reads the generated form

Everything the module needs comes from the service's [`causa.yaml`](../domains/ordering/service/causa.yaml): the HTTP `endpoints`, the `triggers` (event / cron / task), the `outputs` it owns (topics, Spanner databases, Firestore collections — these drive IAM), and the `activeVersion` to deploy. The `ProjectWriteConfigurations` processor writes this into `.causa/project-configurations/<service>.json`, and the module reads its endpoints, triggers, and sizing from there. The Terraform never re-lists a trigger or an endpoint by hand (although it does accept overrides and extensions though variables).

### One image, deployed twice: public API + internal event handler

A service that both serves an API and handles events is deployed as **two Cloud Run services from one image and one config** — a public `service_api` and an internal `service_event_handler`. [`domains/ordering/infrastructure/service.tf`](../domains/ordering/infrastructure/service.tf) instantiates the module twice:

```hcl
# Public HTTP API.
module "service_api" {
  source  = "causa-io/service-container-cloud-run/google"
  version = "1.0.1"
  configuration_file = local.configuration_file
  # ...
  enable_public_http_endpoints = true   # serve /orders/*, populate the `routes` output
}

# Internal event handler — same image, booted with EVENT_HANDLER=true.
module "service_event_handler" {
  source  = "causa-io/service-container-cloud-run/google"
  version = "1.0.1"
  configuration_file = local.configuration_file
  # ...
  name                  = "ordering-events"
  ingress               = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  environment_variables = { EVENT_HANDLER = "true" }
  enable_triggers       = true          # create the Pub/Sub subs, Cloud Scheduler jobs, ...
  set_iam_permissions   = false         # the API twin already set them
  set_tasks_permissions = true          # ...but the handler still needs the trigger perms
}
```

The container is identical on both twins. It inspects `EVENT_HANDLER` at boot to pick a mode. Only the event-handler twin sets `enable_triggers = true`, so the module creates each trigger's Pub/Sub push subscription (with its filter), Cloud Scheduler job, or Cloud Tasks queue — all pointing at the *internal* service.

**Why split one service into two.** For a domain that both exposes an API and handles events, this is the suggested default, for two reasons:

- **Keep the event handlers off the public internet.** The handler twin is `INGRESS_TRAFFIC_INTERNAL_ONLY`; only the API twin is reachable through the load balancer. A push subscription or a scheduler job reaches the handler internally; a client on the internet cannot.
- **Scale the two independently.** Client API traffic and event / backfill throughput are unrelated. Two services means a spike in one does not starve the other, and each gets its own min/max instances, concurrency, and CPU.

**When you don't need it.** The split is a recommendation, not a rule — it is one image described by two module blocks, and either can stand alone:

- A service with **no triggers** needs only the public `service_api`.
- A purely **internal worker** (no public API) needs only the event handler.
- A **low-traffic** service where neither isolation nor independent scaling buys anything can run a single deployment with both `enable_public_http_endpoints` and `enable_triggers` on — one module block instead of two.

Reach for the split when the internal-only isolation or the independent scaling actually earns its keep (which should be most of the time).

### The service account and two deploy-time dependencies

The module can create its own service account, but with the split it is clearer to create one explicitly and hand the same email to both twins (IAM is still managed by the modules). The environment also passes each service module two things from the shared resources:

- `pubsub_topic_ids` — the map of `event full name → topic id`, so a trigger subscribing to `catalog.book.v1` resolves to the real Pub/Sub topic.
- `spanner_ddl_dependency` — the domain's DDL, used as a dependency so the service **rolls out only after its schema is applied**.

Both are provided by the environment backend — see the [environment infrastructure](environment-infrastructure.md) pattern.

### Backfills are directed at the internal twin

Re-running a handler over past events (a backfill) must land on the event handler, not the public API. The service names the target:

```yaml
# service/causa.yaml
google:
  cloudRun:
    eventBackfillServiceName: ordering-events   # matches the handler twin's `name` in Terraform
```

The internal twin's Terraform `name` and this backfill name are the same string. Note that by additionally configuring `eventBackfillServiceCloneConfig`, the backfill can run in a separate clone of the handler, so it does not event compete with live event traffic.

### The public routes feed the environment's API router

The public twin exposes a **`routes`** output (its path prefixes + region + service name), which the domain re-exports as `service_routes` in [`outputs.tf`](../domains/ordering/infrastructure/outputs.tf). The environment merges every domain's routes and hands them to a single API router — covered by the [environment infrastructure](environment-infrastructure.md) pattern.

### Gotcha

- **`set_iam_permissions = false` on the second twin** avoids setting the general IAM permissions twice — but the handler still needs its trigger-specific permissions, so `set_tasks_permissions = true` re-enables just those.

## In this repository

**The domain's service module:**

- The two Cloud Run twins + the shared service account —
  [service.tf](../domains/ordering/infrastructure/service.tf).
- Its inputs (topic ids, DDL dependency, region, active versions) —
  [variables.tf](../domains/ordering/infrastructure/variables.tf).
- The `service_routes` output the router collects —
  [outputs.tf](../domains/ordering/infrastructure/outputs.tf).

**The service declaration the module reads:**

- Endpoints, triggers, `outputs`, `activeVersion`, `eventBackfillServiceName` —
  [service/causa.yaml](../domains/ordering/service/causa.yaml).

**The environment that hosts it:**

- How the backend imports this module, wires its topics / DDL, and fronts its API —
  the [environment infrastructure](environment-infrastructure.md) pattern.
