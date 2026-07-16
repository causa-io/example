// The validator-service pattern: a dedicated injectable that sanitizes and
// validates command or entity data. It runs two kinds of rule: simple value
// checks it owns (accumulated into a single `ValidationError`), and checks
// against live state (delegated to the service that owns the state).
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
import { OrderValidationError } from './errors.js';

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
   * - *Validate* (value checks): simple checks on the sanitized data are
   *   accumulated and raised together as an `OrderValidationError`.
   * - *Validate* (state checks): every ordered book must exist in the catalogue
   *   and be available. This state lookup is delegated to
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
    // Value-check failures accumulate here, across every branch below, and are
    // thrown together once all the checks have run — so the caller learns every
    // value problem at once, not one per round-trip. `fields` is a set: if two
    // rules blame the same field, it is still reported once. Only one such rule
    // exists today. This accumulate-then-throw shape is the standard one, and
    // lets more value checks slot in without restructuring.
    const messages: string[] = [];
    const fields = new Set<string>();

    // Collects only the fields this method rewrites; spread over `data` at the
    // end so untouched fields pass through and the caller keeps its exact type.
    const sanitized: Partial<Writable<Order>> = {};

    // Value checks — sanitize, then accumulate. Do not throw here: let every
    // branch contribute before the single throw below.
    if (data.lines) {
      // Sanitize the lines first, so validation runs on the cleaned data: the
      // merged lines already hold each book once.
      const lines = this.sanitizeLines(data.lines);

      if (lines.length === 0) {
        messages.push('An order must contain at least one line.');
        fields.add('lines');
      }

      sanitized.lines = lines;
    }

    // One throw for all accumulated value failures. Also a short-circuit before
    // the state reads below: no point querying the catalogue for input already
    // known to be invalid.
    if (messages.length > 0) {
      throw new OrderValidationError(messages, [...fields]);
    }

    // State checks, each raising its own dedicated typed error. The line IDs
    // are well-formed (shape validation passed) and non-empty (checked above),
    // but each referenced book must exist in the catalogue and be available.
    if (sanitized.lines) {
      await this.bookProjection.validateAvailable(
        sanitized.lines.map((line) => line.book),
        options,
      );
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
