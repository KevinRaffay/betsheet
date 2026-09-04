-- D76: identify which Claude model generated an LLM card (D75 added the
-- picker; nothing recorded the choice at the CARD level - only per-request
-- in llm_card_requests). `cards.llm_model` is set once, at card creation,
-- from the model that answered the first race persisted onto it, and never
-- overwritten - mirrors how `engine_version` is frozen per card (invariant
-- 14's spirit) so a card's identity never drifts mid-comparison. Ordinary
-- ALTER (nullable, no CHECK - validated at the API layer against
-- server/anthropic-client.js's SELECTABLE_MODELS, same as every other
-- free-text provenance column in this schema).

ALTER TABLE cards ADD COLUMN llm_model TEXT;
