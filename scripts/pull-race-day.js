// M-2 (docs/requirements/multi-parser-entries-ingest.md): pulls one full
// day's slate - however many tracks raced - from a directory of ALREADY
// SAVED per-track pages, one command instead of running
// batch-import-equibase-entries.js once per track by hand.
//
// NO LIVE FETCHING (user decision 2026-09-09, DELIVERABLES.md D189). The
// incoming scope described this script as resolving "which tracks are
// racing" from Equibase's own entries index page and then fetching each
// track automatically. Invariant 6 forbids exactly that: D113 deleted every
// fetcher, HTTP client and robots.txt checker in this codebase because
// Equibase's bot protection is real and confirmed ("don't retry cleverly"),
// and every surviving ingest path takes a file a person already saved. This
// script keeps that posture: --dir points at a directory a person (or the
// equibase-daily-entries skill, via browser automation rather than a
// scripted HTTP client) already populated with one saved page per track,
// and "which tracks are racing" is answered by WHICH FILES ARE THERE for
// the requested date, never a network request.
//
// Usage:
//   npm run pull-race-day -- <YYYY-MM-DD> --dir <directory>
//     [--tracks CODE1,CODE2] [--parser id] [--per-track-parser CODE=id,...]
//     [--write-report path.json]
//
// Every file under --dir is parsed (recursively, .html/.htm only today -
// the sole sourceKind any registered parser has) to learn its own track and
// date; a file whose parsed date doesn't match <date> is out of scope for
// this run, not an error. --tracks limits the run to those track codes
// (shared/track-codes.js's own codes); omit it to pull every track the
// directory holds for that date - the closest this codebase can honestly
// come to "every track racing that day" without fetching an index page.
// --per-track-parser overrides the parser for one track's code; a parser
// whose sourceKind isn't 'html' is refused for that one track (non-fatal to
// the run) because file discovery here only scans HTML pages - mixing
// source kinds needs a second real parser registered first (M-1's finding
// 7: no such parser exists yet with a verified sample to build against).
//
// Each in-scope track gets exactly one row appended to
// data/ingest_runs.jsonl (never truncated - this is the substrate M-3's
// comparison and M-4's cost tracking both read from) and one line in the
// console summary. One track's failure - no file found, a blocking
// warning, an unsupported parser - never aborts the run, matching
// batch-import-equibase-entries.js's own non-fatal philosophy.
//
// SAFE BY CONSTRUCTION: writes to a brand-new temp-directory SQLite
// database (never data/betsheet.sqlite), deleted at the end of the run.
// Exit code is non-zero only on a genuine parser crash or a read-back
// mismatch - a track ending up 'failed' in the ledger is a normal, expected
// outcome of this script, not a process failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getParser, DEFAULT_PARSER_ID } from '../shared/parsers/registry.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { openDb } from '../server/db.js';
import { insertRaceDay } from '../server/ingest.js';
import { newCorrelationId } from '../server/logging.js';

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { date: null, dir: null, tracks: null, parser: DEFAULT_PARSER_ID, perTrackParser: [], writeReport: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { out.dir = argv[++i]; continue; }
    if (a === '--tracks') { out.tracks = argv[++i]; continue; }
    if (a === '--parser') { out.parser = argv[++i]; continue; }
    if (a === '--per-track-parser') { out.perTrackParser.push(argv[++i]); continue; }
    if (a === '--write-report') { out.writeReport = argv[++i]; continue; }
    if (!out.date) { out.date = a; continue; }
  }
  return out;
}

const USAGE = 'Usage: npm run pull-race-day -- <YYYY-MM-DD> --dir <directory> '
  + '[--tracks CODE1,CODE2] [--parser id] [--per-track-parser CODE=id,...] [--write-report path.json]';

const args = parseArgs(process.argv.slice(2));

if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(USAGE);
  console.error('<date> must be YYYY-MM-DD.');
  process.exit(2);
}
if (!args.dir) {
  console.error(USAGE);
  console.error('--dir is required - this script never fetches anything (invariant 6); point it at a directory of already-saved pages.');
  process.exit(2);
}
const inputDir = path.resolve(process.cwd(), args.dir);
if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  console.error(`Not a directory: ${inputDir}`);
  process.exit(2);
}

let defaultParser;
try {
  defaultParser = getParser(args.parser);
} catch (err) {
  console.error(String(err.message));
  process.exit(2);
}
if (defaultParser.sourceKind !== 'html') {
  console.error(`Parser "${defaultParser.id}" has sourceKind "${defaultParser.sourceKind}" - file discovery here only scans HTML pages today, so it cannot be the run's default parser.`);
  process.exit(2);
}

// code -> parser entry. Validated up front so a typo fails the whole run
// immediately rather than surfacing per-track later.
const perTrackParser = new Map();
for (const spec of args.perTrackParser) {
  const eq = spec.indexOf('=');
  if (eq < 0) {
    console.error(`--per-track-parser expects CODE=id, got "${spec}"`);
    process.exit(2);
  }
  const code = spec.slice(0, eq).trim().toUpperCase();
  const id = spec.slice(eq + 1).trim();
  let entry;
  try {
    entry = getParser(id);
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  perTrackParser.set(code, entry);
}

const requestedTracks = args.tracks
  ? new Set(args.tracks.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean))
  : null; // null = every track the directory holds for this date

// ---------- find files (recursively, .html/.htm - the one sourceKind any
// registered parser has today) ----------

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

// ---------- discovery pass: learn each file's own track + date ----------
// Parsed with the DEFAULT parser, since file discovery only found HTML
// pages and that parser is guaranteed html-capable (checked above). A
// track later assigned a DIFFERENT parser via --per-track-parser is
// re-parsed with that parser below - this pass exists only to learn which
// file belongs to which track.

const byTrack = new Map(); // code -> { display, files: [{ file, parsed }] }
const outOfScope = [];
let crashes = 0;

for (const file of files) {
  try {
    const html = fs.readFileSync(file, 'utf8');
    const parsed = defaultParser.parse(html);
    if (!parsed.track || !parsed.date) {
      outOfScope.push({ file, reason: 'no track/date on this page (likely not an entries page)' });
      continue;
    }
    if (parsed.date !== args.date) {
      outOfScope.push({ file, reason: `parsed date ${parsed.date} != requested ${args.date}` });
      continue;
    }
    const { code, display } = canonicalizeTrack(parsed.track);
    if (requestedTracks && !requestedTracks.has(code)) {
      outOfScope.push({ file, reason: `track ${code} (${display}) not in --tracks` });
      continue;
    }
    if (!byTrack.has(code)) byTrack.set(code, { display, files: [] });
    byTrack.get(code).files.push({ file, parsed });
  } catch (err) {
    crashes += 1;
    outOfScope.push({ file, reason: `CRASH: ${String(err?.stack ?? err)}` });
  }
}

// A requested track with no matching file is still in scope for this run -
// it gets a 'failed' ledger row naming the gap, per invariant 11 (a failing
// source must be visible, never silently thinned out of the report).
if (requestedTracks) {
  for (const code of requestedTracks) {
    if (!byTrack.has(code)) byTrack.set(code, { display: null, files: [] });
  }
}

// ---------- temp db (never the real one) ----------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-pull-'));
const dbPath = path.join(tmpDir, 'pull.sqlite');
const db = openDb(dbPath);

// ---------- pull each in-scope track independently ----------

const runId = newCorrelationId();
const rows = [];

for (const code of [...byTrack.keys()].sort()) {
  const info = byTrack.get(code);
  const startedAt = new Date().toISOString();
  const assignedParser = perTrackParser.get(code) ?? defaultParser;
  const row = {
    runId, trackCode: code, raceDate: args.date, parserId: assignedParser.id,
    status: null, raceCount: 0, entryCount: 0, warningCount: 0, droppedFields: [],
    startedAt, finishedAt: null, note: null,
  };

  const finish = (status, note) => {
    row.status = status;
    row.note = note ?? row.note;
    row.finishedAt = new Date().toISOString();
    rows.push(row);
  };

  if (info.files.length === 0) {
    finish('failed', `no file found for ${code} under ${path.relative(process.cwd(), inputDir)} on ${args.date}`);
    continue;
  }
  if (assignedParser.sourceKind !== 'html') {
    finish('failed', `parser "${assignedParser.id}" has sourceKind "${assignedParser.sourceKind}" - file discovery only scans HTML pages today`);
    continue;
  }

  const primary = info.files[0];
  if (info.files.length > 1) {
    const extras = info.files.slice(1).map((f) => path.relative(inputDir, f.file)).join(', ');
    row.note = `${info.files.length} files matched ${code}/${args.date}; used ${path.relative(inputDir, primary.file)}, ignored: ${extras}`;
  }

  // Re-parse with the ASSIGNED parser only if it differs from the discovery
  // (default) one - today they are always the same parser, since exactly
  // one is registered, but this keeps the logic correct once a second
  // html-capable parser exists.
  let parsed = primary.parsed;
  if (assignedParser.id !== defaultParser.id) {
    try {
      const html = fs.readFileSync(primary.file, 'utf8');
      parsed = assignedParser.parse(html);
    } catch (err) {
      crashes += 1;
      finish('failed', `parser "${assignedParser.id}" crashed: ${String(err?.stack ?? err)}`);
      continue;
    }
  }

  row.raceCount = parsed.races.length;
  row.entryCount = parsed.races.reduce((a, r) => a + r.entries.length, 0);
  row.warningCount = parsed.warnings.length;
  row.droppedFields = [...assignedParser.fieldsNotProvided];

  if (parsed.warnings.some((w) => w.blocking) || row.raceCount === 0) {
    finish('failed', (row.note ? row.note + '; ' : '') + 'blocking parse warning(s) or zero races');
    continue;
  }

  try {
    const notes = new Set();
    const capturedAt = fs.statSync(primary.file).mtime.toISOString();
    const payload = assignedParser.toPayload(parsed, capturedAt, notes);
    insertRaceDay(db, payload, newCorrelationId());
  } catch (err) {
    finish('failed', (row.note ? row.note + '; ' : '') + `insertRaceDay failed: ${String(err?.message ?? err)}`);
    continue;
  }
  finish(row.warningCount > 0 ? 'partial' : 'success');
}

// ---------- read-back verification (proves the round trip, not just the parse) ----------

let verifyMismatches = 0;
for (const row of rows.filter((r) => r.status !== 'failed')) {
  const day = db.prepare('SELECT id FROM race_days WHERE track_code = ? AND date = ?').get(row.trackCode, row.raceDate);
  const raceCount = day ? db.prepare('SELECT COUNT(*) AS n FROM races WHERE race_day_id = ?').get(day.id).n : 0;
  if (!day || raceCount !== row.raceCount) {
    verifyMismatches += 1;
    row.note = (row.note ? row.note + '; ' : '') + `read-back mismatch: day ${day ? 'found' : 'NOT found'}, races ${raceCount} != ${row.raceCount}`;
  }
}

// ---------- ledger: append, never truncate - the substrate M-3/M-4 read from ----------

const ledgerPath = path.resolve(process.cwd(), 'data', 'ingest_runs.jsonl');
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.appendFileSync(ledgerPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---------- summary ----------

console.log(`Pulling ${args.date} from ${path.relative(process.cwd(), inputDir)} (default parser: ${defaultParser.id})\n`);
console.log('track'.padEnd(8), 'parser'.padEnd(14), 'status'.padEnd(10), 'races', 'entries', 'warn', 'note');
for (const r of rows) {
  console.log(
    r.trackCode.padEnd(8), r.parserId.padEnd(14), r.status.padEnd(10),
    String(r.raceCount).padStart(5), String(r.entryCount).padStart(7), String(r.warningCount).padStart(4),
    r.note ?? '',
  );
}

const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log('\n== summary ==');
console.log(`tracks:               ${rows.length}`);
for (const [status, count] of Object.entries(byStatus)) console.log(`  ${status.padEnd(10)} ${count}`);
console.log(`total races:          ${rows.reduce((a, r) => a + r.raceCount, 0)}`);
console.log(`total entries:        ${rows.reduce((a, r) => a + r.entryCount, 0)}`);
console.log(`crashes:              ${crashes}`);
console.log(`read-back mismatches: ${verifyMismatches}`);
console.log(`files out of scope for this run: ${outOfScope.length}`);
for (const o of outOfScope) console.log(`  ${path.relative(inputDir, o.file)}: ${o.reason}`);
console.log(`\nAppended ${rows.length} row(s) to ${path.relative(process.cwd(), ledgerPath)}`);

if (args.writeReport) {
  fs.writeFileSync(args.writeReport, JSON.stringify({ runId, date: args.date, inputDir, rows, outOfScope }, null, 2));
  console.log(`Wrote full report: ${args.writeReport}`);
}

// ---------- cleanup: the temp db and everything in it goes here ----------

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

if (crashes > 0) {
  console.error(`\npull-race-day: ${crashes} crash(es) - this breaks a parser's "never throws" contract`);
  process.exit(1);
}
if (verifyMismatches > 0) {
  console.error(`\npull-race-day: ${verifyMismatches} read-back mismatch(es)`);
  process.exit(1);
}
console.log('\npull-race-day: done, no crashes, no read-back mismatches');
