// The delivery side of the Cloud Tasks "review reminder" trigger.
//
// Runs when the queue delivers the task scheduled ~7 days earlier by
// `ReviewReminderSchedulingService`. Cloud Tasks is at-least-once, so the queue
// may deliver the same task more than once. This handler must therefore be
// idempotent, and it keeps that logic here in the service — signalling every
// "nothing to send" outcome by *throwing* a typed error, which the event
// controller catches and turns into an acknowledgement (see `event.controller`).
//
// In a single outbox transaction it:
//   1. loads the order through `OrderService.get` (throws `OrderNotFoundError`
//      if it was deleted meanwhile), then checks the status itself — a reminder
//      is only due for a completed (`confirmed`) order, else it throws
//      `InvalidOrderStatusError`;
//   2. throws `ReviewReminderAlreadySentError` if the `ReviewReminder` marker
//      already exists for this order;
//   3. otherwise writes the marker AND publishes `ordering.review-request.v1`.
//
// The publication is the (mocked) email send. An unmodelled notification
// service consumes the topic.

import {
  type SpannerOutboxTransactionOption,
  SpannerOutboxTransactionRunner,
} from '@causa/runtime-google';
import { Logger } from '@causa/runtime/nestjs';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  OrderStatus,
  ReviewReminder,
  type ReviewReminderTask,
  ReviewRequest,
  ReviewRequestEvent,
  ReviewRequestEventName,
} from '../model/generated.js';
import {
  InvalidOrderStatusError,
  ReviewReminderAlreadySentError,
} from './errors.js';
import { OrderService } from './service.js';

/**
 * The topic on which the "please review your order" email request is published.
 * Declared in `service/causa.yaml` `outputs.eventTopics`.
 */
const REVIEW_REQUEST_TOPIC = 'ordering.review-request.v1';

/**
 * Handles a delivered review-reminder task: publishes the reminder email for a
 * still-completed order, exactly once.
 */
@Injectable()
export class ReviewReminderService {
  constructor(
    private readonly runner: SpannerOutboxTransactionRunner,
    private readonly orderService: OrderService,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(ReviewReminderService.name);
  }

  /**
   * Publishes the review-request email for the task's order.
   *
   * @param task The delivered task payload (identifies the order).
   * @param options Options for the operation.
   * @throws {OrderNotFoundError} if the order was deleted since it was
   *   scheduled.
   * @throws {InvalidOrderStatusError} if the order is no longer `confirmed`.
   * @throws {ReviewReminderAlreadySentError} if the reminder was already sent.
   */
  async send(
    task: ReviewReminderTask,
    options: SpannerOutboxTransactionOption = {},
  ): Promise<void> {
    await this.runner.run(options, async (transaction) => {
      const order = await this.orderService.get(task.order, { transaction });
      if (order.status !== OrderStatus.Confirmed) {
        throw new InvalidOrderStatusError(order.status);
      }

      const alreadySent = await transaction.get(ReviewReminder, {
        id: order.id,
      });
      if (alreadySent) {
        throw new ReviewReminderAlreadySentError();
      }

      const sentAt = transaction.timestamp;
      await transaction.set(new ReviewReminder({ id: order.id, sentAt }));
      await transaction.publish(
        REVIEW_REQUEST_TOPIC,
        new ReviewRequestEvent({
          id: randomUUID(),
          producedAt: sentAt,
          name: ReviewRequestEventName.ReviewRequested,
          data: new ReviewRequest({
            order: order.id,
            customer: order.customer,
          }),
        }),
      );

      this.logger.info('Published review-request event.');
    });
  }
}
