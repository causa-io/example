# Authorization service

An injectable that centralizes access decisions, reused by controllers and by state-change validation.

## The reason

Access rules are easy to scatter: an `if (actor.id !== order.customer …)` copied into every handler drifts over time, and one endpoint ends up more permissive than another. Pulling the decisions into a single injectable means the authorization policy is written **once** and every caller — the read endpoint, and (for state changes) the manager's `validationFn` — asks the same class. It also keeps the decision logic out of the controllers, which stay thin.

## The solution

A per-entity `@Injectable()` service whose methods all take the authenticated caller as the first argument and answer "may this caller do this?", throwing on refusal.

### Where the caller comes from

The runtime resolves the caller at the controller boundary from the request's bearer token, injected with `@AuthUser()`:

```typescript
async get({ id }: OrderGetPathParams, @AuthUser() actor: User) { … }
```

`User` is `{ id: string; [claim: string]: any }` — the subject id plus whatever claims the token carries. In this example Ordering keys its policy on roles: a "staff" role arrives as the `roles` claim (`actor.roles`), and the check deliberately mirrors the Firestore security rules' `isStaff()` helper (`request.auth.token.roles` contains `staff`), so the two ways a client can reach an order — the API, and reading the Firestore mirror directly — enforce the same notion of staff.

The public API root turns authentication on by importing `AuthModule` — a global guard that rejects an anonymous caller with `401` — and providing `IdentityPlatformStrategy`, which validates the Firebase / Identity Platform bearer token and sets `request.user`. So by the time a handler runs, `@AuthUser()` always yields a caller; the event-handler root never imports this.

### The decision, in one place

```typescript
@Injectable()
export class OrderAuthorizationService {
  validateCanRead(actor: User, order: Pick<Order, 'customer'>): void {
    if (this.isStaff(actor) || actor.id === order.customer) return;
    throw new OrderNotFoundError(); // 404, not 403 — see below
  }

  private isStaff(actor: User): boolean {
    return Array.isArray(actor.roles) && actor.roles.includes('staff');
  }
}
```

**404, not 403, on a read.** A caller who is neither staff nor the owner is answered with *not found*, not *forbidden* — otherwise the API would confirm that an order with that id exists but belongs to someone else. This is why `order.api.yaml`'s `orderGet` lists a `404` response and no `403`.

### Reused by the write path

The same service is the policy behind the manager's `validationFn` hook for state-dependent writes: the controller passes `validationFn: (order) => authorizationService.validateCanCancel(actor, order)`, closing over the authenticated `actor`, so a transition is authorized against the **stored** order inside the transaction before it can commit. That hook — and how the service composes it with a state-machine precondition — is the subject of [Controller authorization via `validationFn`](controller-authorization-via-validationfn.md); see the [Controller / Service / Manager split](service-layering.md) for how it fits the layering.

## In this repository

- The service —
  [authorization.service.ts](../domains/ordering/service/src/order/authorization.service.ts).
- Called from the read endpoint —
  [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts) (`get`).
- Authentication wiring that populates the caller (`AuthModule` + `IdentityPlatformStrategy`) —
  [api.module.ts](../domains/ordering/service/src/api.module.ts).
- The staff/owner model it mirrors, on the client side —
  [common/firestore/firestore.rules](../domains/common/firestore/firestore.rules) (`isStaff`, `isAuthenticatedAs`),
  [ordering/firestore/firestore.rules](../domains/ordering/firestore/firestore.rules) (the `orders` match block).
- The rule under test (owner reads, staff reads any, others get `404`) —
  [api.controller.get.spec.ts](../domains/ordering/service/src/order/api.controller.get.spec.ts).
