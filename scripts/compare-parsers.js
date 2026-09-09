// M-3 (docs/requirements/multi-parser-entries-ingest.md): compares a
// challenger parser's output against the registry's DEFAULT parser -
// always baseline-vs-challenger, never symmetric peer comparison - for one
// real track and date, accumulating evidence before ever proposing a
// default change.
//
// NO LIVE FETCHING (inherits M-2's decision, the same file-only posture -
// docs/requirements/multi-parser-entries-ingest.md finding 9). --dir points
// at a directory that may hold BOTH an HTML page and an Apify JSON export
// for the same track/date; each registered parser's own `sourceKind`
// decides which file extension it reads (shared/parsers/registry.js's
// `EXTENSIONS_BY_SOURCE_KIND`). If no file under --dir produces the
// requested track/date through a given parser, that parser is reported
// UNAVAILABLE for this run rather than aborting it - the same "one
// producer's absence doesn't fail the run" philosophy pull-race-day.js
// already applies to tracks.
//
// Usage:
//   npm run compare-parsers -- <YYYY-MM-DD> <TRACK_CODE> --dir <dir>
//     [--parsers id1,id2,...] [--write-report path.json]
//
// Omitting --parsers compares every OTHER registered parser against the
// default. The default itself can never be a "challenger" - it is always
// the baseline, which is the whole point of this script.
//
// Each (date, trackCode, baseline, challenger) comparison actually
// performed appends one row to data/parser_comparisons.jsonl - never
// truncated, since one comparison isn't a conclusion and a trend across
// many race days is (the scope's own stated reason for a ledger at all).
// The decision rule for ever proposing a new default (a minimum sample of
// runs, zero critical regressions - see the requirements doc) is read by a
// person from that ledger; this script does not apply it automatically.

import fs from 'node:fs';
import path from 'node:path';
import { getParser, listParserIds, DEFAULT_PARSER_ID, EXTENSIONS_BY_SOURCE_KIND } from '../shared/parsers/registry.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { compareParsedDays } from '../shared/parsers/compare.js';
import { newCorrelationId } from '../server/logging.js';

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { date: null, trackCode: null, dir: null, parsers: null, writeReport: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { out.dir = argv[++i]; continue; }
    if (a === '--parsers') { out.parsers = argv[++i]; continue; }
    if (a === '--write-report') { out.writeReport = argv[++i]; continue; }
    positional.push(a);
  }
  [out.date, out.trackCode] = positional;
  return out;
}

const USAGE = 'Usage: npm run compare-parsers -- <YYYY-MM-DD> <TRACK_CODE> --dir <dir> '
  + '[--parsers id1,id2,...] [--write-report path.json]';

const args = parseArgs(process.argv.slice(2));

if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(USAGE);
  console.error('<date> must be YYYY-MM-DD.');
  process.exit(2);
}
if (!args.trackCode) {
  console.error(USAGE);
  console.error('<TRACK_CODE> is required.');
  process.exit(2);
}
if (!args.dir) {
  console.error(USAGE);
  console.error('--dir is required - this script never fetches anything (invariant 6).');
  process.exit(2);
}
const inputDir = path.resolve(process.cwd(), args.dir);
if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  console.error(`Not a directory: ${inputDir}`);
  process.exit(2);
}

const trackCode = args.trackCode.toUpperCase();
const baseline = getParser(DEFAULT_PARSER_ID);

let challengerIds;
if (args.parsers) {
  challengerIds = args.parsers.split(',').map((s) => s.trim()).filter(Boolean);
} else {
  challengerIds = listParserIds().filter((id) => id !== DEFAULT_PARSER_ID);
}
// Validate up front - a typo fails the whole run immediately, same rule
// M-1/M-2 already apply to --parser/--per-track-parser.
const challengers = [];
for (const id of challengerIds) {
  if (id === DEFAULT_PARSER_ID) continue; // the baseline is never also a challenger
  let entry;
  try {
    entry = getParser(id);
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  challengers.push(entry);
}
if (challengers.length === 0) {
  console.error('No challenger parsers to compare - the registry has no entry other than the default.');
  process.exit(2);
}

// ---------- find + parse the one file (per parser) that matches the
// requested track/date ----------

function findFilesByExtension(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFilesByExtension(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

let crashes = 0;

function locate(parserEntry) {
  const ext = EXTENSIONS_BY_SOURCE_KIND[parserEntry.sourceKind];
  if (!ext) return { available: false, reason: `no known file extension for sourceKind "${parserEntry.sourceKind}"` };
  const candidates = findFilesByExtension(inputDir, ext);
  if (candidates.length === 0) {
    return { available: false, reason: `no ${ext} file under ${path.relative(process.cwd(), inputDir)}` };
  }
  for (const file of candidates) {
    let raw;
    let parsed;
    try {
      raw = fs.readFileSync(file, 'utf8');
      // ONLY `trackCode` - never `track`/`date`. equibase-html's context
      // shape (`{track, date}`) is a FALLBACK used when the page's own
      // markup can't be read (`pageTrack = track ?? header...`), not a
      // filter - passing the requested track/date there would silently
      // override whatever the file actually says and report a false
      // match for ANY file, regardless of its real content. Found live
      // while verifying this script: it happily "matched" a Del Mar page
      // to a request for Indianapolis. `trackCode` alone is safe because
      // the apify parser is the only one that reads it, and it only
      // SELECTS among rows already present - it invents nothing.
      parsed = parserEntry.parse(raw, { trackCode });
    } catch (err) {
      crashes += 1;
      console.error(`  CRASH parsing ${path.relative(inputDir, file)} with ${parserEntry.id}: ${String(err?.stack ?? err)}`);
      continue;
    }
    if (!parsed.track || !parsed.date) continue;
    const { code } = canonicalizeTrack(parsed.track);
    if (code === trackCode && parsed.date === args.date) {
      return { available: true, file, parsed };
    }
  }
  return { available: false, reason: `no file under ${path.relative(process.cwd(), inputDir)} produced ${trackCode}/${args.date} through ${parserEntry.id}` };
}

console.log(`Comparing against baseline ${baseline.id} for ${trackCode} on ${args.date}\n`);

const baselineResult = locate(baseline);
if (!baselineResult.available) {
  console.log(`baseline (${baseline.id}): UNAVAILABLE - ${baselineResult.reason}`);
} else {
  console.log(`baseline (${baseline.id}): ${path.relative(inputDir, baselineResult.file)} - ${baselineResult.parsed.races.length} race(s)`);
}

// ---------- compare + ledger ----------

const runId = newCorrelationId();
const ledgerRows = [];
const reportComparisons = [];

for (const challenger of challengers) {
  const startedAt = new Date().toISOString();
  const challengerResult = locate(challenger);
  const row = {
    runId, date: args.date, trackCode, baselineParserId: baseline.id, challengerParserId: challenger.id,
    status: null, raceCountMatch: null, entryMismatchCount: null, missingInChallengerCount: null,
    missingInBaselineCount: null, baselineOnlyFields: null, challengerOnlyFields: null,
    dataQualityFindingCount: null, startedAt, finishedAt: null,
  };

  if (!baselineResult.available) {
    row.status = 'baseline_unavailable';
    console.log(`\n${challenger.id}: skipped - baseline unavailable`);
  } else if (!challengerResult.available) {
    row.status = 'challenger_unavailable';
    console.log(`\n${challenger.id}: UNAVAILABLE - ${challengerResult.reason}`);
  } else {
    const diff = compareParsedDays(baselineResult.parsed, challengerResult.parsed, {
      baselineFieldsNotProvided: baseline.fieldsNotProvided,
      challengerFieldsNotProvided: challenger.fieldsNotProvided,
    });
    row.status = 'compared';
    row.raceCountMatch = diff.raceCountMatch;
    row.entryMismatchCount = diff.perRace.reduce((a, r) => a + r.entryMismatches.length, 0);
    row.missingInChallengerCount = diff.perRace.reduce((a, r) => a + r.missingInChallenger.length, 0);
    row.missingInBaselineCount = diff.perRace.reduce((a, r) => a + r.missingInBaseline.length, 0);
    row.baselineOnlyFields = diff.baselineOnlyFields;
    row.challengerOnlyFields = diff.challengerOnlyFields;
    row.dataQualityFindingCount = diff.dataQuality.postPositionGaps.length + diff.dataQuality.doubleSpaceNames.length;
    reportComparisons.push({ challengerParserId: challenger.id, file: path.relative(inputDir, challengerResult.file), diff });

    console.log(`\n${challenger.id}: ${path.relative(inputDir, challengerResult.file)} - ${challengerResult.parsed.races.length} race(s)`);
    console.log(`  race count match:        ${diff.raceCountMatch}`);
    console.log(`  entry mismatches:        ${row.entryMismatchCount}`);
    console.log(`  missing in challenger:   ${row.missingInChallengerCount}`);
    console.log(`  missing in baseline:     ${row.missingInBaselineCount}`);
    console.log(`  baseline-only fields:    ${diff.baselineOnlyFields.join(', ') || '-'}`);
    console.log(`  challenger-only fields:  ${diff.challengerOnlyFields.join(', ') || '-'} (additive value)`);
    console.log(`  data-quality findings:   ${row.dataQualityFindingCount}`);
  }
  row.finishedAt = new Date().toISOString();
  ledgerRows.push(row);
}

const ledgerPath = path.resolve(process.cwd(), 'data', 'parser_comparisons.jsonl');
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.appendFileSync(ledgerPath, ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nAppended ${ledgerRows.length} row(s) to ${path.relative(process.cwd(), ledgerPath)}`);

if (args.writeReport) {
  fs.writeFileSync(args.writeReport, JSON.stringify({
    runId, date: args.date, trackCode, baselineParserId: baseline.id,
    baselineAvailable: baselineResult.available, comparisons: reportComparisons, ledgerRows,
  }, null, 2));
  console.log(`Wrote full report: ${args.writeReport}`);
}

if (crashes > 0) {
  console.error(`\ncompare-parsers: ${crashes} crash(es) - this breaks a parser's "never throws" contract`);
  process.exit(1);
}
console.log('\ncompare-parsers: done, no crashes');
