// Behavioral tests for the two halves of the review-reminder Cloud Tasks flow,
// both handled by `OrderEventController` on the internal event-handler service.
//
// These boot the real `EventsModule` against emulated Google Cloud (Spanner +
// Pub/Sub) via `AppFixture` + `createGoogleFixtures`, then drive each handler
// by POSTing to its route:
//   - `scheduleReviewReminder` — a Pub/Sub push (via `PubSubFixture`). The
//     Cloud Tasks *enqueue* is mocked (there is no local Cloud Tasks emulator),
//     so the test asserts the scheduler was called with the right queue, time,
//     and payload.
//   - `sendReviewReminder` — a Cloud Tasks push (via `CloudTasksFixture`). The
//     full path runs (interceptor → controller → outbox transaction → Spanner +
//     Pub/Sub), so the test asserts the real marker row and published email
//     event, and the idempotency / state guards that suppress them.

import {
  CloudTasksScheduler,
  SpannerEntityManager,
  SpannerOutboxTransactionRunner,
} from '@causa/runtime-google';
import {
  type CloudTasksEventRequester,
  CloudTasksFixture,
  createGoogleFixtures,
  type EventRequester,
  PubSubFixture,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';
import 'jest-extended';
import { EventsModule } from '../events.module.js';
import {
  expectNoReviewRequestEvent,
  expectReviewReminder,
  expectReviewReminderNotToExist,
  expectReviewRequestEvent,
} from '../model/expect.test.js';
import {
  Order,
  ReviewReminder,
  ReviewRequestEvent,
} from '../model/generated.js';
import {
  makeOrderConfirmed,
  makeOrderConfirmedEvent,
  makeOrderPending,
  makeOrderPlacedEvent,
  makeReviewReminder,
  makeReviewRequest,
} from '../model/make.test.js';

const REVIEW_REMINDER_DELAY = 7 * 24 * 60 * 60 * 1000;

describe('OrderEventController (review reminder)', () => {
  let fixture: AppFixture;
  let runner: SpannerOutboxTransactionRunner;

  beforeAll(async () => {
    fixture = new AppFixture(EventsModule, {
      fixtures: createGoogleFixtures({
        pubSubTopics: { 'ordering.review-request.v1': ReviewRequestEvent },
        spannerTypes: [Order, ReviewReminder],
      }),
    });

    await fixture.init();

    runner = fixture.get(SpannerOutboxTransactionRunner);
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('scheduleReviewReminder', () => {
    let scheduleReviewReminder: EventRequester;
    let scheduler: CloudTasksScheduler;

    beforeAll(() => {
      scheduleReviewReminder = fixture
        .get(PubSubFixture)
        .makeRequester('/orders/scheduleReviewReminder');
      // No Cloud Tasks emulator: spy on the enqueue and assert the arguments.
      scheduler = fixture.app.get(CloudTasksScheduler);
      jest
        .spyOn(scheduler, 'schedule')
        .mockResolvedValue({ name: randomUUID() });
    });

    it('should enqueue a review-reminder task 7 days out for a confirmed order', async () => {
      const event = makeOrderConfirmedEvent();

      await scheduleReviewReminder(event);

      const expectedScheduleTime = new Date(
        event.data.updatedAt.getTime() + REVIEW_REMINDER_DELAY,
      );
      expect(scheduler.schedule).toHaveBeenCalledExactlyOnceWith(
        process.env.TASKS_QUEUE_ORDERING_REVIEW_REMINDER,
        expectedScheduleTime,
        {
          url: 'https://cloudtasks.googleapis.com',
          body: { order: event.data.id },
        },
      );
    });

    it('should not schedule a reminder for an order that is not confirmed', async () => {
      const event = makeOrderPlacedEvent();

      await scheduleReviewReminder(event);

      expect(scheduler.schedule).not.toHaveBeenCalled();
    });
  });

  describe('sendReviewReminder', () => {
    let sendReviewReminder: CloudTasksEventRequester;

    beforeAll(() => {
      sendReviewReminder = fixture
        .get(CloudTasksFixture)
        .makeRequester('/orders/sendReviewReminder');
    });

    it('should mark the reminder sent and publish the email for a confirmed order', async () => {
      const order = makeOrderConfirmed();
      await fixture.get(SpannerEntityManager).insert(order);

      await sendReviewReminder({ order: order.id });

      const actual = await expectReviewReminder(runner, { id: order.id });
      await expectReviewRequestEvent(fixture.get(PubSubFixture), {
        producedAt: actual.sentAt,
        data: makeReviewRequest({ order: order.id, customer: order.customer }),
      });
    });

    it('should not publish a second email when the reminder was already sent', async () => {
      const order = makeOrderConfirmed();
      const existingReminder = makeReviewReminder({ id: order.id });
      await fixture.get(SpannerEntityManager).insert([order, existingReminder]);

      await sendReviewReminder({ order: order.id });

      await expectReviewReminder(runner, existingReminder);
      await expectNoReviewRequestEvent(fixture.get(PubSubFixture));
    });

    it('should do nothing for an order that is no longer confirmed', async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await sendReviewReminder({ order: order.id });

      await expectReviewReminderNotToExist(runner, { id: order.id });
      await expectNoReviewRequestEvent(fixture.get(PubSubFixture));
    });

    it('should do nothing for an order that no longer exists', async () => {
      await sendReviewReminder({ order: randomUUID() });

      await expectNoReviewRequestEvent(fixture.get(PubSubFixture));
    });
  });
});
