# The HTTP routes exposed by the public API service. The backend infrastructure
# collects these from every domain to configure the shared API router / load
# balancer (which maps `api.<env>.bookshop.example/orders/*` to this service).

output "service_routes" {
  description = "Routing configuration for this domain's public HTTP endpoints."
  value = {
    "ordering-service" = module.service_api.routes
  }
}
