// Internal, typed service errors owned by the Order entity.
//
// Plain `Error` subclasses with NO HTTP concern. The controller boundary maps
// them to public error DTOs with `@TryMap` (see dto.utils.ts), keeping the
// service layer transport-agnostic and unit-testable without an HTTP stack.
// Book-level errors raised while validating order lines live with the
// catalogue lookup that raises them, see catalog/errors.ts.

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
