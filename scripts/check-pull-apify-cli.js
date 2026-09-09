// Verification for Phase 4's CLI scripts (`docs/requirements/
// apify-equibase-ingest.md`) - scripts/pull-apify-entries.js and
// scripts/pull-apify-results.js - exits non-zero on any failure.
// Run: npm run check-pull-apify-cli
//
// NEVER makes a real Apify call - both scripts' own --fixture option
// replays an already-downloaded dataset export instead, which is exactly
// what this check uses (the same two real fixtures
// check-apify-equibase-ingest.js verifies the server-side wiring against:
// the leaner equibase-apify-parseforge entries capture and the
// equibase-apify-results capture, which happen to be the SAME real day,
// Del Mar 2026-09-07). Boots a real temp server (never data/betsheet.sqlite)
// and runs both scripts as real child processes against it, asserting on
// their stdout and exit codes - this is the actual CLI a person would run,
// not its internals in isolation.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8916;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-pullcli-check-'));
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-apify');
const ENTRIES_FIXTURE = path.join(FIXTURE_DIR, 'parseforge-dmr-2026-09-07.json');
const RESULTS_FIXTURE = path.join(FIXTURE_DIR, 'apify-results-dmr-2026-09-07.json');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Runs a script as a REAL child process, exactly as a person would via
// `npm run pull-apify-...` - never imports its internals, so this proves
// the actual CLI works, argv parsing included. Never sets APIFY_TOKEN in
// the fixture-replay cases (irrelevant - --fixture skips the token check
// entirely) and explicitly clears it in the one case that tests the
// no-fixture, no-token refusal, so a real call is structurally impossible
// from this check no matter what.
function runCli(script, args, { clearToken = false } = {}) {
  const env = { ...process.env, BETSHEET_PORT: String(PORT) };
  if (clearToken) delete env.APIFY_TOKEN;
  try {
    const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

try {
  check('temp server boots', await waitForHealth(), serverOut.slice(-400));

  console.log('-- entries: --fixture replay, preview only (no --yes) --');
  const entriesPreview = runCli('pull-apify-entries.js', ['2026-09-07', '--fixture', ENTRIES_FIXTURE]);
  check('exits 0', entriesPreview.code === 0, entriesPreview.stdout);
  check('shows the real hand-counted totals (11 races, 123 entries) without saving',
    /races: 11/.test(entriesPreview.stdout) && /entries: 123/.test(entriesPreview.stdout) && /preview only/.test(entriesPreview.stdout));
  const daysBeforeSave = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('nothing was saved by the preview-only run', daysBeforeSave.length === 0, String(daysBeforeSave.length));

  console.log('\n-- entries: --fixture replay with --yes actually saves --');
  const entriesSave = runCli('pull-apify-entries.js', ['2026-09-07', '--fixture', ENTRIES_FIXTURE, '--yes']);
  check('exits 0', entriesSave.code === 0, entriesSave.stdout);
  check('reports saved', /saved: race day \d+/.test(entriesSave.stdout));
  const daysAfterSave = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('exactly one race day now exists, with the real entry count', daysAfterSave.length === 1 && daysAfterSave[0].entries === 123, JSON.stringify(daysAfterSave));
  const savedDay = await fetch(`${BASE}/api/race-days/${daysAfterSave[0].id}`).then((r) => r.json());
  check('entries_source is the real provenance value', savedDay.entries_source === 'equibase_apify');

  console.log('\n-- entries: re-running without --replace reports a conflict, never silently duplicates --');
  const conflict = runCli('pull-apify-entries.js', ['2026-09-07', '--fixture', ENTRIES_FIXTURE, '--yes']);
  check('reports conflict, not a second save', /conflict/.test(conflict.stdout));
  const daysAfterConflict = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('still exactly one race day', daysAfterConflict.length === 1, String(daysAfterConflict.length));

  console.log('\n-- entries: --replace overwrites the same day rather than erroring --');
  const replaced = runCli('pull-apify-entries.js', ['2026-09-07', '--fixture', ENTRIES_FIXTURE, '--yes', '--replace']);
  check('reports saved (replaced)', /saved: race day \d+ \(replaced\)/.test(replaced.stdout), replaced.stdout);
  const daysAfterReplace = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('still exactly one race day after replace', daysAfterReplace.length === 1, String(daysAfterReplace.length));

  console.log('\n-- results: run BEFORE checking the day-dependency guard holds for a track with no entries --');
  const resultsNoEntries = runCli('pull-apify-results.js', ['2026-09-07', '--tracks', 'SA', '--fixture', RESULTS_FIXTURE]);
  // The fixture is single-track (DMR), so requesting SA finds no rows for
  // that code at all - this exercises the "no results rows came back"
  // early exit, not the day-lookup guard (that needs a real DMR-shaped
  // fixture with entries genuinely missing, covered next).
  check('no matching rows for a track this fixture does not contain', /No results rows came back/.test(resultsNoEntries.stdout), resultsNoEntries.stdout);

  console.log('\n-- results: --fixture replay, preview only (no --yes) --');
  const resultsPreview = runCli('pull-apify-results.js', ['2026-09-07', '--fixture', RESULTS_FIXTURE]);
  check('exits 0', resultsPreview.code === 0, resultsPreview.stdout);
  check('finds the already-saved day and derives the real race-11 scratches',
    /races: 11, finishers: 106, derived scratches: 4/.test(resultsPreview.stdout), resultsPreview.stdout);
  check('preview only, no grading count reported yet', /preview only/.test(resultsPreview.stdout));

  console.log('\n-- results: --fixture replay with --yes actually saves and grades --');
  const resultsSave = runCli('pull-apify-results.js', ['2026-09-07', '--fixture', RESULTS_FIXTURE, '--yes']);
  check('exits 0', resultsSave.code === 0, resultsSave.stdout);
  check('reports the real finisher/exotic/scratch counts', /106 finisher\(s\), \d+ exotic payoff\(s\), 4 scratch\(es\)/.test(resultsSave.stdout), resultsSave.stdout);
  // Re-fetched, not the id captured before --replace above - --replace
  // deletes and reinserts (invariant 12: ids are never reused), so the
  // day this fixture now lives under has a NEW id.
  const currentDay = await fetch(`${BASE}/api/race-days`).then((r) => r.json()).then((days) => days[0]);
  const resultsRead = await fetch(`${BASE}/api/race-days/${currentDay.id}/results`).then((r) => r.json());
  check('result_charts records the real provenance value', resultsRead.charts[0]?.source_kind === 'equibase_apify');
  check('all 106 finishers landed', resultsRead.results.length === 106, String(resultsRead.results.length));
  const race11Scratches = resultsRead.scratches.filter((s) => s.race_number === 11).map((s) => s.program_number).sort();
  check('the 4 real race-11 scratches are the actual saved rows', JSON.stringify(race11Scratches) === JSON.stringify(['1', '6', '8', '9']));

  console.log('\n-- results: the day-dependency guard fires for a track that genuinely has no entries yet --');
  const otherDayResults = runCli('pull-apify-results.js', ['2026-09-08', '--fixture', RESULTS_FIXTURE]);
  // Same fixture, a date with no saved race day at all - every track in it
  // should be skipped with the "run pull-apify-entries first" reason.
  check('every track is skipped, naming the real reason, never guessed at',
    /skipped\s+no race day for .* on 2026-09-08 - run pull-apify-entries first/.test(otherDayResults.stdout), otherDayResults.stdout);

  console.log('\n-- both scripts refuse cleanly with no server, and with no token and no --fixture --');
  const noServerEnv = { ...process.env, BETSHEET_PORT: '1' };
  let noServerFailed = false;
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pull-apify-entries.js'), '2026-09-07'], { env: noServerEnv, encoding: 'utf8' }); }
  catch (err) { noServerFailed = err.status === 2 && /No BetSheet server answering/.test((err.stdout ?? '') + (err.stderr ?? '')); }
  check('no server -> exit 2 with a clear message, no attempt to call Apify', noServerFailed);

  const noTokenNoFixture = runCli('pull-apify-entries.js', ['2026-09-07'], { clearToken: true });
  check('no token, no --fixture -> exit 2 before any live call is attempted',
    noTokenNoFixture.code === 2 && /APIFY_TOKEN is not set/.test(noTokenNoFixture.stdout));
} finally {
  server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-pull-apify-cli: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-pull-apify-cli: all checks passed');
