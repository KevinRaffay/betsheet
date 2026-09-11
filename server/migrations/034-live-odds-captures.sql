-- 034: live odds captures - a HISTORY of tote boards, not a single mutable
-- cell (D228).
--
-- `entries.live_odds` / `live_odds_decimal` have existed since migration 024
-- and have never held a row (D171 measured 0 of 13,710; re-measured 0 of
-- 13,710 on the 2026-09-10 corpus while scoping this). Nothing here replaces
-- them: they keep their meaning as THE LATEST capture, because
-- `shared/parsers/equibase-entries.js`'s `effectiveOdds`, D117's staleness
-- indicator and every future prompt read them from there and must not have to
-- learn a join.
--
-- What this adds is the thing a single column cannot hold. The question these
-- captures exist to answer is about odds MOVEMENT - a board at 30 minutes to
-- post and the same board at 2 minutes are two different facts, and the drift
-- between them is the signal. Writing the second over the first would destroy
-- the measurement in the act of taking it, which is the same shape as the
-- destructive-replace trap the D204 gotcha records. So every capture is kept,
-- and `entries.live_odds` is a cache of the most recent one.
--
-- Two tables rather than one wide one, matching result_charts/race_results:
-- the header carries provenance once per upload (when, from what, under which
-- correlation id - invariant 8), the rows carry one price per horse.
--
-- Keyed by race NUMBER, not race id, for the same reason `race_results` is
-- (migration 001's own comment): a capture is reconciled against a day by
-- track/date/number, and a number that does not match any stored race is
-- reported rather than silently dropped.
--
-- Ordinary CREATE TABLEs - nothing is rebuilt, no CHECK on an existing table
-- changes, and no existing row is touched.

CREATE TABLE odds_captures (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  -- When the BOARD was read, not when this row was written. Supplied by the
  -- client from the saved file's own mtime, exactly as `oddsCapturedAt`
  -- already is on the entries-ingest path (D116). NULL is honest and means
  -- "staleness unknown"; it never reads as fresh.
  captured_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('equibase_html')),
  raw_digest TEXT,
  correlation_id TEXT,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE odds_capture_entries (
  id INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES odds_captures(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  program_number TEXT NOT NULL,
  live_odds TEXT NOT NULL,
  -- NULL when the printed form is one `morningLineToDecimal` cannot read.
  -- The TEXT is always kept: a price this codebase cannot do arithmetic on is
  -- still a price the board actually showed, and dropping it would be the
  -- silent-failure shape the D213 gotcha is about.
  live_odds_decimal REAL,
  UNIQUE (capture_id, race_number, program_number)
);

CREATE INDEX idx_odds_captures_day ON odds_captures(race_day_id, captured_at);
CREATE INDEX idx_odds_capture_entries_capture ON odds_capture_entries(capture_id);
