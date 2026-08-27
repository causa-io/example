-- The de-duplication marker for review-reminder emails (see
-- spanner/review-reminder.yaml).
--
-- One row per order, inserted in the same outbox transaction that publishes the
-- `ordering.review-request.v1` email event. Because the insert and the
-- publish commit atomically, a replayed Cloud Tasks delivery finds the row
-- already present and skips — the email is published exactly once despite
-- at-least-once task delivery.

CREATE TABLE ReviewReminder (
  id STRING(36) NOT NULL,
  sentAt TIMESTAMP NOT NULL,
) PRIMARY KEY (id),
ROW DELETION POLICY (OLDER_THAN(sentAt, INTERVAL 7 DAY))
