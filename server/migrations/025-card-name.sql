-- D137: an optional human-friendly label on a card, so building several
-- HUMAN cards for the same race day - different strategies tried side by
-- side, D28 append-only already allows it - can be told apart by more than
-- card_number. Ordinary ALTER (nullable, no CHECK, free text): same shape
-- as D76's cards.llm_model. Generic on `cards` rather than human-only -
-- no reason a future LLM or OTR card couldn't carry one too, and a single
-- column is simpler than three near-identical ones. Set once, at creation,
-- by whichever writer is given one; never overwritten by a later call on
-- the same card (mirrors llm_model's frozen-at-creation convention).
ALTER TABLE cards ADD COLUMN name TEXT;
