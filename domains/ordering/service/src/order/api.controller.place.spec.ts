// Controller-level tests for placing an order (`POST /orders`).
//
// These boot the real public API (`ApiModule`) against emulated Google Cloud
// via `AppFixture` + `createGoogleFixtures`, then drive the endpoint over HTTP
// with a bearer token minted by `AuthUsersFixture`.
// The whole stack runs (controller → service → validator → manager → Spanner +
// outbox), so the tests assert real behavior: the stored order, the emitted
// event, and the mapped error responses.
//
// The service is tested primarily at the controller level: one file per
// operation, exercising the full request path rather than each provider in
// isolation.

import { SpannerEntityManager } from '@causa/runtime-google';
import {
  AuthUsersFixture,
  createGoogleFixtures,
  PubSubFixture,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { randomUUID } from 'crypto';
import 'jest-extended';
import { ApiModule } from '../api.module.js';
import {
  expectNoOrderEvent,
  expectOrderPlacedEvent,
} from '../model/expect.test.js';
import {
  BookAvailability,
  BookProjection,
  Order,
  OrderEvent,
} from '../model/generated.js';
import { makeBookProjection } from '../model/make.test.js';

describe('OrderApiController', () => {
  let fixture: AppFixture;

  let token: string;
  let customer: string;

  beforeAll(async () => {
    fixture = new AppFixture(ApiModule, {
      // The `ordering.order.v1` topic is created in the emulator so published
      // events can be asserted; the listed tables are truncated between tests.
      fixtures: createGoogleFixtures({
        pubSubTopics: { 'ordering.order.v1': OrderEvent },
        spannerTypes: [Order, BookProjection],
      }),
    });

    await fixture.init();

    // A plain (non-staff) customer.
    ({
      user: { id: customer },
      token,
    } = await fixture.get(AuthUsersFixture).createAuthUserAndToken());
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('POST /orders', () => {
    it('should reject an unauthenticated request', async () => {
      await fixture.request
        .post('/orders')
        .send({ lines: [{ book: randomUUID(), quantity: 1 }] })
        .expect(401);
    });

    it('should place a pending order and emit orderPlaced', async () => {
      const book = randomUUID();
      await fixture.get(SpannerEntityManager).insert(
        makeBookProjection({
          id: book,
          availability: BookAvailability.Available,
        }),
      );

      const { body } = await fixture.request
        .post('/orders')
        .auth(token, { type: 'bearer' })
        .send({ lines: [{ book, quantity: 2 }] })
        .expect(201);

      expect(body).not.toHaveProperty('externalReference');
      expect(body).not.toHaveProperty('deletedAt');
      await expectOrderPlacedEvent(
        fixture,
        { id: body.id },
        { customer, lines: [{ book, quantity: 2 }] },
        {
          matchesHttpResponse: {
            ...body,
            // Adding back the internal columns that are not returned.
            deletedAt: null,
            externalReference: null,
          },
        },
      );
    });

    it('should merge lines for the same book, summing their quantities', async () => {
      const book = randomUUID();
      const otherBook = randomUUID();
      await fixture.get(SpannerEntityManager).insert([
        makeBookProjection({
          id: book,
          availability: BookAvailability.Available,
        }),
        makeBookProjection({
          id: otherBook,
          availability: BookAvailability.Available,
        }),
      ]);

      const { body } = await fixture.request
        .post('/orders')
        .auth(token, { type: 'bearer' })
        .send({
          lines: [
            { book, quantity: 2 },
            { book: otherBook, quantity: 1 },
            { book, quantity: 3 },
          ],
        })
        .expect(201);

      const lines = [
        { book, quantity: 5 },
        { book: otherBook, quantity: 1 },
      ];
      await expectOrderPlacedEvent(
        fixture,
        { id: body.id },
        { customer, lines },
        {
          matchesHttpResponse: {
            ...body,
            deletedAt: null,
            externalReference: null,
          },
        },
      );
    });

    it('should reject an order with no lines', async () => {
      // `lines: []` passes shape validation (an array is present), so it
      // reaches the validator's own value check, which rejects it.
      await fixture.request
        .post('/orders')
        .auth(token, { type: 'bearer' })
        .send({ lines: [] })
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 400,
            errorCode: 'invalidInput',
            fields: ['lines'],
          }),
        );

      await expectNoOrderEvent(fixture.get(PubSubFixture));
    });

    it('should reject an order for a book that does not exist', async () => {
      const book = randomUUID();

      await fixture.request
        .post('/orders')
        .auth(token, { type: 'bearer' })
        .send({ lines: [{ book, quantity: 1 }] })
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 400,
            errorCode: 'ordering.bookNotFound',
            books: [book],
          }),
        );

      // The transaction rolled back: no event was published.
      await expectNoOrderEvent(fixture.get(PubSubFixture));
    });

    it('should reject an order for a book that cannot be ordered', async () => {
      const book = randomUUID();
      await fixture.get(SpannerEntityManager).insert(
        makeBookProjection({
          id: book,
          availability: BookAvailability.OutOfStock,
        }),
      );

      await fixture.request
        .post('/orders')
        .auth(token, { type: 'bearer' })
        .send({ lines: [{ book, quantity: 1 }] })
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 400,
            errorCode: 'ordering.bookUnavailable',
            books: [book],
          }),
        );

      await expectNoOrderEvent(fixture.get(PubSubFixture));
    });
  });
});
