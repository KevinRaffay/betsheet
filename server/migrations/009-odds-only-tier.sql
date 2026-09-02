-- betsheet:schema-rebuild
--
-- Morning-line sheet as entries source of record (D40).
--
--   * race_days.entries_source records which document(s) the day's entries
--     came from: 'program' (the program PDF or pasted entries, as before),
--     'ml_sheet' (the track's ML/changes PDF alone), 'both' (sheet as the
--     record, program for analysis).
--   * consensus_completeness gains ODDS_ONLY, a tier BELOW PROGRAM_ONLY: no
--     external sources AND no program analysis (no programRank anywhere on
--     the day) - morning lines are the only signal. The CHECK constraint
--     lives on the cards table, so cards is rebuilt (same shape as 007,
--     ids and AUTOINCREMENT preserved).
ALTER TABLE race_days ADD COLUMN entries_source TEXT NOT NULL DEFAULT 'program'
  CHECK (entries_source IN ('program', 'ml_sheet', 'both'));

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
    CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  engine_version TEXT NOT NULL DEFAULT 'lean-0',
  UNIQUE (race_day_id, card_number)
);
INSERT INTO cards_new (id, race_day_id, card_number, variant, strategy_template_id,
                       bankroll_cents, per_race_min_cents, status, correlation_id,
                       consensus_completeness, created_at, engine_version)
  SELECT id, race_day_id, card_number, variant, strategy_template_id,
         bankroll_cents, per_race_min_cents, status, correlation_id,
         consensus_completeness, created_at, engine_version
  FROM cards;
-- Keep the AUTOINCREMENT high-water mark: ids are never reused (007).
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  SELECT 'cards', COALESCE(MAX(id), 0) FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX idx_cards_day ON cards(race_day_id);
