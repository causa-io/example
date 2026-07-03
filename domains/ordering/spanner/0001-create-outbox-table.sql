-- The transactional outbox: the first migration of every event-emitting
-- database.
--
-- Events are published with the transactional-outbox pattern: the service
-- inserts an `OutboxEvent` row in the same Spanner transaction as the state
-- change. This table is written/read by `@causa/runtime-google`'s
-- `SpannerOutboxTransactionRunner`, and its use should mostly be transparent to
-- the service code.
--
-- `shard` is a generated column, which is used to spread the load when polling
-- for unpublished events. Indexing only on `leaseExpiration` would create a hot
-- spot.
--
-- The number of shards (10) and the index name below must match the service's
-- outbox configuration.

CREATE TABLE OutboxEvent (
  id STRING(36) NOT NULL,
  topic STRING(MAX) NOT NULL,
  data BYTES(MAX) NOT NULL,
  attributes JSON NOT NULL,
  leaseExpiration TIMESTAMP,
  shard INT64 AS (MOD(ABS(FARM_FINGERPRINT(id)), 10)),
) PRIMARY KEY (id);

-- The poller scans by (shard, leaseExpiration) to pick up unleased/expired
-- events per shard.
CREATE INDEX OutboxEventsByShardAndLeaseExpiration ON OutboxEvent(shard, leaseExpiration)
