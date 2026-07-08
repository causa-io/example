# Service error / error DTO split

Internal, typed service errors are thrown by the layers that own the logic; a thin mapping at the controller boundary turns each one into a **public error DTO** (`statusCode` + `errorCode` + `message`, plus optional data). The service layer never knows about HTTP.

## The reason

An error has two audiences. Inside the service, an error is a *typed value*: "this book is unavailable", carrying the offending book IDs — something the code that raised it, and the tests around it, can match on by class. On the wire, the same error is an *HTTP response*: a status code, a stable machine-readable `errorCode`, a human message, and whatever payload the client needs to react.

Conflating the two couples every layer to the transport. If the manager throws a `NotFoundException`, then the manager — and the service, and the validator — all depend on `@nestjs/common`, and none of them can be unit-tested without an HTTP stack. Worse, the public contract (what status, what code, what body) ends up scattered across `throw` sites deep in the call tree, where it is invisible to the API spec.

Also, depending on the HTTP endpoint (controller), the same business error may surface as a different HTTP error (an "entity not found" error may be a `404` when calling `GET /entities/:id`, but a `400` when calling `POST /otherKindOfEntities` while referencing a non-existent entity).

The split keeps each audience in its own place:

- **The service, manager, and validator throw plain typed errors** — `Error` subclasses with no HTTP concern. They are transport-agnostic and testable in isolation, and can be reused from any entrypoint (an HTTP request or a triggered event).
- **The controller boundary maps** each typed error to a public error DTO, declaratively, in one small file per entity. The public contract lives at the boundary, next to the route it belongs to, and mirrors the OpenAPI spec.

This is the error half of the [Controller / Service / Manager split](service-layering.md). Entity → DTO mapping is its read-shape counterpart.

## The solution

Three tiers, wired together at the controller.

### 1. Typed service errors

A plain `Error` subclass, thrown by the layer that owns the rule. No status code, no `@nestjs/common` import. When the public response needs extra data, the error carries it as typed `readonly` fields, so the mapper can copy it across.

```typescript
// catalog/errors.ts — thrown by BookProjectionService.validateAvailable
export class BookNotFoundError extends Error {
  constructor(readonly books: string[]) {           // the offending IDs, typed
    super(`The following books do not exist: ${books.join(', ')}.`);
  }
}
```

Errors live **with the code that raises them**: `OrderNotFoundError` beside the order manager (`order/errors.ts`), the book errors beside the projection service that reads the catalogue (`catalog/errors.ts`), and a service-wide `ForbiddenError` at the service root (`errors.ts`) because more than one feature raises it.

### 2. The public error DTO

Modelled as JSON-schema YAML and code-generated into a TypeScript class. Every error DTO carries the same three fields — `statusCode` (an integer `const`), `errorCode` (a string `const`, namespaced `ordering.<camelCase>`), and `message` — plus any extra payload. `additionalProperties: false`, all fields `required`.

```yaml
# api/dtos/book-not-found-error.dto.yaml
title: BookNotFoundErrorDto
properties:
  statusCode: { type: integer, const: 400 }
  errorCode:  { type: string, const: ordering.bookNotFound }
  message:    { type: string }
  books:      # extra data, carried through to the client
    type: array
    items: { type: string, format: uuid }
required: [statusCode, errorCode, message, books]
```

The generator turns the `const`s into literal-typed properties enforced at runtime by `class-validator`, so the code can never emit the wrong status or code:

```typescript
// model/generated.ts (generated — do not edit)
export class BookNotFoundErrorDto {
  @Equals(400) readonly statusCode!: 400;
  @Equals('ordering.bookNotFound') readonly errorCode!: 'ordering.bookNotFound';
  @IsString() readonly message!: string;
  @IsArray() @IsUUID(undefined, { each: true }) readonly books!: string[];
}
```

**Not every error needs a bespoke DTO.** For the common cases (404, 403, 409, request-shape validation) `@causa/runtime` ships ready-made DTO classes (`NotFoundErrorDto`, `ForbiddenErrorDto`, `IncorrectVersionErrorDto`, `ValidationErrorDto`, …), each subclassing an abstract `ErrorDto` and hardcoding its own `statusCode`/`errorCode`. A matching schema exists under [`common/api/dtos/`](../domains/common/api/dtos/) so the OpenAPI documents can `$ref` a consistent shape. The class the controller actually throws comes from the runtime. Define a domain DTO schema only when you need extra payload (like `books`) or a domain-specific `errorCode`.

### 3. The mapping at the boundary

Per-entity `dto.utils.ts` declares one mapper per error, using two combinators from `@causa/runtime/nestjs`:

- **`toDtoType(Error, Dto)`** — instantiate the DTO with no arguments. Use it when the DTO carries nothing beyond status/code/message, i.e. when reusing a shared runtime DTO.
- **`toDto(Error, e => new Dto({...}))`** — build the DTO from the error instance, copying payload fields across. Use it for domain DTOs with extra data.

```typescript
// order/dto.utils.ts
export const orderNotFoundErrorAsDto = toDtoType(OrderNotFoundError, NotFoundErrorDto);
export const forbiddenErrorAsDto     = toDtoType(ForbiddenError, ForbiddenErrorDto);

export const bookNotFoundErrorAsDto = toDto(
  BookNotFoundError,
  ({ books }) => new BookNotFoundErrorDto({
    statusCode: 400, errorCode: 'ordering.bookNotFound',
    message: 'One or more ordered books do not exist.',
    books, // error field → DTO field
  }),
);
```

The mappers are attached to controller methods with the `@TryMap(...)` decorator, which wraps the handler in a try/catch, matches a thrown error against each case *by class*, and rethrows the mapped result:

```typescript
@TryMap(bookNotFoundErrorAsDto, bookUnavailableErrorAsDto)
async place(body: OrderCreateDto, @AuthUser() actor: User): Promise<OrderPublicDto> { … }

@TryMap(orderNotFoundErrorAsDto)
async get({ id }: OrderGetPathParams, @AuthUser() actor: User): Promise<OrderPublicDto> { … }
```

Under the hood the mapped value becomes an `HttpException`: `makeHttpException(dto)` is `new HttpException(dto, dto.statusCode)` — the DTO object *is* the response body, and its `statusCode` field *is* the HTTP status. So `statusCode`/`errorCode` are populated in exactly one of two ways: from the runtime DTO's own hardcoded fields (via `toDtoType`), or from the literal in the `toDto` mapper (which restates the values pinned as `const` in the schema).

### The safety net

An error with no matching `@TryMap` case does not leak: a global exception filter in `@causa/runtime` forwards `HttpException`s and converts anything else into a generic `500 internalServerError`. So a forgotten mapping fails closed (a 500, never a raw stack trace or an internal message) rather than exposing internals.

### Errors in OpenAPI documents

The OpenAPI spec ties it together on the documentation side: each operation's `responses` map `$ref`s the DTO schemas it can return. For example, the place operation's `400` is a `oneOf` of the shared validation DTO plus the two book DTOs (see [order.api.yaml](../domains/ordering/api/order.api.yaml)).

## Gotchas & decisions

- **Where the same error maps is a boundary decision, not a property of the error.** One typed error can map to different DTOs at different endpoints (a plain 404 in one controller, a rich 400-with-payload in another). The mapper file records that choice per entity.
- **Two kinds of validation, two paths.** Request *shape* (types, formats, required fields) is enforced by NestJS's `ValidationPipe` from the generated DTO decorators and surfaces automatically as a `400 invalidInput` — you (almost) never throw it. *State* validation (existence, availability, business invariants) is what the typed errors here are for; see the [Validator service](validator-service.md).
- **`409` is reserved for optimistic-concurrency only.** A business-state conflict (acting on an order in the wrong status) is a `400` with a domain `errorCode`, not a `409` — a stale `updatedAt` is the only thing that yields `409` (the runtime's `IncorrectVersionErrorDto`). See [invalid-order-status-error.dto.yaml](../domains/ordering/api/dtos/invalid-order-status-error.dto.yaml).
- **`toDto` restates values already pinned in the schema.** The `statusCode`/`errorCode` literals in the mapper duplicate the schema `const`s. `toDtoType` avoids the duplication but only works when there is no payload to copy.

## In this repository

The `ordering` service:

- Typed service errors — [order/errors.ts](../domains/ordering/service/src/order/errors.ts) (`OrderNotFoundError`), [catalog/errors.ts](../domains/ordering/service/src/catalog/errors.ts) (`BookNotFoundError` / `BookUnavailableError`, carrying book IDs), [errors.ts](../domains/ordering/service/src/errors.ts) (service-wide `ForbiddenError`).
- Where they are thrown — [manager.ts](../domains/ordering/service/src/order/manager.ts) (`throwNotFoundError` override), [authorization.service.ts](../domains/ordering/service/src/order/authorization.service.ts), [book-projection.service.ts](../domains/ordering/service/src/catalog/book-projection.service.ts) (`validateAvailable`).
- The domain error DTO schemas — [book-not-found-error.dto.yaml](../domains/ordering/api/dtos/book-not-found-error.dto.yaml), [book-unavailable-error.dto.yaml](../domains/ordering/api/dtos/book-unavailable-error.dto.yaml), [invalid-order-status-error.dto.yaml](../domains/ordering/api/dtos/invalid-order-status-error.dto.yaml).
- The shared error DTO schemas (referenced by the OpenAPI specs; the classes come from `@causa/runtime`) — [common/api/dtos/](../domains/common/api/dtos/).
- The mappers and their `@TryMap` application — [order/dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts), [order/api.controller.ts](../domains/ordering/service/src/order/api.controller.ts).
- The OpenAPI `responses` wiring — [order.api.yaml](../domains/ordering/api/order.api.yaml).
- The mapped responses under test (unknown / unavailable book → `400` with `errorCode` + `books` and no event; hidden / missing order → `404`) — [api.controller.place.spec.ts](../domains/ordering/service/src/order/api.controller.place.spec.ts), [api.controller.get.spec.ts](../domains/ordering/service/src/order/api.controller.get.spec.ts).
