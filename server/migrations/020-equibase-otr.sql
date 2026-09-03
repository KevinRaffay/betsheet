-- betsheet:schema-rebuild
--
-- Equibase "Off to the Races" PDF picker (D71): the free at-track sheet
-- ingests as a third static-picker bucket alongside HUMAN and LLM_GENERATED
-- - its printed tickets, taken verbatim, become a card of their own. This
-- PR writes nothing to consensus_picks (that's a separate later PR, gated
-- on a D09 three-source classification decision).
--
--   * consensus_completeness gains EQB_OTR - never pools with any engine
--     bucket, HUMAN, or LLM_GENERATED (invariant 13's extended bucket
--     list). Same shape as migrations 016/018: cards is rebuilt (id/
--     AUTOINCREMENT/saw_classification preserved).
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
    CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY', 'HUMAN', 'LLM_GENERATED', 'EQB_OTR')),
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
