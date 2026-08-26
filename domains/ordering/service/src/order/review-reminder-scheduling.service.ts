// The enqueue side of the Cloud Tasks "review reminder" trigger.
//
// `ordering` wants to email a customer 7 days after an order completes, asking
// them to rate the book. That is deferred work, so it is handed to Cloud Tasks:
// this service creates one task, scheduled 7 days out, that the queue delivers
// back to the `sendReviewReminder` handler.
//
// Crucially, this is called from the `scheduleReviewReminder` *event* handler —
// which reacts to the reliable, at-least-once `orderConfirmed` stream — and not
// from the transaction that confirms the order. Cloud Tasks is not part of the
// transactional outbox, so enqueuing inside the order-confirming commit would
// give no atomicity (a crash between commit and enqueue loses the reminder).
// Reacting to the event instead makes scheduling retriable: a failed enqueue
// simply lets Pub/Sub redeliver `orderConfirmed` and try again — at-least-once
// scheduling. The `sendReviewReminder` handler then makes the *effect*
// exactly-once.

import type { JsonSerializationOf } from '@causa/runtime';
import { CloudTasksScheduler } from '@causa/runtime-google';
import { Logger } from '@causa/runtime/nestjs';
import { Injectable } from '@nestjs/common';
import type { Order, ReviewReminderTask } from '../model/generated.js';

/**
 * How long after an order completes the customer is asked to review it, in
 * milliseconds (7 days).
 */
const REVIEW_REMINDER_DELAY = 7 * 24 * 60 * 60 * 1000;

/**
 * Schedules the deferred "rate your book" reminder as a Cloud Tasks task.
 */
@Injectable()
export class ReviewReminderSchedulingService {
  /**
   * The full path of the queue, resolved from the environment.
   * `null` in a container that is not configured to enqueue (e.g. the public
   * API twin, which never calls {@link schedule}).
   */
  private readonly queue: string | null;

  constructor(
    private readonly scheduler: CloudTasksScheduler,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(ReviewReminderSchedulingService.name);
    // Resolves `TASKS_QUEUE_ORDERING_REVIEW_REMINDER`. The name must match the
    // `queue` of the `sendReviewReminder` trigger in `service/causa.yaml` (the
    // infra module provisions a queue of that name and injects its full path as
    // the `TASKS_QUEUE_ORDERING_REVIEW_REMINDER` environment variable).
    this.queue = scheduler.getQueuePath('ordering-review-reminder');
  }

  /**
   * Enqueues a Cloud Tasks task to send the given order's review reminder ~7
   * days from now.
   *
   * @param order The completed (confirmed) order to remind about.
   */
  async schedule(order: Order): Promise<void> {
    this.logger.info('Scheduling review reminder.');

    if (!this.queue) {
      throw new Error('The review reminder queue is not configured.');
    }

    // The payload only identifies the order; the handler re-reads the order
    // (and its customer) at delivery time, so nothing captured here can go
    // stale over the 7-day wait.
    const body: JsonSerializationOf<ReviewReminderTask> = { order: order.id };

    // `schedule` takes an absolute date, not a relative delay. `updatedAt` is
    // the moment the order became `confirmed`, so the reminder lands 7 days
    // after completion.
    const scheduleTime = new Date(
      order.updatedAt.getTime() + REVIEW_REMINDER_DELAY,
    );

    const { name: taskName } = await this.scheduler.schedule(
      this.queue,
      scheduleTime,
      {
        // A placeholder: the queue's `uri_override` (set by the infra module)
        // pins the real Cloud Run host and the `/orders/sendReviewReminder`
        // path, and its `oidc_token` authenticates the push.
        // The caller supplies neither.
        url: 'https://cloudtasks.googleapis.com',
        body,
      },
    );

    this.logger.info({ taskName }, 'Scheduled review reminder.');
  }
}
