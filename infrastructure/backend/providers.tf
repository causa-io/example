# The default provider targets the environment's GCP project.
provider "google" {
  project = var.gcp_backend_project_id
  region  = var.gcp_region
}

# A second provider used for Firebase/Firestore resources that require API calls
# to be made by a service account (as opposed to workload identity federation).
provider "google" {
  alias = "firebase"

  project = var.gcp_backend_project_id
  region  = var.gcp_region

  user_project_override = true
  billing_project       = var.gcp_backend_project_id

  impersonate_service_account = "some-sa@${var.gcp_common_project_id}.iam.gserviceaccount.com"
}
