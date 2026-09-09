-- betsheet:schema-rebuild
--
-- 033: a real Apify-sourced provenance value for both entries and results
-- (docs/requirements/apify-equibase-ingest.md, phase 1). Two already-built,
-- real-sample-verified parsers - shared/parsers/equibase-apify-parseforge.js
-- (D190/D192) and shared/parsers/equibase-apify-results.js (D193) - have
-- been refusing to save on purpose since the day they were built, because
-- neither `race_days.entries_source` nor `result_charts.source_kind` had a
-- value for this source. This migration is that value; wiring the parsers'
-- own `toPayload`/`apifyResultsToPayload` functions to stop throwing is a
-- separate, later phase.
--
-- Named `equibase_apify`, matching this codebase's existing convention on
-- both columns: name the DOCUMENT/PATH the data came from (`equibase_html`,
-- `equibase_paste`, `dmtc_html`), never the vendor (`parseforge`) - the
-- registry can swap actors under this same value without a further
-- migration, per shared/parsers/registry.js's own "registry entry, never a
-- call-site special case" shape.
--
-- TWO rebuilds in one migration, deliberately - both add the identical
-- value for the identical reason, and neither depends on the other.
--
-- 1. race_days.entries_source (migration 024's CHECK, unchanged since).
--    **race_days is the root of TEN ON DELETE CASCADE children** (CLAUDE.md's
--    own "riskiest table to rebuild" caution) - db.js runs this with foreign
--    keys OFF and a foreign_key_check before commit, same as every prior
--    rebuild of this table. The corpus this rebuild runs against is a
--    disposable sandbox (2026-09-09 user decision) - the rebuild is still
--    done to the same standard as every prior one (data preserved via
--    INSERT...SELECT, not merely dropped and recreated empty), because a
--    disposable corpus is not a reason to write a worse migration, only a
--    reason not to be paralyzed by it. Live index list confirmed against a
--    freshly-migrated database, not trusted from migration 024's own
--    comment (migration 030's lesson): `idx_race_days_meet` is the only one
--    to recreate; UNIQUE(track, date) rides on the table definition and
--    needs no explicit index statement.
--
-- 2. result_charts.source_kind (migration 010's CHECK, unchanged since).
--    No ON DELETE CASCADE children of its own and no secondary index to
--    recreate (confirmed against a freshly-migrated database) - the lower-
--    risk of the two rebuilds in this file.

CREATE TABLE race_days_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track TEXT NOT NULL,
  date TEXT NOT NULL,
  bankroll_cents INTEGER,
  per_race_min_cents INTEGER,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT,
  entries_source TEXT NOT NULL DEFAULT 'program'
    CHECK (entries_source IN ('program', 'ml_sheet', 'both', 'equibase_html', 'equibase_apify')),
  meet TEXT,
  track_code TEXT,
  replayed_at TEXT,
  odds_captured_at TEXT,
  UNIQUE (track, date)
);
INSERT INTO race_days_new
  (id, track, date, bankroll_cents, per_race_min_cents, correlation_id,
   created_at, deleted_at, entries_source, meet, track_code, replayed_at,
   odds_captured_at)
SELECT
  id, track, date, bankroll_cents, per_race_min_cents, correlation_id,
  created_at, deleted_at, entries_source, meet, track_code, replayed_at,
  odds_captured_at
FROM race_days;
DROP TABLE race_days;
ALTER TABLE race_days_new RENAME TO race_days;
CREATE INDEX idx_race_days_meet ON race_days(meet);

CREATE TABLE result_charts_new (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('equibase_paste', 'equibase_pdf', 'dmtc_html', 'equibase_apify')),
  raw_digest TEXT,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  correlation_id TEXT
);
INSERT INTO result_charts_new (id, race_day_id, source_kind, raw_digest, ingested_at, correlation_id)
  SELECT id, race_day_id, source_kind, raw_digest, ingested_at, correlation_id
  FROM result_charts;
DROP TABLE result_charts;
ALTER TABLE result_charts_new RENAME TO result_charts;
