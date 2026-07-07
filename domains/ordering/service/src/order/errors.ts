// Internal, typed service errors owned by the Order entity.
//
// Plain `Error` subclasses with NO HTTP concern. The controller boundary maps
// them to public error DTOs with `@TryMap` (see dto.utils.ts), keeping the
// service layer transport-agnostic and unit-testable without an HTTP stack.
// Book-level errors raised while validating order lines live with the
// catalogue lookup that raises them, see catalog/errors.ts.

/**
 * Thrown when an order is requested (or acted upon) but does not exist.
 */
export class OrderNotFoundError extends Error {
  constructor() {
    super('The order was not found.');
  }
}
