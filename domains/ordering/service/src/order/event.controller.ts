// The HTTP surface for `ordering`'s own order-event triggers.
//
// All routing is supplied by the generated `@AsOrdersEventsController()`
// decorator, so there is no hand-written `@Controller` / `@Post` / `@EventBody`
// here — keeping the routes in lockstep with the triggers declared in
// `service/causa.yaml`.

import { Logger } from '@causa/runtime/nestjs';
import { NotImplementedException } from '@nestjs/common';
import {
  AsOrdersEventsController,
  type OrdersEventsContract,
} from '../api/orders.events.controller.js';
import { OrderEvent } from '../model/generated.js';
import { OrderFirestoreProjectionService } from './firestore-projection.service.js';

/**
 * Handles order events pushed back to `ordering` by its own topic.
 *
 * `@AsOrdersEventsController()` is generated from the order triggers in
 * `service/causa.yaml`. For each method it applies `@Controller('orders')` +
 * `@Post(<trigger>)`, `@HttpCode(200)`, `@UseEventHandler(...)`, and
 * `@EventBody()` on the first parameter.
 *
 * Implementing `OrdersEventsContract` keeps this class in sync with the
 * triggers: rename or remove a trigger and the type stops compiling.
 */
@AsOrdersEventsController()
export class OrderEventController implements OrdersEventsContract {
  constructor(
    private readonly orderFirestoreProjectionService: OrderFirestoreProjectionService,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(OrderEventController.name);
  }

  async handleOrderForFirestore(event: OrderEvent): Promise<void> {
    this.logger.assign({ orderId: event.data.id, eventName: event.name });

    // `processOrSkipEvent` upserts the `OrderDocument`, or returns `null` (a
    // no-op) when a newer document already exists. Either way the handler
    // returns 200, so a replayed or out-of-order delivery is acknowledged
    // rather than retried.
    await this.orderFirestoreProjectionService.processOrSkipEvent(event);
  }

  async handleOrderProcessing(): Promise<void> {
    throw new NotImplementedException();
  }

  async expirePendingOrders(): Promise<void> {
    throw new NotImplementedException();
  }
}
