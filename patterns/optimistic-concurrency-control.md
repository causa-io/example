# Optimistic concurrency control

Guard a mutation with the entity's **`updatedAt`** version: the client passes the version it last saw, and the manager rejects the write with a **`409`** if the stored entity has changed since.

## The reason

Two clients read the same order, both decide to act on it, both write. Without a guard the second write silently overwrites the first — the classic *lost update*. A pessimistic fix takes a lock at read time and holds it until the write commits, serializing the two clients and inviting contention and deadlocks for a conflict that usually never happens.

Optimistic concurrency bets the other way: assume conflicts are rare, take no lock, and *detect* the rare collision instead of preventing it. Every entity already carries a version — its `updatedAt`, stamped from the transaction timestamp on every write. A client that fetched an order remembers that timestamp. When it later mutates the order, it sends the timestamp back. Inside the write transaction the manager compares it to the stored one:

- **They match** → nothing changed since the client read; the write proceeds.
- **They differ** → someone wrote in between; the mutation is rejected with a `409`, and the client re-reads and retries against the fresh version.

No lock is held between the read and the write, so unrelated requests never wait on each other. The cost is that a client on the losing side of a genuine race must retry — cheap, because genuine races are rare.

## The solution

Three pieces: the version on the wire, the option threaded to the manager, and the error mapped to `409`.

### The version is `updatedAt`

`VersionedEntityManager` hardcodes the version field to `updatedAt` — the same column it stamps on every create/update/delete from the transaction timestamp. Nothing extra to model. The public read DTO returns it, and its description tells clients to send it back:

```yaml
# api/dtos/order.dto.yaml
updatedAt:
  type: string
  format: date-time
  description: The date at which the order was last updated. Pass back as `updatedAt` on mutations.
```

### The client passes it as a required query parameter

Each mutating operation takes `updatedAt` as a **required** query parameter, generated into a typed (`Date`) params class:

```yaml
# api/order.api.yaml — orderCancel (orderProcess is identical)
- name: updatedAt
  in: query
  required: true
  schema: { type: string, format: date-time }
  description: The version of the order the client is cancelling.
responses:
  "409":
    description: The provided version does not match the current version.
    content:
      application/json:
        schema:
          $ref: ../../common/api/dtos/incorrect-version-error.dto.yaml
```

### The controller threads it to the manager as `checkUpdatedAt`

The controller pulls `updatedAt` off the query and hands it to the service **in `options`, as `checkUpdatedAt`** — one field of the manager's update options, not a positional parameter — which the service forwards straight into `manager.update`:

```typescript
// order/api.controller.ts
async cancel({ id }, { updatedAt }: OrderCancelQueryParams, @AuthUser() actor) {
  const order = await this.runner.run({ tag: 'orderCancel' }, (transaction) =>
    this.service.cancel(id, { transaction, checkUpdatedAt: updatedAt, validationFn: … }));
  return toOrderPublicDto(order);
}

// order/service.ts — the whole options object (transaction, checkUpdatedAt, …) is
// forwarded with `...options`; only validationFn is overridden. No runner.run wrapper.
this.manager.update(OrderEventName.OrderCancelled, { id }, { status: OrderStatus.Cancelled },
  { ...options, validationFn: … });
```

Keeping `checkUpdatedAt` an *option* rather than a required argument is deliberate: optimistic concurrency is a concern of the API caller, which holds a version to compare. An internal, event-triggered transition of the same entity may have no client version and simply omits it.

### The error is mapped to `409`

The runtime throws `IncorrectEntityVersionError`, a transport-agnostic domain error. The controller maps it to the shared `409` DTO with `@TryMap`, reusing the runtime's ready-made `IncorrectVersionErrorDto`:

```typescript
// order/dto.utils.ts
export const incorrectVersionErrorAsDto = toDtoType(
  IncorrectEntityVersionError, // from @causa/runtime
  IncorrectVersionErrorDto,    // shared 409 DTO, statusCode hardcoded to 409
);
```

`toDtoType` is enough here — unlike a domain DTO, the shared `IncorrectVersionErrorDto` hardcodes its own `statusCode`/`errorCode`, so a no-argument instantiation is already a complete `409` body.

## Gotchas & decisions

- **The mapping is opt-in — without it, a `409` becomes a `500`.** `@causa/runtime` throws `IncorrectEntityVersionError` and ships `IncorrectVersionErrorDto`, but does **not** wire them together. A controller that forgets `@TryMap(incorrectVersionErrorAsDto, …)` lets the error fall through the global filter as a generic `500`. The pairing is the developer's to declare, per operation.
- **`409` is reserved for version mismatches only.** A business-state conflict — acting on an order in the wrong status — is a `400` with a domain `errorCode` (`ordering.invalidOrderStatus`), never a `409`. Keeping the two apart lets a client tell "you're out of date, re-read and retry" (`409`) from "this order can't be cancelled" (`400`). See the [Service error / error DTO split](service-error-dto-split.md).
- **The version round-trips through the client.** The API hands `updatedAt` out on every read and expects it back on every mutation. A client that caches a stale order and never re-reads will keep getting `409`s until it fetches the current version — which is the point.

## In this repository

The `ordering` service, on both state-changing writes (`process` and `cancel`):

- **The version parameter and `409` response** — [order.api.yaml](../domains/ordering/api/order.api.yaml) (`updatedAt` query param, `409` on `orderProcess` / `orderCancel`), generated into [api/model.ts](../domains/ordering/service/src/api/model.ts) (`OrderProcessQueryParams` / `OrderCancelQueryParams`).
- **The version handed out for the client to echo** — [order.dto.yaml](../domains/ordering/api/dtos/order.dto.yaml) (`updatedAt`, "pass back on mutations").
- **`checkUpdatedAt` threaded to the manager** — [service.ts](../domains/ordering/service/src/order/service.ts) (`process`, `cancel`), from [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- **The `409` mapping** — [dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts) (`incorrectVersionErrorAsDto`), applied with `@TryMap` on both operations in [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- **The shared error DTO schema** (the class comes from `@causa/runtime`) — [incorrect-version-error.dto.yaml](../domains/common/api/dtos/incorrect-version-error.dto.yaml).
- **The rule under test** (a stale `updatedAt` → `409`, no mutation, no event) — [api.controller.process.spec.ts](../domains/ordering/service/src/order/api.controller.process.spec.ts), [api.controller.cancel.spec.ts](../domains/ordering/service/src/order/api.controller.cancel.spec.ts).

Pairs with [Controller authorization via `validationFn`](controller-authorization-via-validationfn.md): the same `manager.update` call carries both the `checkUpdatedAt` version guard and the `validationFn` authorization/state guard, so one transaction enforces concurrency, permission, and state together.
