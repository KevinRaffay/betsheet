-- 036: `odds_captures.source` admits 'manual' (D232).
--
-- D228 built the capture path around a saved Equibase entries page, on the
-- assumption that the page's LiveOdds column carries the board. IT DOES NOT,
-- and the evidence is in the repo's own fixture: all 123 LiveOdds cells in the
-- real Del Mar capture are EMPTY, the column header carries
-- `title="Live Odds refreshed every 60 seconds"`, and the values are written
-- client-side by an external `/js/liveOdds.js`. Every capture shape this
-- codebase supports - `view-source:` and Ctrl+S "Webpage, HTML Only" - is
-- defined by `shared/parsers/equibase-entries.js`'s own header as the ORIGINAL
-- SERVER MARKUP, so both are empty by construction, at any hour.
--
-- The Apify route is out for the same underlying reason: the actor scrapes the
-- same page server-side, so it never sees what the browser's JS wrote. Checked
-- against all three real captures on file - entries rows carry
-- `morningLineOdds` and `morningLineDecimal` and no live-odds field of any
-- kind, and results rows carry only the payoffs.
--
-- So the board is TYPED IN, by a person, at post time. That is not a fallback
-- this codebase should be embarrassed about - it is the same posture every
-- other source here already has (invariant 6: every source of data is a file a
-- person chose to upload, or now a number a person chose to type), and it is
-- the only route that exists.
--
-- ONE CHECK VALUE IS ALL THIS ADDS. The storage D228 built is right and is
-- reused unchanged: a capture HISTORY rather than a mutable cell, because the
-- drift between two boards is the signal. What changes is that a capture can
-- now say where it came from, and 'manual' is a first-class provenance value
-- rather than an absence.
--
-- A CHECK constraint cannot be altered in place, so this is the table-rebuild
-- shape migration 033 established. `odds_captures` has ON DELETE CASCADE
-- children (`odds_capture_entries.capture_id`), so the rebuild drops and
-- recreates the parent INSIDE the migration's own transaction with foreign
-- keys deferred by the runner - the children are re-pointed by id, which is
-- preserved verbatim by the INSERT ... SELECT below.

CREATE TABLE odds_captures_new (
  id INTEGER PRIMARY KEY,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  captured_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('equibase_html', 'manual')),
  raw_digest TEXT,
  correlation_id TEXT,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO odds_captures_new (id, race_day_id, captured_at, source, raw_digest, correlation_id, ingested_at)
  SELECT id, race_day_id, captured_at, source, raw_digest, correlation_id, ingested_at FROM odds_captures;
DROP TABLE odds_captures;
ALTER TABLE odds_captures_new RENAME TO odds_captures;
CREATE INDEX idx_odds_captures_day ON odds_captures(race_day_id, captured_at);
