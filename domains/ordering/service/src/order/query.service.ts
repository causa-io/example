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
import { Order, OrderBookIndex } from '../model/generated.js';
import { OrderPageQuery } from './types.js';

/**
 * The index used for the customer-scoped listing.
 * Declared in `domains/ordering/spanner/0004-add-orders-by-customer-index.sql`,
 * its key is `(customer, createdAt DESC, id)` — exactly the filter and sort
 * this query uses.
 */
const ORDERS_BY_CUSTOMER_INDEX = 'OrdersByCustomer';

/**
 * The index used for the book-scoped listing.
 * Declared in `domains/ordering/spanner/0005-create-order-book-index.sql` on
 * the companion `OrderBook` table, its key is `(book, createdAt DESC, id)` —
 * the filter and sort of `listByBook`.
 */
const ORDER_BOOKS_BY_BOOK_INDEX = 'OrderBooksByBook';

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

  /**
   * Lists every order containing a given book, across all customers, most
   * recent first, one page at a time.
   * This backs the staff-only `GET /orders?book=…`.
   *
   * The books of an order live in the `lines` JSON array, which Spanner cannot
   * seek into. The read therefore goes through the companion `OrderBook` index
   * (one row per (order, book), maintained by `OrderManager`): it seeks that
   * table by `book` and joins back to `Order` for the payload.
   * The keyset cursor and ordering are served entirely by the index:
   * `OrderBook` denormalizes the order's `createdAt`, so no `Order` column is
   * needed to sort the page.
   *
   * Identical pagination to {@link OrderQueryService.listByCustomer} (same
   * `(createdAt, id)` cursor), just seeded from a different index.
   *
   * Unlike `listByCustomer`, the query carries no `deletedAt IS NULL`: a
   * soft-deleted order has no `OrderBook` rows to join to. `OrderManager` keeps
   * the index in sync on every write, and on a delete the parent REPLACE
   * cascade-deletes the interleaved rows while its `deletedAt` guard skips
   * re-inserting them — so a deleted order is already unreachable through this
   * index, with no read-side filter needed.
   *
   * @param book The book every returned order must contain.
   * @param query The paginated query (optional limit + optional cursor).
   * @param options The read options (e.g. a transaction to read within).
   * @returns A page of orders plus the query for the next page.
   */
  async listByBook(
    book: string,
    query: OrderPageQuery,
    options: SpannerReadOnlyStateTransactionOption = {},
  ): Promise<Page<Order, OrderPageQuery>> {
    const queryWithLimit = query.withLimits();

    const items = await this.runner.entityManager.query(
      {
        transaction: options.transaction?.spannerTransaction,
        entityType: Order,
      },
      {
        // Select the joined `Order` columns (aliased `o`), so rows hydrate into
        // `Order` instances exactly as the customer listing does.
        sql: `
          SELECT
            ${this.runner.entityManager.sqlColumns(Order, { alias: 'o' })}
          FROM
            ${this.runner.entityManager.sqlTable(OrderBookIndex, {
              index: ORDER_BOOKS_BY_BOOK_INDEX,
            })} AS ob
          JOIN ${this.runner.entityManager.sqlTable(Order)} AS o
            ON o.id = ob.id
          WHERE
            ob.book = @book
            AND (
              ob.createdAt < @readAfterCreatedAt
              OR (ob.createdAt = @readAfterCreatedAt AND ob.id > @readAfterId)
            )
          ORDER BY
            ob.createdAt DESC,
            ob.id
          LIMIT
            @limit`,
        params: {
          book,
          readAfterCreatedAt:
            query.readAfter?.createdAt ?? new Date('9999-12-31T23:59:59.999Z'),
          readAfterId: query.readAfter?.id ?? '',
          limit: queryWithLimit.limit,
        },
      },
    );

    return new Page(items, queryWithLimit, ({ createdAt, id }) => ({
      createdAt,
      id,
    }));
  }
}
