-- Human cards (D54): a human's pasted tickets become a first-class card,
-- graded by the existing grader, in their own completeness bucket. Every
-- change here is additive - ordinary migration, no rebuild needed.
--
--   * tickets.rationale_text carries the human's pasted rationale verbatim
--     (distinct from tickets.rationale, which engine tickets already use
--     for the algorithm's own explanation - human tickets set both to the
--     same text so CardView.jsx needs no change to display it).
--   * tickets.odds_at_bet carries the odds column verbatim, recorded only,
--     never used for math.
--   * race_days.replayed_at is set the first time any race on the day is
--     ever locked on a human card (persistHumanRace, server/human-cards.js)
--     - a later Replay UI (D55) reads it, but the write belongs with the
--     writer regardless of caller.
--   * human_race_state records, per (card, race), when picks were locked
--     and (later) when results were revealed - the two timestamps that let
--     blindness be derived rather than set by hand. `passed` marks an
--     explicit PASS (zero tickets that race) so a passed race doesn't need
--     a placeholder ticket the grader would have to special-case.
ALTER TABLE tickets ADD COLUMN rationale_text TEXT;
ALTER TABLE tickets ADD COLUMN odds_at_bet TEXT;
ALTER TABLE race_days ADD COLUMN replayed_at TEXT;

CREATE TABLE human_race_state (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  picks_locked_at TEXT NOT NULL,
  results_revealed_at TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (card_id, race_number)
);
CREATE INDEX idx_human_race_state_card ON human_race_state(card_id);
