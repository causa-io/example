// Shared test helpers for the order feature.
//
// `.test.ts` (like `make.test.ts` / `expect.test.ts`) marks a helper module,
// not a spec: jest only runs `*.spec.ts`, and these are excluded from coverage.

import { SpannerOutboxTransactionRunner } from '@causa/runtime-google';
import type { AppFixture } from '@causa/runtime/nestjs/testing';
import { Order } from '../model/generated.js';
import { makeOrderEvent } from '../model/make.test.js';
import { OrderManager } from './manager.js';

/**
 * Seeds orders into Spanner through the real write path.
 *
 * Rather than inserting the `Order` rows directly, this processes a generic
 * order event with {@link OrderManager}, so `updateState` runs — writing each
 * order *and* maintaining its companion `OrderBook` index rows, exactly as a
 * real placement would. A direct `SpannerEntityManager.insert` of the `Order`
 * alone would leave that index empty. (`processEvent` only updates state; it
 * does not emit an event, so seeding stays quiet on the outbox.)
 *
 * @param fixture The app fixture to resolve providers from.
 * @param orders The orders to seed (each is stored as given — `createdAt`,
 *   `lines`, etc. are preserved).
 */
export async function insertOrders(
  fixture: AppFixture,
  orders: Order[],
): Promise<void> {
  const manager = fixture.get(OrderManager);

  await fixture.get(SpannerOutboxTransactionRunner).run(async (transaction) => {
    for (const data of orders) {
      await manager.processEvent(makeOrderEvent({ data }), { transaction });
    }
  });
}
