-- betsheet:schema-rebuild
--
-- 030: TIPSHEET becomes a card bucket (D171).
--
-- D166-D170 kept tip picks in their own table, on purpose: a ranked opinion is
-- not a card, and nothing staked money on it. Staking changes that - a tip
-- sheet now produces real tickets that the ordinary grader grades - so it
-- needs a bucket of its own, and invariant 13 requires that bucket never pool
-- with EQB_OTR, HUMAN, LLM_GENERATED or any lean-* engine version.
--
-- A CHECK constraint cannot be ALTERed, so this is a REBUILD. Same shape as
-- migrations 016 (HUMAN), 018 (LLM_GENERATED) and 020 (EQB_OTR), and it must
-- carry the FOUR columns added since 020 that those migrations never saw:
-- llm_model (022), notes_present (023), name (025), and external_id /
-- built_on / saw_reference_cards (027). Dropping one silently would destroy
-- LLM model attribution, the D152 import's idempotency key, or a card's name.
--
-- `cards` is the riskiest table here to rebuild: five ON DELETE CASCADE
-- children (tickets, allocations, publishes, human_race_state,
-- llm_card_requests), and DROP TABLE on a parent with FKs ON cascades those
-- deletes. The `-- betsheet:schema-rebuild` header runs this outside the
-- wrapping transaction with FKs OFF and requires foreign_key_check to pass
-- before commit. Verified against a copy of the REAL corpus (169 race days,
-- 136 cards, 6095 result rows), never a fixture - see the D171 ledger row.
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
    CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY',
                                      'HUMAN', 'LLM_GENERATED', 'EQB_OTR', 'TIPSHEET')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  engine_version TEXT NOT NULL DEFAULT 'lean-0',
  saw_classification INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT,
  notes_present INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  external_id TEXT,
  built_on TEXT,
  saw_reference_cards INTEGER NOT NULL DEFAULT 0,
  UNIQUE (race_day_id, card_number)
);
INSERT INTO cards_new (id, race_day_id, card_number, variant, strategy_template_id,
                       bankroll_cents, per_race_min_cents, status, correlation_id,
                       consensus_completeness, created_at, engine_version, saw_classification,
                       llm_model, notes_present, name, external_id, built_on, saw_reference_cards)
  SELECT id, race_day_id, card_number, variant, strategy_template_id,
         bankroll_cents, per_race_min_cents, status, correlation_id,
         consensus_completeness, created_at, engine_version, saw_classification,
         llm_model, notes_present, name, external_id, built_on, saw_reference_cards
  FROM cards;
-- Ids are never reused (migration 007): keep the AUTOINCREMENT high-water mark.
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'cards', COALESCE(MAX(id), 0) FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
-- BOTH indexes go with the dropped table and must come back. Checked against
-- the live database rather than assumed - the first draft of this migration
-- restored only the external_id one and would have silently dropped
-- idx_cards_day, which every per-day card lookup uses.
CREATE INDEX idx_cards_day ON cards(race_day_id);
-- Without this one the D153 static import would silently double every
-- re-import: external_id is its only idempotency key (migration 027).
CREATE UNIQUE INDEX idx_cards_external_id ON cards(external_id);
