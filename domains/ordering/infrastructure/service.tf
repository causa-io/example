# Deploys the ordering service twice from the same container image and
# configuration.
#
# - `service_api`: the public HTTP API. Receives customer requests.
# - `service_event_handler`: internal-only. Receives Pub/Sub push deliveries and
#    other triggers as HTTP requests. Distinguished at runtime by the
#    EVENT_HANDLER=true environment variable, so the same code boots in "event
#    handler" mode.
#
# Splitting them lets each scale independently and keeps the event handlers off
# the public internet.

locals {
  active_version = lookup(var.active_versions, "ordering-service", null)

  # The generated configuration JSON for this service.
  configuration_file = "${local.project_configurations_directory}/ordering-service.json"
}

# A dedicated service account for the service, following least privilege.
# This can be automatically created by the Cloud Run module. However, because
# the API / event split is used here, it is clearer to create it explicitly and
# pass it to both modules.
# IAM permissions are managed by the modules themselves.
resource "google_service_account" "service" {
  account_id   = "ordering-service"
  display_name = "Ordering Cloud Run service"
  description  = "The service account used by Cloud Run in the Ordering domain."
}

# Public HTTP API service.
module "service_api" {
  source  = "causa-io/service-container-cloud-run/google"
  version = "1.0.1"

  configuration_file = local.configuration_file
  active_version     = local.active_version

  pubsub_topic_ids       = var.pubsub_topic_ids
  spanner_ddl_dependency = var.spanner_ddl_dependency

  service_account = {
    email = google_service_account.service.email
  }

  # Expose the public HTTP endpoints (/orders, ...).
  # This configures public access (through IAM) and sets the
  # `public_http_endpoints` output.
  enable_public_http_endpoints = true
}

# Internal event-handler service.
module "service_event_handler" {
  source  = "causa-io/service-container-cloud-run/google"
  version = "1.0.1"

  configuration_file = local.configuration_file
  active_version     = local.active_version

  pubsub_topic_ids       = var.pubsub_topic_ids
  spanner_ddl_dependency = var.spanner_ddl_dependency

  service_account = {
    email = google_service_account.service.email
  }

  # Same image, booted as an event handler.
  name                  = "ordering-events"
  ingress               = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  environment_variables = { EVENT_HANDLER = "true" }

  # The module creates the Pub/Sub push subscriptions and other trigger-related
  # resources.
  enable_triggers = true
  # IAM permissions have already been set by the `service_api` module, though...
  set_iam_permissions = false
  # ...only trigger-specific permissions may be needed.
  set_tasks_permissions = true
}
