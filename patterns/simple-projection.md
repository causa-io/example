# Simple projection

Maintain a local view of another domain's entity, built from that domain's unordered at least once event stream.

## The reason

Each domain owns its own database and never shares it, domains communicate strictly through events. So when `ordering` needs catalogue data to validate an order line, it cannot read the catalogue's `Book` table. Calling the catalogue's API on every order would couple the two at runtime, making an ordering request fail whenever the catalogue is slow or down.

A projection removes that coupling. `ordering` **subscribes** to `catalog.book.v1` and maintains a local `BookProjection` table it owns, updated asynchronously as events arrive. Because the table belongs to `ordering`, the domain shapes it for its own needs — the view it wants, the indexes its own queries want — and it serves its own read load without touching the catalogue. Order validation then reads a local table, in the same Spanner transaction as the write it guards.

A projection holds only what the consumer needs (here, a book's title and availability, plus the id and timestamps to store and version the row), which also keeps it insulated from upstream schema changes it doesn't use.

## The solution

### The projection is a table the consumer owns, modelled under `spanner/`

The projection schema lives under the consuming domain's `spanner/` folder, not `entities/`, because it is a table the consumer maintains for its own use — derived from another domain, not a first-class entity of this one. It is a normal `causa.googleSpannerTable`, so `cs model genCode` emits a `@SpannerTable` class for it exactly like an entity, and it gets its own DDL migration.

Only the needed properties are declared. Note the version/soft-delete columns are kept: `updatedAt` (drives idempotency, below) and `deletedAt` (a nullable soft-delete marker, garbage-collected by a Spanner row-deletion policy).

```yaml
# spanner/book-projection.yaml (trimmed)
title: BookProjection
causa:
  googleSpannerTable:
    primaryKey: [id]
properties:
  id: { type: string, format: uuid }
  createdAt: { type: string, format: date-time }
  updatedAt: { type: string, format: date-time }
  deletedAt: { oneOf: [{ type: string, format: date-time }, { type: "null" }] }
  # ... properties needed by Ordering.
```

### A `VersionedEventProcessor` builds the row, idempotently

The consuming service declares an **event trigger** in its `causa.yaml`, subscribing to the upstream topic and routing pushes to an HTTP endpoint:

```yaml
# service/causa.yaml
serviceContainer:
  triggers:
    handleBookForProjection:
      type: event
      topic: catalog.book.v1
      endpoint:
        type: http
        path: /catalog/handleBookForProjection
```

The handler extends the runtime's `VersionedEventProcessor`. A projection only has to declare two things — the **version property** and how to **`project()`** an event into a row — and the base class supplies everything else: fetch the current row by primary key, compare versions, skip the event if it is not strictly newer, and upsert.

```typescript
export class BookProjectionService extends VersionedEventProcessor<
  SpannerOutboxTransaction, SpannerReadOnlyStateTransaction,
  BookEvent, BookProjection, SpannerOutboxTransactionRunner
> {
  constructor(runner: SpannerOutboxTransactionRunner) {
    super(BookProjection, runner, 'updatedAt'); // version property
  }

  protected async project(event: BookEvent): Promise<BookProjection> {
    const { data } = event; // `data` is a full Book...
    return new BookProjection({ // ...projected down to what ordering needs
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: data.deletedAt,
      title: data.title,
      availability: data.availability,
    });
  }
}
```

**Idempotency comes for free from the version property.** Pub/Sub delivers at least once and out of order, so the same book event can arrive twice, or an old one can arrive after a newer one. `processOrSkipEvent` builds the projection, reads the stored row, and — because `updatedAt` is the version — skips (returns `null`, a no-op) whenever the stored row is newer-or-equal. No manual "have I seen this?" bookkeeping.

**There is no create / update / delete branching.** Every book event carries the book in its post-change state, so `project()` is the same for all of them. A `bookDeleted` event simply carries a set `deletedAt`, which lands in the row.

### The event controller calls `processOrSkipEvent`

The event controller handling the trigger drives the projection by calling `processOrSkipEvent`, which processes the event or skips it when a newer row already exists — so the handler is safe under Pub/Sub's unordered, at-least-once delivery.

```typescript
@AsCatalogEventsController()
export class CatalogEventController implements CatalogEventsContract {
  async handleBookForProjection(event: BookEvent): Promise<void> {
    await this.bookProjectionService.processOrSkipEvent(event);
  }
}
```

### The projection service also serves reads of the view

The `VersionedEventProcessor` subclass does more than consume events. Its one job is to maintain the `BookProjection` view — and because it *owns* that view, it also owns **access** to it. Reads against the projection ("do these books exist, and can they be ordered?") are methods on the same service, not a separate lookup service. The consumer that needs the answer states the rule and delegates the read to the owner of the view:

```typescript
// A method on BookProjectionService, alongside project():
async validateAvailable(bookIds: string[], options: SpannerReadOnlyStateTransactionOption) {
  const { entityManager } = this.runner; // the transaction runner exposes the SpannerEntityManager
  // ...read the projection rows, then throw BookNotFoundError / BookUnavailableError...
}
```

Keeping reads on the owner means a query against the view — its columns, its `deletedAt IS NULL` filter — is written once, next to the code that shapes the view, and every consumer goes through it.

## In this repository

**The projection model:**

- Schema (only the needed fields, under `spanner/`) —
  [book-projection.yaml](../domains/ordering/spanner/book-projection.yaml).
- DDL migration —
  [0002-create-book-projection-table.sql](../domains/ordering/spanner/0002-create-book-projection-table.sql).

**The source it projects from (the catalogue):**

- The entity —
  [book.yaml](../domains/catalog/entities/book.yaml).
- The event contract consumed —
  [book/v1.yaml](../domains/catalog/events/book/v1.yaml).

**The handler:**

- The trigger declaration —
  [service/causa.yaml](../domains/ordering/service/causa.yaml) (`handleBookForProjection`).
- The processor (`VersionedEventProcessor`, `project()`, version property) and
  the read side that owns access to the view (`validateAvailable`, used by order
  validation — see [Validator service](validator-service.md)) —
  [book-projection.service.ts](../domains/ordering/service/src/catalog/book-projection.service.ts).
- The thin controller —
  [event.controller.ts](../domains/ordering/service/src/catalog/event.controller.ts).
- Module wiring —
  [catalog/module.ts](../domains/ordering/service/src/catalog/module.ts),
  [catalog/event.module.ts](../domains/ordering/service/src/catalog/event.module.ts),
  [events.module.ts](../domains/ordering/service/src/events.module.ts).
- The generated route decorator —
  [catalog.events.controller.ts](../domains/ordering/service/src/api/catalog.events.controller.ts).

**The behaviour, as tests (create and ignore-stale-version):**

- [event.controller.book.spec.ts](../domains/ordering/service/src/catalog/event.controller.book.spec.ts). Note that the `VersionedEventProcessor` logic is already tested. You don't need to cover all idempotency cases, only what your projection logic adds.
