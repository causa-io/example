locals {
  security_rules      = file(var.security_rules_file)
  security_rules_sha1 = sha1(local.security_rules)
}

# This uploads the Firestore rules.
resource "google_firebaserules_ruleset" "firestore" {
  provider = google.firebase

  source {
    files {
      content     = local.security_rules
      name        = "firestore.rules"
      fingerprint = local.security_rules_sha1
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# This enables ("releases") the rules to be used by the Firestore service.
resource "google_firebaserules_release" "firestore" {
  provider = google.firebase

  name         = "cloud.firestore/${google_firestore_database.default.name}"
  ruleset_name = google_firebaserules_ruleset.firestore.id
}
