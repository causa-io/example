// Read-side order queries that return more than one row or use non-trivial
// indexing.
//
// Single-entity reads by primary key stay on `OrderService` (via the manager's
// `get`). The moment a read returns a *list*, it needs pagination, ordering and
// a hand-written SQL query — a different enough concern that it gets its own
// service.

import {
  SpannerOutboxTransactionRunner,
  type SpannerReadOnlyStateTransactionOption,
} from '@causa/runtime-google';
import { Page } from '@causa/runtime/nestjs';
import { Injectable } from '@nestjs/common';
import { Order } from '../model/generated.js';
import { OrderPageQuery } from './types.js';

/**
 * The index used for the customer-scoped listing.
 * Declared in `domains/ordering/spanner/0004-add-orders-by-customer-index.sql`,
 * its key is `(customer, createdAt DESC, id)` — exactly the filter and sort
 * this query uses.
 */
const ORDERS_BY_CUSTOMER_INDEX = 'OrdersByCustomer';

/**
 * Queries for orders.
 */
@Injectable()
export class OrderQueryService {
  constructor(private readonly runner: SpannerOutboxTransactionRunner) {}

  /**
   * Lists a customer's orders, most recent first, one page at a time.
   *
   * Keyset (token) pagination: the page is an ordered range scan that starts
   * immediately after the previous page's last row. The cursor is the
   * `(createdAt, id)` of that row, carried opaquely in `query.readAfter`.
   *
   * The page size is defaulted and capped here (`withLimits`), so no caller can
   * make one request scan unbounded rows.
   *
   * @param customer The customer whose orders to list.
   * @param query The paginated query (optional limit + optional cursor).
   * @param options The read options (e.g. a transaction to read within).
   * @returns A page of orders plus the query for the next page.
   */
  async listByCustomer(
    customer: string,
    query: OrderPageQuery,
    options: SpannerReadOnlyStateTransactionOption = {},
  ): Promise<Page<Order, OrderPageQuery>> {
    const queryWithLimit = query.withLimits();

    const items = await this.runner.entityManager.query(
      {
        // Reading through the caller's transaction (when given) keeps the list
        // consistent with the rest of their read-only snapshot.
        transaction: options.transaction?.spannerTransaction,
        // Hydrate rows into `Order` instances (parses the `lines` JSON, etc.).
        entityType: Order,
      },
      {
        sql: `
          SELECT
            ${this.runner.entityManager.sqlColumns(Order)}
          FROM
            ${this.runner.entityManager.sqlTable(Order, {
              index: ORDERS_BY_CUSTOMER_INDEX,
            })}
          WHERE
            customer = @customer
            AND deletedAt IS NULL
            -- Keyset predicate: "strictly after the cursor" in the scan's order
            -- (createdAt descending, then id ascending).
            AND (
              createdAt < @readAfterCreatedAt
              OR (createdAt = @readAfterCreatedAt AND id > @readAfterId)
            )
          ORDER BY
            createdAt DESC,
            id
          LIMIT
            @limit`,
        params: {
          customer,
          // On the first page there is no cursor, so seed one that sorts before
          // every row.
          readAfterCreatedAt:
            query.readAfter?.createdAt ?? new Date('9999-12-31T23:59:59.999Z'),
          readAfterId: query.readAfter?.id ?? '',
          limit: queryWithLimit.limit,
        },
      },
    );

    // `Page` derives `nextPageQuery` from the last item's cursor, but only when
    // the page came back full (`items.length === limit`); a short page is the
    // last one, and `nextPageQuery` is null.
    return new Page(items, queryWithLimit, ({ createdAt, id }) => ({
      createdAt,
      id,
    }));
  }
}
