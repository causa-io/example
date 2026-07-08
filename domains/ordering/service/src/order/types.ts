// Local types for the Order feature.
//
// Command/query shapes that are not entities or DTOs live here, keeping the
// service and controller files focused on behavior.

import { PageQuery, type WithLimit } from '@causa/runtime/nestjs';
import type { Order } from '../model/generated.js';

/**
 * The data required to place a new {@link Order}.
 */
export type PlaceOrderData = Pick<Order, 'customer' | 'lines'>;

/**
 * The default and maximum page sizes for the order listing.
 */
export const ORDER_LIST_LIMITS = { default: 20, max: 100 } as const;

/**
 * The cursor keying an order-list page: the `(createdAt, id)` of the previous
 * page's last row, which the next page reads after.
 *
 * Orders are listed most recent first, keyed on the *pair* `(createdAt, id)`.
 * `createdAt` alone is not unique (two orders could share a commit timestamp),
 * so `id` breaks ties and makes the ordering total — pages then never overlap
 * or skip a row at their boundary.
 */
export type OrderListReadAfter = {
  readonly createdAt: Date;
  readonly id: string;
};

/**
 * The page query the `OrderQueryService` reads against.
 *
 * This is the "business" side of pagination: a {@link PageQuery} over the order
 * cursor, deliberately free of any HTTP concern. The opaque base64 encoding of
 * the cursor lives only on the HTTP-facing `OrderListQueryDto`.
 */
export class OrderPageQuery extends PageQuery<OrderListReadAfter> {
  /**
   * Returns a copy with `limit` defaulted and capped.
   */
  withLimits(): WithLimit<OrderPageQuery> {
    return this.withLimit(ORDER_LIST_LIMITS);
  }
}
