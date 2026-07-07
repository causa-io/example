// Controller-level tests for reading an order (`GET /orders/:id`).
//
// These boot the real `ApiModule` against the emulators and drive the endpoint
// over HTTP with bearer tokens minted by `AuthUsersFixture`.
// They focus on the read shape and on the authorization rule.

import { SpannerEntityManager } from '@causa/runtime-google';
import {
  AuthUsersFixture,
  createGoogleFixtures,
} from '@causa/runtime-google/testing';
import { AppFixture } from '@causa/runtime/nestjs/testing';
import { randomUUID } from 'crypto';
import 'jest-extended';
import { ApiModule } from '../api.module.js';
import { Order, OrderEvent } from '../model/generated.js';
import { makeOrderLine, makeOrderPending } from '../model/make.test.js';

describe('OrderApiController', () => {
  let fixture: AppFixture;

  let customerToken: string;
  let customer: string;
  let staffToken: string;

  beforeAll(async () => {
    fixture = new AppFixture(ApiModule, {
      fixtures: createGoogleFixtures({
        // The topics to which services publish events during the tests must be
        // declared / mocked here.
        pubSubTopics: { 'ordering.order.v1': OrderEvent },
        // The list of Spanner tables that will be cleared between tests.
        spannerTypes: [Order],
      }),
    });

    await fixture.init();

    // Creates Firebase Auth / Identity Platform users for the emulator.
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

  describe('GET /orders/:id', () => {
    it('should reject an unauthenticated request', async () => {
      await fixture.request.get(`/orders/${randomUUID()}`).expect(401);
    });

    it("should return the customer's own order", async () => {
      const order = makeOrderPending({
        customer,
        lines: [makeOrderLine({ book: randomUUID(), quantity: 3 })],
      });
      await fixture.get(SpannerEntityManager).insert(order);

      const { body } = await fixture.request
        .get(`/orders/${order.id}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(200);

      // Exactly the public DTO — no `externalReference` / `deletedAt`.
      expect(body).toEqual({
        id: order.id,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        customer: order.customer,
        status: order.status,
        lines: order.lines,
      });
    });

    it("should let staff read another customer's order", async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .get(`/orders/${order.id}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
    });

    it("should hide another customer's order behind a 404", async () => {
      const order = makeOrderPending();
      await fixture.get(SpannerEntityManager).insert(order);

      await fixture.request
        .get(`/orders/${order.id}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(404);
    });

    it('should return 404 for an unknown order', async () => {
      await fixture.request
        .get(`/orders/${randomUUID()}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(404);
    });
  });
});
