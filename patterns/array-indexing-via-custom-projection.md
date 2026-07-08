# Array indexing via custom projection

Make the elements of an array column queryable by materializing a companion table — one row per element — and indexing that. The companion is an **interleaved child** of the parent, kept in sync inside the same write transaction, so a lookup Spanner cannot run against the array becomes an ordinary indexed range scan.

## The reason

An `Order` holds its books in a `lines` JSON array. "List every order containing book X" has no efficient plan against that column: Spanner cannot seek into a (JSON) array, so the only option is to scan every order and unpack the array — cost grows with the number of orders, and no index can help.

The fix is to **promote the array elements out into their own table**: one row per `(order, book)`. That table has a scalar `book` column, so a plain secondary index on it turns the lookup into a range scan. The companion also carries a copy of the order's `createdAt`, so the same index serves the ordering — the listing never has to touch the `Order` row to sort a page.

This is the read-model idea of the [simple projection](simple-projection.md) pattern, but aimed inward: the projection is not of another domain's entity, it is a re-shaping of *this* entity's own array into an indexable form.

## The solution

### The companion table

A Spanner table with one row per array element, **interleaved in the parent** so the two share storage locality and a delete contract:

```sql
CREATE TABLE OrderBook (
  id STRING(36) NOT NULL,        -- the order's id (the interleaving parent key)
  book STRING(36) NOT NULL,      -- one ordered book (the element discriminator)
  createdAt TIMESTAMP NOT NULL,  -- denormalized from the order, to sort from the index
) PRIMARY KEY (id, book),
  INTERLEAVE IN PARENT `Order` ON DELETE CASCADE;

CREATE INDEX OrderBooksByBook ON OrderBook(book, createdAt DESC, id)
```

The primary key **leads with the parent's key** (`id`) — a requirement of interleaving — and appends the element (`book`) to give one row per book. The secondary index `(book, createdAt DESC, id)` mirrors `OrdersByCustomer`: the filter column first, then the sort, then the tie-breaker (which is also the join key back to `Order`).

The table is modelled in Causa as a schema-only type living under `spanner/` (like the `BookProjection`), not under `entities/`: it is an internal index the service maintains, not a domain entity.

```yaml
title: OrderBookIndex
causa:
  googleSpannerTable:
    name: OrderBook
    primaryKey: [id, book]
```

### Keeping it in sync — one hook, every write

The rows are maintained by overriding **`updateState`** on the entity manager, the single hook every `create` / `update` / `delete` funnels through (`create → makeProcessAndPublishEvent → processEvent → updateState`). So the index is written atomically with the order and its outbox event, on all three operations, with no extra call sites:

```typescript
protected async updateState(order: Order, transaction: SpannerOutboxTransaction) {
  await super.updateState(order, transaction);        // REPLACEs the Order row
  if (order.deletedAt) return;                        // soft-deleted → stay empty
  for (const { book } of order.lines) {
    await transaction.set(
      new OrderBookIndex({ id: order.id, book, createdAt: order.createdAt }),
    );
  }
}
```

The method never deletes anything — it only re-inserts the current set. That works because of one Spanner subtlety. The base `updateState` writes the parent with a Spanner `REPLACE` mutation (delete-then-insert of the row). Because `OrderBook` is `INTERLEAVE IN PARENT … ON DELETE CASCADE`, that delete cascade-removes all of the order's existing `OrderBook` rows. A plain column `UPDATE` mutation would leave interleaved children untouched — so this pattern is coupled to the base write staying a `REPLACE`.

On a soft-delete the parent is still `REPLACE`-written (clearing the children via the cascade) but the `deletedAt` guard skips re-inserting, so a deleted order drops out of every book listing immediately.

### The read

The query seeks the companion index, then joins back to the parent for the payload. It is the same keyset ([pagination](pagination.md)) as the customer listing — same `(createdAt, id)` cursor — just seeded from a different index:

```sql
SELECT <Order columns AS o>
FROM `OrderBook`@{FORCE_INDEX=`OrderBooksByBook`} AS ob
  JOIN `Order` AS o ON o.id = ob.id
WHERE ob.book = @book
  AND ( ob.createdAt < @readAfterCreatedAt
        OR (ob.createdAt = @readAfterCreatedAt AND ob.id > @readAfterId) )
ORDER BY ob.createdAt DESC, ob.id
LIMIT @limit
```

The filter, the sort and the cursor are all served by the index's own columns (`book`, the denormalized `createdAt`, `id`). The join to `Order` only fetches the columns to return. `sqlColumns(Order, { alias: 'o' })` and `sqlTable(…, { index })` emit the aliased column list and the `FORCE_INDEX` hint.

Note there is **no** `deletedAt IS NULL` here, unlike the customer listing. It is unnecessary: a soft-deleted order has no `OrderBook` rows to join to (the manager clears them on delete), so a deleted order is already unreachable through this index.

## Gotchas

- **The `ON DELETE CASCADE` is crucial, and only `REPLACE` triggers it.** The whole "delete the old rows for free" contract rests on the base write being a `REPLACE` on an interleaved-with-cascade child. Dropping the cascade, or switching the base write to a column `UPDATE`, silently leaks stale rows.
- **Every write re-writes all element rows.** A create/update deletes the whole set (via the cascade) and re-inserts it. That is cheap for a handful of lines.
- **Duplicate elements collide on the primary key.** Two rows with the same `(id, book)` cannot both exist. Here it is a non-issue because the validator merges order lines referencing the same book *before* the write — the array is de-duplicated upstream, so each element yields a distinct key. A projection over a possibly-duplicated array must dedupe first.
- **Deleted parents are excluded by the write path, not the read.** Because the manager clears a deleted order's index rows (the `REPLACE` cascade + the `deletedAt` guard), the read needs no `deletedAt IS NULL` filter — a deleted order simply has nothing to join to. The exclusion is an invariant of how the index is maintained.

## In this repository

The pattern indexes the books inside an order, powering the staff "list every order containing this book" listing.

- The companion schema (`OrderBookIndex` → table `OrderBook`, composite key, denormalized `createdAt`) — [order-book.yaml](../domains/ordering/spanner/order-book.yaml).
- The hand-written DDL that the schema cannot express: `INTERLEAVE IN PARENT … ON DELETE CASCADE` and the `OrderBooksByBook` index — [0005-create-order-book-index.sql](../domains/ordering/spanner/0005-create-order-book-index.sql).
- The sync write path — the `updateState` override that re-inserts one row per line, relying on the parent `REPLACE` + cascade — [manager.ts](../domains/ordering/service/src/order/manager.ts).
- The read: the index-seek + join keyset query — [query.service.ts](../domains/ordering/service/src/order/query.service.ts) (`listByBook`).
- The behavior under test — cross-customer listing, pagination carrying the `book` filter, non-matching (wrong-book) exclusion, and non-staff `403` — [api.controller.list.spec.ts](../domains/ordering/service/src/order/api.controller.list.spec.ts). Its orders are seeded *through the manager* (`OrderManager.processEvent`), so the index is populated by `updateState` — the real write path — rather than by hand-inserting index rows — [utils.test.ts](../domains/ordering/service/src/order/utils.test.ts) (`insertOrders`).
