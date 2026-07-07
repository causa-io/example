// Typed errors describing catalogue books.
//
// They carry the offending book IDs and no HTTP concern. They live with the
// service that raises them — `BookProjectionService.validateAvailable`, which
// owns the projection and its reads.
// The ordering API maps them to its `ordering.bookNotFound` /
// `ordering.bookUnavailable` responses at the controller boundary (see
// order/dto.utils.ts).

/**
 * Thrown when one or more books are absent from the local `BookProjection` —
 * unknown to the catalogue, or removed from it, from ordering's point of view.
 */
export class BookNotFoundError extends Error {
  constructor(readonly books: string[]) {
    super(`The following books do not exist: ${books.join(', ')}.`);
  }
}

/**
 * Thrown when one or more books exist but cannot currently be ordered (out of
 * stock / discontinued).
 */
export class BookUnavailableError extends Error {
  constructor(readonly books: string[]) {
    super(
      `The following books cannot currently be ordered: ${books.join(', ')}.`,
    );
  }
}
