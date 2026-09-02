// Verification for the ingest API - exits non-zero on any failure.
// Run: npm run check-ingest
//
// Boots the REAL server (child process) against a temp database and temp
// log dir, then exercises the whole flow over HTTP: parse the real pasted
// fixture, save it, read it back, conflict + replace, reject bad payloads,
// and parse the real program PDF end-to-end.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-ingestcheck-'));

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
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  check('server boots on a temp db', await waitForHealth(), serverOut.slice(-400));

  // --- parse the real pasted fixture ---
  const fixture = fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'entries', 'dmtc-2026-09-03.txt'), 'utf8');
  const parseRes = await fetch(`${BASE}/api/parse/entries-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: fixture }),
  });
  const parsed = await parseRes.json();
  check('parse endpoint: real fixture -> 8 races, correlation id',
    parseRes.ok && parsed.races.length === 8 && typeof parsed.correlationId === 'string');

  const echo = await fetch(`${BASE}/api/parse/entries-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'cid-echo' },
    body: JSON.stringify({ text: 'Race 1\n' }),
  }).then((r) => r.json());
  check('parse endpoint echoes a supplied correlation id', echo.correlationId === 'cid-echo');

  // --- save, read back ---
  const payload = {
    track: 'Del Mar',
    date: parsed.date,
    bankrollCents: 20000,
    perRaceMinCents: 500,
    races: parsed.races,
  };
  const saveRes = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': parsed.correlationId },
    body: JSON.stringify(payload),
  });
  const saved = await saveRes.json();
  check('save: 201 with id', saveRes.status === 201 && Number.isInteger(saved.id), JSON.stringify(saved));

  const list = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('list: one day, 8 races, 81 entries',
    list.length === 1 && list[0].races === 8 && list[0].entries === 81, JSON.stringify(list));

  const day = await fetch(`${BASE}/api/race-days/${saved.id}`).then((r) => r.json());
  const r1 = day.races.find((r) => r.number === 1);
  const fav = r1.entries.find((e) => e.horse_name === "Bit's Tiger Magic");
  check('detail: race fields persisted (wager menu included)',
    r1.surface === 'TURF' && r1.distance === '5 FURLONGS' && /Exacta/.test(r1.wager_menu));
  check('detail: entry round-trips',
    fav && fav.program_number === '4' && fav.morning_line === '8/5' &&
    Math.abs(fav.morning_line_decimal - 1.6) < 1e-9 && fav.jockey === 'J. Hernandez');
  const scratched = day.races.find((r) => r.number === 3).entries
    .find((e) => e.horse_name === 'Charmz Away');
  check('detail: program-less scratch stored visibly as SCR',
    scratched && scratched.program_number === 'SCR' && scratched.scratched === 1);

  // --- conflict + replace ---
  const conflict = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  check('duplicate day without replace -> 409', conflict.status === 409);

  const replace = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, replace: true }),
  });
  const replaced = await replace.json();
  const listAfter = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('replace: 201, still exactly one day',
    replace.status === 201 && replaced.replaced === true && listAfter.length === 1);

  // --- validation ---
  const bad = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ track: '', date: 'August 30', races: [] }),
  });
  check('bad payload -> 400', bad.status === 400);

  const badPdf = await fetch(`${BASE}/api/parse/program-pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.from('this is not a pdf'),
  });
  check('corrupt pdf -> 422 with message, not a crash', badPdf.status === 422);

  // --- the real program PDF, end to end over HTTP ---
  const pdf = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'programs', 'delmar-2026-08-30.pdf'));
  const pdfRes = await fetch(`${BASE}/api/parse/program-pdf?track=Del%20Mar&date=2026-08-30`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: pdf,
  });
  const pdfParsed = await pdfRes.json();
  check('program-pdf endpoint: 10 races, 98 entries, best bet present',
    pdfRes.ok && pdfParsed.races.length === 10 &&
    pdfParsed.races.reduce((a, r) => a + r.entries.length, 0) === 98 &&
    pdfParsed.races[3].entries.some((e) => e.bestBet));
  const raceFourAnalysis = pdfParsed.analysis?.find((a) => a.race === 4)?.text;
  check('program-pdf endpoint: per-race Bottom Line analysis present',
    typeof raceFourAnalysis === 'string' && raceFourAnalysis.length > 80);

  // Saving the PDF parse for its own (different) date must coexist with the
  // pasted day rather than conflict.
  const savePdf = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      track: 'Del Mar', date: pdfParsed.date, bankrollCents: 20000,
      perRaceMinCents: 500, races: pdfParsed.races, analysis: pdfParsed.analysis,
    }),
  });
  const listBoth = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('both days stored side by side', savePdf.status === 201 && listBoth.length === 2);
  const pdfDay = await fetch(`${BASE}/api/race-days/${(await savePdf.json?.(), listBoth.find((d) => d.date === '2026-08-30').id)}`).then((r) => r.json());
  const bb = pdfDay.races.find((r) => r.number === 4).entries.find((e) => e.best_bet === 1);
  check('pdf day: best bet and program ranks persisted',
    bb?.horse_name === 'Run With Liberty' && bb?.program_rank === 1);
  check('pdf day: Bottom Line text persists on the matching race',
    pdfDay.races.find((r) => r.number === 4)?.bottom_line === raceFourAnalysis);

  // ---- results-chart parse endpoints (preview only; nothing persists) ----

  const chartText = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'charts', 'dmr-2026-08-30.txt'), 'utf8');
  const chartTextRes = await fetch(`${BASE}/api/parse/results-text`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: chartText }),
  });
  const chartParsed = await chartTextRes.json();
  check('results-text endpoint: 10 races, winners with payouts',
    chartTextRes.ok && chartParsed.races.length === 10 &&
    chartParsed.races.every((r) => r.results[0]?.winCents > 0));

  const chartPdf = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'charts', 'dmr-2026-08-30.pdf'));
  const chartPdfRes = await fetch(`${BASE}/api/parse/results-pdf`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: chartPdf,
  });
  const chartPdfParsed = await chartPdfRes.json();
  check('results-pdf endpoint parses identically to the pasted text', (() => {
    const strip = (o) => JSON.stringify({ races: o.races, track: o.track, date: o.date });
    return chartPdfRes.ok && strip(chartPdfParsed) === strip(chartParsed);
  })());
  check('corrupt results pdf -> 422, not a crash',
    (await fetch(`${BASE}/api/parse/results-pdf`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.from('nope'),
    })).status === 422);

  // ---- results persistence: save, read back, replace, refuse mismatches ----

  const jpost2 = (url, body) => fetch(BASE + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const resultsPayload = {
    track: chartParsed.track, date: chartParsed.date,
    sourceKind: 'paste', races: chartParsed.races,
  };
  const pastedDayId = listBoth.find((d) => d.date === '2026-09-03').id;
  const wrongDay = await jpost2(`/api/race-days/${pastedDayId}/results`, resultsPayload);
  check('chart for the wrong date is refused whole (422)', wrongDay.status === 422);

  const saveResultsRes = await jpost2(`/api/race-days/${pdfDay.id}/results`, resultsPayload);
  const savedResults = await saveResultsRes.json();
  check('results save: 201 with counts (90 finishers, 68 payoffs, 8 scratches)',
    saveResultsRes.status === 201 && savedResults.results === 90 &&
    savedResults.exotics === 68 && savedResults.scratches === 8,
    JSON.stringify(savedResults));

  const readResults = await fetch(`${BASE}/api/race-days/${pdfDay.id}/results`).then((r) => r.json());
  check('results read back: winner, exacta, scratch, provenance chart row', (() => {
    const winner = readResults.results.find((r) => r.race_number === 1 && r.finish_position === 1);
    const exacta = readResults.exotics.find((x) => x.race_number === 1 && x.bet_type === 'exacta');
    return winner?.horse_name === "Howie's Law" && winner?.win_cents === 280 &&
      exacta?.combination === '1-6' && exacta?.payout_cents === 1030 &&
      readResults.scratches.some((s) => s.horse_name === 'The Chosen Bride') &&
      readResults.charts.length === 1 && readResults.charts[0].source_kind === 'equibase_paste';
  })());

  await jpost2(`/api/race-days/${pdfDay.id}/results`, resultsPayload);
  const afterReplace = await fetch(`${BASE}/api/race-days/${pdfDay.id}/results`).then((r) => r.json());
  check('re-saving replaces results but appends provenance',
    afterReplace.results.length === 90 && afterReplace.charts.length === 2);

  check('deletion preview now counts result rows',
    (await fetch(`${BASE}/api/race-days/${pdfDay.id}/deletion-preview`).then((r) => r.json())).results === 90);

  // ---- soft delete: cascade by filter, logs intact, restore ----

  const preview = await fetch(`${BASE}/api/race-days/${pdfDay.id}/deletion-preview`).then((r) => r.json());
  check('deletion preview counts the tree',
    preview.races === 10 && preview.entries === 98 &&
    Number.isInteger(preview.sources) && Number.isInteger(preview.cards) && Number.isInteger(preview.tickets),
    JSON.stringify(preview));

  const del = await fetch(`${BASE}/api/race-days/${pdfDay.id}`, { method: 'DELETE' });
  check('soft delete: 200 with counts', del.status === 200 && (await del.json()).races === 10);

  const listAfterDelete = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('deleted day excluded from the default list',
    !listAfterDelete.some((d) => d.id === pdfDay.id) && listAfterDelete.length === 1);

  const deletedList = await fetch(`${BASE}/api/race-days?deleted=1`).then((r) => r.json());
  check('deleted list shows it, with its deleted_at and counts intact',
    deletedList.length === 1 && deletedList[0].id === pdfDay.id &&
    deletedList[0].deleted_at != null && deletedList[0].entries === 98);

  const genOnDeleted = await fetch(`${BASE}/api/race-days/${pdfDay.id}/cards`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('mutations against a deleted day -> 410', genOnDeleted.status === 410);
  const pasteOnDeleted = await fetch(`${BASE}/api/race-days/${pdfDay.id}/consensus/manual`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceName: 'X', races: [] }),
  });
  check('manual paste against a deleted day -> 410', pasteOnDeleted.status === 410);
  check('results save against a deleted day -> 410',
    (await jpost2(`/api/race-days/${pdfDay.id}/results`, resultsPayload)).status === 410);

  await new Promise((r) => setTimeout(r, 300));
  const traceFile = path.join(tmp, 'logs', 'decision-trace.jsonl');
  const traceEvents = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  check('deletion logged to the decision-trace stream under the day\'s correlation id',
    traceEvents.some((e) => e.event === 'race_day_deleted' && e.raceDayId === pdfDay.id &&
      typeof e.correlationId === 'string' && e.entries === 98));

  const restore = await fetch(`${BASE}/api/race-days/${pdfDay.id}/restore`, { method: 'POST' });
  const listAfterRestore = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('restore brings the day back to the default list',
    restore.status === 200 && listAfterRestore.some((d) => d.id === pdfDay.id));

  // A soft-deleted tombstone for a track/date is superseded by re-ingesting.
  await fetch(`${BASE}/api/race-days/${pdfDay.id}`, { method: 'DELETE' });
  const reingest = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      track: 'Del Mar', date: pdfDay.date, bankrollCents: 20000, perRaceMinCents: 500,
      races: pdfParsed.races,
    }),
  });
  const reingestBody = await reingest.json();
  const finalList = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  const finalDeleted = await fetch(`${BASE}/api/race-days?deleted=1`).then((r) => r.json());
  check('re-ingesting over a deleted tombstone succeeds without replace, tombstone gone',
    reingest.status === 201 && finalList.length === 2 && finalDeleted.length === 0);

  // The live bug: the superseding day must get a NEW id - the old id stays
  // uniquely bound to the deleted day's logged history forever.
  check('superseding day gets a fresh id, never the tombstone\'s',
    Number(reingestBody.id) > Number(pdfDay.id),
    `tombstone=${pdfDay.id} new=${reingestBody.id}`);

  await new Promise((r) => setTimeout(r, 300));
  const traceEvents2 = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('supersession documents itself in the decision trace',
    traceEvents2.some((e) => e.event === 'race_day_superseded' &&
      e.supersededRaceDayId === pdfDay.id && e.raceDayId === reingestBody.id &&
      e.supersededWasDeleted === true && typeof e.supersededCorrelationId === 'string'));

  // ---- factory reset: everything gone, logs included, auditable era start ----

  const noConfirm = await fetch(`${BASE}/api/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('reset without the confirm token -> 400, nothing wiped',
    noConfirm.status === 400 &&
    (await fetch(`${BASE}/api/race-days`).then((r) => r.json())).length === 2);

  const reset = await fetch(`${BASE}/api/reset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET' }),
  });
  const resetBody = await reset.json();
  check('reset: 200 with row counts and log-file count',
    reset.status === 200 && resetBody.rowsRemoved.race_days === 2 &&
    resetBody.rowsRemoved.entries > 0 && resetBody.logFilesRemoved >= 1,
    JSON.stringify(resetBody));

  const emptyLive = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  const emptyDeleted = await fetch(`${BASE}/api/race-days?deleted=1`).then((r) => r.json());
  check('after reset: no live and no deleted race days',
    emptyLive.length === 0 && emptyDeleted.length === 0);

  await new Promise((r) => setTimeout(r, 300));
  const appLogFile = path.join(tmp, 'logs', 'app.jsonl');
  const appEvents = fs.readFileSync(appLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('the fresh app log opens with the app_reset event (auditable era start)',
    appEvents.length >= 1 && appEvents[0].event === 'app_reset' &&
    appEvents[0].rowsRemoved.race_days === 2);
  check('decision-trace log file is gone until something writes again',
    !fs.existsSync(traceFile));

  const freshSave = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  check('after reset: race-day ids restart at 1 (safe - the old logs went too)',
    freshSave.id === 1);

  // ---- track canonicalization (D35): every spelling collides on the code ----
  const spellingDate = '2026-01-01';
  const spellingPayload = (track) => ({
    track, date: spellingDate, bankrollCents: 20000, perRaceMinCents: 500, races: parsed.races,
  });
  const spellA = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spellingPayload('Delmar')),
  });
  check('track spelling "Delmar" saves', spellA.status === 201);
  const spellB = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spellingPayload('DEL MAR')),
  });
  check('"DEL MAR" collides with "Delmar" on the same date (same code) -> 409', spellB.status === 409);
  const spellC = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spellingPayload('Del Mar'), replace: true }),
  });
  const spellCBody = await spellC.json();
  check('"Del Mar" replaces the same row under the shared code', spellC.status === 201);
  const spellRow = await fetch(`${BASE}/api/race-days/${spellCBody.id}`).then((r) => r.json());
  check('the saved day carries the canonical display name and code regardless of input spelling',
    spellRow.track === 'Del Mar' && spellRow.track_code === 'DMR', JSON.stringify(spellRow));

  const unknownTrack = await fetch(`${BASE}/api/parse/entries-text`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Santa Anita Daily Entries\nRace 1\n' }),
  }).then((r) => r.json());
  check('an unrecognized track never blocks the preview, just warns',
    unknownTrack.track === 'Santa Anita' &&
    unknownTrack.warnings.some((w) => w.type === 'unrecognized_track'), JSON.stringify(unknownTrack.warnings));

  const knownTrack = await fetch(`${BASE}/api/parse/entries-text`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Del Mar Daily Entries\nRace 1\n' }),
  }).then((r) => r.json());
  check('a recognized track never warns',
    !knownTrack.warnings.some((w) => w.type === 'unrecognized_track'));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
}

if (failures) {
  console.error(`\ncheck-ingest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-ingest: all checks passed');
