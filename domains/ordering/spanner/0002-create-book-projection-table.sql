CREATE TABLE BookProjection (
  id STRING(36) NOT NULL,
  createdAt TIMESTAMP NOT NULL,
  updatedAt TIMESTAMP NOT NULL,
  deletedAt TIMESTAMP,
  title STRING(MAX) NOT NULL,
  availability STRING(MAX) NOT NULL,
) PRIMARY KEY (id),
-- Similarly to tables for entities owned by the domain, projections are also
-- soft-deleted and garbage-collected by Spanner. This accounts for out-of-order
-- at least once processing. Events as late as 1 day after the deletion won't
-- accidentally recreate the projection.
ROW DELETION POLICY (OLDER_THAN(deletedAt, INTERVAL 1 DAY))
