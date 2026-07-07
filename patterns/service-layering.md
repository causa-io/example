# Controller / Service / Manager split

How a service is layered internally: Controller (HTTP) → Service (commands and business logic) → Manager (writes + events).

## The reason

A service that owns an entity has to do many unrelated things when it handles a request: parse and validate HTTP input, decide who is allowed to act, open a transaction, check the command against current state, write the row, emit an event, and shape the response. Put all of that in one class and every method becomes a tangle that is hard to read and harder to test.

The split gives each concern exactly one home. Each layer is small, has a single responsibility, and can be tested in isolation (if needed). It allows reusing the business logic from several entrypoints: a client-issued HTTP request or a triggered event. It is also **predictable**: every entity in every Causa service follows the same layer shape, so a reader who has seen one knows where to look in all of them.

The names are a convention, not a framework requirement — but they are used consistently across Causa codebases, so this repository follows them.

## The solution

Each entity gets a self-contained folder (`service/src/<entity>/`) built around three layers — **Controller → Service → Manager** — one file per layer:

| Layer | File | Responsibility |
| --- | --- | --- |
| **Controller** | `api.controller.ts` | The HTTP boundary. Routing from the generated decorator; extract the caller; delegate; map result/errors to DTOs. No business logic. |
| **Service** | `service.ts` | Commands / orchestration, plus single-entity reads. Runs validation, calls the manager, returns the entity. Owns *what it means* to place — and to fetch — an order. |
| **Manager** | `manager.ts` | A `VersionedEntityManager` subclass. The single-entity write paired with its event (atomic through the outbox), plus the inherited by-primary-key `get`. Owns *how* an order is written and fetched. |

The Controller and Manager ends stay fixed; the middle is where the design breathes. **"Service" is a role, not a single class** — the command service (`service.ts`) is the one every entity has, but the layer holds a family of specialized collaborators that grow with the entity, each small and single-purpose:

- an [authorization service](authorization-service.md) — owns the access policy, called at the boundary;
- a [validator service](validator-service.md) — sanitizes input against current state, inside the write transaction;

```
POST /orders    → Controller.place → Service.place → Manager.create ─┐ one Spanner
                                                   ↘ Validator       ├─ transaction
                                                                     └→ Order row + orderPlaced event (outbox)

GET /orders/:id → Controller.get → Service.get → Manager.get → (Order | 404)
                                 ↘ AuthorizationService.validateCanRead
```

### The manager is a thin `VersionedEntityManager`

The manager binds the runtime's `VersionedEntityManager` to this domain's topic, event, and entity, and adds almost nothing. Its inherited `create` / `update` / `delete` each mutate the row *and* append the matching event to the transactional outbox (published on commit) — so state and event can never diverge.

```typescript
@Injectable()
export class OrderManager extends VersionedEntityManager<
  SpannerOutboxTransaction, SpannerReadOnlyStateTransaction,
  OrderEvent, SpannerOutboxTransactionRunner
> {
  constructor(runner: SpannerOutboxTransactionRunner) {
    super('ordering.order.v1', OrderEvent, Order, runner); // (topic, event, entity, runner)
  }
  // Surfaces the domain's typed error instead of the generic runtime one.
  protected throwNotFoundError(): never {
    throw new OrderNotFoundError();
  }
}
```

`create` also stamps `createdAt` / `updatedAt` / `deletedAt` from the transaction timestamp, so the service never sets them by hand. `update` and `delete` do the same for `updatedAt` and `deletedAt`.

### The service orchestrates one command

The service sequences the work inside a transaction — the one the controller opened, joined here by passing it through `options`. Validation runs **inside** that same transaction as the write, so an order cannot be validated against a book that disappears before the write commits.

```typescript
async place(data: PlaceOrderData,
            options: SpannerOutboxTransactionOption & { orderId?: string } = {}) {
  const id = options.orderId ?? randomUUID();   // use the caller's ID, or mint one
  return this.runner.run(options, async (transaction) => {  // joins the controller's tx
    const { customer, lines } = await this.validator.sanitize(data, { transaction }); // same tx
    const event = await this.manager.create(
      OrderEventName.OrderPlaced,
      { id, customer, status: OrderStatus.Pending, lines, externalReference: null },
      { transaction },
    );
    return event.data; // the created Order
  });
}
```

**The ID is minted by the controller, not the service.** A creation command takes an optional `orderId` and falls back to a fresh UUID (`options.orderId ?? randomUUID()`). The controller generates the ID up front, attaches it to the logger, and passes it down — so the request is traceable.

**The transaction is opened by the controller, too.** Each handler calls `runner.run(...)` — `{ tag: 'orderPlace' }` for the write, `{ readOnly: true }` for the read — and passes the resulting `transaction` down as an option. Opening it at the boundary is what lets the controller **tag** it (tags surface in Spanner's query stats and traces, so a slow or contended transaction is attributable to its endpoint) and lets one read transaction span both the fetch and the authorization check. The service still calls `runner.run(options)`, which *joins* the passed transaction rather than opening a new one, so the service also works when called on its own.

### The controller is thin and maps at the boundary

Routing, paths, and status codes come from the generated `@AsOrderApiController()` decorator (built from `order.api.yaml`), so there are no hand-written `@Post` / `@Get` here. `implements OrderApiContract` keeps the class in lockstep with the spec — change an operation there and this stops compiling. The controller's only jobs are to pull the caller off the request, delegate, and translate.

```typescript
@AsOrderApiController()
export class OrderApiController implements OrderApiContract {
  @TryMap(bookNotFoundErrorAsDto, bookUnavailableErrorAsDto)      // domain error → HTTP DTO
  async place(body: OrderCreateDto, @AuthUser() actor: User): Promise<OrderPublicDto> {
    const orderId = randomUUID();
    this.logger.assign({ orderId });                             // traceable before any write
    const order = await this.runner.run({ tag: 'orderPlace' }, (transaction) =>
      this.service.place({ customer: actor.id, lines: body.lines }, { orderId, transaction }));
    return toOrderPublicDto(order);                               // entity → public DTO
  }

  @TryMap(orderNotFoundErrorAsDto)
  async get({ id }: OrderGetPathParams, @AuthUser() actor: User): Promise<OrderPublicDto> {
    const order = await this.runner.run({ readOnly: true }, async (transaction) => {
      const fetched = await this.service.get(id, { transaction });
      this.authorizationService.validateCanRead(actor, fetched);  // authorize the read
      return fetched;
    });
    return toOrderPublicDto(order);
  }
}
```

Two translation concerns live in `dto.utils.ts`, keeping the layers below HTTP-agnostic:

- **entity → DTO** (`toOrderPublicDto`): the read shape (`OrderPublicDto`) drops internal columns (`externalReference`, `deletedAt`).
- **error → DTO** via `@TryMap`: `toDtoType(OrderNotFoundError, NotFoundErrorDto)` for a plain status, and `toDto(BookNotFoundError, ({ books }) => new BookNotFoundErrorDto({ …, books }))` when the DTO carries extra data. The service layer throws typed errors and knows nothing about HTTP.

### Authorization at the controller boundary

Authorization is decided at the controller boundary, *before* any work, and always through the [Authorization service](authorization-service.md) so the policy is defined once. On a read, the controller fetches, then calls `authorizationService.validateCanRead(actor, order)` (the `get` handler above); `place` needs no check because the customer is forced to the authenticated caller, never taken from the body.

Writes whose permission depends on the *stored* state (state transitions) are authorized differently — through the manager/service's `validationFn` hook, which runs against the current entity inside the transaction and throws before the mutation commits.

## In this repository

The `ordering` service, entity folder `service/src/order/`:

- Controller —
  [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- Service (the `place` command and the `get` read) —
  [service.ts](../domains/ordering/service/src/order/service.ts).
- Manager (`VersionedEntityManager` subclass — the write, the event, and the by-key `get`) —
  [manager.ts](../domains/ordering/service/src/order/manager.ts).
- Boundary mapping (entity → DTO, error → DTO) —
  [dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts),
  [errors.ts](../domains/ordering/service/src/order/errors.ts).
- Module wiring (providers vs. controller split across the two container roots) —
  [module.ts](../domains/ordering/service/src/order/module.ts),
  [api.module.ts](../domains/ordering/service/src/order/api.module.ts),
  [api.module.ts (root)](../domains/ordering/service/src/api.module.ts).
- The generated route contract this controller implements —
  [order.api.controller.ts](../domains/ordering/service/src/api/order.api.controller.ts),
  from [order.api.yaml](../domains/ordering/api/order.api.yaml).
- The stack under test, driven over HTTP (one spec per operation) —
  [api.controller.place.spec.ts](../domains/ordering/service/src/order/api.controller.place.spec.ts),
  [api.controller.get.spec.ts](../domains/ordering/service/src/order/api.controller.get.spec.ts).

The two collaborators have their own pages: [Authorization service](authorization-service.md) and [Validator service](validator-service.md).
