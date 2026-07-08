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
import { AuthUser, Logger } from '@causa/runtime/nestjs';
import { NotImplementedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
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
  OrderCreateDto,
  OrderListDto,
  OrderPublicDto,
} from '../model/generated.js';
import { OrderAuthorizationService } from './authorization.service.js';
import {
  bookNotFoundErrorAsDto,
  bookUnavailableErrorAsDto,
  forbiddenErrorAsDto,
  orderNotFoundErrorAsDto,
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

  @TryMap(bookNotFoundErrorAsDto, bookUnavailableErrorAsDto)
  async place(
    body: OrderCreateDto,
    @AuthUser() actor: User,
  ): Promise<OrderPublicDto> {
    // Mint the order ID here, so it is logged (and traceable) before any write,
    // and hand it to the service, which uses it rather than generating its own.
    const orderId = randomUUID();
    this.logger.assign({ orderId, customer: actor.id });

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
    this.logger.assign({ orderId: id });

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
    this.logger.assign({ customer });

    // Parse + validate the raw params (decoding the opaque `readAfter` cursor),
    // then default and cap the page size.
    const validatedQuery = (
      await OrderListQueryDto.fromParams(query)
    ).withLimit(ORDER_LIST_LIMITS);

    // Hand the query service the plain domain query.
    const page = await this.queryService.listByCustomer(
      customer,
      new OrderPageQuery({
        limit: validatedQuery.limit,
        readAfter: validatedQuery.readAfter,
      }),
    );

    // Convert the stored `Order`s to the public DTO. Passing `validatedQuery`
    // (which carries the opaque-cursor decorator) lets `map` rebuild
    // `page.nextPageQuery` with the typing from `validatedQuery`
    // (`OrderListQueryDto`).
    return page.map(toOrderPublicDto, validatedQuery).serialize();
  }

  async process(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: OrderProcessPathParams,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _query: OrderProcessQueryParams,
  ): Promise<OrderPublicDto> {
    throw new NotImplementedException();
  }
}
