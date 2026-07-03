# Open / closed enum

How to model an enumerated value in a Causa schema, and why a write DTO should use a **closed** enum even when the stored
property is **open**.

## The two shapes

Causa offers two ways to model "one of a set of string values", with opposite trade-offs.

**Closed enum** — `oneOf` + `$ref` to an enum defined under `$defs` (or a shared file):

```yaml
availability:
  oneOf:
    - $ref: "#/$defs/BookAvailability"

$defs:
  BookAvailability:
    type: string
    enum: [available, outOfStock, discontinued]
```

The generated TypeScript is a strict `enum`, and validation **rejects** any value outside the set. Adding a value is a **breaking change** for any consumer that exhaustively switches on it.

**Open enum** — a plain `type: string` annotated with `causa.enumHint`:

```yaml
genre:
  type: string
  causa:
    enumHint: "#/$defs/BookGenre"
```

The hint is **advisory only**: the value stays a plain string (e.g. generated as `string | BookGenre` in TypeScript), and validation **accepts** unknown values. Adding a value is **not** a breaking change — the hint just documents the values known today.

## The reason

Some enumerated sets are **expected to grow**: new genres, categories, or types get added over the life of the system. Modelling such a set as an **open** enum makes that growth a non-event — adding a value is not a breaking change, and no consumer has to be redeployed in lockstep.

The trade-off is a contract with consumers: an open enum warns them that, while they may treat the values they know specially, they **must also handle unknown values** — ignore them, or fall back to generic behavior — because a value they have never seen can legitimately appear.

At any point in time, though, the enum still names the set of **known** values, so writers must not be free to invent their own. A client creating or updating an entity has to pick from the current set — which is why the write/command DTO uses the **closed** form, rejecting an unknown value with a `400` at validation before any handler runs. The set grows only through a deliberate schema change, never through arbitrary client input.

In short: **open** so the set can grow without breaking readers, **closed** on the write path so clients cannot invent values.

## The solution

Model the field three times, deliberately:

| Where | Shape | Why |
| --- | --- | --- |
| Entity (stored) | open (`enumHint`) | the set is expected to grow; don't reject values added later |
| Write DTO (create / update) | closed (`oneOf` + `$ref`) | clients must stay within the currently-known set |
| Read DTO (public) | open (`enumHint`) | consumers must tolerate values added in later versions |

All three point at the **same** `$defs` enum, so the "known subset" is declared once. The write DTO consumes it as a hard constraint; the entity and read DTO consume it as a hint.

### When to close both sides instead

If the set is a genuine **state machine that is not expected to change** — and where an added value would break business logic anyway — use a closed enum everywhere. There is no tolerance to gain, and closing it turns "impossible state" into a compile/validation error. `Order.status` and `Book.availability` are modelled this way.

### Event names: open root, closed per-event

Event schemas apply the same idea on a different axis. The generic event's `name` is an **open** `enumHint`, so publishing a new event type does not break existing consumers (a projection consumes every event regardless of name).

## In this repository

**The open/closed split — `Book.genre`:**

- Stored open — [book.yaml](../domains/catalog/entities/book.yaml) (`genre`
  property + the `BookGenre` `$defs` enum).
- Written closed —
  [book-create.dto.yaml](../domains/catalog/api/dtos/book-create.dto.yaml) and
  [book-update.dto.yaml](../domains/catalog/api/dtos/book-update.dto.yaml)
  (`genre` via `oneOf` + `$ref` to `BookGenre`).
- Read open —
  [book-public.dto.yaml](../domains/catalog/api/dtos/book-public.dto.yaml)
  (`genre` via `enumHint`).
- Persisted as a plain string —
  [0002-create-book-table.sql](../domains/catalog/spanner/0002-create-book-table.sql)
  (`genre STRING(MAX)`).

**Closed on both sides (state machines):**

- `Book.availability` — [book.yaml](../domains/catalog/entities/book.yaml).
- `Order.status` — [order.yaml](../domains/ordering/entities/order.yaml).
- `BookProjection.availability` reuses the catalogue's closed enum across domains
  via a cross-file `$ref` —
  [book-projection.yaml](../domains/ordering/spanner/book-projection.yaml).

**Event names:**

- [catalog/events/book/v1.yaml](../domains/catalog/events/book/v1.yaml).
- [ordering/events/order/v1.yaml](../domains/ordering/events/order/v1.yaml).
