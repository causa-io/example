# Backend infrastructure — per-domain modules
#
# Each domain that runs a service contributes a Terraform module under
# `domains/<domain>/infrastructure/`. The backend imports it here, passing the
# inputs it needs: the map of Pub/Sub topic ids (so the service's triggers can
# subscribe) and the Spanner DDL dependency (so the service waits for its
# database schema before deploying).

locals {
  # Every domain that exposes a public API contributes its routes here, via that
  # domain module's `service_routes` output. The merged map is handed to the
  # api-router module (see api-router.tf).
  service_routes = merge(
    module.ordering.service_routes,
  )
}

module "ordering" {
  source = "../../domains/ordering/infrastructure"

  gcp_region = var.gcp_region

  # Map of event full name → Pub/Sub topic id, used to wire the service's event
  # triggers.
  pubsub_topic_ids = module.topics.topic_ids

  # The ordering database's DDL, used as a deploy-time dependency so the service
  # rolls out only after its schema is in place.
  spanner_ddl_dependency = module.spanner_databases.ddls["ordering"]

  firestore_database = module.firestore.database_name

  # Allows an override of the service's active version set in `causa.yaml`.
  # This can for example be used to test a new version (unmerged PR) of the
  # service in a development environment.
  active_versions = var.active_versions

  is_production = local.is_production
}
