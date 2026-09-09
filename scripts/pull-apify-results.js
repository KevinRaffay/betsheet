// Phase 4 (docs/requirements/apify-equibase-ingest.md): a live, on-demand
// results pull, the sibling of pull-apify-entries.js. Talks to the ACTUAL
// running server over HTTP - the day-scoped preview route
// (server/equibase-apify-results.js, D196) already builds
// context.entriesByRace from the day's saved entries, and the existing
// POST /race-days/:id/results route already carries the track/date-
// mismatch refusal and the auto-grade-on-save behavior, so neither is
// reimplemented here.
//
// COSTS REAL MONEY EVERY TIME IT RUNS WITHOUT --fixture - even without
// --yes; see pull-apify-entries.js's header for why there is no cheaper
// preview-only mode that skips the call, and what --fixture replays
// instead.
//
// REQUIRES entries already ingested for the day (the resolved scratch-
// derivation design: entries are always ingested before results). A track
// with no matching race day is skipped with that reason, never guessed at.
//
// Usage:
//   npm run pull-apify-results -- <YYYY-MM-DD> [--tracks DMR,SA] [--yes]
//     [--write-report path.json] [--fixture path.json]

import 'dotenv/config';
import fs from 'node:fs';
import { hasToken } from '../server/apifyClient.js';
import { fetchResults } from '../server/apifyEquibase.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { newCorrelationId } from '../server/logging.js';

const BASE = `http://127.0.0.1:${process.env.BETSHEET_PORT || 8788}`;

function parseArgs(argv) {
  const out = { date: null, tracks: null, yes: false, writeReport: null, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tracks') { out.tracks = argv[++i]; continue; }
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--write-report') { out.writeReport = argv[++i]; continue; }
    if (a === '--fixture') { out.fixture = argv[++i]; continue; }
    if (!out.date) { out.date = a; continue; }
  }
  return out;
}

const USAGE = 'Usage: npm run pull-apify-results -- <YYYY-MM-DD> [--tracks DMR,SA] [--yes] [--write-report path.json] [--fixture path.json]';

const args = parseArgs(process.argv.slice(2));

if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(USAGE);
  console.error('<date> must be YYYY-MM-DD.');
  process.exit(2);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No BetSheet server answering at ${BASE} - start it first (npm run dev or npm start).`);
  process.exit(2);
}

const trackList = args.tracks ? args.tracks.split(',').map((t) => t.trim()).filter(Boolean) : [];

// --fixture replays an already-downloaded dataset export with no live call
// and no token needed - see pull-apify-entries.js's own header for why
// this is a real feature, not just a test seam.
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
  console.log(`Calling Apify (parseforge/equibase-scraper, resultType=results, includeWagers=true, date=${args.date}${trackList.length ? `, tracks=${trackList.join(',')}` : ', tracks=all'}) - this costs real money.`);
  // D204: see pull-apify-entries.js's identical comment - runId lets a
  // suspicious row count be checked against the actor's own run.
  ({ items, runId } = await fetchResults({ raceDate: args.date, tracks: trackList }));
  console.log(`Received ${items.length} row(s) - Apify run ${runId} (https://console.apify.com/actors/runs/${runId}).\n`);
}

// --tracks filters here too, not just on the live call - see
// pull-apify-entries.js's identical comment for why.
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
  console.log('No results rows came back - likely no official chart yet for this date/track. Nothing to preview.');
  process.exit(0);
}

const days = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
const results = [];

for (const code of [...byTrack.keys()].sort()) {
  const rows = byTrack.get(code);
  const { display } = canonicalizeTrack(rows[0].trackName ?? code);
  const row = { trackCode: code, raceDate: args.date, status: null, detail: null };
  results.push(row);
  console.log(`-- ${code} (${display}) --`);

  const day = days.find((d) => d.track === display && d.date === args.date && !d.deleted_at);
  if (!day) {
    row.status = 'skipped';
    row.detail = `no race day for ${display} on ${args.date} - run pull-apify-entries first`;
    console.log(`  ${row.detail}\n`);
    continue;
  }

  const correlationId = newCorrelationId();
  const previewRes = await fetch(`${BASE}/api/race-days/${day.id}/results-apify/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
    body: JSON.stringify({ data: JSON.stringify(rows) }),
  });
  const preview = await previewRes.json();
  if (!previewRes.ok) {
    row.status = 'failed';
    row.detail = preview.error ?? `HTTP ${previewRes.status}`;
    console.log(`  ${row.detail}\n`);
    continue;
  }

  const finishers = preview.races.reduce((a, r) => a + r.results.length, 0);
  const scratches = preview.races.reduce((a, r) => a + r.scratches.length, 0);
  console.log(`  races: ${preview.races.length}, finishers: ${finishers}, derived scratches: ${scratches}, warnings: ${preview.warnings.length}`);
  for (const w of preview.warnings) console.log(`    ${w.blocking ? 'BLOCKING' : 'warning'}: ${w.type}${w.race != null ? ` (race ${w.race})` : ''}`);

  if (!args.yes) {
    row.status = 'preview-only';
    console.log('  preview only - pass --yes to save\n');
    continue;
  }

  const saveRes = await fetch(`${BASE}/api/race-days/${day.id}/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
    body: JSON.stringify(preview),
  });
  const saveBody = await saveRes.json();
  if (saveRes.status === 201) {
    row.status = 'saved';
    row.detail = `${saveBody.results} finisher(s), ${saveBody.exotics} exotic payoff(s), ${saveBody.scratches} scratch(es), ${saveBody.gradedCards.length} card(s) graded`;
  } else {
    row.status = 'failed';
    row.detail = saveBody.error ?? `HTTP ${saveRes.status}`;
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
