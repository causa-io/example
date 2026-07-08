-- Companion index table backing the "list orders containing this book" listing
-- (`GET /orders?book=…`, see order/query.service.ts `listByBook`).
--
-- The books of an order live in the `lines` JSON array on the `Order` row,
-- which Spanner cannot efficiently seek into. This table promotes them out: one
-- row per (order, book). A secondary index on `book` then turns "find every
-- order for a book" into a range scan instead of a full-table JSON scan.
--
-- INTERLEAVE IN PARENT `Order` ON DELETE CASCADE is what keeps the two in sync
-- cheaply. `OrderManager.updateState` writes the parent `Order` with a Spanner
-- REPLACE (delete + insert of the row); because these rows are interleaved
-- children with ON DELETE CASCADE, that REPLACE also deletes all of the order's
-- existing `OrderBook` rows. The manager then re-inserts one row per current
-- line — all in the same transaction as the order write and its outbox event.
-- Losing the CASCADE would leak stale rows on every update, and require using
-- the previous state to delete the old rows before re-inserting the new ones.
--
-- `createdAt` is denormalized from the order so the index below carries
-- everything the listing needs (filter + sort + join key), and the scan never
-- has to touch the `Order` row to order the page.

CREATE TABLE OrderBook (
  id STRING(36) NOT NULL,
  book STRING(36) NOT NULL,
  createdAt TIMESTAMP NOT NULL,
) PRIMARY KEY (id, book),
  INTERLEAVE IN PARENT `Order` ON DELETE CASCADE;

-- Serves the book-scoped, most-recent-first listing, mirroring
-- `OrdersByCustomer`:
--   * `book` — the equality column every book listing filters on.
--   * `createdAt DESC` — "most recent first".
--   * `id` — the tie-breaker (the order id).
--     Spanner appends it anyway (it is part of the primary key). It is spelled
--     out to make the mixed-direction sort explicit.
-- Orders soft-deleted rows never appear here: on soft-delete the manager clears
-- the rows (via the cascade) and does not re-add them.

CREATE INDEX OrderBooksByBook ON OrderBook(book, createdAt DESC, id)
