-- betsheet:schema-rebuild
--
-- Cards become APPEND-ONLY with a per-day ordinal and a full generation
-- recipe:
--   * UNIQUE(race_day_id, variant) is dropped - generating never
--     overwrites; every generation inserts a new row.
--   * card_number: 1, 2, 3... within its race day (display ordinal).
--   * per_race_min_cents joins bankroll_cents / variant /
--     consensus_completeness so the card row carries its complete recipe.
--   * id gains AUTOINCREMENT - same never-reuse rule the race-day id-reuse
--     bug taught (migration 006): trace events reference card ids forever.
-- Existing rows keep their ids; card_number is backfilled in id order
-- within each day; per_race_min_cents backfills from the race day.
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
    CHECK (consensus_completeness IN ('FULL', 'PARTIAL', 'PROGRAM_ONLY')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (race_day_id, card_number)
);
INSERT INTO cards_new (id, race_day_id, card_number, variant, strategy_template_id,
                       bankroll_cents, per_race_min_cents, status, correlation_id,
                       consensus_completeness, created_at)
  SELECT c.id, c.race_day_id,
         ROW_NUMBER() OVER (PARTITION BY c.race_day_id ORDER BY c.id),
         c.variant, c.strategy_template_id, c.bankroll_cents,
         rd.per_race_min_cents, c.status, c.correlation_id,
         c.consensus_completeness, c.created_at
  FROM cards c JOIN race_days rd ON rd.id = c.race_day_id;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
-- The old index died with the dropped table; recreate under its own name.
CREATE INDEX idx_cards_day ON cards(race_day_id);
