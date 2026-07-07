-- `Order` is a reserved word, so the table name is quoted with backticks.
CREATE TABLE `Order` (
  id STRING(36) NOT NULL,
  createdAt TIMESTAMP NOT NULL,
  updatedAt TIMESTAMP NOT NULL,
  deletedAt TIMESTAMP,
  customer STRING(36) NOT NULL,
  status STRING(MAX) NOT NULL,
  -- The array of order lines, serialized as JSON.
  lines JSON NOT NULL,
  externalReference STRING(MAX),
) PRIMARY KEY (id),
-- Soft-deleted rows are physically removed one day after `deletedAt`.
-- Until then they remain queryable, but application queries filter them out
-- with `WHERE deletedAt IS NULL`.
ROW DELETION POLICY (OLDER_THAN(deletedAt, INTERVAL 1 DAY))
