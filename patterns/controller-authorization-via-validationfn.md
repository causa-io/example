# Controller authorization via `validationFn`

Authorize (or otherwise guard) a **state-dependent write** with the manager's **`validationFn`** hook: a callback that runs against the *stored* entity, fetched inside the write transaction, and **throws to abort the mutation before it commits**. The controller injects authorization that depends on the stored entity; the service composes its own state-machine precondition on top.

## The reason

Some permission checks can be made the moment a request arrives — "is the caller staff?" needs only the token. Others cannot: "may this caller cancel *this* order?" depends on the order's `customer`, which is not known until the row is read. The naive fix — fetch the entity, check, then write — opens a window: the entity can change between the check and the write, and the check reads a different snapshot than the mutation.

`VersionedEntityManager.update` (and `delete`) closes that window with a `validationFn`. The manager fetches the current entity *once*, inside the write transaction, hands it to the callback, and only proceeds if the callback returns. A thrown error aborts the transaction — no row is written, no event is emitted. The check and the mutation see the same snapshot, atomically, with no second read.

This gives two distinct guards the same home:

- **Authorization that depends on the stored entity** — ownership, status-gated permissions. Supplied by the *controller*, closing over the authenticated caller.
- **State-machine preconditions** — "only a `pending` order may be cancelled". Owned by the *service*, which owns the transition.

Contrast the boundary check: when a decision needs only the caller (not the stored entity), it stays at the controller boundary — no `validationFn`, no transaction required. This page is about the other case.

## The solution

Four pieces: the manager hook, an authorization-service method, the service that composes, and the controller that injects.

### The hook

`update` accepts a `validationFn` in its options. The runtime calls it after fetching the current entity and *before* the optimistic-concurrency check and the write:

```typescript
// @causa/runtime — VersionedEntityManager.findExistingEntityOrFail (paraphrased)
const existingEntity = await this.get(entityKey, { transaction });
if (options.validationFn) {
  await options.validationFn(existingEntity, transaction); // throws → whole update aborts
}
if (options.checkUpdatedAt && /* stale */) throw new IncorrectEntityVersionError(...);
```

Its type is `(existingEntity, transaction) => Promise<void>`: it receives the *pre-mutation* entity and the current transaction, and signals refusal by throwing. It never sees the new state — it guards the transition *from* the current one.

### Authorization lives in the authorization service

The decision stays in the [Authorization service](authorization-service.md), so the policy is written once. Cancelling is allowed to the order's own customer or to staff — which is *exactly* who may read it, so the check delegates straight to `validateCanRead`:

```typescript
// order/authorization.service.ts
validateCanCancel(actor: User, order: Pick<Order, 'customer'>): void {
  // Cancelling needs no permission beyond seeing the order, so this IS the read
  // check: owner or staff, else 404.
  this.validateCanRead(actor, order);
}
```

The refusal is a **`404`, not `403`**: a caller who is neither owner nor staff must not learn the order exists (the existence-hiding rule of `validateCanRead` — see the [Authorization service](authorization-service.md)). Because cancelling needs no permission beyond visibility, there is no separate `403` case at all.

### The service composes: caller check first, then state check

The command service owns the transition, so it owns the `pending` precondition. It accepts the caller's authorization hook and runs it *before* its own state check, then hands the composite to the manager.

A single write, so the command opens no transaction of its own — it forwards `options.transaction` straight to `manager.update`, which joins it (or opens one if absent):

```typescript
// order/service.ts — cancel
// `options` is the manager's own update-options type (transaction, checkUpdatedAt,
// validationFn, …), taken whole and forwarded with `...options`. Everything the
// caller set — including the version and joined transaction — passes straight
// through; only `validationFn` is overridden, to compose (see Gotchas).
async cancel(id, options: OrderUpdateOptions) {
  const event = await this.manager.update(
    OrderEventName.OrderCancelled, { id }, { status: OrderStatus.Cancelled },
    {
      ...options,                                   // forwards transaction, checkUpdatedAt, …
      validationFn: async (order, tx) => {
        await options.validationFn?.(order, tx);    // 1. caller's authorization (owner-or-staff)
        this.assertPending(order);                  // 2. service's state rule (else 400)
      },
    },
  );
  return event.data as OrderCancelled;
}

private assertPending(order: Order): asserts order is OrderPending {
  if (order.status !== OrderStatus.Pending) throw new InvalidOrderStatusError(order.status);
}
```

**Order matters.** Authorization runs first: a non-owner is rejected with `404` before the state check can run, so they never learn whether the order was cancellable. Reverse the two and a stranger probing a processing order would get a `400` that confirms the order exists.

### The controller injects the caller-dependent check

The controller never touches the manager (see the [Controller / Service / Manager split](service-layering.md)); it passes its authorization hook *through* the service, closing over the authenticated `actor`:

```typescript
// order/api.controller.ts — cancel
@TryMap(invalidOrderStatusErrorAsDto, orderNotFoundErrorAsDto, incorrectVersionErrorAsDto)
async cancel({ id }: OrderCancelPathParams, { updatedAt }: OrderCancelQueryParams,
             @AuthUser() actor: User): Promise<OrderPublicDto> {
  const order = await this.runner.run({ tag: 'orderCancel' }, (transaction) =>
    this.service.cancel(id, {
      transaction,
      checkUpdatedAt: updatedAt,
      validationFn: async (order) => this.authorizationService.validateCanCancel(actor, order),
    }),
  );
  return toOrderPublicDto(order);
}
```

### Two layers: access, then action (`process`)

`cancel` and `process` both authorize through a `validationFn`, because both decisions read the stored order. What differs is *how much* permission the action demands beyond visibility — and the general rule is to check **access before action**:

- `cancel` needs nothing beyond access — whoever can see the order may cancel it — so `validateCanCancel` *is* the read check, and there is no separate `403`.
- `process` layers a stricter action gate on top of access: first "can you see it?" (else `404`), then "are you staff?" (else `403`).

```typescript
// order/authorization.service.ts
validateCanProcess(actor: User, order: Pick<Order, 'customer'>): void {
  this.validateCanRead(actor, order);   // 1. access — else 404 (existence hidden)
  if (this.isStaff(actor)) return;      // 2. action — staff may process
  throw new ForbiddenError();           // owner can see it, but may not process → 403
}
```

Running the access layer first is what makes the stranger's `404` hide the order: they are refused before the action gate — or the state check — can betray that it exists. Only a caller who *passes* access but *fails* the action gate (the owner, here) receives a `403`.

Boundary authorization still applies where a decision needs *no* stored entity: the list endpoints check `validateCanList` against a query parameter, before any read (see the [Controller / Service / Manager split](service-layering.md)).

## Gotchas & decisions

- **Authorization before state, always.** Composing the caller's check ahead of the state check is what keeps a non-owner from learning an order's status. It is a security property of the ordering, not a stylistic choice.
- **Access before action: `404` before `403`.** When an action needs more than visibility (`process` is staff-only), check visibility *first* (`validateCanRead` → `404`) and the action gate *second* (→ `403`). A caller who cannot see the order is refused before the gate runs, so a `403` never confirms the order exists; only a caller who *can* see it but lacks the action gets `403`.
- **Take the manager's whole update-options type and spread it — don't re-declare a hook, and don't `Pick` fields.** The command's `options` parameter *is* `VersionedEntityUpdateOptions<SpannerOutboxTransaction, Order>`, forwarded with `{ ...options, validationFn: … }`. So the caller can set any update option (`transaction`, `checkUpdatedAt`, …) and it passes straight through, and the `validationFn` type — `(existingEntity, transaction) => Promise<void>` — can never drift from what `manager.update` accepts.
- **Override `validationFn`, don't just set it.** Since the whole options object is spread, a `validationFn` the caller passed is already in it. The command must *compose* — `await options.validationFn?.(…); <state checks>` — not blindly assign, or a caller-supplied check would be silently dropped.
- **The check reuses the manager's fetch.** `validationFn` receives the entity the manager already read to perform the update; it adds no second query. Authorization that would otherwise need its own read gets it for free, on the write snapshot.

## In this repository

The `ordering` service, `process` (pending → processing) and `cancel` (pending → cancelled):

- **The policy** — [authorization.service.ts](../domains/ordering/service/src/order/authorization.service.ts) (`validateCanCancel`, which delegates to `validateCanRead` → `404`; `validateCanProcess`, which layers a staff action gate on that read check → `404` for a stranger, `403` for the non-staff owner).
- **The composition** (caller auth + `pending` state check, wired as the manager's `validationFn`) — [service.ts](../domains/ordering/service/src/order/service.ts) (`cancel`, `process`, `assertPending`; each command takes the manager's `VersionedEntityUpdateOptions` whole and spreads them, overriding only `validationFn` to compose).
- **The controller** (inject an authorization `validationFn` closing over the caller) — [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- **The typed state error and its `400` mapping** — [errors.ts](../domains/ordering/service/src/order/errors.ts) (`InvalidOrderStatusError`), [dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts) (`invalidOrderStatusErrorAsDto`), from [invalid-order-status-error.dto.yaml](../domains/ordering/api/dtos/invalid-order-status-error.dto.yaml).
- **The transition on the model** (the `cancelled` state and `orderCancelled` event; `entityMutationFrom: OrderPendingConstraint` mirrors the runtime `pending` check) — [order.yaml](../domains/ordering/entities/order.yaml), [events/order/v1.yaml](../domains/ordering/events/order/v1.yaml).
- **The route contract** (`403`/`404` responses per operation) — [order.api.yaml](../domains/ordering/api/order.api.yaml).
- **The rules under test** — `process`: the non-staff owner → `403` but a stranger → `404` (access before action); `cancel`: non-owner → `404` (even for a non-pending order, proving access runs before the state check), owner/staff → `200` + `orderCancelled`; wrong state → `400` — [api.controller.process.spec.ts](../domains/ordering/service/src/order/api.controller.process.spec.ts), [api.controller.cancel.spec.ts](../domains/ordering/service/src/order/api.controller.cancel.spec.ts).

This is the state-changing counterpart to the boundary authorization in the [Controller / Service / Manager split](service-layering.md), and pairs with [Optimistic concurrency control](optimistic-concurrency-control.md), which guards the same two writes with `updatedAt`.
