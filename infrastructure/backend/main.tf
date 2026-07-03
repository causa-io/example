# Backend infrastructure — shared resources
#
# Wires the Causa-published Terraform modules to the artefacts generated into
# `.causa/` by the processors (topics, Spanner DDL, project configs, merged
# Firestore rules).

locals {
  is_production = terraform.workspace == "prod"

  # Where the processors write their generated artefacts.
  causa_directory                   = "${path.module}/../../.causa"
  project_configurations_directory  = "${local.causa_directory}/project-configurations"
  infrastructure_configuration_file = "${local.project_configurations_directory}/infrastructure-backend.json"
}

# Creates one Spanner database per domain, applying that domain's DDL bundle.
# The module reads the database list and DDL from the generated artefacts.
module "spanner_databases" {
  source  = "causa-io/spanner-databases/google"
  version = "0.4.0"

  infrastructure_configuration_file = local.infrastructure_configuration_file
  databases_directory               = "${local.causa_directory}/spanner-databases"
}

# Creates the Pub/Sub topics discovered from the domains' event schemas
# (catalog.book.v1, ordering.order.v1, ...).
# This also streams each topic to its own BigQuery table, according to the
# google.pubSub.bigQueryStorage configuration.
module "topics" {
  source  = "causa-io/event-topics-pubsub/google"
  version = "0.2.2"

  infrastructure_configuration_file = local.infrastructure_configuration_file
  topics_directory                  = "${local.causa_directory}/pubsub-topics"

  deletion_protection = local.is_production
}

# The Firestore database backing the read models, plus the ruleset merged from
# every domain's firestore.rules by the GoogleFirestoreMergeRules processor.
# Kept in a local submodule (./firestore) so the APIs requiring the calls to be
# made by a service account are contained and configured (see providers.tf).
module "firestore" {
  source = "./firestore"

  database_name       = var.firestore_database_name
  location_id         = var.firestore_location_id
  security_rules_file = var.firestore_security_rules_file
  is_production       = local.is_production

  providers = {
    google.firebase = google.firebase
  }
}
