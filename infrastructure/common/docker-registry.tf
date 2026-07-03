# The Artifact Registry Docker repository that every environment's Cloud Run
# service pulls its images from.
# The repository path is referenced in causa.google.yaml
# (`google.cloudRun.dockerRepository`).
resource "google_artifact_registry_repository" "backend" {
  repository_id = "backend"
  location      = var.gcp_region
  format        = "DOCKER"
  description   = "Container images for the Bookshop backend services."
}
