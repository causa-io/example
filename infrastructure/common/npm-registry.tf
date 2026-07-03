# The Artifact Registry npm repository hosting the Bookshop's shared packages
# (e.g. `@bookshop-example/common`).
# Both the package project and every consuming service resolve and publish here.
# Their `.npmrc` files point the `@bookshop-example` scope at this repo
# (`europe-west1-npm.pkg.dev/<project>/npm`).
# See the private-npm-package pattern.
resource "google_artifact_registry_repository" "npm" {
  repository_id = "npm"
  location      = var.gcp_region
  format        = "NPM"
  description   = "Private npm registry for the Bookshop shared TypeScript packages."
}
