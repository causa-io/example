// Orchestrates Ordering's commands, and single-entity reads.
//
// The service layer (business logic / commands): it opens the transaction, runs
// validation against current state, then delegates the actual write + event
// emission to `OrderManager`. It owns the rules of *placing* an order,
// `OrderManager` owns the mechanics of *writing* one.

import {
  type SpannerOutboxTransactionOption,
  SpannerOutboxTransactionRunner,
  type SpannerReadOnlyStateTransactionOption,
} from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  OrderEventName,
  type OrderNotDeleted,
  type OrderPending,
  OrderStatus,
} from '../model/generated.js';
import { OrderManager } from './manager.js';
import type { PlaceOrderData } from './types.js';
import { OrderValidatorService } from './validator.service.js';

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
}
