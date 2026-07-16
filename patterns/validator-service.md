# Validator service

A dedicated injectable that validates a command against **current state** (e.g. the ordered books exist and are available) and throws typed service errors.

## The reason

A command can be perfectly well-formed and still be invalid. Whether an order *can* be placed depends on live state — do the books exist, can they be ordered? — not just on the shape of the request. Those are two different kinds of validation, and Causa keeps them apart:

- **Shape validation** (types, required fields, formats, ranges) is declared on the DTO with `class-validator` decorators generated from the schema, and enforced by NestJS's `ValidationPipe` before the handler runs. The service never sees a malformed body.
- **State and business validation, plus sanitization** (existence, status, invariants such as "an order must have a line") lives in a dedicated service the command calls **inside its transaction**. Most such rules read current state — exactly why they cannot sit on the DTO — but the service also carries the stateless invariants worth enforcing in one place, across every command that touches the data. It is also where the command's data is *sanitized* — normalized or transformed against that state before the write, hence the method name `sanitize`.

Separating this validation into its own service keeps the command orchestration (`service.ts`) readable and makes the rules independently testable. It also allows reusing this logic in multiple commands.

## The solution

A per-entity `@Injectable()` exposing a single `sanitize` method. A few design choices carry the pattern.

**`sanitize` takes a template.** The data is passed as a `Partial` of the entity — the fields the command sets — sanitized, validated, and returned. Typing it generically, `<T extends Partial<Order>>`, means one method serves both a creation and a later partial update: each step is guarded on the field it needs (here, both the merge and the availability lookup run only when `lines` are present), and the caller gets back exactly the type it passed in.

```typescript
@Injectable()
export class OrderValidatorService {
  constructor(private readonly bookProjection: BookProjectionService) {}

  async sanitize<T extends Partial<Order>>(
    data: T,
    options: SpannerReadOnlyStateTransactionOption,
  ): Promise<T> {
    // Value-check failures accumulate across every branch, then throw once.
    const messages: string[] = [];
    const fields = new Set<string>();       // a set: one field, reported once

    const sanitized: Partial<Writable<Order>> = {}; // fields this rewrites

    // Value checks: sanitize, then accumulate — do not throw yet.
    if (data.lines) {
      const lines = this.sanitizeLines(data.lines); // merge duplicate books
      if (lines.length === 0) {
        messages.push('An order must contain at least one line.');
        fields.add('lines');
      }
      sanitized.lines = lines;
    }

    // One throw for every value failure, before any state read.
    if (messages.length > 0) {
      throw new OrderValidationError(messages, [...fields]);
    }

    // State checks: delegated, each throwing its own typed error.
    if (sanitized.lines) {
      await this.bookProjection.validateAvailable(
        sanitized.lines.map((line) => line.book),
        options,
      );
    }

    return { ...data, ...sanitized }; // untouched fields pass through
  }
}
```

**It sanitizes first, then validates the result.** `sanitize` does not only reject — it also *transforms*, which is why it is named `sanitize` and not `validate`. Here duplicate lines are merged: two lines for the same book collapse into one with the summed quantity. Each step writes only the fields it touches into a `sanitized` accumulator (`Partial<Writable<Order>>`), and the method returns `{ ...data, ...sanitized }` — the caller's data with just the rewritten fields overlaid, everything else passing through. A pure-validation rule would `throw` and hand the input back untouched; a sanitizing one returns a cleaned copy.

**The error it throws depends on the kind of check.** A *simple value check* — here, that an order has at least one line — is a stateless rule the validator owns. Such checks **accumulate** — across every branch — into a single `OrderValidationError` (a subclass of the runtime `ValidationError`, carrying the failed `fields` as a set, so one field faulted by two rules is still reported once). It is thrown once, *before* any state read, so the caller learns every value problem together and an already-invalid request costs no catalogue query. They surface to the client as the very same `400 invalidInput` DTO the framework's `ValidationPipe` returns for *shape* errors — value and shape validation are indistinguishable from outside. An *elaborate check* — do books exist and can they be ordered? — needs a read of current state and gets its *own* dedicated typed error (`BookNotFoundError` / `BookUnavailableError`, mapped to a distinct domain response). The rule of thumb: **simple value checks accumulate into one validation error, reference or state checks throw their own.**

**The lookup is delegated, not done here.** The validator states the *rule* — every ordered book must exist and be available — and hands the actual reading to the `BookProjectionService`. That is the service which *maintains* the `BookProjection` from `catalog.book.v1` events, and so it also *owns access to it*: reads against the view live on the service that owns the view, not in a separate lookup service (see [Simple projection](simple-projection.md)). The validator never touches the `BookProjection` table itself. It only knows which service answers "are these books orderable?". The projection service runs the read and raises the typed errors.

**Read inside the write transaction.** `sanitize` receives the caller's transaction and threads it to the lookup. Validation and the write see the same snapshot.

**Read a local projection, not a cross-domain call.** `ordering` does not call the catalogue at request time; it validates against the local `BookProjection` it maintains from `catalog.book.v1` (see [Simple projection](simple-projection.md)). No runtime coupling to another domain.

The command calls `sanitize` as the first step inside its transaction. If it throws, the transaction never commits, so no partial order and no event are produced.

## Gotchas

- **A value check here looks like a generic validation error to the client.** `OrderValidationError` maps to the same `400 invalidInput` DTO as the DTO's `class-validator` failures, deliberately: the caller need not know whether "at least one line" was enforced declaratively on the DTO or in service code. Reserve a *dedicated* error — with its own `errorCode` — for a rule the client must tell apart, such as a missing book (`ordering.bookNotFound`).
- **This is a validation *example*, not robust stock management.** The transaction gives atomicity only within the `ordering` domain. The `BookProjection` it reads is eventually consistent with the catalogue — built from the unordered, at-least-once `catalog.book.v1` stream — so "available" reflects the last event `ordering` has seen, not the catalogue's live truth. Two concurrent orders can both pass validation against the same stock. **If stock were crucial** (an inventory that must never oversell), this synchronous in-transaction check would not be enough. The logic would be more complex and probably asynchronous: a reserve-then-confirm flow coordinated across domains by **choreography** (events), rather than a single transaction. What is shown here is the *shape* of state validation, not a distributed-inventory solution.

## In this repository

- The validator (the `sanitize` template) —
  [validator.service.ts](../domains/ordering/service/src/order/validator.service.ts).
- The delegated catalogue lookup, on the service that owns the projection —
  [book-projection.service.ts](../domains/ordering/service/src/catalog/book-projection.service.ts) (`validateAvailable`).
- Called by the place command, in-transaction —
  [service.ts](../domains/ordering/service/src/order/service.ts).
- The state it reads (the catalogue projection) —
  [book-projection.yaml](../domains/ordering/spanner/book-projection.yaml)
  (built by the [Simple projection](simple-projection.md) pattern).
- The validator's own value-check error — accumulated, then mapped to the shared
  `400 invalidInput` DTO —
  [order/errors.ts](../domains/ordering/service/src/order/errors.ts) (`OrderValidationError`),
  [order/dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts) (`orderValidationErrorAsDto`).
- The delegated reference errors and their DTO mapping —
  [catalog/errors.ts](../domains/ordering/service/src/catalog/errors.ts),
  [order/dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts),
  from [book-not-found-error.dto.yaml](../domains/ordering/api/dtos/book-not-found-error.dto.yaml)
  and [book-unavailable-error.dto.yaml](../domains/ordering/api/dtos/book-unavailable-error.dto.yaml).
- The behavior under test (duplicate lines merged; an empty order → `400 invalidInput`; unknown / unavailable books → `400`, no event) —
  [api.controller.place.spec.ts](../domains/ordering/service/src/order/api.controller.place.spec.ts).
