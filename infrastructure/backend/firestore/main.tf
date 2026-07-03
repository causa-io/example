# The Firestore database used by both the backend and the mobile clients.
resource "google_firestore_database" "default" {
  name                              = var.database_name
  location_id                       = var.location_id
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = var.is_production ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = var.is_production ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
}
