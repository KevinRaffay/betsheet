-- 031: which tip sheet a TIPSHEET card came from (D174).
--
-- D171 recorded the source only inside `cards.name` ("trackmaster — Win on the
-- top pick"), which is a DISPLAY string. That was enough while staking was
-- append-only, and stops being enough the moment a card has to be found again:
-- one card per (race day, source, variant), extended as more races get tip
-- picks, instead of three fresh cards on every run.
--
-- A plain ADDITIVE column - no rebuild. Nothing about a CHECK changes, and
-- `cards` is the riskiest table here to rebuild (five ON DELETE CASCADE
-- children); migration 027 set the precedent of not rebuilding it for columns.
--
-- Same shape and purpose as `cards.llm_model` (022): the per-producer identity
-- a card is looked up by, set at creation and never rewritten. NULL for every
-- card that is not a tip sheet, which is honest rather than a sentinel.
ALTER TABLE cards ADD COLUMN tip_source_label TEXT;

-- Backfill the cards D171 already wrote. Safe to derive from the name because
-- D171 built it in exactly one place and one format - `<source> — <label>`
-- with an EM DASH - so the prefix is the source verbatim. Scoped to TIPSHEET
-- cards that actually match that shape; anything else is left NULL rather than
-- guessed at, and a NULL simply means the next stake starts a fresh card.
UPDATE cards
   SET tip_source_label = substr(name, 1, instr(name, ' — ') - 1)
 WHERE consensus_completeness = 'TIPSHEET'
   AND tip_source_label IS NULL
   AND name IS NOT NULL
   AND instr(name, ' — ') > 1;

-- The lookup this exists for.
CREATE INDEX idx_cards_tip_source ON cards(race_day_id, tip_source_label, variant);
