# Cloud Tasks trigger

Run deferred work through a Causa **`type: task`** trigger, backed by a **Cloud Tasks queue**. The task is scheduled from a separate event trigger (because creating a task happens **outside** the transactional outbox) and its handler is made idempotent (because Cloud Tasks delivers **at least once**, just like a Pub/Sub push).

## The reason

Some work should happen *later*, at a specific time tied to one entity: email a customer 7 days after their order completes, or expire a one-time token an hour after it is issued. Cloud Tasks is the queue for that — you enqueue a task with a `scheduleTime`, and it POSTs the payload back to your service at (roughly) that time, retrying until it gets a `2xx`.

The naive ways to defer work are worse:

- **`setTimeout` / an in-process timer** dies with the instance. Cloud Run scales to zero; the timer never fires.
- **Enqueuing inside the write transaction** looks atomic but isn't: Cloud Tasks is *not* part of the [transactional outbox](simple-projection.md), so a crash between the commit and the enqueue loses the task, and a crash between the enqueue and the commit schedules work for a state that never happened.

Causa's answer is to split the concern in two, and lean on delivery guarantees at each half:

- **Schedule from an event.** The enqueue reacts to a domain *event* (`orderConfirmed`), which is delivered at least once off the outbox. A failed enqueue just makes Pub/Sub redeliver the event and try again — so the task is scheduled *at least once*.
- **Make the handler idempotent.** Because the task is delivered at least once — exactly like a Pub/Sub push — the handler must tolerate running twice. This is the *same* idempotency any at-least-once processing needs (usually a read-before-write against Spanner state).

## The two triggers

The pattern is two triggers working together — one to schedule, one to handle — declared side by side in the service's `causa.yaml`:

| Trigger | `type:` | Backing resource | Body injected | Its job |
| --- | --- | --- | --- | --- |
| `scheduleReviewReminder` | `event` | Pub/Sub push subscription (filtered to `orderConfirmed`) | the `OrderEvent` envelope | enqueue the task, 7 days out |
| `sendReviewReminder` | `task` | Cloud Tasks queue | a plain `ReviewReminderTask` payload | idempotently send the reminder |

Keeping scheduling in its *own* event trigger — rather than enqueuing inside the transaction that confirms the order — is the reliability argument: task creation cannot join the outbox, so it rides the at-least-once `orderConfirmed` event instead, the durable signal that a reminder is owed.

## The solution

Five pieces, all but the queue itself from `@causa/runtime-google`: the two trigger declarations, a *scheduling service* (enqueue), an *idempotent handler* (deliver), and a *marker table* for de-duplication.

### 1. Declare the task trigger

A Cloud Tasks trigger is `type: task` with a `queue` and — unlike an `event` trigger — an explicit `dto`, because its payload is a plain command, not an entity-event envelope:

```yaml
# service/causa.yaml
serviceContainer:
  triggers:
    sendReviewReminder:
      type: task
      queue: ordering-review-reminder      # the Cloud Tasks queue the infra module provisions
      dto: ../tasks/review-reminder.yaml   # types the handler's `@EventBody()` payload
      endpoint:
        type: http
        path: /orders/sendReviewReminder
```

`cs model genCode` turns this into the same generated `@AsOrdersEventsController()` decorator as any other trigger — but for a task it emits `@UseEventHandler('google.cloudTasks')` (the `CLOUD_TASKS_EVENT_HANDLER_ID`) and types the `@EventBody()` param as the `dto` class. So the handler receives the **plain payload**, not an event:

```typescript
// src/order/event.controller.ts
async sendReviewReminder(task: ReviewReminderTask): Promise<void> {
  this.logger.assign({ orderId: task.order });
  await this.reviewReminderService.send(task);
}
```

Two bits of wiring make that decorator work — mirroring the Pub/Sub setup already in the service:

- **`CloudTasksModule.forRoot()`** in [`base.module.ts`](../domains/ordering/service/src/base.module.ts) provides the `CloudTasksScheduler` (used to enqueue, below).
- **`CloudTasksEventHandlerInterceptor.withOptions({ isDefault: false })`** registered as an `APP_INTERCEPTOR` in [`events.module.ts`](../domains/ordering/service/src/events.module.ts) parses the delivered task (its headers + JSON body). `isDefault: false` means it runs only on the routes whose generated decorator opts in via `@UseEventHandler('google.cloudTasks')`.

Because the payload lives under `tasks/` (not `events/`), that folder is added to the model-class generator's globs in [`causa.typescript.yaml`](../causa.typescript.yaml) so a class is emitted for it.

### 2. Schedule from the event

The `scheduleReviewReminder` event handler reacts to `orderConfirmed` and delegates to a scheduling service. The trigger's subscription is *filtered* to `orderConfirmed`, but the handler re-checks the state anyway — a backfill or a misconfigured subscription can deliver any order event to the trigger, so a handler should never assume its filter:

```typescript
// src/order/event.controller.ts
async scheduleReviewReminder(event: OrderEvent): Promise<void> {
  if (event.data.status !== OrderStatus.Confirmed) {
    return; // not confirmed — nothing to schedule
  }
  await this.reviewReminderSchedulingService.schedule(event.data);
}
```

The scheduling service's only job is to enqueue one task:

```typescript
// src/order/review-reminder-scheduling.service.ts
constructor(private readonly scheduler: CloudTasksScheduler, /* … */) {
  // Resolves the env var TASKS_QUEUE_ORDERING_REVIEW_REMINDER, injected by the
  // infra module.
  this.queue = scheduler.getQueuePath('ordering-review-reminder');
}

async schedule(order: Order): Promise<void> {
  const body: JsonSerializationOf<ReviewReminderTask> = { order: order.id };
  // `schedule` takes an absolute Date, not a delay: 7 days after confirmation.
  const scheduleTime = new Date(order.updatedAt.getTime() + REVIEW_REMINDER_DELAY);
  await this.scheduler.schedule(this.queue, scheduleTime, {
    url: 'https://cloudtasks.googleapis.com', // placeholder; the queue rewrites host + path
    body,
  });
}
```

The payload carries only the order id: the handler re-reads everything else at delivery time, so nothing captured here can go stale over the 7-day wait. The `url` is a placeholder because the queue's `uri_override` (set by the infra module) pins the real Cloud Run host and the `/orders/sendReviewReminder` path, and its OIDC token authenticates the push.

### 3. Handle idempotently, publishing through the outbox

The delivered task runs in a single outbox transaction. The service reads the order through its owning `OrderService`, checks the state itself, and signals every *nothing-to-send* outcome by **throwing** a typed error. On the happy path it writes the marker **and** publishes the email together:

```typescript
// src/order/review-reminder.service.ts
await this.runner.run(options, async (transaction) => {
  // (1) Load through the owning service, in this transaction. `get` throws
  //     OrderNotFoundError for a missing or soft-deleted order.
  const order = await this.orderService.get(task.order, { transaction });
  // The reminder is only due for a completed order.
  if (order.status !== OrderStatus.Confirmed) {
    throw new InvalidOrderStatusError(order.status);
  }

  // (2) De-duplicate: a replayed delivery finds the marker already present.
  if (await transaction.get(ReviewReminder, { id: order.id })) {
    throw new ReviewReminderAlreadySentError(order.id);
  }

  // (3) Marker + email, atomic through the outbox: both commit, or neither does.
  const sentAt = transaction.timestamp;
  await transaction.set(new ReviewReminder({ id: order.id, sentAt }));
  await transaction.publish(
    'ordering.review-request.v1',
    new ReviewRequestEvent({
      id: randomUUID(),
      producedAt: sentAt,
      name: ReviewRequestEventName.ReviewRequested,
      data: new ReviewRequest({ order: order.id, customer: order.customer }),
    }),
  );
});
```

These `nothing-to-send` errors are *expected*, not failures — so the point of catching them is **log hygiene**, not retry control. The event-handler interceptor (the same one the Pub/Sub handlers use) already returns a 200 for any non-`RetryableError`, so an uncaught one is acknowledged, not retried — but it logs it as an *error*. `@TryMap` catches the three expected ones first and `toNull` swallows them with an info log, keeping the error stream clean. It is the same `@TryMap` the API controllers use, except the cases *swallow* the error instead of mapping it to an error DTO. Only a `RetryableError` (thrown by the runtime, e.g. on a transaction conflict) becomes a 5xx that the broker actually retries:

```typescript
// src/order/event.controller.ts
@TryMap(
  // `toNull` swallows the error → the handler returns 200 with an info log (not
  // an error one). The side effect is a `function` (not an arrow) so `@TryMap`
  // can bind `this` to the controller.
  toNull(OrderNotFoundError, function (this: OrderEventController) {
    this.logger.info('Order no longer exists.');
  }),
  toNull(InvalidOrderStatusError, function (this: OrderEventController) {
    this.logger.info('Order is no longer completed.');
  }),
  toNull(ReviewReminderAlreadySentError, function (this: OrderEventController) {
    this.logger.info('Review reminder already sent.');
  }),
)
async sendReviewReminder(task: ReviewReminderTask): Promise<void> {
  this.logger.assign({ orderId: task.order });
  await this.reviewReminderService.send(task);
}
```

The **marker table** is a minimal internal table under `spanner/` — one row per order, keyed by the order id — with a row-deletion policy for retention:

```sql
-- spanner/0006-create-review-reminder-table.sql
CREATE TABLE ReviewReminder (
  id STRING(36) NOT NULL,     -- the order id
  sentAt TIMESTAMP NOT NULL,
) PRIMARY KEY (id),
ROW DELETION POLICY (OLDER_THAN(sentAt, INTERVAL 7 DAY))
```

**A dedicated marker table is only one way to de-duplicate, and often not the best.** It is needed *here* because the task's whole effect is a bare publication — there is no first-class state whose change would itself be idempotent. When a task instead *mutates* an entity (confirm a payment, flip a status, set a field), that state change already carries the idempotency: a read-before-write, a versioned processor, or an optimistic `updatedAt` check makes a second delivery a no-op — the meaningful state *is* the marker, and no dummy table is introduced. Reach for a marker table only when, as with a fire-and-forget notification, there is genuinely no state to key on.

The **email** is mocked by a Pub/Sub publication: `ordering.review-request.v1` is a *plain* event — no `causa.entityEvent`, and its `data` is a plain payload rather than a versioned entity — but it keeps the standard `id` / `producedAt` / `name` / `data` envelope every topic in the backend uses. It is published on the outbox transaction with `transaction.publish(topic, event)`. An unmodelled notification service consumes it and sends the actual email. Publishing it *inside* the transaction is what ties the "email was requested" side effect to the "marker written" fact: a replay can never send a second email.

### 4. The infrastructure is generated

No hand-written Terraform: the [service infrastructure](service-infrastructure.md) module provisions the queue, its retry config, the `uri_override` + OIDC token, the enqueuer / `serviceAccountUser` / `run.invoker` IAM, and the `TASKS_QUEUE_ORDERING_REVIEW_REMINDER` env var — all from the `type: task` trigger, when the event-handler twin sets `enable_triggers = true` and `set_tasks_permissions = true`.

## Gotchas

- **Schedule from the event, never from the write.** Cloud Tasks is not in the outbox, so enqueuing inside the order-confirming transaction gives no atomicity. Reacting to the reliable `orderConfirmed` event makes the *scheduling* retriable; the idempotent handler makes the *effect* exactly-once. The two guarantees compose — neither alone is enough.
- **Don't trust the subscription filter.** A `google.pubSub.filter` narrows what the trigger *normally* receives, but a backfill may replay the whole topic through the handler, and filters get misconfigured. Re-check the state in the handler (here, `event.data.status === Confirmed`) so an unexpected event is skipped, not acted on.
- **At-least-once means the handler must be idempotent** — the same requirement as any Pub/Sub handler, unrelated to the outbox. *Prefer* keying on meaningful state the task already changes (a read-before-write, a versioned processor, an `updatedAt` check); introduce a dedicated marker row only when the effect has no state of its own to key on (as here, a bare publication).
- **The task DTO is a payload, not an event.** It has no `id` / `producedAt` / `name` envelope and no `causa.entityEvent`; it lives under `tasks/`, and that glob must be added to the model-class generator or no class is emitted.
- **Keep the payload thin, re-read at delivery.** Seven days is long enough for the order to be cancelled, deleted, or otherwise moved on. Carrying only the id and re-reading forces the state guard and avoids acting on a stale snapshot.
- **When you do use a marker, its retention must outlast the retry window.** The row is what suppresses duplicates, so its row-deletion policy (7 days) must comfortably exceed how long the queue might keep retrying/redelivering a task (minutes to hours).

## In this repository

**The two trigger declarations:**

- `scheduleReviewReminder` (event) + `sendReviewReminder` (task), and the `ordering.review-request.v1` output topic —
  [service/causa.yaml](../domains/ordering/service/causa.yaml).

**The schemas:**

- The task payload (plain DTO, under `tasks/`) —
  [review-reminder.yaml](../domains/ordering/tasks/review-reminder.yaml).
- The de-duplication marker table + its DDL —
  [review-reminder.yaml](../domains/ordering/spanner/review-reminder.yaml),
  [0006-create-review-reminder-table.sql](../domains/ordering/spanner/0006-create-review-reminder-table.sql).
- The plain email event published through the outbox (standard envelope, plain `data`) —
  [review-request/v1.yaml](../domains/ordering/events/review-request/v1.yaml).

**The code:**

- The two handlers (thin controller methods) —
  [event.controller.ts](../domains/ordering/service/src/order/event.controller.ts).
- The scheduler (enqueue via `CloudTasksScheduler`) —
  [review-reminder-scheduling.service.ts](../domains/ordering/service/src/order/review-reminder-scheduling.service.ts).
- The idempotent sender (state guard + marker + transactional publish) —
  [review-reminder.service.ts](../domains/ordering/service/src/order/review-reminder.service.ts).
- Wiring: `CloudTasksModule.forRoot()` —
  [base.module.ts](../domains/ordering/service/src/base.module.ts);
  the Cloud Tasks interceptor —
  [events.module.ts](../domains/ordering/service/src/events.module.ts);
  the two services as domain providers —
  [order/module.ts](../domains/ordering/service/src/order/module.ts), imported by the event handler's
  [order/event.module.ts](../domains/ordering/service/src/order/event.module.ts).
- The task DTO added to the code generator —
  [causa.typescript.yaml](../causa.typescript.yaml).

**The infrastructure:**

- The Cloud Run event-handler twin that turns the trigger into a real queue + IAM (`enable_triggers`, `set_tasks_permissions`) — the [service infrastructure](service-infrastructure.md) pattern,
  [service.tf](../domains/ordering/infrastructure/service.tf).

**The behaviour, as tests (enqueue with a mocked scheduler; deliver + de-duplicate + state-guard):**

- [event.controller.review-reminder.spec.ts](../domains/ordering/service/src/order/event.controller.review-reminder.spec.ts).
