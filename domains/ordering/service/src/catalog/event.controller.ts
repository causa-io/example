// The HTTP surface for `ordering`'s consumption of the catalogue domain.
//
// All routing is supplied by the generated `@AsCatalogEventsController()`
// decorator, so there is no hand-written `@Controller` / `@Post` / `@EventBody`
// here — keeping the route in lockstep with the trigger declared in
// `service/causa.yaml`.

import { Logger } from '@causa/runtime/nestjs';
import {
  AsCatalogEventsController,
  type CatalogEventsContract,
} from '../api/catalog.events.controller.js';
import { BookEvent } from '../model/generated.js';
import { BookProjectionService } from './book-projection.service.js';

/**
 * Handles catalogue events pushed to `ordering`.
 *
 * `@AsCatalogEventsController()` is generated from the
 * `handleBookForProjection` trigger in `service/causa.yaml`.
 * It applies, for this method:
 *   - `@Controller('catalog')` + `@Post('handleBookForProjection')` → the route
 *     `POST /catalog/handleBookForProjection` the trigger points at.
 *   - `@HttpCode(200)` → acknowledge the Pub/Sub delivery.
 *   - `@UseEventHandler('google.pubSub')` → select the Pub/Sub interceptor
 *     (registered in `EventsModule`) that decodes and validates the push body.
 *   - `@EventBody()` on the first parameter → inject the parsed `BookEvent`.
 *
 * Implementing `CatalogEventsContract` keeps this class in sync with the
 * trigger: remove or rename the trigger and the type stops compiling.
 */
@AsCatalogEventsController()
export class CatalogEventController implements CatalogEventsContract {
  constructor(
    private readonly bookProjectionService: BookProjectionService,
    private readonly logger: Logger,
  ) {
    this.logger.setContext(CatalogEventController.name);
  }

  async handleBookForProjection(event: BookEvent): Promise<void> {
    this.logger.assign({ bookId: event.data.id, eventName: event.name });

    // `processOrSkipEvent` upserts the projection, or returns `null` (a no-op)
    // when a newer row already exists. Either way the handler returns 200, so a
    // replayed or out-of-order delivery is acknowledged rather than retried.
    await this.bookProjectionService.processOrSkipEvent(event);
  }
}
