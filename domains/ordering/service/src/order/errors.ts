// Internal, typed service errors owned by the Order entity.
//
// Plain `Error` subclasses with NO HTTP concern. The controller boundary maps
// them to public error DTOs with `@TryMap` (see dto.utils.ts), keeping the
// service layer transport-agnostic and unit-testable without an HTTP stack.
// Book-level errors raised while validating order lines live with the
// catalogue lookup that raises them, see catalog/errors.ts.

import { ValidationError } from '@causa/runtime';
import type { OrderStatus } from '../model/generated.js';

/**
 * Thrown when an order is requested (or acted upon) but does not exist.
 */
export class OrderNotFoundError extends Error {
  constructor() {
    super('The order was not found.');
  }
}

/**
 * Thrown when the data for an order fails one or more *semantic* rules that
 * need no read of current state.
 *
 * It extends the runtime {@link ValidationError}, which holds the accumulated
 * human-readable `validationMessages`. This subclass adds the `fields` that
 * failed. `OrderValidatorService.sanitize` collects every such failure and
 * throws once, so a caller learns all of them together rather than one per
 * round-trip.
 *
 * This is the *business* counterpart to the shape validation the
 * `ValidationPipe` runs from the DTO: both are input rules, but shape checks
 * (types, formats, required fields) are declared on the DTO, while these need
 * domain logic, so they live in the validator.
 * Both map to the same shared `400 invalidInput` {@link ValidationErrorDto}
 * (see dto.utils.ts).
 *
 * Contrast the *stateful* line checks, which raise their own typed errors (see
 * catalog/errors.ts).
 */
export class OrderValidationError extends ValidationError {
  /**
   * @param messages The human-readable reasons validation failed.
   * @param fields The names of the request fields that failed.
   */
  constructor(
    messages: string[],
    readonly fields: string[],
  ) {
    super(messages);
  }
}

/**
 * Thrown when a state transition is attempted on an order whose current status
 * does not allow it (e.g. cancelling an order that is no longer `pending`).
 *
 * Raised by the state-check `validationFn` the service hands to
 * `OrderManager.update`, so it runs against the *stored* order inside the write
 * transaction. Mapped to the domain `400 ordering.invalidOrderStatus` DTO — a
 * business-state conflict, never the `409` reserved for optimistic-concurrency
 * mismatches.
 */
export class InvalidOrderStatusError extends Error {
  /**
   * @param status The current, disallowing status of the order.
   */
  constructor(readonly status: OrderStatus) {
    super(`The order cannot transition from its '${status}' status.`);
  }
}
