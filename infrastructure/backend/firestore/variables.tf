variable "database_name" {
  description = "The name of the Firestore database."
  type        = string
}

variable "location_id" {
  description = "The ID of the App Engine location where the Firestore database will be stored."
  type        = string
}

variable "security_rules_file" {
  description = "The path to the file containing the Firestore security rules."
  type        = string
}

variable "is_production" {
  description = "Defines whether the environment is production."
  type        = bool
}
