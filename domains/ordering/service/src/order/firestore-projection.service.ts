// Spanner is the source of truth for orders, but a customer's app wants a
// real-time view of its order history without polling the API. So `ordering`
// mirrors each order into a Firestore `OrderDocument`, which clients read
// directly (gated by `domains/ordering/firestore/firestore.rules`).
//
// This is the same projection machinery as the catalogue `BookProjection` (see
// `../catalog/book-projection.service.ts`), with one substitution: the state is
// stored in Firestore instead of Spanner, so the transaction stack is the
// `FirestorePubSub*` trio rather than the `SpannerOutbox*` one.
// The `VersionedEventProcessor` still supplies fetch-compare-upsert and
// idempotency.
//
// Two differences from the catalogue projection are worth noting:
//   - This service projects the domain's OWN entity (`ordering` owns `Order`),
//     not another domain's. It is still driven by the event stream, not by the
//     write path, so the read model stays eventually-consistent and the write
//     path never blocks on Firestore.
//   - The projection is client-facing, so `project()` copies only the fields a
//     client may see and leaves out internal ones (here `externalReference`).
//     The reduced `OrderDocument` schema documents the intended shape but
//     strips nothing at runtime. See `domains/ordering/firestore/order.yaml`.

import { VersionedEventProcessor } from '@causa/runtime';
import {
  FirestorePubSubTransaction,
  FirestorePubSubTransactionRunner,
  FirestoreReadOnlyStateTransaction,
} from '@causa/runtime-google';
import { Injectable } from '@nestjs/common';
import { OrderDocument, OrderEvent } from '../model/generated.js';

/**
 * Maintains the client-facing `OrderDocument` in Firestore, built from
 * `ordering.order.v1` events.
 *
 * The generic parameters bind the processor to the Firestore transaction stack
 * (Firestore state + Pub/Sub), the source event type, and the projected
 * document type.
 */
@Injectable()
export class OrderFirestoreProjectionService extends VersionedEventProcessor<
  FirestorePubSubTransaction,
  FirestoreReadOnlyStateTransaction,
  OrderEvent,
  OrderDocument,
  FirestorePubSubTransactionRunner
> {
  constructor(runner: FirestorePubSubTransactionRunner) {
    // - `OrderDocument`: the document class the base fetches/writes. Its
    //   `@FirestoreCollection` decorator (generated from
    //   `firestore/order.yaml`) names the path `orders/{id}`, so the base needs
    //    no collection wiring.
    // - `runner`: supplies the Firestore transaction the upsert runs in.
    // - `'updatedAt'`: the version property. The base compares the incoming
    //   document's `updatedAt` against the stored one and skips the event when
    //   the stored document is newer-or-equal — which makes the handler
    //   idempotent under Pub/Sub's at-least-once, out-of-order delivery.
    super(OrderDocument, runner, 'updatedAt');
  }

  /**
   * Builds the document to store from an order event.
   *
   * Every order event carries the order in its post-change state, so there is
   * no create/update/delete branching:
   *   - `orderPlaced` / `orderProcessing` / … → `deletedAt` is null → a live
   *     document is upserted.
   *   - a delete would carry a set `deletedAt`, and
   *     `@SoftDeletedFirestoreCollection` moves the document to the soft-delete
   *     collection on the same upsert.
   *
   * `externalReference` is intentionally NOT copied: it is an internal
   * third-party reference with no meaning to the client.
   * This explicit field list is the enforcement.
   */
  protected async project({ data }: OrderEvent): Promise<OrderDocument> {
    return new OrderDocument({
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: data.deletedAt,
      customer: data.customer,
      status: data.status,
      lines: data.lines,
    });
  }
}
