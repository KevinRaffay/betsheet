-- betsheet:schema-rebuild
--
-- 040: COMBINED becomes a card bucket (D436).
--
-- A COMBINED card is a parlay whose legs were chosen by the combined per-race
-- model (shared/race-consensus.js, D434) - market odds nudged by tip sheets,
-- LLM cards and OTR. Invariant 13: it must never pool with any of the buckets
-- whose signals it reads, nor with HUMAN or any lean-* engine version, which
-- is why it is a bucket of its own rather than a variant of one of theirs.
--
-- A CHECK constraint cannot be ALTERed, so this is a REBUILD - the same shape
-- as 016 / 018 / 020 / 030, and it must carry the THREE columns added since
-- 030 that it never saw: tip_source_label (031), live_odds_present (037) and
-- tip_sheets_present (038). And THREE indexes, not two: 031 added
-- idx_cards_tip_source, which every per-source tip-card lookup uses. The
-- column list and the index list were both read off the live database's
-- sqlite_master on 2026-09-26, not reconstructed from the migrations.
--
-- `cards` has five ON DELETE CASCADE children (tickets, allocations,
-- publishes, human_race_state, llm_card_requests); the schema-rebuild header
-- runs this outside the wrapping transaction with FKs OFF and requires
-- foreign_key_check to pass before commit.
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
                                      'HUMAN', 'LLM_GENERATED', 'EQB_OTR', 'TIPSHEET',
                                      'COMBINED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  engine_version TEXT NOT NULL DEFAULT 'lean-0',
  saw_classification INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT,
  notes_present INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  external_id TEXT,
  built_on TEXT,
  saw_reference_cards INTEGER NOT NULL DEFAULT 0,
  tip_source_label TEXT,
  live_odds_present INTEGER NOT NULL DEFAULT 0,
  tip_sheets_present INTEGER NOT NULL DEFAULT 0,
  UNIQUE (race_day_id, card_number)
);
INSERT INTO cards_new (id, race_day_id, card_number, variant, strategy_template_id,
                       bankroll_cents, per_race_min_cents, status, correlation_id,
                       consensus_completeness, created_at, engine_version, saw_classification,
                       llm_model, notes_present, name, external_id, built_on, saw_reference_cards,
                       tip_source_label, live_odds_present, tip_sheets_present)
  SELECT id, race_day_id, card_number, variant, strategy_template_id,
         bankroll_cents, per_race_min_cents, status, correlation_id,
         consensus_completeness, created_at, engine_version, saw_classification,
         llm_model, notes_present, name, external_id, built_on, saw_reference_cards,
         tip_source_label, live_odds_present, tip_sheets_present
  FROM cards;
-- Ids are never reused (migration 007): keep the AUTOINCREMENT high-water mark.
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'cards', COALESCE(MAX(id), 0) FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX idx_cards_day ON cards(race_day_id);
CREATE UNIQUE INDEX idx_cards_external_id ON cards(external_id);
CREATE INDEX idx_cards_tip_source ON cards(race_day_id, tip_source_label, variant);
