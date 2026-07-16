# Structured logging

Every service logs through `@causa/runtime`'s Pino-based **`Logger`**: each class sets a **context** in its constructor, and each request or event **`assign`**s a few request-wide fields (the *actor*, the entity *ids*, the *event name*). Every line the request then emits carries those fields, so logs become structured, *filterable* data in the observability platform — the raw material for debugging, log-based metrics, alerting, and real-time dashboards.

## The reason

A log line like `` `order ${id} placed by ${user}` `` is fine to read by eye and useless to a machine. You cannot filter a hundred thousand of them by customer, count how many placements failed in the last minute, or alert when that count spikes — the interesting values are buried inside a string.

*Structured* logging turns those values into named fields on a JSON log entry. Once `orderId`, `actor`, and `eventName` are columns rather than substrings, the logging platform (here Cloud Logging) can:

- **filter** — scope a query to one order, one customer, or one endpoint while chasing a bug;
- **correlate** — pivot from an HTTP request to the events it triggered, because they share the same ids;
- **measure** — define a log-based metric ("placements per minute", "cancellations by staff") and build alerting or a business dashboard on top of it, with no extra instrumentation.

The cost is one discipline: attach the right fields at the boundary, every time. Causa makes that nearly free — the logger is request-scoped, so you `assign` the fields once and every subsequent line inherits them.

## The solution

Four pieces, all from `@causa/runtime` / `@causa/runtime-google`: a process-wide Cloud Logging configuration, a request-scoped injected `Logger`, per-request enrichment in controllers, and per-event enrichment in event handlers (where the runtime already supplies the `eventId`).

### The logger is request-scoped; `assign` binds fields to it

The injected `Logger` (re-exported from `@causa/runtime/nestjs`) is *request-scoped*. Two methods shape what a line carries:

- **`setContext(name)`** — a per-instance label, emitted as the `context` field. Called once in the constructor with the class name, so a log query can be scoped to *where* a line came from.
- **`assign(fields)`** — binds `fields` onto *this request's* logger, so every line emitted for the rest of the request carries them — *including the framework's automatic `"request completed"` line*.

As part of an HTTP request (API or event trigger), at least one request log will be emitted automatically ("request completed") with the bound fields. Controllers and services can also call `logger.info` / `warn` / `error` to narrate a step worth recording, optionally with one-off fields (`logger.info({ oneOffId }, 'step completed')`). The flows in this example are simple enough that the handlers only enrich and never narrate. Richer flows reach for both.

### Controllers assign the actor and the entity ids

Each controller sets its context once, then every handler `assign`s the authenticated **actor** and the entity **id(s)** it touches, before doing any work — so even a line logged mid-failure is already attributed.

```typescript
// domains/ordering/service/src/order/api.controller.ts
constructor(/* … */ private readonly logger: Logger) {
  this.logger.setContext(OrderApiController.name); // `context` on every line
}

async place(body: OrderCreateDto, @AuthUser() actor: User): Promise<OrderPublicDto> {
  const orderId = randomUUID();                     // minted here, so it is logged before any write
  this.logger.assign({ orderId, actor: actor.id }); // request-wide: who, and which order
  // No explicit level call needed here — the framework's "request completed" line carries both fields.
}

async get({ id }: OrderGetPathParams, @AuthUser() actor: User): Promise<OrderPublicDto> {
  this.logger.assign({ orderId: id, actor: actor.id });
  // …
}
```

### Event handlers assign entity ids, the runtime adds `eventId`

Trigger endpoints follow the same shape, with one difference: the incoming `eventId` is added *for* you. Before the handler runs, the runtime's Pub/Sub interceptor has already `assign`ed `eventId` (and `pubSubMessageId`) to the request logger, so the handler only adds its domain fields on top.

```typescript
// domains/ordering/service/src/order/event.controller.ts
async handleOrderForFirestore(event: OrderEvent): Promise<void> {
  // `eventId` / `pubSubMessageId` are already on the logger (set by the interceptor).
  this.logger.assign({ orderId: event.data.id, eventName: event.name });
  await this.orderFirestoreProjectionService.processOrSkipEvent(event);
}
```

This is what makes a delivery traceable end to end: the same `eventId` tags every line the handler emits, and `orderId` ties it back to the HTTP request that produced the event. The same interceptor mechanism supplies the id for other trigger types.

### Cloud Logging output

One process-wide call, before the app boots, switches the Pino output to the shape Google Cloud Logging expects:

```typescript
// domains/ordering/service/src/index.ts
updatePinoConfiguration(googlePinoConfiguration);
```

`googlePinoConfiguration` maps Pino levels to Cloud Logging `severity`, tags errors with the Error Reporting `@type` (so thrown errors surface there), and redacts sensitive headers. The runtime's base config already sets `serviceContext` (service name + version, for Error Reporting) and redacts the `authorization` header.

### Responsibility summary

Who sets each field:

| Field | Set by | Where |
| --- | --- | --- |
| `context` | the class, once | `setContext(ClassName.name)` in the constructor |
| `severity`, `serviceContext` | the runtime config | `updatePinoConfiguration` at startup |
| `eventId`, `pubSubMessageId` | the runtime interceptor | automatically, per incoming event |
| `actor`, `orderId`, `customer`, `bookId`, `eventName`, … | your handler | `assign(…)` at the boundary and individual logs |

## Gotchas

- **`setContext` is *not* request-wide.** It labels the emitting instance (the `context` field) and nothing more. It is `assign` that carries per-request data. The two are complementary: set the context once, assign per request.
- **`eventId` is automatic — never assign it by hand.** The event interceptor sets it as soon as the event is parsed, uniformly across every trigger type. Handlers add only their domain fields, so correlation is consistent service-wide.
- **Log the id, not the whole user.** Here the actor is logged as `actor.id`, keeping arbitrary token claims out of the logs. In real codebases a *typed* user object — a curated application shape, not the raw decoded JWT — is often logged whole for richer debugging. The rule is to control what the type exposes, never to dump unbounded claims.
- **Assign fields you will actually query.** An assigned field earns its place by being a filter, a correlation key, or the basis of a metric. `actor` + entity id + `eventName` cover all three. Individual log lines can add one-off fields.
- **Don't `assign` the same field twice.** For speed, Pino serializes a child's bindings once and appends them, so a second `assign` of a key does not overwrite the first — the raw line carries the key twice (`"orderId":"A","orderId":"B"`). Cloud Logging then collapses the duplicate by *concatenating* the two values into one field, which silently ends up a garbled join of both rather than either id. This bites inside a transaction lambda: `runner.run` re-executes its callback on a retry (contention/abort), so an `assign` *within* the callback re-adds the field on every attempt. Assign once, at the boundary — before opening the transaction, as the controllers here do.

## In this repository

- **Cloud Logging configuration** (process-wide, before boot) —
  [index.ts](../domains/ordering/service/src/index.ts) (`updatePinoConfiguration`).
- **Controller enrichment** (context in the constructor, `actor` + entity ids per handler) —
  [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- **Event-handler enrichment** (domain fields on top of the runtime's automatic `eventId`) —
  [order/event.controller.ts](../domains/ordering/service/src/order/event.controller.ts),
  [catalog/event.controller.ts](../domains/ordering/service/src/catalog/event.controller.ts).

The boundaries doing the enrichment are the same ones described in the
[Controller / Service / Manager split](service-layering.md).
