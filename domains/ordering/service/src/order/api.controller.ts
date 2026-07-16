// The public HTTP surface for orders.
//
// Thin by design: routing and status codes come from the generated
// `@AsOrderApiController()` decorator (built from the OpenAPI spec), so there
// are no hand-written `@Post` / `@Get` / `@Body` here. Every method just wires
// the request to the layer that does the work, then maps the result — or a
// thrown domain error, via `@TryMap` — to a public DTO. `implements
// OrderApiContract` keeps this class in lockstep with the spec: change an
// operation there and this stops compiling.

import { TryMap, type User } from '@causa/runtime';
import { SpannerOutboxTransactionRunner } from '@causa/runtime-google';
import { AuthUser, Logger, Page } from '@causa/runtime/nestjs';
import { randomUUID } from 'crypto';
import {
  OrderCancelPathParams,
  OrderCancelQueryParams,
  OrderGetPathParams,
  OrderListQueryParams,
  OrderProcessPathParams,
  OrderProcessQueryParams,
} from '../api/model.js';
import {
  AsOrderApiController,
  type OrderApiContract,
} from '../api/order.api.controller.js';
import {
  Order,
  OrderCreateDto,
  OrderListDto,
  OrderPublicDto,
} from '../model/generated.js';
import { OrderAuthorizationService } from './authorization.service.js';
import {
  bookNotFoundErrorAsDto,
  bookUnavailableErrorAsDto,
  forbiddenErrorAsDto,
  incorrectVersionErrorAsDto,
  invalidOrderStatusErrorAsDto,
  orderNotFoundErrorAsDto,
  orderValidationErrorAsDto,
  toOrderPublicDto,
} from './dto.utils.js';
import { OrderListQueryDto } from './list-query.dto.js';
import { OrderQueryService } from './query.service.js';
import { OrderService } from './service.js';
import { ORDER_LIST_LIMITS, OrderPageQuery } from './types.js';

/**
 * Handles the `/orders` HTTP API.
 */
@AsOrderApiController()
export class OrderApiController implements OrderApiContract {
  constructor(
    private readonly runner: SpannerOutboxTransactionRunner,
    private readonly service: OrderService,
    private readonly queryService: OrderQueryService,
    private readonly authorizationService: OrderAuthorizationService,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(OrderApiController.name);
  }

  @TryMap(
    orderValidationErrorAsDto,
    bookNotFoundErrorAsDto,
    bookUnavailableErrorAsDto,
  )
  async place(
    body: OrderCreateDto,
    @AuthUser() actor: User,
  ): Promise<OrderPublicDto> {
    // Mint the order ID here, so it is logged (and traceable) before any write,
    // and hand it to the service, which uses it rather than generating its own.
    const orderId = randomUUID();
    // Enrich the request-scoped logger. `assign` binds these fields to *this*
    // request's logger, so every line emitted while handling it — including the
    // framework's automatic "request completed" line — carries them. They
    // become structured columns to filter and build log-based metrics on in
    // Cloud Logging: `actor` (who made the call) and `orderId` (which order it
    // created).
    this.logger.assign({ orderId, actor: actor.id });

    // The controller opens the transaction and tags it for observability.
    // Other options could be set on the transaction here, such as event
    // attributes applying to all events (e.g. the actor ID).
    const order = await this.runner.run({ tag: 'orderPlace' }, (transaction) =>
      this.service.place(
        { customer: actor.id, lines: body.lines },
        { orderId, transaction },
      ),
    );
    return toOrderPublicDto(order);
  }

  @TryMap(orderNotFoundErrorAsDto)
  async get(
    { id }: OrderGetPathParams,
    @AuthUser() actor: User,
  ): Promise<OrderPublicDto> {
    // Same request-wide enrichment as `place`.
    this.logger.assign({ orderId: id, actor: actor.id });

    // Creating the transaction here would actually be optional, as we're not
    // adding a tag and the authorization logic does not access additional
    // state.
    const order = await this.runner.run(
      { readOnly: true },
      async (transaction) => {
        const fetched = await this.service.get(id, { transaction });
        this.authorizationService.validateCanRead(actor, fetched);
        return fetched;
      },
    );
    return toOrderPublicDto(order);
  }

  @TryMap(forbiddenErrorAsDto)
  async list(
    query: OrderListQueryParams,
    @AuthUser() actor: User,
  ): Promise<OrderListDto> {
    // Default to the caller's own orders.
    // A staff member may target a specific `customer`.
    const customer = query.customer ?? actor.id;
    this.authorizationService.validateCanList(actor, customer);
    // `actor` is the caller; `customer` is the account whose orders are listed.
    // Usually the same, but a staff member may target another.
    this.logger.assign({ actor: actor.id, customerId: customer });

    // Parse + validate the raw params (decoding the opaque `readAfter` cursor),
    // then default and cap the page size.
    const validatedQuery = (
      await OrderListQueryDto.fromParams(query)
    ).withLimit(ORDER_LIST_LIMITS);
    const pageQuery = new OrderPageQuery({
      limit: validatedQuery.limit,
      readAfter: validatedQuery.readAfter,
    });

    // A `book` filter selects the staff-only, cross-customer listing (every
    // order containing that book, served by a different index), otherwise the
    // listing is scoped to a customer. Each branch authorizes before it reads.
    const page =
      validatedQuery.book != null
        ? await this.listByBook(actor, validatedQuery.book, pageQuery)
        : await this.listByCustomer(actor, validatedQuery.customer, pageQuery);

    // Convert the stored `Order`s to the public DTO. Passing `validatedQuery`
    // (which carries the opaque-cursor decorator) lets `map` rebuild
    // `page.nextPageQuery` with the typing from `validatedQuery`
    // (`OrderListQueryDto`).
    return page.map(toOrderPublicDto, validatedQuery).serialize();
  }

  /**
   * Authorizes and reads the staff-only listing of every order containing a
   * book (across all customers), via the companion `OrderBook` index.
   */
  private listByBook(
    actor: User,
    book: string,
    query: OrderPageQuery,
  ): Promise<Page<Order, OrderPageQuery>> {
    this.logger.assign({ bookId: book });
    this.authorizationService.validateCanListByBook(actor);
    return this.queryService.listByBook(book, query);
  }

  /**
   * Authorizes and reads a customer-scoped listing: the caller's own orders by
   * default, or — for staff — a specific `customer`'s.
   */
  private listByCustomer(
    actor: User,
    customer: string | undefined,
    query: OrderPageQuery,
  ): Promise<Page<Order, OrderPageQuery>> {
    const target = customer ?? actor.id;
    this.logger.assign({ customerId: target });
    this.authorizationService.validateCanList(actor, target);
    return this.queryService.listByCustomer(target, query);
  }

  @TryMap(
    forbiddenErrorAsDto,
    invalidOrderStatusErrorAsDto,
    orderNotFoundErrorAsDto,
    incorrectVersionErrorAsDto,
  )
  async process(
    { id }: OrderProcessPathParams,
    { updatedAt }: OrderProcessQueryParams,
    @AuthUser() actor: User,
  ): Promise<OrderPublicDto> {
    this.logger.assign({ orderId: id, actor: actor.id });

    // Authorization is decided against the stored order.
    // Like `cancel`, the check is injected as the manager's `validationFn`.
    const order = await this.runner.run(
      { tag: 'orderProcess' },
      (transaction) =>
        this.service.process(id, {
          transaction,
          checkUpdatedAt: updatedAt,
          validationFn: async (order) =>
            this.authorizationService.validateCanProcess(actor, order),
        }),
    );
    return toOrderPublicDto(order);
  }

  @TryMap(
    invalidOrderStatusErrorAsDto,
    orderNotFoundErrorAsDto,
    incorrectVersionErrorAsDto,
  )
  async cancel(
    { id }: OrderCancelPathParams,
    { updatedAt }: OrderCancelQueryParams,
    @AuthUser() actor: User,
  ): Promise<OrderPublicDto> {
    this.logger.assign({ orderId: id, actor: actor.id });

    // Cancelling is allowed to the order's own customer or to staff, a decision
    // that depends on the *stored* order, not just the caller. So the check is
    // handed down as a `validationFn`: it runs against the order fetched inside
    // the write transaction, closing over the authenticated `actor`, and throws
    // (a `404`, hiding the order from a non-owner) before the mutation commits.
    // The service composes it ahead of its own `pending`-state check.
    const order = await this.runner.run({ tag: 'orderCancel' }, (transaction) =>
      this.service.cancel(id, {
        transaction,
        checkUpdatedAt: updatedAt,
        validationFn: async (order) =>
          this.authorizationService.validateCanCancel(actor, order),
      }),
    );
    return toOrderPublicDto(order);
  }
}
