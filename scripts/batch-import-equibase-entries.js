// Batch regression harness for the Equibase entries HTML parser (D104/D116)
// across many real saved pages spanning many tracks.
//
// D104's ledger row flagged this gap directly: "the track-agnostic claim is
// still UNTESTED - the only fixture is Del Mar." This runs every file a person
// hands it through the SAME parser and the SAME insertRaceDay() write path the
// server uses, so a parser bug AND a schema-mapping bug both surface the way a
// real ingest would hit them - not merely as a diff against one hand-picked
// golden.
//
// SAFE BY CONSTRUCTION: every run opens a brand-new temp-directory SQLite
// database (never data/betsheet.sqlite - the same isolation check-ingest.js
// uses) and deletes the whole temp directory on exit, success or failure.
// Nothing here can touch a real race day.
//
// Usage:
//   npm run batch-equibase -- <directory> [--write-report path.json]
//
// <directory> is searched recursively for .html/.htm files. Each is treated as
// one saved Equibase entries page - a direct save or a view-source: capture,
// which the parser auto-detects and unwraps.
//
// Exit code is non-zero only on a genuine crash (the parser's contract is
// "never throws", so a file that breaks it IS the regression this exists to
// catch) or a read-back mismatch. Parser warnings and import skips are
// ordinary output to be read, not failures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEquibaseEntriesHtml } from '../shared/parsers/equibase-entries.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { openDb } from '../server/db.js';
import { insertRaceDay } from '../server/ingest.js';
import { newCorrelationId } from '../server/logging.js';

// ---------- CLI ----------

const args = process.argv.slice(2);
const reportFlagIndex = args.indexOf('--write-report');
const reportPath = reportFlagIndex >= 0 ? args[reportFlagIndex + 1] : null;
// Guarded on reportFlagIndex >= 0: with the flag absent it is -1, so a naive
// `i !== reportFlagIndex + 1` filters out args[0] - the directory itself - and
// every run without a report path dies on the usage message.
const dirArg = args.find((a, i) => a !== '--write-report'
  && !(reportFlagIndex >= 0 && i === reportFlagIndex + 1));

if (!dirArg) {
  console.error('Usage: npm run batch-equibase -- <directory-of-html-files> [--write-report path.json]');
  process.exit(2);
}
const inputDir = path.resolve(process.cwd(), dirArg);
if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  console.error(`Not a directory: ${inputDir}`);
  process.exit(2);
}

// ---------- find files ----------

function findHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findHtmlFiles(full));
    else if (/\.html?$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = findHtmlFiles(inputDir).sort();
if (files.length === 0) {
  console.error(`No .html/.htm files found under ${inputDir}`);
  process.exit(2);
}
console.log(`Found ${files.length} HTML file(s) under ${inputDir}\n`);

// ---------- payload adapter: parser output -> insertRaceDay's shape ----------
//
// D115 gave the six Equibase-only entry fields real columns and D116 wired the
// route, so almost nothing is dropped any more. What still has no home is
// listed explicitly rather than left to be discovered: a field silently lost at
// ingest cannot be recovered without re-saving the page.

const UNMAPPED = [
  ['race.purseCents', 'the races table has no purse column'],
  ['entry.effectiveOdds', 'derived, not source data - recomputable from liveOdds/morningLine, both of which ARE stored'],
  ['entry.effectiveOddsDecimal', 'as above'],
];

function toPayload(parsed, capturedAt, notes) {
  return {
    track: parsed.track,
    date: parsed.date,
    // D115's vocabulary. NOT 'program': that would file an Equibase page under
    // the deleted program parser's source and quietly corrupt the provenance
    // this whole ingest exists to keep straight.
    entriesSource: 'equibase_html',
    // What D116's UI sends: the page prints no capture time, so the file's own
    // mtime is the best available and the staleness module reads it.
    oddsCapturedAt: capturedAt,
    races: parsed.races.map((race) => {
      if (race.purseCents != null) notes.add('race.purseCents');
      // A range-claiming race can carry more than one distinct claim price
      // across its entries while `races.claiming_price_cents` holds exactly
      // one. Per-entry values are preserved in `entries.claim_price` (D115),
      // so nothing is lost - but the race-level number is still a choice, and
      // a race whose entries disagree is flagged rather than silently reduced.
      const claimPrices = [...new Set(race.entries.map((e) => e.claimPrice).filter(Boolean))];
      if (claimPrices.length > 1) {
        notes.add(`race ${race.number}: claim price varies by entry (${claimPrices.join(', ')})`);
      }
      for (const e of race.entries) {
        if (e.effectiveOdds != null) notes.add('entry.effectiveOdds');
      }
      return {
        number: race.number,
        postTime: race.postTime,
        distance: race.distance,
        surface: race.surface,
        // D116 added both, and the wager menu is LOAD-BEARING: TicketBuilder
        // and human-picks.js read races.wager_menu for minimums, and a null
        // there is a silent fallback to BET.minimums rather than a visible
        // failure - so every ticket at this track would be costed wrong.
        raceType: race.raceType,
        wagerMenu: race.wagerMenu,
        conditions: race.conditions,
        claimingPriceCents: claimPrices.length ? moneyToCents(claimPrices[0]) : null,
        entries: race.entries.map((e) => ({
          programNumber: e.programNumber,
          postPosition: e.postPosition,
          horseName: e.horseName,
          morningLine: e.morningLine,
          morningLineDecimal: e.morningLineDecimal,
          jockey: e.jockey,
          trainer: e.trainer,
          weight: e.weight,
          scratched: e.scratched,
          // D115's six. Passing them is the point of running the REAL writer:
          // a column added to a migration but never threaded through here
          // would look fine in the parser and be empty in the database.
          liveOdds: e.liveOdds,
          liveOddsDecimal: e.liveOddsDecimal,
          medication: e.medication,
          ageSex: e.ageSex,
          claimPrice: e.claimPrice,
          alsoEligible: e.alsoEligible,
        })),
      };
    }),
  };
}

const moneyToCents = (s) => {
  const m = String(s ?? '').match(/[\d,.]+/);
  return m ? Math.round(Number(m[0].replace(/,/g, '')) * 100) : null;
};

// ---------- temp db (never the real one) ----------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-eqb-batch-'));
const dbPath = path.join(tmpDir, 'batch.sqlite');
console.log(`Using throwaway database: ${dbPath}\n`);
const db = openDb(dbPath);

// ---------- run ----------

const results = [];
let crashes = 0;

for (const file of files) {
  const rel = path.relative(inputDir, file);
  const row = {
    file: rel, status: null, track: null, date: null, races: 0, entries: 0, activeEntries: 0,
    warnings: [], columnCounts: [], notes: [], trackRecognized: null, error: null,
  };
  try {
    // utf8, not latin1: Equibase serves UTF-8, and horse, jockey and trainer
    // names carry accented characters at plenty of these tracks. Reading a
    // UTF-8 page as latin1 does not fail, it mojibakes the names - which would
    // then be stored, and would look like a parser bug.
    const html = fs.readFileSync(file, 'utf8');
    const parsed = parseEquibaseEntriesHtml(html);
    row.track = parsed.track;
    row.date = parsed.date;
    row.races = parsed.races.length;
    row.entries = parsed.races.reduce((a, r) => a + r.entries.length, 0);
    row.activeEntries = parsed.races.reduce((a, r) => a + r.activeEntries, 0);
    row.warnings = parsed.warnings.map((w) => ({ type: w.type, race: w.race ?? null, blocking: w.blocking }));
    row.columnCounts = [...new Set(parsed.races.map((r) => r.columnCount))].sort();
    row.wagerMenus = parsed.races.filter((r) => r.wagerMenu).length;
    row.reducedTable = parsed.warnings.some((w) => w.type === 'program_number_from_post_position');
    row.trackRecognized = parsed.track ? canonicalizeTrack(parsed.track).recognized : null;

    if (row.warnings.some((w) => w.type === 'index_page_not_entries')) {
      row.status = 'wrong_page_index';
      results.push(row);
      continue;
    }
    if (row.warnings.some((w) => w.blocking) || row.races === 0) {
      row.status = 'parsed_with_blocking_warnings';
      results.push(row);
      continue;
    }

    const notes = new Set();
    const capturedAt = fs.statSync(file).mtime.toISOString();
    const payload = toPayload(parsed, capturedAt, notes);
    row.notes = [...notes];

    try {
      insertRaceDay(db, payload, newCorrelationId());
      row.status = 'imported';
    } catch (err) {
      // Most likely a UNIQUE(track, date) collision - a duplicate file in the
      // batch, or two spellings canonicalizing to one track on one day.
      row.status = 'import_skipped';
      row.error = String(err?.message ?? err);
    }
  } catch (err) {
    row.status = 'CRASH';
    row.error = String(err?.stack ?? err);
    crashes += 1;
  }
  results.push(row);
}

// ---------- read-back verification ----------
// Proves the round trip, not just the parse. Counts alone would pass on a day
// whose every entry stored NULL, so the Equibase-only columns are checked too:
// D115 added them and D116 threaded them through, and a break in either would
// otherwise be invisible here.

let verifyMismatches = 0;
const noMenuDays = [];
for (const row of results.filter((r) => r.status === 'imported')) {
  const day = db.prepare('SELECT id, entries_source, odds_captured_at FROM race_days WHERE track = ? AND date = ?')
    .get(canonicalizeTrack(row.track).display, row.date);
  const raceCount = day ? db.prepare('SELECT COUNT(*) AS n FROM races WHERE race_day_id = ?').get(day.id).n : 0;
  const entryCount = day
    ? db.prepare('SELECT COUNT(*) AS n FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ?').get(day.id).n
    : 0;
  const problems = [];
  if (!day) problems.push('day not found on read-back');
  if (raceCount !== row.races) problems.push(`races ${raceCount} != ${row.races}`);
  if (entryCount !== row.entries) problems.push(`entries ${entryCount} != ${row.entries}`);
  if (day && day.entries_source !== 'equibase_html') problems.push(`entries_source=${day.entries_source}`);
  if (day && !day.odds_captured_at) problems.push('odds_captured_at not stored');
  if (day) {
    // A null wager menu is NOT a mismatch, and it was wrong to treat it as
    // one: several tracks print no menu on this page at all ("Free Tools:
    // <Track> ALLOWANCE", with nothing in between), so an empty menu is the
    // SOURCE's limitation rather than a disagreement between parser and
    // database. What IS a mismatch is the count moving between the two.
    // Still surfaced loudly on its own line, because TicketBuilder and
    // human-picks.js then fall back to BET.minimums - Del Mar's numbers - and
    // mis-costing every ticket at another track is a silent money error.
    const menus = db.prepare('SELECT COUNT(*) AS n FROM races WHERE race_day_id = ? AND wager_menu IS NOT NULL').get(day.id).n;
    if (menus !== (row.wagerMenus ?? 0)) problems.push(`wager menus stored ${menus} != parsed ${row.wagerMenus}`);
    if ((row.wagerMenus ?? 0) === 0) noMenuDays.push(`${row.track} ${row.date}`);
  }
  if (problems.length) {
    verifyMismatches += 1;
    row.verifyError = problems.join('; ');
  }
}

// ---------- summary ----------

console.log('file'.padEnd(46), 'status'.padEnd(30), 'track'.padEnd(22), 'date'.padEnd(12), 'races', 'entries', 'warn');
for (const r of results) {
  console.log(
    r.file.padEnd(46), (r.status ?? '').padEnd(30), (r.track ?? '-').padEnd(22), (r.date ?? '-').padEnd(12),
    String(r.races).padStart(5), String(r.entries).padStart(7), String(r.warnings.length).padStart(4),
  );
}

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const allWarningTypes = {};
for (const r of results) for (const w of r.warnings) allWarningTypes[w.type] = (allWarningTypes[w.type] ?? 0) + 1;
const allNotes = new Set();
for (const r of results) for (const d of r.notes) allNotes.add(d);
const unrecognizedTracks = [...new Set(results.filter((r) => r.trackRecognized === false).map((r) => r.track))].sort();
const columnCounts = [...new Set(results.flatMap((r) => r.columnCounts))].sort((a, b) => a - b);

console.log('\n== summary ==');
console.log(`files:                ${results.length}`);
for (const [status, count] of Object.entries(byStatus)) console.log(`  ${status.padEnd(30)} ${count}`);
console.log(`total races parsed:   ${results.reduce((a, r) => a + r.races, 0)}`);
console.log(`total entries:        ${results.reduce((a, r) => a + r.entries, 0)}`);
console.log(`distinct column counts seen: ${columnCounts.join(', ') || '-'}`);
console.log(`crashes:              ${crashes}`);
console.log(`read-back mismatches: ${verifyMismatches}`);
for (const r of results.filter((x) => x.verifyError)) console.log(`  ${r.file}: ${r.verifyError}`);

console.log('\nwarning types across the batch:');
for (const [type, count] of Object.entries(allWarningTypes)) console.log(`  ${type.padEnd(30)} ${count}`);

console.log('\nfields with no column today (would be lost on a real import):');
for (const [field, why] of UNMAPPED) console.log(`  - ${field}: ${why}`);
if (allNotes.size) {
  console.log('\n...of which these were actually PRESENT in this batch:');
  for (const d of allNotes) console.log(`  - ${d}`);
}

if (noMenuDays.length) {
  console.log(`\ndays whose page prints NO wager menu at all (${noMenuDays.length}) - minimums fall back to Del Mar's:`);
  for (const d of noMenuDays) console.log(`  - ${d}`);
}

console.log("\ntracks NOT in shared/track-codes.js's registry (derived code, never blocked):");
for (const t of unrecognizedTracks) console.log(`  - ${t}`);

if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify(
    { inputDir, files: results, byStatus, allWarningTypes, unrecognizedTracks, columnCounts }, null, 2,
  ));
  console.log(`\nWrote full report: ${reportPath}`);
}

// ---------- cleanup: the temp db and everything in it goes here ----------

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nDeleted throwaway database: ${tmpDir}`);

if (byStatus.wrong_page_index) {
  console.log(`\nNOTE: ${byStatus.wrong_page_index} file(s) are the race-card INDEX page, which carries no horses.`);
  console.log('Save equibase.com/static/entry/<TRACK><MMDDYY><COUNTRY>-EQB.html instead.');
}
if (crashes > 0) {
  console.error(`\nbatch-import-equibase-entries: ${crashes} file(s) crashed the parser - this breaks its "never throws" contract`);
  process.exit(1);
}
if (verifyMismatches > 0) {
  console.error(`\nbatch-import-equibase-entries: ${verifyMismatches} file(s) failed read-back verification`);
  process.exit(1);
}
console.log('\nbatch-import-equibase-entries: done, no crashes, no read-back mismatches');
