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
import { Order, OrderEvent } from '../model/generated.js';
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
}
