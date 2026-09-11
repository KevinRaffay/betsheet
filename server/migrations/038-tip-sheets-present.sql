-- 038: which LLM cards actually SAW a tip sheet (D369).
--
-- D179 put the day's tip sheets (D176's `tip_picks`) into the prompt as a
-- labelled BASELINE PICKS block, and chose NOT to record that in a column:
-- `prompt_text` stores the whole user prompt verbatim, so the block is
-- captured for free, and D221's `llmInputsLabel` reads it back out by grep.
-- D234 then argued the opposite for the tote board, and the argument holds
-- here too: a grep bets on a rendering detail of a template whose own history
-- (D112/D125/D136/D145/D160/D178...) is a record of changing, and the day it
-- changes every historical label silently flips. `cards.notes_present` (D92)
-- and `cards.live_odds_present` (D234) are columns; this is the third input,
-- recorded the same way, so that "did this card see live odds and tip sheets"
-- is two flags on the row and not one flag plus a string scan.
--
-- TIP SHEETS ONLY, not the whole baseline. The BASELINE PICKS block carries
-- two sources - tip sheets and Equibase's Off to the Races - and they are
-- different experiments: a tip sheet is a person's ranked opinion, OTR is an
-- algorithm's printed tickets. The request was for tip sheets; OTR stays
-- readable through `llmInputsLabel` (`otr`/`both`) until it earns its own
-- column.
--
-- TWO COLUMNS, MIRRORING NOTES AND THE BOARD EXACTLY:
--   * llm_card_requests.tip_sheets_present - did THIS race's generation carry
--     at least one tip sheet. The per-race truth.
--   * cards.tip_sheets_present - did AT LEAST ONE race on this card. It
--     LATCHES, for D92's reason: a sheet realistically covers some races and
--     not others, and a flag meaning "every race" would read false on every
--     real card.
--
-- Ordinary ALTERs - no CHECK touches either column, so no table rebuild.

ALTER TABLE cards ADD COLUMN tip_sheets_present INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_card_requests ADD COLUMN tip_sheets_present INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Backfill 1: link the request row that CREATED each card to that card.
--
-- The first race of a brand-new LLM card is previewed before the card exists
-- (invariant 9: preview first, the card is only minted on save), so its
-- request row was written with card_id NULL - and nothing ever set it
-- afterwards. Every per-race read keyed on `card_id` therefore missed race
-- one of every card: D221's inputs label, D234's per-race `saw_board`, and
-- the modal's own `/cards/:id/llm-requests` list. Measured on the corpus at
-- D369: 74 of 488 request rows had no card; 34 of those match exactly one
-- card on the same day by correlation id (invariant 8 - one id per card
-- session, and `cards.correlation_id` is that session's), 0 match more than
-- one, and the remaining 40 were previews never saved on any card.
-- `server/llm-cards.js` now sets card_id at save time; this repairs history.
-- Guarded to exactly-one match so an ambiguous session can never be guessed.
UPDATE llm_card_requests
   SET card_id = (SELECT c.id FROM cards c
                   WHERE c.correlation_id = llm_card_requests.correlation_id
                     AND c.race_day_id = llm_card_requests.race_day_id)
 WHERE card_id IS NULL
   AND correlation_id IS NOT NULL
   AND (SELECT COUNT(*) FROM cards c
         WHERE c.correlation_id = llm_card_requests.correlation_id
           AND c.race_day_id = llm_card_requests.race_day_id) = 1;

-- ---------------------------------------------------------------------------
-- Backfill 2: the per-race flag, from the stored prompt.
--
-- A one-time derivation at migration time is a different thing from a
-- derivation on every read - migration 031 did exactly this for
-- `tip_source_label`. The BASELINE PICKS block (server/llm-prompt.js) renders
-- tip-sheet lines FIRST and the single OTR line LAST, so the block's first
-- line is a tip sheet's whenever any tip sheet was present. This expression
-- was checked against `llmInputsLabel` on every one of the 488 stored
-- prompts before shipping: identical on all of them (149 tipsheet/both).
-- `char(10)` because the prompt is joined with '\n' - never CRLF.
UPDATE llm_card_requests
   SET tip_sheets_present = 1
 WHERE instr(prompt_text, char(10) || 'BASELINE PICKS' || char(10)) > 0
   AND substr(prompt_text,
              instr(prompt_text, char(10) || 'BASELINE PICKS' || char(10)) + 16,
              25) <> 'Equibase Off to the Races';

-- Backfill 3: the card latch, from the rows that could have been saved. A
-- failed call (error set) is refused by persistLlmRace and can never have
-- latched, so it is excluded here for the same reason.
UPDATE cards
   SET tip_sheets_present = 1
 WHERE tip_sheets_present = 0
   AND EXISTS (SELECT 1 FROM llm_card_requests r
                WHERE r.card_id = cards.id
                  AND r.tip_sheets_present = 1
                  AND r.error IS NULL);
