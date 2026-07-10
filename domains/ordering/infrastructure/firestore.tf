# Firestore configuration owned by the ordering domain.
#
# The Firestore database itself is created once, at the environment level (see
# infrastructure/backend/firestore/); its name is threaded in here as
# `var.firestore_database`. This file configures the `orders` read model: the
# collection (through the shared Causa module) and the one composite index its
# client queries need.
#
# A Firestore collection needs no creation — it exists as soon as a document is
# written to it. What Terraform can manage is its indexing and TTL, which is
# what the `causa-io/firestore-collection/google` module wraps.

# The `orders` collection, configured through the shared Causa module.
#
# The module does two things here, both tied to how the read model behaves:
#   - `single_field_index_exemptions`: `createdAt` / `updatedAt` / `deletedAt`
#     are monotonic timestamps. An automatic single-field index on a sequential
#     value hot-spots — writes concentrate on one edge of the index range, which
#     caps the collection's sustained write rate (~500 writes/s) — so indexing
#     them is disabled (this also cuts write cost). The client never filters or
#     sorts on them alone, so nothing is lost; the composite index below is
#     declared explicitly and is unaffected.
#   - soft-deleted TTL (on by default, `expire_soft_deleted_documents = true`):
#     when an order is deleted, the runtime moves the `OrderDocument` to a
#     sibling `orders$deleted` collection and stamps `_expirationDate` on it
#     (the `hasSoftDelete` flag in domains/ordering/firestore/order.yaml).
#     The module sets the Firestore TTL policy on that field — so the garbage
#     collection is configured here rather than hand-rolled. It is the Firestore
#     counterpart of the Spanner row-deletion policy that reaps soft-deleted
#     rows in the book projection.
module "firestore_collections" {
  source  = "causa-io/firestore-collection/google"
  version = "0.3.2"

  for_each = toset([
    # /orders/{id}
    "orders",
  ])

  database = var.firestore_database
  name     = each.key

  single_field_index_exemptions = ["createdAt", "updatedAt", "deletedAt"]
}

# Lets a customer list their own orders, newest first:
#   orders.where('customer', '==', uid).orderBy('createdAt', 'desc')
#
# A query that filters on one field and sorts on another needs a composite index
# — which the module does not manage (it handles single-field indexes and TTL).
# The equality field comes first, then the sort field. The trailing `__name__`
# mirrors the last sort direction (the tie-breaker Firestore appends).
#
# The query is exactly what the security rules already permit:
# `customer == uid` matches `isAuthenticatedAs(resource.data.customer)`, see
# domains/ordering/firestore/firestore.rules.
resource "google_firestore_index" "orders_by_customer_and_created_at" {
  database   = var.firestore_database
  collection = "orders"

  fields {
    field_path = "customer"
    order      = "ASCENDING"
  }

  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "DESCENDING"
  }
}
