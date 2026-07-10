// Controller-level tests for cancelling an order (`POST /orders/:id/cancel`).
//
// These boot the real `ApiModule` against the emulators and drive the endpoint
// over HTTP. `cancel` showcases authorization that depends on the *stored*
// order, threaded down as the manager's `validationFn`:
//   - the order's own customer or staff may cancel; anyone else gets a 404 that
//     hides the order's existence;
//   - authorization runs *before* the `pending`-state check, so a non-owner
//     never learns the order's state (a non-owner sees 404, never 400);
//   - optimistic concurrency (`updatedAt`) still guards the mutation.

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
  expectOrderCancelledEvent,
  expectOrderNotMutated,
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

  describe('POST /orders/:id/cancel', () => {
    it('should reject an unauthenticated request', async () => {
      await fixture.request
        .post(`/orders/${randomUUID()}/cancel`)
        .query({ updatedAt: new Date().toISOString() })
        .expect(401);
    });

    it("should let the order's customer cancel their pending order and emit orderCancelled", async () => {
      const order = makeOrderPending({ customer });
      await fixture.get(SpannerEntityManager).insert(order);

      const { body } = await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(200);

      await expectOrderCancelledEvent(
        fixture,
        // The full order in the previous state, ensuring no other property
        // changed.
        order,
        // The `status == 'cancelled'` check is already in the
        // `expectOrderCancelledEvent` helper, and no other property changed.
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

    it("should let staff cancel another customer's pending order", async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(staffToken, { type: 'bearer' })
        .expect(200);

      await expectOrderCancelledEvent(fixture, order, {});
    });

    it("should hide another customer's order behind a 404", async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(404);

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it('should answer a non-owner with 404 even when the order is not pending (authorization runs before the state check)', async () => {
      const order = makeOrderProcessing();
      await fixture.get(SpannerEntityManager).insert(order);

      // A non-owner gets 404 (existence hidden), never the 400 that would
      // reveal the order is in a non-cancellable state.
      await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(404);

      await expectOrderNotMutated(fixture, order, { expectNoEvent: true });
    });

    it('should reject cancelling an order that is not pending with 400', async () => {
      const order = makeOrderProcessing({ customer });
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: order.updatedAt.toISOString() })
        .auth(customerToken, { type: 'bearer' })
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
      const order = makeOrderPending({ customer });
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .post(`/orders/${order.id}/cancel`)
        .query({ updatedAt: new Date('2000-01-01').toISOString() })
        .auth(customerToken, { type: 'bearer' })
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
        .post(`/orders/${randomUUID()}/cancel`)
        .query({ updatedAt: new Date().toISOString() })
        .auth(customerToken, { type: 'bearer' })
        .expect(404);
    });
  });
});
