// D82: one-off. Sports from the Basement is no longer a source of anything,
// so its stored consensus picks must stop feeding the engine - a card
// regenerated on an affected day would otherwise still be built partly on
// SFTB, and every stored classification on those races was computed with an
// SFTB vote in it.
//
// What this does, and deliberately does not do:
//   - DELETES consensus_picks rows for the SFTB source. Those are signal.
//   - RE-CLASSIFIES every race that lost a pick, through the same
//     classifyAndPersist() the fetch runner uses, so races.classification /
//     classification_source_count / classification_agreement / contrarian
//     flags reflect the sources that remain. Leaving them would keep an
//     SFTB-derived call on the row under a different name.
//   - KEEPS fetch_attempts rows. Invariant 11 exists so a source's fetch
//     history stays visible; deleting the audit trail to tidy up is exactly
//     what it forbids. Same for the decision-trace log files.
//   - DISABLES the sources row (enabled = 0) rather than deleting it, so the
//     kept fetch_attempts keep their foreign key and the history stays
//     readable.
//
// Idempotent: a second run finds no picks and re-disables nothing.
// Dry run by default (reports what it WOULD change); --yes writes.
// Run: npm run remove-sftb-picks [-- --yes]

import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.slice(2).includes('--yes');

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { classifyAndPersist } = await import(pathToFileURL(path.join(ROOT, 'server', 'consensus.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const SOURCE_NAME = 'Sports from the Basement';
const log = getLogger('app');
const db = getDb();

const source = db.prepare('SELECT id, name, enabled FROM sources WHERE name = ?').get(SOURCE_NAME);
if (!source) {
  console.log(`No "${SOURCE_NAME}" source row in this database. Nothing to do.`);
  process.exit(0);
}

const picks = db.prepare(`
  SELECT cp.id, cp.race_id, r.number AS race_number, r.race_day_id, d.date, d.track
  FROM consensus_picks cp
  JOIN races r ON r.id = cp.race_id
  JOIN race_days d ON d.id = r.race_day_id
  WHERE cp.source_id = ?
  ORDER BY d.date, r.number
`).all(source.id);

const attempts = db.prepare('SELECT COUNT(*) n FROM fetch_attempts WHERE source_id = ?').get(source.id).n;
const races = [...new Map(picks.map((p) => [p.race_id, p])).values()];
const days = [...new Set(picks.map((p) => p.race_day_id))];

console.log(`source "${source.name}" (id ${source.id}, enabled=${source.enabled})`);
console.log(`  ${picks.length} consensus pick(s) across ${races.length} race(s) on ${days.length} day(s)`);
console.log(`  ${attempts} fetch_attempts row(s) - KEPT (invariant 11: a source's fetch history stays visible)\n`);
for (const r of races) console.log(`  ${r.date} race ${r.race_number}`);

if (!write) {
  console.log(`\nDry run - nothing written. Re-run with --yes to delete the picks, re-classify the ${days.length} affected day(s) and disable the source.`);
  process.exit(0);
}

const apply = db.transaction(() => {
  db.prepare('DELETE FROM consensus_picks WHERE source_id = ?').run(source.id);
  db.prepare('UPDATE sources SET enabled = 0 WHERE id = ?').run(source.id);
});
apply();

// Re-classify OUTSIDE the delete transaction: classifyAndPersist runs its own,
// and a race whose last external pick just went is supposed to fall back to
// the program-only defaults rather than keep a stale call.
//
// It takes a loaded day ({ id, races: [{ id, number, entries }] }), the same
// shape server/equibase-otr.js builds - and it classifies the WHOLE day, so
// this iterates days, not races.
const raceRows = db.prepare('SELECT id, number FROM races WHERE race_day_id = ? ORDER BY number');
const entriesFor = db.prepare('SELECT * FROM entries WHERE race_id = ?');
let reclassified = 0;
for (const dayId of days) {
  const dayRaces = raceRows.all(dayId).map((r) => ({ id: r.id, number: r.number, entries: entriesFor.all(r.id) }));
  classifyAndPersist(db, { id: dayId, races: dayRaces }, `sftb-removal-${dayId}`);
  reclassified += dayRaces.length;
}

console.log(`\nDeleted ${picks.length} pick(s), re-classified ${reclassified} race(s), disabled the source.`);
console.log(`Kept ${attempts} fetch_attempts row(s) and every decision-trace entry.`);
log.info('sftb_picks_removed', { sourceId: source.id, picks: picks.length, races: reclassified, days: days.length, attemptsKept: attempts });
