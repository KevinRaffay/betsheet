// Phase 4 (docs/requirements/apify-equibase-ingest.md): a live, on-demand
// entries pull - one command in place of "run the actor externally,
// download a file, run a separate ingest command." NOT a
// pull-race-day.js retrofit: that script's whole design is built around
// scanning a --dir of already-saved files, a fundamentally different input
// model from a live API call, and it writes to a THROWAWAY temp database
// because it is a validation harness, not a real ingestion path. This
// script IS a real ingestion path - it talks to the ACTUAL running server
// over HTTP, exactly like a browser client would, so the day-conflict
// check, the explicit-replace flow, entriesSource validation (D195) and
// the day_superseded trace all come from the route unchanged rather than
// being reimplemented here and risking drift from it.
//
// COSTS REAL MONEY EVERY TIME IT RUNS WITHOUT --fixture - even without
// --yes. The Apify call happens before the save decision, because the
// preview needs real fetched data to show. --yes governs the SAVE only
// (invariant 9: preview first, warnings shown, explicit confirmation
// before anything is written) - running this script at all, live, is the
// "a person deliberately triggered this" act invariant 6's live-fetch
// exception (D197) requires; there is no second, cheaper preview-only mode
// that skips the call. --fixture is the free alternative: it replays an
// already-downloaded dataset export (the Apify console's own UI needs no
// token) through the identical path, which is also how this script is
// verified without ever spending real money.
//
// Usage:
//   npm run pull-apify-entries -- <YYYY-MM-DD> [--tracks DMR,SA] [--yes]
//     [--replace] [--bankroll-cents N] [--per-race-min-cents N]
//     [--write-report path.json] [--fixture path.json]
//
// Omit --tracks for every track racing that day (one call either way - the
// actor takes the whole list at once, filtered before rows are ever
// written or charged). Multiple tracks in one response are grouped by
// their own trackCode client-side and handled as independent race days -
// one track's blocking warnings or save failure never stops the others.

import 'dotenv/config';
import fs from 'node:fs';
import { hasToken } from '../server/apifyClient.js';
import { fetchEntries } from '../server/apifyEquibase.js';
import { parseApifyParseforgeDataset, apifyParseforgeToPayload } from '../shared/parsers/equibase-apify-parseforge.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { newCorrelationId } from '../server/logging.js';

const BASE = `http://127.0.0.1:${process.env.BETSHEET_PORT || 8788}`;

function parseArgs(argv) {
  const out = {
    date: null, tracks: null, yes: false, replace: false,
    bankrollCents: null, perRaceMinCents: null, writeReport: null, fixture: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tracks') { out.tracks = argv[++i]; continue; }
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--replace') { out.replace = true; continue; }
    if (a === '--bankroll-cents') { out.bankrollCents = Number(argv[++i]); continue; }
    if (a === '--per-race-min-cents') { out.perRaceMinCents = Number(argv[++i]); continue; }
    if (a === '--write-report') { out.writeReport = argv[++i]; continue; }
    if (a === '--fixture') { out.fixture = argv[++i]; continue; }
    if (!out.date) { out.date = a; continue; }
  }
  return out;
}

const USAGE = 'Usage: npm run pull-apify-entries -- <YYYY-MM-DD> [--tracks DMR,SA] [--yes] '
  + '[--replace] [--bankroll-cents N] [--per-race-min-cents N] [--write-report path.json] [--fixture path.json]';

const args = parseArgs(process.argv.slice(2));

if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(USAGE);
  console.error('<date> must be YYYY-MM-DD.');
  process.exit(2);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No BetSheet server answering at ${BASE} - start it first (npm run dev or npm start).`);
  console.error('This script saves through the real server so its day-conflict and validation logic is reused, never reimplemented.');
  process.exit(2);
}

const trackList = args.tracks ? args.tracks.split(',').map((t) => t.trim()).filter(Boolean) : [];

// --fixture replays an already-downloaded dataset export (e.g. from the
// Apify console's own UI, or a previous run's --write-report) through the
// identical preview/save path, with NO live call and NO token needed -
// genuinely useful on its own (the same "someone already has a file"
// posture every other ingest path in this codebase takes), and how this
// script is verified without ever spending real money.
let items;
let runId = null;
if (args.fixture) {
  items = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  console.log(`Replaying ${items.length} row(s) from ${args.fixture} (no live call).\n`);
} else {
  if (!hasToken()) {
    console.error('APIFY_TOKEN is not set (see .env.example) - nothing was called. Use --fixture to replay an already-downloaded export instead.');
    process.exit(2);
  }
  console.log(`Calling Apify (parseforge/equibase-scraper, resultType=entries, date=${args.date}${trackList.length ? `, tracks=${trackList.join(',')}` : ', tracks=all'}) - this costs real money.`);
  // D204: runId is printed and written to --write-report so a row-count
  // that looks wrong (a large-field track undercounted, Kentucky Downs
  // 2026-09-09) can be checked directly at
  // https://console.apify.com/actors/runs/<runId> instead of guessing
  // whether the actor's own scrape was short or something downstream
  // dropped rows.
  ({ items, runId } = await fetchEntries({ raceDate: args.date, tracks: trackList }));
  console.log(`Received ${items.length} row(s) - Apify run ${runId} (https://console.apify.com/actors/runs/${runId}).\n`);
}

// Group by each row's own track, mirroring the parser's own fallback (the
// leaner capture, D192, has no trackCode field at all). --tracks filters
// here too, not just on the live call - a --fixture file can hold more
// than what was asked for, and the live path already gets this filtering
// from the actor itself, so both paths should agree.
const wantTracks = trackList.length ? new Set(trackList.map((t) => canonicalizeTrack(t).code)) : null;
const byTrack = new Map(); // code -> rows[]
for (const row of items) {
  const code = row.trackCode ?? (row.trackName ? canonicalizeTrack(row.trackName).code : null);
  if (!code) continue;
  if (wantTracks && !wantTracks.has(code)) continue;
  if (!byTrack.has(code)) byTrack.set(code, []);
  byTrack.get(code).push(row);
}

if (byTrack.size === 0) {
  console.log('No entries rows came back - likely no card on this date for the requested track(s). Nothing to preview.');
  process.exit(0);
}

const results = [];
for (const code of [...byTrack.keys()].sort()) {
  const rows = byTrack.get(code);
  const correlationId = newCorrelationId();
  const parsed = parseApifyParseforgeDataset(JSON.stringify(rows));
  const row = {
    trackCode: code, track: parsed.track, raceDate: parsed.date, correlationId,
    races: parsed.races.length,
    entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
    warnings: parsed.warnings.length,
    blocking: parsed.warnings.filter((w) => w.blocking),
    status: null, detail: null,
  };
  results.push(row);

  console.log(`-- ${code} (${parsed.track ?? 'unparsed'}) --`);
  console.log(`  races: ${row.races}, entries: ${row.entries}, warnings: ${row.warnings}`);
  for (const w of parsed.warnings) console.log(`    ${w.blocking ? 'BLOCKING' : 'warning'}: ${w.type}`);

  if (row.blocking.length > 0 || row.races === 0) {
    row.status = 'skipped';
    row.detail = 'blocking warning(s) or zero races - not saved';
    console.log(`  ${row.detail}\n`);
    continue;
  }

  if (!args.yes) {
    row.status = 'preview-only';
    console.log('  preview only - pass --yes to save\n');
    continue;
  }

  const payload = apifyParseforgeToPayload(parsed, new Date().toISOString());
  if (args.bankrollCents != null) payload.bankrollCents = args.bankrollCents;
  if (args.perRaceMinCents != null) payload.perRaceMinCents = args.perRaceMinCents;
  if (args.replace) payload.replace = true;

  const res = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (res.status === 201) {
    row.status = 'saved';
    row.detail = `race day ${body.id}${body.replaced ? ' (replaced)' : ''}`;
  } else if (res.status === 409) {
    row.status = 'conflict';
    row.detail = `already exists as day ${body.existingId} - rerun with --replace to overwrite`;
  } else {
    row.status = 'failed';
    row.detail = body.error ?? `HTTP ${res.status}`;
  }
  console.log(`  ${row.status}: ${row.detail}\n`);
}

console.log('== summary ==');
for (const r of results) {
  console.log(`  ${r.trackCode.padEnd(6)} ${String(r.status).padEnd(14)} ${r.detail ?? ''}`);
}

if (args.writeReport) {
  fs.writeFileSync(args.writeReport, JSON.stringify({ date: args.date, tracks: trackList, apifyRunId: runId, results }, null, 2));
  console.log(`\nWrote full report: ${args.writeReport}`);
}

if (results.some((r) => r.status === 'failed')) process.exit(1);
