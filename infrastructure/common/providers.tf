# The Google provider targets the fixed common project.
# All resources in this project are environment-independent.
provider "google" {
  project = var.gcp_common_project_id
  region  = var.gcp_region
}
