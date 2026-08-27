// The HTTP surface for `ordering`'s own order-event triggers.
//
// All routing is supplied by the generated `@AsOrdersEventsController()`
// decorator, so there is no hand-written `@Controller` / `@Post` / `@EventBody`
// here — keeping the routes in lockstep with the triggers declared in
// `service/causa.yaml`.

import { toNull, TryMap } from '@causa/runtime';
import { Logger } from '@causa/runtime/nestjs';
import { NotImplementedException } from '@nestjs/common';
import {
  AsOrdersEventsController,
  type OrdersEventsContract,
} from '../api/orders.events.controller.js';
// `ReviewReminderTask` is a value import (not `type`): `@TryMap` decorates
// `sendReviewReminder`, so `emitDecoratorMetadata` records the parameter type,
// and the Cloud Tasks interceptor reads it back to parse + validate the body. A
// type-only import would erase to `Object` and the body would fail validation.
import {
  OrderEvent,
  OrderStatus,
  ReviewReminderTask,
} from '../model/generated.js';
import {
  InvalidOrderStatusError,
  OrderNotFoundError,
  ReviewReminderAlreadySentError,
} from './errors.js';
import { OrderFirestoreProjectionService } from './firestore-projection.service.js';
import { ReviewReminderSchedulingService } from './review-reminder-scheduling.service.js';
import { ReviewReminderService } from './review-reminder.service.js';

/**
 * Handles order events pushed back to `ordering` by its own topic.
 *
 * `@AsOrdersEventsController()` is generated from the order triggers in
 * `service/causa.yaml`. For each method it applies `@Controller('orders')` +
 * `@Post(<trigger>)`, `@HttpCode(200)`, `@UseEventHandler(...)`, and
 * `@EventBody()` on the first parameter.
 *
 * Implementing `OrdersEventsContract` keeps this class in sync with the
 * triggers: rename or remove a trigger and the type stops compiling.
 */
@AsOrdersEventsController()
export class OrderEventController implements OrdersEventsContract {
  constructor(
    private readonly orderFirestoreProjectionService: OrderFirestoreProjectionService,
    private readonly reviewReminderSchedulingService: ReviewReminderSchedulingService,
    private readonly reviewReminderService: ReviewReminderService,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(OrderEventController.name);
  }

  async handleOrderForFirestore(event: OrderEvent): Promise<void> {
    // Enrich the event-scoped logger with the domain fields. The Causa
    // runtime's Pub/Sub interceptor has already assigned `eventId` (and
    // `pubSubMessageId`) to this logger, so every line handling this delivery
    // is correlated by the event. We add the order id and event name on top.
    this.logger.assign({ orderId: event.data.id, eventName: event.name });

    // `processOrSkipEvent` upserts the `OrderDocument`, or returns `null` (a
    // no-op) when a newer document already exists. Either way the handler
    // returns 200, so a replayed or out-of-order delivery is acknowledged
    // rather than retried.
    await this.orderFirestoreProjectionService.processOrSkipEvent(event);
  }

  async handleOrderProcessing(): Promise<void> {
    throw new NotImplementedException();
  }

  async expirePendingOrders(): Promise<void> {
    throw new NotImplementedException();
  }

  /**
   * The scheduling half of the review-reminder flow: reacts to `orderConfirmed`
   * by enqueuing a Cloud Tasks task ~7 days out — see
   * `ReviewReminderSchedulingService`. Kept in its own event trigger so it
   * inherits the at-least-once reliability of the event stream.
   *
   * The trigger's subscription filters to `orderConfirmed`, but the handler
   * does not rely on it: a backfill or a misconfigured subscription can deliver
   * *any* order event to this trigger.
   */
  async scheduleReviewReminder(event: OrderEvent): Promise<void> {
    this.logger.assign({ orderId: event.data.id, eventName: event.name });

    if (event.data.status !== OrderStatus.Confirmed) {
      this.logger.info('Order is not confirmed, skipping scheduling.');
      return;
    }

    await this.reviewReminderSchedulingService.schedule(event.data);
  }

  /**
   * Handles a delivered Cloud Tasks task (the delivery half): publishes the
   * review-request email for the order — see `ReviewReminderService`.
   * Unlike the Pub/Sub handlers above, the injected body is the plain
   * {@link ReviewReminderTask} payload, not an event envelope.
   *
   * The service throws a typed error for every "nothing to send" outcome (the
   * order is gone, is no longer completed, or the reminder was already sent).
   * These are expected, not failures. The event-handler interceptor already
   * turns any non-`RetryableError` into a 200 (so the broker does not retry it)
   * — but it logs it as an *error*. So `@TryMap`/`toNull` catches these three
   * first and logs them at info instead, keeping the error stream clean.
   * Only a `RetryableError` (thrown by the runtime, e.g. on a transaction
   * conflict) yields a 5xx and an actual retry, identical to the Pub/Sub
   * interceptor.
   */
  @TryMap(
    // Each side effect is a `function` (not an arrow) so `toNull` can bind
    // `this` to the controller when it runs it. The order id is already on the
    // request logger.
    toNull(OrderNotFoundError, function (this: OrderEventController) {
      this.logger.info('Order no longer exists.');
    }),
    toNull(InvalidOrderStatusError, function (this: OrderEventController) {
      this.logger.info('Order is no longer completed.');
    }),
    toNull(
      ReviewReminderAlreadySentError,
      function (this: OrderEventController) {
        this.logger.info('Review reminder already sent.');
      },
    ),
  )
  async sendReviewReminder(task: ReviewReminderTask): Promise<void> {
    this.logger.assign({ orderId: task.order });
    await this.reviewReminderService.send(task);
  }
}
