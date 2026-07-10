// Behavioral tests for the order Firestore projection handler.
//
// These boot the real `EventsModule` against emulated Google Cloud (Firestore)
// via `AppFixture` + `createGoogleFixtures`, then drive the handler by POSTing
// a Pub/Sub push to its route — exercising the full path: interceptor →
// controller → `VersionedEventProcessor` → Firestore. Running them requires the
// emulators (`FIRESTORE_EMULATOR_HOST`).
//
// `createGoogleFixtures` always sets up an isolated Firestore database and
// clears it between tests.

import { FirestorePubSubTransactionRunner } from '@causa/runtime-google';
import {
  createGoogleFixtures,
  type EventRequester,
  PubSubFixture,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { EventsModule } from '../events.module.js';
import { expectOrderDocument } from '../model/expect.test.js';
import { OrderStatus } from '../model/generated.js';
import {
  makeOrder,
  makeOrderDocument,
  makeOrderEvent,
} from '../model/make.test.js';

describe('OrderEventController', () => {
  let fixture: AppFixture;
  let runner: FirestorePubSubTransactionRunner;

  beforeAll(async () => {
    fixture = new AppFixture(EventsModule, {
      fixtures: createGoogleFixtures(),
    });

    await fixture.init();

    runner = fixture.get(FirestorePubSubTransactionRunner);
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('handleOrderForFirestore', () => {
    let handleOrderForFirestore: EventRequester;

    beforeAll(() => {
      // A helper that POSTs an event to the trigger route as a Pub/Sub push.
      handleOrderForFirestore = fixture
        .get(PubSubFixture)
        .makeRequester('/orders/handleOrderForFirestore');
    });

    it('should write the order document from an order event', async () => {
      const event = makeOrderEvent();

      await handleOrderForFirestore(event);

      // `externalReference` is not asserted (and not passed): `OrderDocument`
      // does not carry it — the projection drops it for the client.
      await expectOrderDocument(runner, {
        id: event.data.id,
        createdAt: event.data.createdAt,
        updatedAt: event.data.updatedAt,
        deletedAt: null,
        customer: event.data.customer,
        status: event.data.status,
        lines: event.data.lines,
      });
    });

    it('should ignore an event older than the stored document', async () => {
      const existing = makeOrderDocument({
        status: OrderStatus.Pending,
        updatedAt: new Date('2025-06-01'),
      });
      await runner.run((transaction) => transaction.set(existing));
      // A replayed / out-of-order event carrying an older version of the order,
      // with a different status to prove the stale write is not applied.
      const event = makeOrderEvent({
        data: makeOrder({
          ...existing,
          status: OrderStatus.Cancelled,
          updatedAt: new Date('2025-01-01'),
        }),
      });

      await handleOrderForFirestore(event);

      await expectOrderDocument(runner, existing);
    });
  });
});
