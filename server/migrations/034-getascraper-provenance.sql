-- betsheet:schema-rebuild
--
-- 034: a provenance value for the third registered entries parser,
-- shared/parsers/equibase-getascraper.js (D219) - the getascraper/
-- equibase-us-horse-racing-scraper Apify actor.
--
-- WHY A SEPARATE VALUE RATHER THAN REUSING 'equibase_apify'. Migration 033's
-- own reasoning was that the value names the DOCUMENT/PATH, not the vendor, so
-- "the registry can swap actors under this same value without a further
-- migration." That argument holds for SWAPPING one actor for another; it does
-- not hold here, because both actors are registered and in use AT THE SAME TIME
-- for different jobs, and they differ in a way the corpus has to be able to see:
--
--   parseforge   carries no post time at all (11 of 11 races null in its own
--                fixture) but does carry program numbers, age/sex and claim price.
--   getascraper  carries a post time per race - the reason it was added, since
--                without one a day is invisible on the D209-D211 calendar - but
--                carries no program number (one is DERIVED from post position),
--                no distance and no surface.
--
-- Those are different data, not the same data from a different vendor. Filing
-- both under one value would make "which days have a real program number?"
-- unanswerable from the corpus, which is exactly the provenance question
-- invariant 13 exists to keep answerable. Hence a distinct value.
--
-- ONE rebuild: race_days.entries_source (migration 024's CHECK, widened by 033).
-- `result_charts.source_kind` is deliberately NOT touched - this deliverable
-- wires the ENTRIES half of this source only. Its results rows carry the
-- winner's win/place/show alone, and shared/grading.js:66-67 scores a horse that
-- finished in the money with no price on file as ('loss', 0), so ingesting them
-- would write real winnings into the corpus as losses. See DELIVERABLES.md D219.
--
-- **race_days is the root of TEN ON DELETE CASCADE children** (CLAUDE.md's own
-- "riskiest table to rebuild" caution) - db.js runs this with foreign keys OFF
-- and a foreign_key_check before commit, same as every prior rebuild of this
-- table. Data is preserved via INSERT...SELECT rather than dropped and
-- recreated empty. Live index list re-confirmed against a freshly-migrated
-- database rather than trusted from 024's or 033's comment (migration 030's
-- lesson): `idx_race_days_meet` is the only index to recreate; UNIQUE(track,
-- date) rides on the table definition and needs no explicit statement.

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
    CHECK (entries_source IN ('program', 'ml_sheet', 'both', 'equibase_html', 'equibase_apify', 'equibase_getascraper')),
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
