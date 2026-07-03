// Providers shared by every feature module.
//
// Both container roots — the public API (`ApiModule`) and the internal event
// handler (`EventsModule`) — import this module, so the wiring to Spanner,
// Pub/Sub and the transactional outbox is declared exactly once.

import {
  PubSubPublisherModule,
  SpannerModule,
  SpannerOutboxTransactionModule,
} from '@causa/runtime-google';
import { Module } from '@nestjs/common';
import { HealthModule } from './health.js';

@Module({
  imports: [
    // Connects to the service's Spanner database (`ordering`).
    // Connection details come from the environment (`SPANNER_INSTANCE` /
    // `SPANNER_DATABASE`).
    SpannerModule.forRoot(),

    // Provides the `EventPublisher` used by the outbox sender to publish to
    // Pub/Sub.
    PubSubPublisherModule.forRoot(),

    // Provides the `SpannerOutboxTransactionRunner`: a transaction runner that
    // writes state changes and enqueues outbox events in the same Spanner
    // transaction.
    // `index` and `sharding` must match the outbox table's DDL.
    SpannerOutboxTransactionModule.forRoot({
      index: 'OutboxEventsByShardAndLeaseExpiration',
      sharding: { column: 'shard', count: 10 },
    }),

    HealthModule,
  ],
})
export class BaseModule {}
