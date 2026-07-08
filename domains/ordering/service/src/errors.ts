// Service-wide errors, not owned by any single feature.
//
// Plain `Error` subclasses with NO HTTP concern — like the feature-scoped
// `order/errors.ts`, but living at the service root because more than one
// feature can raise them. The controller boundary maps them to public error
// DTOs with `@TryMap`.

/**
 * Thrown when an authenticated caller is not allowed to perform an action.
 * Mapped to the shared `403 forbidden` DTO at the controller boundary.
 */
export class ForbiddenError extends Error {
  constructor(message = 'The caller is not allowed to perform this action.') {
    super(message);
  }
}
