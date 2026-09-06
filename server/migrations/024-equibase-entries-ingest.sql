-- betsheet:schema-rebuild
--
-- Equibase entries ingest (P-2 of the simulator pivot): a race day created
-- from a manually saved copy of Equibase's entries page, which is how a track
-- with no automated feed gets ingested at all now that the Del Mar program and
-- ML-sheet parsers are gone (D113).
--
-- Invariant 6 is not bent and is not being re-litigated: the parser
-- (shared/parsers/equibase-entries.js, D104) takes an HTML STRING and never
-- fetches. The file arrives because a person opened the page and saved it -
-- the same manual-upload posture as the Equibase OTR sheet.
--
-- TWO parts, and the first is why this file carries the rebuild header.
--
-- 1. race_days.entries_source must admit a new value. Migration 009 added it
--    as an ALTER carrying a CHECK, and SQLite cannot ALTER a CHECK, so the
--    table is rebuilt. **race_days is the root of ten ON DELETE CASCADE
--    children** (races, cards, race_results, exotic_payoffs, result_scratches,
--    result_charts, fetch_attempts, llm_card_requests, llm_notes,
--    simulation_results), which is exactly why the rebuild header exists: it
--    runs outside the wrapping transaction with foreign_keys OFF, because
--    dropping a parent with FKs ON would cascade every one of those tables to
--    empty. db.js re-enables FKs and runs foreign_key_check before commit.
--
--    The new value is `equibase_html`, NOT the `EQB_MANUAL_UPLOAD` the
--    requirements doc proposed. Deliberate: this column's existing vocabulary
--    is lowercase and names the DOCUMENT the entries came from - `program`,
--    `ml_sheet` - and `program` was a manual upload too, so "manual upload"
--    does not distinguish anything. `equibase_html` says which document it is,
--    in the casing its own column already uses. (`consensus_completeness` is
--    UPPERCASE; that is a different column with a different convention, and
--    copying it here would have made this one inconsistent with itself.)
--
-- 2. Ordinary ALTERs for the fields the Equibase page carries that nothing in
--    this schema had a home for. Every one is nullable and none is read by
--    any money calculation:
--
--    entries.live_odds / live_odds_decimal
--      The tote board price, when the capture was taken late enough to have
--      one. Stored BESIDE morning_line, never over it - both raw values are
--      always kept. **Storing this is inert; FEEDING it to generation would
--      not be.** shared/betmath.js's estimateTicketPayouts reads
--      morning_line_decimal, and pointing it at live odds instead would change
--      what every stored estimate means and would be an ENGINE_VERSION-class
--      change (invariant 14). Nothing does that here.
--
--    entries.medication      "L" (Lasix), "L1" and so on. NOT equipment -
--                            that column is blinkers-and-such, a different
--                            fact, and merging them would lose both.
--    entries.age_sex         "5/G", "3/F" - as the page prints it, one field,
--                            because splitting it invents a parse the source
--                            does not support.
--    entries.claim_price     The tag in a claiming race, as printed ("$22,500").
--                            The requirements doc did not list this one; it is
--                            added anyway because the parser already extracts
--                            it, it is real handicapping information, and a
--                            column dropped at ingest cannot be recovered
--                            without re-saving the page. not_to_be_claimed
--                            already existed and answers a different question.
--    entries.also_eligible   An AE horse is on the page but not in the body of
--                            the field. Kept and flagged rather than dropped,
--                            the same treatment scratches get.
--
--    race_days.odds_captured_at
--      When the page was saved. ONE timestamp for the whole card, which means
--      later races are staler than earlier ones by construction - that is the
--      design, and the per-race staleness indicator is what surfaces it, not a
--      defect to fix with per-race timestamps the source cannot supply.

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
    CHECK (entries_source IN ('program', 'ml_sheet', 'both', 'equibase_html')),
  meet TEXT,
  track_code TEXT,
  replayed_at TEXT,
  odds_captured_at TEXT,
  UNIQUE (track, date)
);

INSERT INTO race_days_new
  (id, track, date, bankroll_cents, per_race_min_cents, correlation_id,
   created_at, deleted_at, entries_source, meet, track_code, replayed_at)
SELECT
  id, track, date, bankroll_cents, per_race_min_cents, correlation_id,
  created_at, deleted_at, entries_source, meet, track_code, replayed_at
FROM race_days;

DROP TABLE race_days;
ALTER TABLE race_days_new RENAME TO race_days;

-- Recreate what the rebuild dropped. The UNIQUE(track, date) rides on the
-- table definition above; this index does not.
CREATE INDEX idx_race_days_meet ON race_days(meet);

-- ---- part 2: ordinary ALTERs ----
ALTER TABLE entries ADD COLUMN live_odds TEXT;
ALTER TABLE entries ADD COLUMN live_odds_decimal REAL;
ALTER TABLE entries ADD COLUMN medication TEXT;
ALTER TABLE entries ADD COLUMN age_sex TEXT;
ALTER TABLE entries ADD COLUMN claim_price TEXT;
ALTER TABLE entries ADD COLUMN also_eligible INTEGER NOT NULL DEFAULT 0;
