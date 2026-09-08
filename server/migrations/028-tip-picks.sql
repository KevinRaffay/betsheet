-- 028: TIPSHEET picks extracted from a screenshot of a third-party
-- handicapping app (D166).
--
-- A NEW TABLE, not a widening of `cards`. That is the load-bearing shape
-- decision here, and it is what keeps this deliverable's promise that no
-- HUMAN / LLM / OTR schema or grading path is touched: a tip_picks row is a
-- RANKED OPINION someone else published, not a card. Nothing stakes money on
-- it yet (ticket construction is a later deliverable), so it has no tickets,
-- no allocations, no bankroll and no grade set, and `cards.consensus_
-- completeness` therefore does NOT gain a TIPSHEET value - which is why this
-- migration needs no table rebuild at all. When staking does arrive it will
-- write ordinary cards that REFERENCE these rows; it will not turn these rows
-- into cards.
--
-- Deliberately NO completeness column. Invariant 13 buckets on what SIGNAL a
-- card had, and every tipsheet row has exactly one signal: the source's own
-- ranking. Odds ride along when the screenshot happens to show them, but they
-- are a nicety, not a tier - EQB_OTR carries no odds either and is not graded
-- on a completeness axis for it. Scoring for this bucket is rank-based (win %,
-- rank accuracy), so there is no odds-calibration branch a completeness level
-- would ever be read by.
CREATE TABLE tip_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  -- Real race numbers only. Unlike llm_notes (migration 023), 0 has no
  -- day-level meaning here: a tipsheet pick is always about one race.
  race_no INTEGER NOT NULL CHECK (race_no >= 1),

  -- Single-valued today, and a CHECK rather than a bare TEXT so a writer
  -- cannot quietly file a row into a bucket that does not exist. Invariant 13:
  -- TIPSHEET never pools with EQB_OTR, HUMAN, LLM_GENERATED or any lean-*
  -- bucket without an explicit choice. A future second screenshot-derived
  -- bucket extends this list in its own migration.
  bucket TEXT NOT NULL DEFAULT 'TIPSHEET' CHECK (bucket IN ('TIPSHEET')),

  -- WHOSE opinion this is: 'trackmaster', 'numberfire', 'tipsheet-other', ...
  -- Free TEXT, NOT a CHECK constraint, and not the `source_label` vocabulary
  -- from docs/requirements/card-source-model.md P-3.2 - that vocabulary is
  -- unscheduled and exists nowhere in this schema (see the D166 ledger row).
  -- The seed list lives in shared/tip-picks.js as a CONSTANT the extractor
  -- steers the model toward, because the set of tip apps someone screenshots
  -- is still being discovered, and a CHECK here would make meeting a new one
  -- at the track a schema migration. Grouping stays clean by normalizing the
  -- label on the way in, not by refusing unknown ones.
  source_label TEXT NOT NULL,

  -- The ranked picks: a JSON array of
  --   { horse_no, horse_name, rank, ml_odds?, live_odds? }
  -- ordered by rank, rank starting at 1. Odds are OMITTED (not null-filled,
  -- not guessed) when the screenshot does not show them - absence of odds is a
  -- normal tipsheet, never a failed extraction. Stored as JSON text rather
  -- than a child table because a pick list is read and written whole, always
  -- belongs to exactly one row, and has no independent identity: there is no
  -- query that wants one horse's pick without the ranking it sits in.
  picks TEXT NOT NULL,

  -- When the screenshot was TAKEN (the odds/scratches it shows are as of this
  -- moment), not when it was extracted - created_at records that. Nullable
  -- because a file's mtime is the only evidence available for an image
  -- someone forwarded, and a wrong capture time is worse than a missing one.
  captured_at TEXT,

  -- The model's unedited response, before any parse or normalization. The
  -- audit half of invariant 11's spirit: an extraction that read a horse's
  -- number wrong must be diagnosable later without re-running a paid vision
  -- call against an image that may be gone. Kept even when the parse
  -- SUCCEEDED, for the same reason llm_card_requests keeps prompt_text.
  raw_extraction TEXT,

  -- Which model read the image, and a sha256 of the image bytes. Two
  -- extractions of the same screenshot under different models are the
  -- comparison this bucket exists to make possible; the hash is what proves
  -- they read the same pixels.
  model TEXT,
  image_sha256 TEXT,

  created_at TEXT NOT NULL,

  -- One extraction per (day, race, source). Re-extracting the same race from
  -- the same app REPLACES rather than accumulating - a second screenshot of
  -- one app's picks for one race is a correction, not a second opinion.
  UNIQUE (race_day_id, race_no, source_label)
);
CREATE INDEX idx_tip_picks_day ON tip_picks(race_day_id);
