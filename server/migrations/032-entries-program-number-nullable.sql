-- betsheet:schema-rebuild
--
-- 032: a scratched horse may have NO program number (D180).
--
-- Equibase prints two kinds of scratched row. One is a full row that keeps its
-- number and carries a scratch reason - 153 such rows are stored and are not
-- touched here. The other REPLACES the number and post-position cells with a
-- single marker:
--
--   <tr class="scratch"><td colspan="2"><b> SCR</b></td><td>King of Clubs</td>
--
-- so the number is genuinely absent from the page. Verified against the saved
-- Equibase capture for DMR 2026-09-06, not inferred.
--
-- `shared/parsers/equibase-entries.js` reads that correctly and returns
-- `programNumber: null`. The lie was introduced downstream, by this column
-- being NOT NULL: `insertRaceDay` substituted the literal 'SCR', and D122 had
-- to add 'SCR-2', 'SCR-3' when a race scratched more than one horse, because
-- the placeholders collided on UNIQUE(race_id, program_number) and failed the
-- whole day's insert.
--
-- NULL is what the page actually says. It also dissolves the collision rather
-- than working around it: SQLite's UNIQUE permits ANY NUMBER of NULLs, so two
-- scratches in one race need no suffix, no counter and no ordering - which
-- makes the stored value independent of the order rows happen to be parsed in,
-- something 'SCR-2' never was.
--
-- 150 rows are backfilled. Every one is `scratched = 1` (checked), so the
-- backfill cannot touch a horse that has a real number.
--
-- Rebuild rather than ALTER because dropping NOT NULL needs one. `entries` has
-- no ON DELETE CASCADE children - the two rows referencing it
-- (consensus_picks, otr_consensus_picks) are ON DELETE SET NULL - so this is
-- far less dangerous than the `cards` rebuild in 030. Verified against a
-- VACUUM INTO copy of the real corpus: 13,710 rows, 76 referencing
-- consensus_picks rows, foreign_key_check clean.
CREATE TABLE entries_new (
  id INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  -- NULLABLE (D180). NULL means "this horse has no printed program number",
  -- which is only ever true of a scratched row, and is a fact rather than a
  -- placeholder. Readers must treat NULL as "no number", never as a name.
  program_number TEXT,
  post_position INTEGER,
  horse_name TEXT NOT NULL,
  morning_line TEXT,
  morning_line_decimal REAL,
  jockey TEXT,
  trainer TEXT,
  weight INTEGER,
  equipment TEXT,
  scratched INTEGER NOT NULL DEFAULT 0,
  not_to_be_claimed INTEGER NOT NULL DEFAULT 0,
  program_rank INTEGER,
  best_bet INTEGER NOT NULL DEFAULT 0,
  live_odds TEXT,
  live_odds_decimal REAL,
  medication TEXT,
  age_sex TEXT,
  claim_price TEXT,
  also_eligible INTEGER NOT NULL DEFAULT 0,
  UNIQUE (race_id, program_number)
);
INSERT INTO entries_new (id, race_id, program_number, post_position, horse_name,
                         morning_line, morning_line_decimal, jockey, trainer, weight,
                         equipment, scratched, not_to_be_claimed, program_rank, best_bet,
                         live_odds, live_odds_decimal, medication, age_sex, claim_price,
                         also_eligible)
  SELECT id, race_id,
         -- The backfill. Scoped to scratched rows AND the placeholder shape,
         -- so a horse legitimately numbered (there is no such number, but the
         -- guard costs nothing) cannot be blanked.
         CASE WHEN scratched = 1 AND program_number LIKE 'SCR%' THEN NULL
              ELSE program_number END,
         post_position, horse_name,
         morning_line, morning_line_decimal, jockey, trainer, weight,
         equipment, scratched, not_to_be_claimed, program_rank, best_bet,
         live_odds, live_odds_decimal, medication, age_sex, claim_price,
         also_eligible
  FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
-- The index goes with the dropped table and must come back (migration 030's
-- lesson: check the live index list, do not trust the previous migration).
CREATE INDEX idx_entries_race ON entries(race_id);
