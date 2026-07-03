# These variables are populated by Causa from the `infrastructure.variables`
# block in causa.yaml (which in turn reads workspace configuration).

variable "gcp_common_project_id" {
  type        = string
  description = "The ID of the GCP project holding shared, environment-independent resources."
}

variable "gcp_region" {
  type        = string
  description = "The GCP region where regional resources are placed."
}

variable "gcp_organization" {
  type        = string
  description = "The GCP organization ID that owns the projects."
}

variable "gcp_billing_account" {
  type        = string
  description = "The billing account ID linked to the projects."
}
