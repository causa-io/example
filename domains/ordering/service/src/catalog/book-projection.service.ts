// `ordering` cannot read the catalogue's `Book` table (domains never share
// tables). It instead subscribes to `catalog.book.v1` and keeps a local
// `BookProjection` row per book, so it can validate order lines (does the book
// exist? is it available?) without a synchronous cross-domain call.
//
// All of the machinery — fetching the current row, comparing versions, skipping
// stale/replayed events, upserting — lives in the runtime's
// `VersionedEventProcessor`. A projection only has to declare two things:
//   - The version property (`updatedAt`) used to order events.
//   - `project()`, which maps a source event to the row to store.

import { VersionedEventProcessor } from '@causa/runtime';
import {
  SpannerOutboxTransaction,
  SpannerOutboxTransactionRunner,
  SpannerReadOnlyStateTransaction,
} from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { BookEvent, BookProjection } from '../model/generated.js';

/**
 * Maintains the local `BookProjection` from `catalog.book.v1` events.
 *
 * The generic parameters bind the processor to this service's transaction stack
 * (Spanner + outbox), the source event type, and the projected row type.
 */
@Injectable()
export class BookProjectionService extends VersionedEventProcessor<
  SpannerOutboxTransaction,
  SpannerReadOnlyStateTransaction,
  BookEvent,
  BookProjection,
  SpannerOutboxTransactionRunner
> {
  constructor(runner: SpannerOutboxTransactionRunner) {
    // - `BookProjection`: the row class the base fetches/writes by primary key.
    // - `runner`: supplies the Spanner transaction the upsert runs in.
    // - `'updatedAt'`: the version property. The base compares the incoming
    //   projection's `updatedAt` against the stored row's and skips the event
    //   when the stored row is newer-or-equal — which is what makes the handler
    //   idempotent under Pub/Sub's at-least-once, out-of-order delivery.
    super(BookProjection, runner, 'updatedAt');
  }

  /**
   * Builds the row to store from a book event.
   *
   * The event payload is a full `Book`, but `ordering` only needs the title and
   * availability, plus the id/timestamps required to store and version the row.
   * Copying only those fields decouples the projection from upstream schema
   * churn: a new `Book` property never touches this code.
   *
   * There is no create/update/delete branching. Every book event carries the
   * book in its post-change state, so:
   *   - `bookCreated` / `bookUpdated` → `deletedAt` is null → a live row is
   *     upserted.
   *   - `bookDeleted` → `deletedAt` is set → the same upsert stores a
   *     soft-deleted row (the Spanner row-deletion policy later reaps it).
   */
  protected async project({ data }: BookEvent): Promise<BookProjection> {
    return new BookProjection({
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: data.deletedAt,
      title: data.title,
      availability: data.availability,
    });
  }
}
