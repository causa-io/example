// Orchestrates Ordering's commands, and single-entity reads.
//
// The service layer (business logic / commands): it opens the transaction, runs
// validation against current state, then delegates the actual write + event
// emission to `OrderManager`. It owns the rules of *placing* an order,
// `OrderManager` owns the mechanics of *writing* one.

import { type VersionedEntityUpdateOptions } from '@causa/runtime';
import {
  type SpannerOutboxTransaction,
  type SpannerOutboxTransactionOption,
  SpannerOutboxTransactionRunner,
  type SpannerReadOnlyStateTransactionOption,
} from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  type Order,
  type OrderCancelled,
  OrderEventName,
  type OrderNotDeleted,
  type OrderPending,
  type OrderProcessing,
  OrderStatus,
} from '../model/generated.js';
import { InvalidOrderStatusError } from './errors.js';
import { OrderManager } from './manager.js';
import type { PlaceOrderData } from './types.js';
import { OrderValidatorService } from './validator.service.js';

/**
 * The options `OrderManager.update` accepts for the `Order` entity, bound to
 * this service's read-write transaction (`transaction`, `checkUpdatedAt`,
 * `validationFn`, …).
 */
type OrderUpdateOptions = VersionedEntityUpdateOptions<
  SpannerOutboxTransaction,
  Order
>;

/**
 * Commands and single-entity reads for orders.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly runner: SpannerOutboxTransactionRunner,
    private readonly manager: OrderManager,
    private readonly validator: OrderValidatorService,
  ) {}

  /**
   * Places a new order in the `pending` status.
   *
   * In a single transaction: validate every line against the catalogue
   * projection, then create the order and emit `orderPlaced` through the
   * outbox.
   * If validation throws, the transaction never commits, so neither a partial
   * order nor an event is produced.
   *
   * @param data The customer and the lines to order.
   * @param options Options for the operation.
   * @returns The newly created, pending order.
   */
  async place(
    data: PlaceOrderData,
    options: SpannerOutboxTransactionOption & {
      /**
       * The `orderId` to assign the order, defaulting to a fresh UUID.
       */
      readonly orderId?: string;
    } = {},
  ): Promise<OrderPending> {
    const id = options.orderId ?? randomUUID();

    // Unlike the single-write commands below (`process` / `cancel`), `place`
    // performs *two* transaction-bound steps — validate the lines, then create
    // the order — that must be atomic. So it cannot just forward
    // `options.transaction` to one manager call: it must ensure a transaction
    // wraps *both*. `runner.run` does exactly that, opening a new transaction
    // when the caller passed none or reusing `options.transaction`.
    return this.runner.run(options, async (transaction) => {
      const { customer, lines } = await this.validator.sanitize(data, {
        transaction,
      });

      const event = await this.manager.create(
        OrderEventName.OrderPlaced,
        {
          // `createdAt` / `updatedAt` / `deletedAt` are stamped by the manager
          // from the transaction timestamp — they are not set here.
          id,
          customer,
          status: OrderStatus.Pending,
          lines,
          externalReference: null,
        },
        { transaction },
      );

      return event.data as OrderPending;
    });
  }

  /**
   * Fetches a single order by ID.
   *
   * Reading one entity by primary key needs no query service: the manager's
   * inherited `get` does it, throwing `OrderNotFoundError` when the order is
   * missing or soft-deleted.
   *
   * @param id The order ID.
   * @param options Options for the operation.
   * @returns The order.
   */
  async get(
    id: string,
    options: SpannerReadOnlyStateTransactionOption = {},
  ): Promise<OrderNotDeleted> {
    return (await this.manager.get({ id }, options)) as OrderNotDeleted;
  }

  /**
   * Moves a pending order to `processing`, emitting `orderProcessing`.
   *
   * The transition is guarded three ways, all inside the write transaction:
   * - *Optimistic concurrency* (`checkUpdatedAt`): the caller's known version
   *   must still be the stored one, or the manager throws
   *   `IncorrectEntityVersionError` (mapped to `409`).
   * - *State* (`validationFn`): the order must still be `pending`, or
   *   {@link InvalidOrderStatusError} is thrown (mapped to `400`).
   * - *Existence*: a missing / soft-deleted order surfaces `OrderNotFoundError`
   *   (`404`) from the manager.
   *
   * `options.checkUpdatedAt` is optional (as is everything in the update
   * options): optimistic concurrency is a concern of the API *caller*, which
   * holds a version to compare (the controller sets it from the request). An
   * internal, event-triggered transition may legitimately move an order with no
   * client version to check, and simply omits it.
   *
   * @param id The order to process.
   * @param options The manager's update options.
   * @returns The order, now processing.
   */
  async process(
    id: string,
    options: OrderUpdateOptions = {},
  ): Promise<OrderProcessing> {
    // A single write, so — unlike `place` — this command opens no transaction
    // of its own. `manager.update` runs in one already: it joins
    // `options.transaction` when the caller passes one (the controller does),
    // and opens its own otherwise.
    // Wrapping it in `runner.run` would only add a redundant nesting level.
    const event = await this.manager.update(
      OrderEventName.OrderProcessing,
      { id },
      { status: OrderStatus.Processing },
      {
        ...options,
        validationFn: async (order, tx) => {
          await options.validationFn?.(order, tx);
          this.assertPending(order);
        },
      },
    );

    return event.data as OrderProcessing;
  }

  /**
   * Cancels a pending order, emitting `orderCancelled`.
   *
   * Same three transactional guards as {@link OrderService.process}
   * (optimistic concurrency, `pending` state, existence). The difference is
   * authorization: cancelling is allowed to the order's *own customer* as well
   * as staff, a decision that depends on the **stored** order — so the caller
   * (the controller) injects it as `options.validationFn`, and this method
   * composes it *before* its own state check. Running authorization first means
   * a caller who may not touch the order learns nothing about its state.
   *
   * The caller's authorization (`validationFn`) and version (`checkUpdatedAt`)
   * travel in `options` — the manager's own update options, forwarded whole —
   * and both are optional, so an internal, event-triggered cancellation can
   * omit either.
   *
   * @param id The order to cancel.
   * @param options The manager's update options.
   * @returns The order, now cancelled.
   */
  async cancel(
    id: string,
    options: OrderUpdateOptions = {},
  ): Promise<OrderCancelled> {
    // Like `process`, a single write: no `runner.run` wrapper.
    // The options are forwarded whole (`...options`). `validationFn` is the one
    // field overridden, to compose the caller's check with the service's own.
    const event = await this.manager.update(
      OrderEventName.OrderCancelled,
      { id },
      { status: OrderStatus.Cancelled },
      {
        ...options,
        validationFn: async (order, tx) => {
          // Caller-supplied authorization first (owner-or-staff), then the
          // service's own state rule.
          await options.validationFn?.(order, tx);
          this.assertPending(order);
        },
      },
    );

    return event.data as OrderCancelled;
  }

  /**
   * Asserts an order is still `pending`, the sole legal prior state for the
   * `process` and `cancel` transitions.
   *
   * @param order The stored order the transition is about to mutate.
   */
  private assertPending(order: Order): asserts order is OrderPending {
    if (order.status !== OrderStatus.Pending) {
      throw new InvalidOrderStatusError(order.status);
    }
  }
}
