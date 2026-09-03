-- betsheet:schema-rebuild
--
-- LLM cards (D63): a manual, per-race LLM-generated card as a third
-- comparison point alongside lean and human - investigating whether a
-- non-static LLM picker beats the static rules engine, not replacing it.
--
--   * consensus_completeness gains LLM_GENERATED - never pools with any
--     engine bucket or with HUMAN (invariant 13's extended bucket list).
--     The CHECK constraint lives on the cards table, so cards is rebuilt
--     (same shape as migration 016, ids/AUTOINCREMENT/saw_classification
--     from 017 all preserved).
--   * llm_card_requests is the audit log of every LLM call for a card's
--     races - one row per call, success or failure, never overwritten
--     (mirrors fetch_attempts' "every attempt is visible" rule, invariant
--     11). race_day_id is always known (the day the call was made for);
--     card_id is nullable because the FIRST call for a brand-new card
--     necessarily happens before that card exists (preview never writes
--     game data - invariant 9 - so nothing is persisted from a preview
--     except this log row). A row is never updated after insert, so an
--     early race's card_id stays null even once the card is created by a
--     later confirm; race_day_id + race_number still make it findable.
CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  card_number INTEGER NOT NULL,
  variant TEXT NOT NULL DEFAULT 'default',
  strategy_template_id INTEGER REFERENCES strategy_templates(id),
  bankroll_cents INTEGER NOT NULL,
  per_race_min_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  correlation_id TEXT NOT NULL,
  consensus_completeness TEXT NOT NULL DEFAULT 'PROGRAM_ONLY'
    CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY', 'HUMAN', 'LLM_GENERATED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  engine_version TEXT NOT NULL DEFAULT 'lean-0',
  saw_classification INTEGER NOT NULL DEFAULT 0,
  UNIQUE (race_day_id, card_number)
);
INSERT INTO cards_new (id, race_day_id, card_number, variant, strategy_template_id,
                       bankroll_cents, per_race_min_cents, status, correlation_id,
                       consensus_completeness, created_at, engine_version, saw_classification)
  SELECT id, race_day_id, card_number, variant, strategy_template_id,
         bankroll_cents, per_race_min_cents, status, correlation_id,
         consensus_completeness, created_at, engine_version, saw_classification
  FROM cards;
-- Keep the AUTOINCREMENT high-water mark: ids are never reused (007).
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'cards', COALESCE(MAX(id), 0) FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX idx_cards_day ON cards(race_day_id);

CREATE TABLE llm_card_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_day_id INTEGER NOT NULL REFERENCES race_days(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
  race_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  response_text TEXT,
  model TEXT,
  requested_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX idx_llm_card_requests_day ON llm_card_requests(race_day_id);
CREATE INDEX idx_llm_card_requests_card ON llm_card_requests(card_id);
