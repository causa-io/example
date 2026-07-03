# Backend infrastructure — public API router
#
# A single global HTTPS load balancer fronts the public API of every domain.
# Each domain that exposes HTTP endpoints contributes a `service_routes` output.
# Those are merged into `local.service_routes` in domains.tf and handed to the
# api-router module here. The module turns that map into a URL map + backends,
# terminates TLS with a Google-managed certificate for `domain_name`, and serves
# it from a single public IP.

locals {
  # The public hostname of the API, e.g. `api.dev.bookshop.example`.
  domain_name = "api.${var.base_dns_name}"
}

# The static public IP the load balancer listens on. Its `.address` feeds the
# DNS record below. Its `.id` is handed to the router module as the
# forwarding-rule address.
resource "google_compute_global_address" "api_load_balancer" {
  name = "api-load-balancer"
}

# The DNS A record pointing the API hostname at the load balancer IP.
# It is created in the shared managed zone, which lives in the common project,
# hence the explicit `project` override.
resource "google_dns_record_set" "api" {
  project      = var.gcp_common_project_id
  managed_zone = var.gcp_dns_managed_zone
  name         = "${local.domain_name}."
  type         = "A"
  rrdatas      = [google_compute_global_address.api_load_balancer.address]

  # Production's address is stable, so a long TTL is safe.
  # Dev keeps it short so a teardown/rebuild propagates quickly.
  ttl = local.is_production ? 21600 : 300
}

# Require at least TLS 1.2 for all API traffic.
# Passed to the router, which attaches it to the HTTPS target proxy.
resource "google_compute_ssl_policy" "restricted" {
  name    = "restricted"
  profile = "RESTRICTED"
}

# The router itself. It builds the global HTTPS load balancer (URL map + one
# backend per service), provisions a Google-managed certificate for
# `domain_name`, and wires everything to the IP above.
module "api_router" {
  source  = "causa-io/api-router/google"
  version = "0.3.2"

  gcp_project_id = var.gcp_backend_project_id
  ip_address     = google_compute_global_address.api_load_balancer.id
  domain_name    = local.domain_name
  ssl_policy     = google_compute_ssl_policy.restricted.id

  # Requests that match no service route (e.g. a bare hit on the API host) are
  # redirected to the environment's website root.
  default_url_redirect = {
    host          = var.base_dns_name
    path          = "/"
    response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query   = true
  }

  # The merged map of every domain's public routes, assembled in domains.tf.
  services = local.service_routes
}
