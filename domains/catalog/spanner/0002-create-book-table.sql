-- DDL files are numbered migrations applied in order.
--
-- They live under a domain's `spanner/` folder. The domain folder name
-- (`catalog`) is the database name (see the `google.spanner.ddls` rule in
-- causa.google.yaml).
--
-- The infrastructure layer collects all of a domain's DDL and applies it to
-- that database via the `spanner_databases` Terraform module.
--
-- This table must stay consistent with ../entities/book.yaml.
-- The generated `Book` class maps to these columns.
-- Nested objects (e.g. `price`) are stored as JSON columns.

CREATE TABLE Book (
  id STRING(36) NOT NULL,
  createdAt TIMESTAMP NOT NULL,
  updatedAt TIMESTAMP NOT NULL,
  deletedAt TIMESTAMP,
  title STRING(MAX) NOT NULL,
  authorName STRING(MAX) NOT NULL,
  isbn STRING(13) NOT NULL,
  price JSON NOT NULL,
  cost JSON NOT NULL,
  availability STRING(MAX) NOT NULL,
  genre STRING(MAX) NOT NULL,
) PRIMARY KEY (id),
-- Soft-deleted rows are physically removed one day after `deletedAt`.
-- Until then they remain queryable, but application queries filter them out
-- with `WHERE deletedAt IS NULL`.
ROW DELETION POLICY (OLDER_THAN(deletedAt, INTERVAL 1 DAY))
