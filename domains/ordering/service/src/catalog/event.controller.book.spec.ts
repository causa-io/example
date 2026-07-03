// Behavioral tests for the book projection handler.
//
// These boot the real `EventsModule` against emulated Google Cloud (Spanner +
// Pub/Sub) via `AppFixture` + `createGoogleFixtures`, then drive the handler by
// POSTing a Pub/Sub push to its route — exercising the full path: interceptor →
// controller → `VersionedEventProcessor` → Spanner. Running them requires the
// emulators (`SPANNER_INSTANCE`/`SPANNER_DATABASE` + `PUBSUB_EMULATOR_HOST`).

import {
  SpannerEntityManager,
  SpannerOutboxTransactionRunner,
} from '@causa/runtime-google';
import {
  createGoogleFixtures,
  type EventRequester,
  PubSubFixture,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { EventsModule } from '../events.module.js';
import { expectBookProjection } from '../model/expect.test.js';
import { BookProjection } from '../model/generated.js';
import {
  makeBookCreatedEvent,
  makeBookNotDeleted,
  makeBookProjection,
  makeBookUpdatedEvent,
} from '../model/make.test.js';

describe('CatalogEventController', () => {
  let fixture: AppFixture;

  beforeAll(async () => {
    fixture = new AppFixture(EventsModule, {
      // The `BookProjection` table is created (from the service's DDL) and
      // truncated between tests.
      fixtures: createGoogleFixtures({ spannerTypes: [BookProjection] }),
    });

    await fixture.init();
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('handleBookForProjection', () => {
    let handleBookForProjection: EventRequester;

    beforeAll(() => {
      // A helper that POSTs an event to the trigger route as a Pub/Sub push.
      handleBookForProjection = fixture
        .get(PubSubFixture)
        .makeRequester('/catalog/handleBookForProjection');
    });

    it('should create a projection row from a book event', async () => {
      const event = makeBookCreatedEvent();

      await handleBookForProjection(event);

      await expectBookProjection(fixture.get(SpannerOutboxTransactionRunner), {
        id: event.data.id,
        createdAt: event.data.createdAt,
        updatedAt: event.data.updatedAt,
        deletedAt: null,
        title: event.data.title,
        availability: event.data.availability,
      });
    });

    it('should ignore an event older than the stored row', async () => {
      const existing = makeBookProjection({
        updatedAt: new Date('2025-06-01'),
      });
      await fixture.get(SpannerEntityManager).insert(existing);
      // A replayed / out-of-order event carrying an older version of the book.
      const event = makeBookUpdatedEvent({
        data: makeBookNotDeleted({
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: new Date('2025-01-01'),
          title: 'a stale title',
        }),
      });

      await handleBookForProjection(event);

      await expectBookProjection(
        fixture.get(SpannerOutboxTransactionRunner),
        existing,
      );
    });
  });
});
