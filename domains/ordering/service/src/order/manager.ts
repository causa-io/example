// The low-level write + event machinery for `Order`.
//
// `OrderManager` binds the runtime's `VersionedEntityManager` to this domain's
// topic, event, and entity. It is intentionally thin: the base class provides
// `create` / `update` / `delete` / `get`, each of which — in a single Spanner
// transaction — mutates the `Order` row AND appends the matching event to the
// transactional outbox (published on commit). Business orchestration lives in
// `OrderService`. This class only knows how to "write one order + emit one
// event".

import { VersionedEntityManager } from '@causa/runtime';
import {
  SpannerOutboxTransaction,
  SpannerOutboxTransactionRunner,
  SpannerReadOnlyStateTransaction,
} from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { Order, OrderBookIndex, OrderEvent } from '../model/generated.js';
import { OrderNotFoundError } from './errors.js';

/**
 * Manages the `Order` versioned entity: single-entity writes paired with
 * `ordering.order.v1` events through the outbox.
 *
 * The generic parameters bind the manager to this service's transaction stack
 * (Spanner read-write + read-only) and to the `OrderEvent` type. The entity
 * type (`Order`) is the event's payload.
 */
@Injectable()
export class OrderManager extends VersionedEntityManager<
  SpannerOutboxTransaction,
  SpannerReadOnlyStateTransaction,
  OrderEvent,
  SpannerOutboxTransactionRunner
> {
  constructor(runner: SpannerOutboxTransactionRunner) {
    // The topic must match the one declared in `service/causa.yaml`
    // `outputs.eventTopics`.
    super('ordering.order.v1', OrderEvent, Order, runner);
  }

  /**
   * Overrides the base "not found" so a read/update that misses (or hits a
   * soft-deleted row) surfaces the domain's typed error, which the controller
   * maps to a `404`.
   */
  protected throwNotFoundError(): never {
    throw new OrderNotFoundError();
  }

  /**
   * Writes the `Order` row *and* keeps its `OrderBook` index in sync, so the
   * books inside the order stay queryable (see the "array indexing via custom
   * projection" pattern).
   *
   * Every create / update / delete funnels through this one hook, so the index
   * is maintained on all of them, atomically with the order write and its
   * outbox event.
   *
   * The re-write is a full replace, and it leans on Spanner semantics:
   * `super.updateState` writes the order with a REPLACE (delete + insert of the
   * row).
   * Because `OrderBook` is `INTERLEAVE IN PARENT Order ON DELETE CASCADE`, that
   * REPLACE also deletes every existing `OrderBook` row of this order.
   * This method never deletes anything itself, it only (re-)inserts the current
   * set. If the base write ever stopped using REPLACE, stale rows would leak.
   *
   * @param order The order being written (its post-change state).
   * @param transaction The read-write transaction the order write runs in.
   */
  protected async updateState(
    order: Order,
    transaction: SpannerOutboxTransaction,
  ): Promise<void> {
    await super.updateState(order, transaction);

    // A soft-deleted order must vanish from every book listing. The parent
    // REPLACE above already cascade-cleared its rows. Leaving them gone (not
    // re-adding any) is the whole deletion.
    if (order.deletedAt) {
      return;
    }

    // One row per ordered book. `lines` is de-duplicated by book upstream (the
    // validator merges lines referencing the same book), so each yields a
    // distinct `(id, book)` primary key and none collide.
    for (const { book } of order.lines) {
      await transaction.set(
        new OrderBookIndex({ id: order.id, book, createdAt: order.createdAt }),
      );
    }
  }
}
