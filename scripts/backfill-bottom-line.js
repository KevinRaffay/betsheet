// D59: one-off retroactive fix. server/backfill.js's dayPayload() dropped
// parsed.merged.analysis before this PR, so every day the batch runner
// ever saved has races.bottom_line = NULL even though the program PDF's
// handicapper analysis was parsed and sitting right there. This re-parses
// each already-saved day's archived program (data/raw/DMR/<date>/) via
// the same parseArchivedDay() the runner itself uses, and fills in
// bottom_line for any race whose analysis text is now available.
//
// Idempotent and safe to re-run: only UPDATEs races.bottom_line, nothing
// else. Defaults to a dry run (reports what it WOULD change); --yes
// writes it. Run: npm run backfill-bottom-line -- [--yes] [--raw-dir dir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const write = args.includes('--yes');
const rawDirArg = args.includes('--raw-dir') ? args[args.indexOf('--raw-dir') + 1] : null;

const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server', 'db.js')));
const { parseArchivedDay } = await import(pathToFileURL(path.join(ROOT, 'server', 'backfill.js')));
const { DEFAULT_RAW_DIR } = await import(pathToFileURL(path.join(ROOT, 'server', 'dmtc-crawler.js')));
const { getLogger } = await import(pathToFileURL(path.join(ROOT, 'server', 'logging.js')));

const rawDir = rawDirArg ? path.resolve(rawDirArg) : DEFAULT_RAW_DIR;
const log = getLogger('app');
const db = getDb();

const days = db.prepare(`
  SELECT id, date, entries_source, meet FROM race_days
  WHERE deleted_at IS NULL AND entries_source IN ('program', 'both')
  ORDER BY date
`).all();

console.log(`${days.length} saved day(s) with a program parse to check, raw archive: ${rawDir}\n`);

let daysUpdated = 0;
let racesUpdated = 0;
let daysSkippedMissingArchive = 0;
let daysNoAnalysis = 0;
const details = [];

for (const day of days) {
  const alreadyHave = db.prepare('SELECT COUNT(*) n FROM races WHERE race_day_id = ? AND bottom_line IS NOT NULL').get(day.id).n;
  const totalRaces = db.prepare('SELECT COUNT(*) n FROM races WHERE race_day_id = ?').get(day.id).n;
  if (alreadyHave === totalRaces && totalRaces > 0) continue; // fully populated already

  let parsed;
  try {
    parsed = await parseArchivedDay({ date: day.date }, { rawDir });
  } catch (err) {
    console.error(`  ${day.date}: parse error - ${err.message}`);
    daysSkippedMissingArchive++;
    continue;
  }
  if (parsed.missing) {
    console.log(`  ${day.date}: skipped - archive missing (${parsed.missing.join(', ')})`);
    daysSkippedMissingArchive++;
    continue;
  }
  const analysis = parsed.merged?.analysis ?? [];
  if (analysis.length === 0) {
    console.log(`  ${day.date}: no handicapper-analysis pages found in this program - nothing to fill`);
    daysNoAnalysis++;
    continue;
  }

  let thisDayRaces = 0;
  const raceExists = db.prepare('SELECT 1 FROM races WHERE race_day_id = ? AND number = ?');
  const apply = db.transaction(() => {
    const upd = db.prepare('UPDATE races SET bottom_line = ? WHERE race_day_id = ? AND number = ?');
    for (const a of analysis) {
      if (!a.text) continue;
      if (write) {
        const info = upd.run(a.text, day.id, a.race);
        if (info.changes > 0) thisDayRaces++;
      } else if (raceExists.get(day.id, a.race)) {
        thisDayRaces++; // dry-run: same match condition the write path uses
      }
    }
  });
  apply();

  if (thisDayRaces > 0) {
    daysUpdated++;
    racesUpdated += thisDayRaces;
    details.push({ date: day.date, meet: day.meet, races: thisDayRaces });
    console.log(`  ${day.date} (${day.meet ?? 'no meet'}): ${write ? 'wrote' : 'would write'} bottom_line for ${thisDayRaces} race(s)`);
  }
}

console.log(`\n${write ? 'Wrote' : 'Would write'} bottom_line for ${racesUpdated} race(s) across ${daysUpdated} day(s).`);
console.log(`Skipped (archive missing): ${daysSkippedMissingArchive}. Skipped (no analysis pages in that program): ${daysNoAnalysis}.`);
if (!write) console.log('\nDry run - nothing written. Re-run with --yes to apply.');
else log.info('bottom_line_backfilled', { daysUpdated, racesUpdated, daysSkippedMissingArchive, daysNoAnalysis, details });
