// The validator-service pattern: a dedicated injectable that sanitizes and
// validates command or entity data against live state.
// It usually exposes a single `sanitize` method that takes the data as a
// template: a `Partial` of the entity, so the same method serves creation and
// partial updates. The method validates the input, possibly sanitizes
// (modifies) it, and returns it.
//
// The actual catalogue lookup is delegated to `BookProjectionService`, the
// service that owns the projection and so owns access to it.
// This runs against the caller's transaction, so the check reads the same
// snapshot the order is written to.

import { type Writable } from '@causa/runtime';
import { type SpannerReadOnlyStateTransactionOption } from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { BookProjectionService } from '../catalog/book-projection.service.js';
import { Order, OrderLine } from '../model/generated.js';

/**
 * Validates orders.
 */
@Injectable()
export class OrderValidatorService {
  constructor(private readonly bookProjection: BookProjectionService) {}

  /**
   * Sanitizes and validates the data for an order, returning the cleaned data.
   *
   * When `lines` are present:
   * - *Sanitize*: lines referencing the same book are merged into a single
   *   line, summing their quantities.
   * - *Validate*: every ordered book must exist in the catalogue and be
   *   available. The lookup is delegated to
   *   `BookProjectionService.validateAvailable`, which throws the typed
   *   `BookNotFoundError` / `BookUnavailableError`.
   *
   * Every field is optional, so the same method serves a creation and a partial
   * update: an update that does not touch the lines simply skips both steps.
   *
   * @param data The order data to sanitize and validate.
   * @param options The transaction to read within.
   * @returns The sanitized, validated data.
   */
  async sanitize<T extends Partial<Order>>(
    data: T,
    options: SpannerReadOnlyStateTransactionOption,
  ): Promise<T> {
    // Collects only the fields this method rewrites; spread over `data` at the
    // end so untouched fields pass through and the caller keeps its exact type.
    const sanitized: Partial<Writable<Order>> = {};

    if (data.lines) {
      // Sanitize the lines first, so validation runs on the cleaned data: the
      // merged lines already hold each book once.
      const lines = this.sanitizeLines(data.lines);

      // Validate: every ordered book must exist in the catalogue and be
      // available.
      await this.bookProjection.validateAvailable(
        lines.map((line) => line.book),
        options,
      );

      sanitized.lines = lines;
    }

    return { ...data, ...sanitized };
  }

  /**
   * Merges lines referencing the same book into a single line, summing their
   * quantities.
   *
   * @param lines The raw order lines.
   * @returns Fresh, de-duplicated {@link OrderLine} instances.
   */
  private sanitizeLines(lines: readonly OrderLine[]): OrderLine[] {
    return Object.values(
      lines.reduce(
        (acc, { book, quantity }) => {
          acc[book] = new OrderLine({
            book,
            quantity: (acc[book]?.quantity ?? 0) + quantity,
          });
          return acc;
        },
        {} as Record<string, OrderLine>,
      ),
    );
  }
}
