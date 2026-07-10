# Testing with `AppFixture` + Google fixtures

Boot the **real** NestJS module against emulated Google Cloud with `AppFixture` + `createGoogleFixtures`, focus on contract-level tests (drive it over HTTP or a Pub/Sub push), and assert the real outcome — persisted state, emitted events, response body — with generated `make` / `expect` helpers. One spec per operation.

## The reason

A Causa service is mostly wiring between the framework, Spanner, Pub/Sub, and the transactional outbox. The interesting behavior — a transaction that rolls back and publishes nothing, an event that is written atomically with its row, an interleaved index that a bare insert would miss, an authorization rule that hides a row behind a 404 — lives in that wiring, not in any one method. Unit tests with mocked collaborators assert that the wiring was *called*; they say nothing about whether it *works*, and they rot on every refactor.

So the service is tested **behaviorally, against the real stack**. Each spec boots the actual module (`ApiModule` or `EventsModule`) with real providers, backed by Google Cloud **emulators** (Spanner, Pub/Sub, Firestore, Identity Platform) rather than mocks. The test drives the entrypoint exactly as a client would and checks what actually happened in the database and on the topic. Nothing between the HTTP boundary and Spanner is stubbed, so the tests survive refactors and catch integration bugs a mocked test cannot.

The cost — the emulators must be running — is paid once by the tooling. The payoff is tests that exercise controller → service → validator → manager → Spanner → outbox as one piece. This is the live counterpart to the [Controller / Service / Manager split](service-layering.md): the layers are described there, exercised here.

## The solution

### `AppFixture` — the app under test

`AppFixture` (from `@causa/runtime/nestjs/testing`) wraps a NestJS application built from one of the service's real root modules and a set of **fixtures** that provision and reset the emulated infrastructure around it.

```typescript
let fixture: AppFixture;

beforeAll(async () => {
  fixture = new AppFixture(ApiModule, {
    fixtures: createGoogleFixtures({
      pubSubTopics: { 'ordering.order.v1': OrderEvent }, // temp topic, captures published events
      spannerTypes: [Order, BookProjection],             // tables created from DDL, truncated per test
    }),
  });
  await fixture.init();                                   // boot the app + all fixtures, once
});

afterEach(() => fixture.clear());                         // reset state between tests
afterAll(() => fixture.delete());                         // close app, drop temp DBs / topics
```

The lifecycle is fixed: **`init()` once** in `beforeAll` (creates the emulated database and topics and boots Nest), **`clear()` in `afterEach`** (truncates the declared tables and drains captured messages so each test starts clean), **`delete()` in `afterAll`** (tears everything down). One app per spec file, reset between tests — not rebuilt.

`fixture` is the handle to everything: `fixture.request` is a [supertest](https://github.com/ladjs/supertest) agent bound to the running app, and `fixture.get(TypeOrToken)` resolves any provider **or fixture** from the container (`SpannerEntityManager`, `PubSubFixture`, `AuthUsersFixture`, …).

### `createGoogleFixtures` — the emulated infrastructure

One call (from `@causa/runtime-google/testing`) returns the whole array of Google fixtures — there is no need to assemble them by hand. It wires the Firebase app, Identity Platform auth users, Firestore, Spanner, Pub/Sub, Cloud Tasks, and Cloud Scheduler, plus the test-only helpers that make assertions possible. It is configured entirely through its options:

| Option | Purpose |
| --- | --- |
| `pubSubTopics` | Map of **production topic name → event class**. Each becomes a temporary emulator topic with a capturing subscription, so published events can be asserted. Declare every topic the code under test publishes to. |
| `spannerTypes` | The entity classes whose tables are created (from the service's DDL) and truncated between tests. |
| `disableSpannerOutbox` | Defaults to `true`: disables background polling, only used in real environments to recover events that failed to publish after the initial commit. |
| `disableAppCheck` | Defaults to `true`: bypasses the App Check guard so requests need only a bearer token. |
| `versionedEntityRunner` | The runner backing the `VersionedEntityFixture` (used by the mutation-assertion helpers below); `null` disables it. |

### Seeding preconditions

State is created through the app's own persistence layer, never by hand-writing emulator rows. The common path is the entity manager with a generated factory:

```typescript
const book = randomUUID();
await fixture.get(SpannerEntityManager).insert(
  makeBookProjection({ id: book, availability: BookAvailability.Available }),
);
```

When a write has **side effects a bare insert would skip** — here the interleaved `OrderBook` index the manager maintains — seed through the manager / event path instead, so those side effects are built too (see [utils.test.ts](../domains/ordering/service/src/order/utils.test.ts) and [Array indexing via custom projection](array-indexing-via-custom-projection.md)).

Authenticated callers come from the Identity Platform emulator via `AuthUsersFixture`, which mints a real signed token:

```typescript
const { user, token } = await fixture.get(AuthUsersFixture).createAuthUserAndToken();
const { token: staffToken } = await fixture.get(AuthUsersFixture)
  .createAuthUserAndToken({ roles: ['staff'] });        // role claims for authz tests
```

### Driving the operation

**HTTP endpoints** are driven with the supertest agent. The token is attached per request, and its absence is a first-class test case:

```typescript
await fixture.request
  .post('/orders')
  .auth(token, { type: 'bearer' })     // the authenticated caller
  .send({ lines: [{ book, quantity: 2 }] })
  .expect(201);

await fixture.request.post('/orders').send({ … }).expect(401);   // no .auth → unauthenticated
```

**Event handlers** are driven by a `PubSubFixture` requester that POSTs a properly-formed Pub/Sub push to the handler's route, exercising interceptor → controller → processor exactly as a real delivery would:

```typescript
const handleBookForProjection = fixture.get(PubSubFixture)
  .makeRequester('/catalog/handleBookForProjection');
await handleBookForProjection(makeBookCreatedEvent());
```

### `make` / `expect` — generated helpers

Both are code-generated from the domain schemas (declared in [causa.typescript.yaml](../causa.typescript.yaml): `typescriptTestObject` → `make.test.ts`, `typescriptTestExpectation` → `expect.test.ts`) and should never be edited manually. They live under `src/model/` with a `.test.ts` suffix, which matters: Jest runs `*.spec.ts` as suites, while `*.test.ts` are helper modules imported by the specs — not run themselves, and excluded from coverage.

- **`make*` factories** build a valid entity or event with sensible random defaults, overridable through a partial: `makeOrderPending({ customer })`, `makeBookProjection({ availability })`, `makeBookCreatedEvent()`.
- **`expect*` helpers** come in three shapes:
  - *State readers* — `expectBookProjection(runner, expected)` reads through a read-only transaction and `toEqual`s against a matcher-filled shape; plus `expect…NotToExist`.
  - *Event assertions* — `expectNoOrderEvent(eventFixture)` proves a rolled-back transaction published nothing on the topic.
  - *Mutation assertions* — the high-level `expectOrderPlacedEvent(fixture, before, updates, { matchesHttpResponse })` delegates to `VersionedEntityFixture.expectMutated`, checking **stored state, emitted event, and HTTP response together** in one call.

```typescript
const { body } = await fixture.request.post('/orders')
  .auth(token, { type: 'bearer' })
  .send({ lines: [{ book, quantity: 2 }] })
  .expect(201);

// One assertion covers the row, the orderPlaced event, and the response body.
await expectOrderPlacedEvent(
  fixture,
  { id: body.id },
  { customer, lines: [{ book, quantity: 2 }] },
  { matchesHttpResponse: { ...body, deletedAt: null, externalReference: null } },
);
```

**`before` and `updates` together are the expected post-state.** The helper asserts the stored (and emitted) entity `toEqual`s `{ …matchers, ...before, <the event's status>, updatedAt: <any Date>, ...updates }`. So `before` pins what should stay the same and `updates` names what the mutation changes — anything *neither* pinned nor updated falls back to a loose matcher (`expect.any(...)`) and is **not** actually checked. That makes the two shapes differ:

- **A creation** (`orderPlaced`) has no prior state, so `before` is just the key (`{ id }`) and every created field goes in `updates` — as above.
- **A transition** (`orderProcessing`, `orderCancelled`) *has* a prior state: pass the **whole prior entity** as `before`, so every property is pinned, and put only the genuine changes in `updates`. For a pure status flip that is `{}` — the helper bakes the new status in itself, so an empty `updates` reads as *"and nothing else changed"*, and a bug that also touched `lines` or `customer` fails.

  The helper can assert the new status without being told because the **event's constraint schema fixes it**: `orderCancelled`'s data satisfies `OrderCancelledConstraint`, whose `status` is `const: cancelled`, and the `typescriptTestExpectation` generator turns that `const` into a precise matcher (`status: OrderStatus.Cancelled`). A field the constraint only *tightens* — rather than fixing to a `const` — yields a **loose** matcher instead, so the test must still pass its exact value: `OrderConfirmedConstraint` constrains `externalReference` to a non-null `string`, so `expectOrderConfirmedEvent` bakes in only `externalReference: expect.any(String)` (it knows the field became non-null, not *which* reference), and a confirmed-order test passes the concrete value in `updates`.

```typescript
// `before` is the full prior order; `{}` updates ⇒ only status + updatedAt may change.
// `status` is asserted for us — it is `const: cancelled` in OrderCancelledConstraint.
await expectOrderCancelledEvent(fixture, order, {}, { matchesHttpResponse: { …body } });

// Contrast a confirmation: `externalReference` is only tightened to non-null in the
// constraint (loose matcher), so the exact value is passed in `updates`.
await expectOrderConfirmedEvent(fixture, order, { externalReference: 'ext-ref-123' });
```

### One spec per operation

Specs are colocated with the code under test and named for the entrypoint: `api.controller.<operation>.spec.ts` beside the controller (`api.controller.place.spec.ts`, `.get.spec.ts`, `.list.spec.ts`), and `event.controller.<subject>.spec.ts` for event handlers. The outer `describe` is the controller class; a nested `describe` names the route. Splitting per operation keeps each file focused on one request path and its edge cases rather than growing one monolithic suite.

## Gotchas

- **The emulators must already be running.** A spec assumes Spanner / Pub/Sub / Firestore / Auth are up (see the header note in [event.controller.book.spec.ts](../domains/ordering/service/src/catalog/event.controller.book.spec.ts)), it does not start them. In this workspace the Causa CLI owns their lifecycle (`cs emulators start`, then `cs test`). Emulator hosts and the project/instance/database names are supplied as environment variables in [.env](../domains/ordering/service/.env), loaded by `dotenv/config`.
- **Declare every topic you publish to.** A topic missing from `pubSubTopics` is not captured, so its events can't be asserted (and, depending on wiring, the publish can fail). The map is also how `expect…Event` knows which subscription to read.
- **Seed through the manager when side effects matter.** `SpannerEntityManager.insert` writes only the row. Anything the manager does on top — an interleaved companion index, a derived column — is skipped, so tests that read via that index must seed through the manager / event path instead.
- **In a mutation assertion, pin the prior state — don't under-specify `before`.** `before` and `updates` are the expected post-state; whatever neither names is matched loosely and goes unchecked, so a too-thin `before` (e.g. just `{ id }`) silently stops verifying every other column. For a *transition*, pass the **full prior entity** as `before` and only the real changes as `updates` — the assertion then proves the mutation changed *nothing else*. Only a *creation*, which has no prior state, uses a key-only `before`.
- **`{}` updates only holds when the constraint fixes every changed field to a `const`.** The helper auto-asserts a changed field only where the event's constraint pins it to a `const` (like `status`); a field the constraint merely *tightens* (e.g. `externalReference` to non-null) gets a loose `expect.any(...)` matcher, so its exact value must still be passed in `updates` or the assertion won't catch a wrong one.
- **`SpannerFixture` copies the real DDL.** The emulated database is built from the service's declared schema (`SPANNER_DATABASE`), so a table missing from `spannerTypes` is simply never truncated between tests — a source of cross-test bleed if you forget to list it.
- **State resets, the app does not.** `clear()` (afterEach) resets data only; the Nest app and its providers are booted once per file in `beforeAll`. Anything cached in a provider's constructor persists across a file's tests.

## In this repository

The `ordering` service:

- The specs, one per operation (the full stack under test) — [api.controller.place.spec.ts](../domains/ordering/service/src/order/api.controller.place.spec.ts), [api.controller.get.spec.ts](../domains/ordering/service/src/order/api.controller.get.spec.ts), [api.controller.list.spec.ts](../domains/ordering/service/src/order/api.controller.list.spec.ts), and the projection event handler [event.controller.book.spec.ts](../domains/ordering/service/src/catalog/event.controller.book.spec.ts).
- The modules booted under test — [api.module.ts](../domains/ordering/service/src/api.module.ts), [events.module.ts](../domains/ordering/service/src/events.module.ts).
- Seeding through the manager (to build the interleaved index) — [utils.test.ts](../domains/ordering/service/src/order/utils.test.ts).
- Test-runner and emulator configuration — [jest.config.mjs](../domains/ordering/service/jest.config.mjs), [.env](../domains/ordering/service/.env), [package.json](../domains/ordering/service/package.json) (the `test` script).
