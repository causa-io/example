# Firestore projection + security rules

Mirror a backend entity into **Firestore** so client apps read it in *real time*, and gate those reads with **security rules**. A `VersionedEventProcessor` projects the entity's event stream into a **client-shaped document**, and per-domain `firestore.rules` fragments — merged into one ruleset — decide who may read each document. Clients only ever read, every write goes through the backend.

## The reason

Spanner is the source of truth for an order, but a customer's app wants to *watch* its order history — status changing from `pending` to `confirmed` — without polling the API.

Firestore provides this: clients open a real-time listener on a document and get pushed every change. So `ordering` mirrors each order into a Firestore `OrderDocument` and lets the customer's app subscribe. The backend owns the writes, the client only reads.

That move creates two needs the Spanner table never had, because the client now talks to the database directly, with no API layer in between:

- **A shape safe to expose.** The stored entity carries fields a client must not see. The projection is a *reduced* document that simply does not contain them.
- **Access control in the database.** With no controller to run [authorization](authorization-service.md), the rules *are* the authorization layer — evaluated by Firestore on every client read.

This is the same event-driven, idempotent projection machinery as the [Simple projection](simple-projection.md). What differs is the *consumer* (a client, via Firestore, rather than the domain's own query path in Spanner) and that here a domain projects its *own* entity rather than another domain's.

## The solution

Four pieces: a client-shaped **document schema**, the **security rules**, the **projection processor**, and the **trigger** that drives it. The processor and trigger are the [Simple projection](simple-projection.md) with its transaction stack swapped from Spanner to Firestore, the schema and rules are new.

### The document is a reduced, client-shaped schema

The Firestore document is modelled under the domain's `firestore/` folder, separate from the `entities/` Spanner table. It declares only the fields a client should see, and the `causa.googleFirestoreCollection` extension names the collection path and opts into soft-delete:

```yaml
# firestore/order.yaml (trimmed)
title: OrderDocument            # suffixed `Document` — it is the Firestore shape, not the entity
causa:
  googleFirestoreCollection:
    path: [orders, property: id]  # documents live at `orders/{id}`
    hasSoftDelete: true           # a set `deletedAt` moves the doc to a soft-delete collection
properties:
  id: { type: string, format: uuid }
  createdAt: { type: string, format: date-time }
  updatedAt: { type: string, format: date-time }   # the version property (idempotency, below)
  deletedAt: { oneOf: [{ type: string, format: date-time }, { type: "null" }] }
  customer: { type: string, format: uuid }          # the owner — the security rule gates on this
  status: { oneOf: [{ $ref: ../entities/order.yaml#/$defs/OrderStatus }] }
  lines: { type: array, items: { oneOf: [{ $ref: ../entities/order.yaml#/$defs/OrderLine }] } }
  # NOTE: the entity's `externalReference` is absent — it is not part of this schema.
```

`cs model genCode` emits an `OrderDocument` class carrying `@FirestoreCollection({ path: (doc) => ['orders', doc.id] })` and `@SoftDeletedFirestoreCollection()` — and *no* `@SpannerColumn`/`@SpannerTable`. Same domain concept as `Order`, deliberately a distinct type so the client shape can diverge from the stored one.

The entity's `externalReference` (the third-party reference, an internal detail) is **absent from the document schema**, so the generated `OrderDocument` type does not declare it. That documents the intended shape and types the projection's output, but the projection has to actually decline to copy the field.

### The security rules gate client reads

Each domain contributes a `firestore.rules` *fragment*: bare `match` blocks, no `service`/`rules_version` wrapper. The `GoogleFirestoreMergeRules` processor concatenates every fragment with the shared helpers and wraps the result into the single ruleset that is deployed (see [Environment infrastructure](environment-infrastructure.md)).

```
// ordering/firestore/firestore.rules — the ordering domain's fragment
match /orders/{orderId} {
  allow read: if
    isStaff() ||                                 // staff see every order
    isAuthenticatedAs(resource.data.customer);   // the customer sees its own

  // All writes go through the backend (Admin SDK, which bypasses rules).
  // Clients are never allowed to write.
  allow write: if false;
}
```

The two predicates are reusable helpers, kept in the `common` fragment so every domain expresses *owner* and *staff* the same way:

```
// common/firestore/firestore.rules — shared helpers
function isAuthenticatedAs(id) {                 // owner: the caller IS this user
  return isAuthenticated() && id != null && id is string && request.auth.uid == id;
}
function isStaff() {                             // staff: a custom-claim role
  return isAuthenticated() &&
    request.auth.token.roles != null && request.auth.token.roles is list &&
    'staff' in request.auth.token.roles;
}
```

*Owner* reads a field of the document (`resource.data.customer`) and compares it to the caller's `uid`; *staff* reads a `roles` custom claim off the auth token. The defensive `!= null` / `is string|list` guards keep a malformed token from throwing instead of denying.

This owner-or-staff split is a *deliberately simple* illustration — enough to show where authorization lives once clients read the database directly. Real access policies are usually richer: role hierarchies, organization or team membership, visibility that depends on the document's state, per-field conditions. What carries over is the *structure*, not this exact rule — shared predicates in the `common` fragment, a `match` block per collection — only the conditions grow.

The rules are *executable*, so they are tested from the client's side against the merged ruleset the emulator serves. **Prefer not to seed documents:** assert against the *query* instead, which the emulator allows only if it can prove every result is readable. That keeps a rules test about the rule rather than fixture state, and it works here because the `orders` rule only inspects the document being read. A possible exception is a rule that consults a *second* document — a cross-reference `get(/databases/.../someCollection/$(id))`: there the test *must* first write that referenced document with `env.withSecurityRulesDisabled(...)`, because the decision depends on data that has to exist. Not the case here.

```typescript
// collections.spec.ts — the deployed rules, not the app
// The emulator already serves the merged `.causa/firestore.rules` (Causa loads
// it), and project id + host come from `.env` — so no config is needed.
env = await initializeTestEnvironment({});
const asUser = (uid, claims) => env.authenticatedContext(uid, claims).firestore();

// A filtered query is allowed only when the filter matches what the rule permits.
await assertSucceeds(asUser(me).collection('orders').where('customer', '==', me).get());      // own → ok
await assertSucceeds(asUser(x, { roles: ['staff'] }).collection('orders').get());             // staff → any
await assertFails(asUser(me).collection('orders').where('customer', '==', other).get());      // another's → denied
await assertFails(asUser(me).collection('orders').doc(id).set({ … }));                        // write → denied
```

### The projection processor writes the document, idempotently

The processor is a `VersionedEventProcessor`, exactly like the Spanner [Simple projection](simple-projection.md) — only the transaction generics change from the `SpannerOutbox*` trio to the `FirestorePubSub*` one, and it projects to `OrderDocument`:

```typescript
// order/firestore-projection.service.ts
export class OrderFirestoreProjectionService extends VersionedEventProcessor<
  FirestorePubSubTransaction, FirestoreReadOnlyStateTransaction,
  OrderEvent, OrderDocument, FirestorePubSubTransactionRunner
> {
  constructor(runner: FirestorePubSubTransactionRunner) {
    super(OrderDocument, runner, 'updatedAt'); // version property → idempotency
  }

  protected async project({ data }: OrderEvent): Promise<OrderDocument> {
    return new OrderDocument({           // a full Order in, a reduced document out
      id: data.id, createdAt: data.createdAt, updatedAt: data.updatedAt,
      deletedAt: data.deletedAt, customer: data.customer,
      status: data.status, lines: data.lines,
      // `externalReference` is not copied — and `OrderDocument` has no such field.
    });
  }
}
```

**Idempotency comes from the version property, for free.** Pub/Sub is at-least-once and unordered, so the same order event can arrive twice or out of order. `processOrSkipEvent` builds the document, reads the stored one, and — because `updatedAt` is the version — skips whenever the stored document is newer-or-equal. **There is no create/update/delete branching:** every order event carries the order in its post-change state, and a delete simply carries a set `deletedAt`, which `@SoftDeletedFirestoreCollection` relocates to the soft-delete collection on the same upsert.

### The thin controller drives it, and the wiring

The event controller adds no logic — its route comes from the generated `@AsOrdersEventsController()`, and it delegates to `processOrSkipEvent`:

```typescript
// order/event.controller.ts
@AsOrdersEventsController()
export class OrderEventController implements OrdersEventsContract {
  async handleOrderForFirestore(event: OrderEvent): Promise<void> {
    this.logger.assign({ orderId: event.data.id, eventName: event.name });
    await this.orderFirestoreProjectionService.processOrSkipEvent(event);
  }
}
```

Two more wires make it run: the trigger subscribes the service to its *own* topic, and `BaseModule` gains the Firestore transaction runner.

```yaml
# service/causa.yaml — subscribe to our own order events
triggers:
  handleOrderForFirestore:
    type: event
    topic: ordering.order.v1                 # this service both produces and consumes it
    endpoint: { type: http, path: /orders/handleOrderForFirestore }
outputs:
  # Declares the collection this service owns — and is what grants the service
  # account read+write access to the Firestore database: the Cloud Run module
  # grants `roles/datastore.user` when this list is non-empty.
  google.firestore: [orders]
```

```typescript
// base.module.ts — the Firestore counterpart of the Spanner outbox runner
FirestorePubSubTransactionModule.forRoot(), // relies on FirebaseModule + PubSubPublisherModule
```

## Gotchas

- **`project()` is the security boundary, not the schema.** What reaches Firestore is whatever the returned instance carries, so `project()` must set only the client-safe fields explicitly. The reduced schema documents the shape and types the output. It strips nothing at runtime, so the explicit field list in `project()` is the enforcement.
- **`allow write: if false` — clients only read.** The projection writes with the Admin SDK, which bypasses security rules entirely, so the rules only ever need to express *read* access. A client never writes the read model; it changes an order by calling the API, which emits the event that updates Firestore.
- **A domain projects its *own* entity here.** Unlike the cross-domain [Simple projection](simple-projection.md), `ordering` mirrors `Order`. It is still driven by the *event stream*, not the write path — so the command that changes an order never blocks on a Firestore write, and a replayed event rebuilds the document for free.
- **Two test surfaces, two tools.** The *writer* is tested with the server SDK — boot the app on emulators (`AppFixture` + `createGoogleFixtures`), POST an event, assert the document (see [Testing with `AppFixture`](testing-with-app-fixture.md)). The *rules* are tested from the *client* side with `@firebase/rules-unit-testing` against the merged `.causa/firestore.rules` — no app, just `assertSucceeds` / `assertFails` per principal.
- **The collection's indexing and TTL are Terraform, and the shared Causa module does most of it.** Because the client reads Firestore directly, any query beyond a document lookup needs an index, declared in the domain's `firestore.tf`. Use the `causa-io/firestore-collection/google` module per collection: it exempts monotonic timestamps (`createdAt` / `updatedAt` / `deletedAt`) from automatic single-field indexing, and sets the TTL on `orders$deleted._expirationDate` (`expire_soft_deleted_documents`, on by default) so soft-deleted documents are garbage-collected. A *composite* index (a filter-plus-sort) is the one thing the module does not cover, so it stays a plain `google_firestore_index` (equality field, then sort field, then a trailing `__name__` matching the sort direction).

## In this repository

The `ordering` service mirrors `Order` into the `orders` Firestore collection for the customer's app:

- **The client-shaped document** (drops `externalReference`; declares the `orders/{id}` path and soft-delete) — [order.yaml](../domains/ordering/firestore/order.yaml), generated as `OrderDocument` in [generated.ts](../domains/ordering/service/src/model/generated.ts).
- **The security rules** (owner-or-staff read, no client write) — [ordering/firestore.rules](../domains/ordering/firestore/firestore.rules); the shared `isAuthenticatedAs` / `isStaff` helpers — [common/firestore.rules](../domains/common/firestore/firestore.rules). Merged by `GoogleFirestoreMergeRules` and deployed via Terraform — see [Environment infrastructure](environment-infrastructure.md).
- **The projection processor** (`VersionedEventProcessor` on the Firestore stack, `project()` dropping `externalReference`) — [firestore-projection.service.ts](../domains/ordering/service/src/order/firestore-projection.service.ts).
- **The thin controller** (drives `processOrSkipEvent`; stubs the two triggers owned by other patterns) — [event.controller.ts](../domains/ordering/service/src/order/event.controller.ts), against the generated contract in [orders.events.controller.ts](../domains/ordering/service/src/api/orders.events.controller.ts).
- **The wiring** — the trigger on the service's own topic and the maintained collection in [service/causa.yaml](../domains/ordering/service/causa.yaml) (`handleOrderForFirestore`, `outputs.google.firestore`); the Firestore runner in [base.module.ts](../domains/ordering/service/src/base.module.ts); the handler module in [event.module.ts](../domains/ordering/service/src/order/event.module.ts), imported by [events.module.ts](../domains/ordering/service/src/events.module.ts).
- **The writer, as tests** (writes the document from an event; ignores a stale, out-of-order event) — [event.controller.firestore.spec.ts](../domains/ordering/service/src/order/event.controller.firestore.spec.ts). Note the `VersionedEventProcessor` idempotency is already tested by the runtime — the spec covers only what this projection adds.
- **The rules, as tests** (owner reads own, staff reads any, other customer denied, unauthenticated denied, client write denied) — [collections.spec.ts](../domains/ordering/service/src/collections.spec.ts), using `@firebase/rules-unit-testing` against the merged `.causa/firestore.rules`.
- **The collection's infrastructure** (the shared `causa-io/firestore-collection/google` module — single-field index exemptions + the soft-deleted-documents TTL; plus a composite index for the customer's order-history query) — [firestore.tf](../domains/ordering/infrastructure/firestore.tf), which consumes the environment's Firestore database name — see [Environment infrastructure](environment-infrastructure.md).

This is the client-facing sibling of the Spanner [Simple projection](simple-projection.md): same event-driven, idempotent machinery, a different consumer and a security boundary.
