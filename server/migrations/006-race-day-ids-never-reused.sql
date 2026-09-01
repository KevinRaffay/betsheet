-- betsheet:schema-rebuild
--
-- Race-day ids must NEVER be reused. Found in live testing: deleting a day
-- and re-ingesting the same track/date (tombstone supersession) let SQLite
-- hand the new row the old rowid, so decision-trace events for
-- "raceDayId 1" ambiguously described different days - breaking the
-- promise that a deleted day's logged history stays inspectable.
--
-- AUTOINCREMENT makes rowids monotonic for the table's lifetime (tracked in
-- sqlite_sequence, which explicit-id inserts below also seed). Requires a
-- table rebuild, hence the schema-rebuild directive: db.js runs this with
-- foreign keys OFF and checks foreign_key_check before committing. Child
-- tables reference race_days by NAME, so the rename re-attaches them.
CREATE TABLE race_days_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  bankroll_cents INTEGER,
  per_race_min_cents INTEGER,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT,
  UNIQUE (track, date)
);
INSERT INTO race_days_new (id, track, date, bankroll_cents, per_race_min_cents,
                           correlation_id, created_at, deleted_at)
  SELECT id, track, date, bankroll_cents, per_race_min_cents,
         correlation_id, created_at, deleted_at
  FROM race_days;
DROP TABLE race_days;
ALTER TABLE race_days_new RENAME TO race_days;
