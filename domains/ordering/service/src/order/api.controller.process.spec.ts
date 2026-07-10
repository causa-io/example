// Controller-level tests for processing an order (`POST /orders/:id/process`).
//
// These boot the real `ApiModule` against the emulators and drive the endpoint
// over HTTP. `process` showcases two patterns exercised end-to-end here:
//   - authorization decided at the controller boundary (staff only), before the
//     transaction opens;
//   - optimistic concurrency (`updatedAt`) and the `pending`-state check run by
//     the service's `validationFn`, both inside the write transaction.

import { SpannerEntityManager } from '@causa/runtime-google';
import {
  AuthUsersFixture,
  createGoogleFixtures,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { randomUUID } from 'crypto';
import 'jest-extended';
import { ApiModule } from '../api.module.js';
import {
  expectOrderNotMutated,
  expectOrderProcessingEvent,
} from '../model/expect.test.js';
import { Order, OrderEvent } from '../model/generated.js';
import { makeOrderPending, makeOrderProcessing } from '../model/make.test.js';

describe('OrderApiController', () => {
  let fixture: AppFixture;

  let customerToken: string;
  let customer: string;
  let staffToken: string;

  beforeAll(async () => {
    fixture = new AppFixture(ApiModule, {
      fixtures: createGoogleFixtures({
        pubSubTopics: { 'ordering.order.v1': OrderEvent },
        spannerTypes: [Order],
      }),
    });

    await fixture.init();

    const auth = fixture.get(AuthUsersFixture);
    ({
      user: { id: customer },
      token: customerToken,
    } = await auth.createAuthUserAndToken());
    ({ token: staffToken } = await auth.createAuthUserAndToken({
      roles: ['staff'],
    }));
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('POST /orders/:id/process', () => {
    it('should reject an unauthenticated request', async () => {
      await fixture.request
        .post(`/orders/${randomUUID()}/process`)
        .query({ updatedAt: new Date().toISOString() })
        .expect(401);
    });

    it('should move a pending order to processing and emit orderProcessing', async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      const { body } = await fixture.request
        .post(`/orders/${order.id}/process`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(staffToken, { type: 'bearer' })
        .expect(200);

      // One assertion covers the stored row, the orderProcessing event, and the
      // response body.
      await expectOrderProcessingEvent(
        fixture,
        // The full order in its previous state, so every property is pinned and
        // the transition is asserted to have changed nothing but the status.
        order,
        // No further changes: the helper already asserts
        // `status == 'processing'` (and the new `updatedAt`).
        {},
        {
          matchesHttpResponse: {
            ...body,
            deletedAt: null,
            externalReference: null,
          },
        },
      );
    });

    it('should reject the owner with 403: they can see their order but only staff may process it', async () => {
      const order = makeOrderPending({ customer });
      await fixture.get(SpannerEntityManager).insert(order);

      // The owner passes the access check (they can see it), then fails the
      // action check (processing is staff-only) → 403.
      await fixture.request
        .post(`/orders/${order.id}/process`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(403);

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it("should hide another customer's order behind a 404, not a 403", async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      // A non-owner, non-staff caller fails the *access* check first, so they
      // get 404 (existence hidden) rather than the 403 the owner receives.
      await fixture.request
        .post(`/orders/${order.id}/process`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(404);

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it('should reject an order that is not pending with 400', async () => {
      const order = makeOrderProcessing();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/process`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(staffToken, { type: 'bearer' })
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 400,
            errorCode: 'ordering.invalidOrderStatus',
          }),
        );

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it('should reject a stale version with 409', async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/process`)
        .query({ updatedAt: new Date('2000-01-01').toISOString() })
        .auth(staffToken, { type: 'bearer' })
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 409,
            errorCode: 'incorrectVersion',
          }),
        );

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it('should return 404 for an unknown order', async () => {
      await fixture.request
        .post(`/orders/${randomUUID()}/process`)
        .query({ updatedAt: new Date().toISOString() })
        .auth(staffToken, { type: 'bearer' })
        .expect(404);
    });
  });
});
