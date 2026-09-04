-- D74: Equibase "Off to the Races" as a third, independent consensus
-- source (D07 stands - still no fetcher; the picks come from the PDF D71/
-- D72 already archive and parse). Two schema changes:
--
--   * consensus_picks.pick_type gains 'also' - the sheet's box-only
--     mentions (its 4-horse exacta box minus the show/win picks it DOES
--     rank) have no printed rank at all, so they can never honestly be
--     'third'/'fourth'. CHECK constraints can't be ALTERed in SQLite, so
--     this is a rebuild (id is a plain INTEGER PRIMARY KEY, not
--     AUTOINCREMENT, so no sqlite_sequence bookkeeping is needed - rows
--     are already routinely deleted/reinserted by consensus.js's
--     storePicks refresh-on-reupload semantics).
--   * races.classification_agreement (ordinary ALTER, nullable, no
--     rebuild needed for a new column): how many sources share the
--     plurality top pick (shared/classification.js's `agreement`, D09's
--     three-source rule) - stored so a majority view is available in the
--     table and future templates without reclassifying anything now.

-- betsheet:schema-rebuild

CREATE TABLE consensus_picks_new (
  id INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  program_number TEXT,
  horse_name TEXT,
  pick_type TEXT NOT NULL CHECK (pick_type IN
    ('top', 'second', 'third', 'also', 'watch_out', 'contrarian')),
  note TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO consensus_picks_new
    (id, race_id, source_id, entry_id, program_number, horse_name, pick_type, note, fetched_at)
  SELECT id, race_id, source_id, entry_id, program_number, horse_name, pick_type, note, fetched_at
  FROM consensus_picks;
DROP TABLE consensus_picks;
ALTER TABLE consensus_picks_new RENAME TO consensus_picks;

ALTER TABLE races ADD COLUMN classification_agreement INTEGER;
