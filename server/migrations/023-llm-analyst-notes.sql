-- 023: per-race analyst notes for the LLM card generator (D92).
--
-- Free-text handicapper commentary the user pastes per race, fed to the model
-- as an ADVISORY, UNTRUSTED input. Notes never change bet sizing: stakes come
-- from the race bankroll and the wager menu, and the server re-validates every
-- stake regardless of what a note says.
--
-- llm_notes is the DRAFT: the only mutable table in the LLM subsystem, and
-- deliberately so - it is a scratchpad the user edits between generations. The
-- immutable record is the per-call snapshot on llm_card_requests below. That
-- split is invariant 15's shape: record the facts, let the working surface move.
--
-- Keyed by (race_day_id, race_number), NOT by card_id. Notes are a property of
-- a RACE, not a card: the same commentary should feed a Sonnet card and an Opus
-- card, which is the comparison cards.llm_model (D76) exists to enable. A
-- card_id key would also be unusable for the first preview of a brand-new card,
-- which necessarily precedes that card's existence (invariant 9, see D63).
CREATE TABLE llm_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  -- 0 = the card-level note for the whole day, prepended to every race's
  -- prompt. Real race numbers are always >= 1 (both llm-cards routes reject
  -- race <= 0), so 0 is unambiguously not a race and one UNIQUE covers both
  -- scopes without a second table or a nullable discriminator.
  race_number INTEGER NOT NULL CHECK (race_number >= 0),
  notes_text TEXT NOT NULL,
  source_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (race_day_id, race_number)
);
CREATE INDEX idx_llm_notes_day ON llm_notes(race_day_id);

-- The immutable snapshot, one per generate call. Ordinary ALTERs, no rebuild:
-- nothing here touches a CHECK constraint (migration 022 is the precedent), and
-- rebuilding an append-only audit log that carries an FK to cards would be real
-- risk for no benefit.
--
-- notes_race_text / notes_card_text: what the HUMAN typed, verbatim and
--   untruncated. Split in two so a findings query can dedupe the day-level note,
--   which is repeated into every race's prompt.
-- notes_hash / notes_char_count: over the COMPOSED, sanitized, TRUNCATED payload
--   the model actually received - not over the raw text above. The text columns
--   answer "what did the human write"; these answer "what did the model see".
-- notes_entered_at: the DRAFT's own updated_at at call time, i.e. when the human
--   wrote it - not when the call happened (requested_at already records that).
--   It is the only column a future blindness derivation could be built from.
-- notes_present: not purely derivable - it survives a future redaction of the
--   text columns, which matters because pasted commentary is someone else's
--   copyrighted prose.
-- notes_post_result: 1 when the day already had results at call time. Notes
--   written after a result is known are not blind; findings queries filter on it.
ALTER TABLE llm_card_requests ADD COLUMN notes_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_card_requests ADD COLUMN notes_race_text TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_card_text TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_source_label TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_hash TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_char_count INTEGER;
ALTER TABLE llm_card_requests ADD COLUMN notes_entered_at TEXT;
ALTER TABLE llm_card_requests ADD COLUMN notes_post_result INTEGER NOT NULL DEFAULT 0;

-- Card-level separability, so notes cards never pool with bare LLM cards in
-- P/L or simulation. A COLUMN rather than a new template id, for the same
-- reason D76 used cards.llm_model rather than multiplying engine_version:
-- strategy_template_id is set once in persistLlmRace's card-creation branch and
-- never updated, and both that route's `template !== 'llm'` guard and the
-- modal's card-discovery filter would reject an 'llm-notes' card outright.
--
-- IMPORTANT: this LATCHES, it does not freeze. Unlike llm_model (which is fixed
-- at creation and refuses a mismatched save with a 409), a user will realistically
-- have commentary for 3 of 8 races, so refusing the other 5 would make the
-- feature unusable. The honest reading is therefore "AT LEAST ONE race on this
-- card used notes", never "every race did" - per-race truth lives in
-- llm_card_requests.notes_present.
ALTER TABLE cards ADD COLUMN notes_present INTEGER NOT NULL DEFAULT 0;
