// Controller-level tests for listing orders (`GET /orders`).
//
// Like the other controller specs, these boot the real public API against the
// emulators and drive the endpoint over HTTP. They focus on the two things the
// pagination pattern must get right:
//   - the page contract: ordering (most recent first), the page size `limit`,
//     and following the opaque `nextPageQuery` cursor to the last page;
//   - the authorization rule: a caller lists their own orders, staff may target
//     any `customer`, and a non-staff caller may not.

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
import {
  makeOrder,
  makeOrderLine,
  makeOrderPending,
} from '../model/make.test.js';

describe('OrderApiController', () => {
  let fixture: AppFixture;

  let customerToken: string;
  let customer: string;
  let staffToken: string;
  let staff: string;

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
    ({
      user: { id: staff },
      token: staffToken,
    } = await auth.createAuthUserAndToken({
      roles: ['staff'],
    }));
  });

  afterEach(() => fixture.clear());

  afterAll(() => fixture.delete());

  describe('GET /orders', () => {
    it('should reject an unauthenticated request', async () => {
      await fixture.request.get('/orders').expect(401);
    });

    it('should forbid a non-staff caller from listing another customer', async () => {
      await fixture.request
        .get('/orders')
        .query({ customer: randomUUID() })
        .auth(customerToken, { type: 'bearer' })
        .expect(403)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 403,
            errorCode: 'forbidden',
          }),
        );
    });

    it('should reject a malformed cursor with 400', async () => {
      await fixture.request
        .get('/orders?readAfter=not-a-valid-cursor')
        .auth(customerToken, { type: 'bearer' })
        .expect(400)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            statusCode: 400,
            errorCode: 'invalidInput',
          }),
        );
    });

    it("should list the caller's own, non-deleted orders, most recent first", async () => {
      const older = makeOrderPending({
        customer,
        createdAt: new Date('2026-02-01'),
        lines: [makeOrderLine({ book: randomUUID(), quantity: 1 })],
      });
      const newer = makeOrderPending({
        customer,
        createdAt: new Date('2026-02-02'),
      });
      // Neither of these belongs in the response — and their later timestamps
      // would put them at the top of the list if they wrongly leaked in.
      const otherCustomer = makeOrderPending({
        createdAt: new Date('2026-02-03'),
      });
      const softDeleted = makeOrder({
        customer,
        createdAt: new Date('2026-02-04'),
        deletedAt: new Date('2026-02-04'),
      });
      await fixture
        .get(SpannerEntityManager)
        .insert([older, newer, otherCustomer, softDeleted]);

      const { body } = await fixture.request
        .get('/orders')
        .auth(customerToken, { type: 'bearer' })
        .expect(200);

      // Only the caller's own live orders, most recent first.
      expect(body.items.map((o: { id: string }) => o.id)).toEqual([
        newer.id,
        older.id,
      ]);
      // Only one page: no cursor.
      expect(body.nextPageQuery).toBeNull();
      // Items are the public DTO — no internal columns.
      expect(body.items[0]).not.toHaveProperty('externalReference');
      expect(body.items[0]).not.toHaveProperty('deletedAt');
    });

    it('should page through results with an opaque cursor, ending on a null nextPageQuery', async () => {
      const orders = [
        new Date('2026-02-01'),
        new Date('2026-02-02'),
        new Date('2026-02-03'),
      ].map((createdAt) => makeOrderPending({ customer, createdAt }));
      await fixture.get(SpannerEntityManager).insert(orders);
      const mostRecentFirst = [orders[2].id, orders[1].id, orders[0].id];

      // First page of two, newest first.
      const first = await fixture.request
        .get('/orders')
        .query({ limit: 2 })
        .auth(customerToken, { type: 'bearer' })
        .expect(200);
      expect(first.body.items.map((o: { id: string }) => o.id)).toEqual(
        mostRecentFirst.slice(0, 2),
      );
      expect(first.body.nextPageQuery).toEqual(expect.any(String));

      // Following the cursor yields the remaining order, then stops.
      const second = await fixture.request
        .get(`/orders${first.body.nextPageQuery}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(200);
      expect(second.body.items.map((o: { id: string }) => o.id)).toEqual(
        mostRecentFirst.slice(2),
      );
      expect(second.body.nextPageQuery).toBeNull();
    });

    it('should keep paging stable when orders share a createdAt (id tie-break)', async () => {
      // Same timestamp, so ordering falls entirely to the `id` tie-breaker
      // (ascending). The page boundary must split the two without skipping or
      // repeating either. Two real UUIDs, sorted so the ordering is known.
      const createdAt = new Date('2026-02-05');
      const [lowerUuid, higherUuid] = [randomUUID(), randomUUID()].sort();
      const lowerId = makeOrderPending({ customer, createdAt, id: lowerUuid });
      const higherId = makeOrderPending({
        customer,
        createdAt,
        id: higherUuid,
      });
      await fixture.get(SpannerEntityManager).insert([lowerId, higherId]);

      const first = await fixture.request
        .get('/orders')
        .query({ limit: 1 })
        .auth(customerToken, { type: 'bearer' })
        .expect(200);
      expect(first.body.items.map((o: { id: string }) => o.id)).toEqual([
        lowerId.id,
      ]);

      const second = await fixture.request
        .get(`/orders${first.body.nextPageQuery}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(200);
      expect(second.body.items.map((o: { id: string }) => o.id)).toEqual([
        higherId.id,
      ]);

      // A page that is exactly `limit` long still carries a cursor: the client
      // learns it has reached the end from the following page coming back
      // empty.
      const third = await fixture.request
        .get(`/orders${second.body.nextPageQuery}`)
        .auth(customerToken, { type: 'bearer' })
        .expect(200);
      expect(third.body).toEqual({ items: [], nextPageQuery: null });
    });

    it("should let staff page through a specific customer's orders", async () => {
      const older = makeOrderPending({
        customer,
        createdAt: new Date('2026-02-01'),
      });
      const newer = makeOrderPending({
        customer,
        createdAt: new Date('2026-02-02'),
      });
      const staffOrder = makeOrderPending({
        customer: staff,
        createdAt: new Date('2026-01-15'),
      });
      await fixture
        .get(SpannerEntityManager)
        .insert([older, newer, staffOrder]);

      const first = await fixture.request
        .get('/orders')
        .query({ customer, limit: 1 })
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
      expect(first.body.items.map((o: { id: string }) => o.id)).toEqual([
        newer.id,
      ]);
      // The cursor carries the `customer` filter, so the next page is scoped.
      expect(first.body.nextPageQuery).toContain(`customer=${customer}`);

      const second = await fixture.request
        .get(`/orders${first.body.nextPageQuery}`)
        .auth(staffToken, { type: 'bearer' })
        .expect(200);
      // The customer's remaining order — not the staff's own.
      expect(second.body.items.map((o: { id: string }) => o.id)).toEqual([
        older.id,
      ]);
    });
  });
});
