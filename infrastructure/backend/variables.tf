# Variables populated by Causa from the `infrastructure.variables` block in causa.yaml.

variable "gcp_backend_project_id" {
  type        = string
  description = "The ID of the GCP project for the selected environment."
}

variable "gcp_common_project_id" {
  type        = string
  description = "The ID of the GCP project holding shared resources (Docker repo, DNS, ...)."
}

variable "gcp_region" {
  type        = string
  description = "The GCP region where regional resources are placed."
}

variable "gcp_dns_managed_zone" {
  type        = string
  description = "The shared DNS managed zone used to expose this environment's API."
}

variable "base_dns_name" {
  type        = string
  description = "The base DNS name for this environment (e.g. dev.bookshop.example)."
}

variable "docker_repository_name" {
  type        = string
  description = "The name of the Artifact Registry Docker repository for service images."
}

variable "firestore_database_name" {
  type        = string
  description = "The name of the Firestore database."
}

variable "firestore_location_id" {
  type        = string
  description = "The location of the Firestore database."
}

variable "firestore_security_rules_file" {
  type        = string
  description = "Path to the merged Firestore security rules file generated into .causa/."
}

# The active service versions, keyed by service name.
# Overrides the version recorded in each service's causa.yaml.
# This can for example be used to test a new version (unmerged PR) of the
# service in a development environment.
variable "active_versions" {
  type        = map(string)
  default     = {}
  description = "The active versions of the services to deploy."
}
