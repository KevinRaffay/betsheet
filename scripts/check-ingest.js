// Verification for the ingest API - exits non-zero on any failure.
// Run: npm run check-ingest
//
// Boots the REAL server (child process) against a temp database and temp
// log dir, then exercises the whole flow over HTTP: save a real fixture day,
// read it back, conflict + replace, reject bad payloads, and parse a real
// Equibase entries page end-to-end.

import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
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

  // --- a real fixture day, save + read back ---
  //
  // Frozen output of the retired plain-text pasted-entries parser
  // (shared/entries-parser.js, deleted along with the /new page's paste box
  // that used to call it - the paste box now runs the same Equibase HTML
  // parser as the file upload, exercised further down). This day's own
  // program numbers line up with the Equibase OTR PDF fixture, which is why
  // it is frozen rather than dropped - see tests/fixtures/days/README.md.
  const parsed = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'days', 'dmtc-2026-09-03.entries.json'), 'utf8'));
  check('fixture day: 8 races, 81 entries', parsed.races.length === 8
    && parsed.races.reduce((a, r) => a + r.entries.length, 0) === 81);

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
    headers: { 'content-type': 'application/json' },
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

  // The program-PDF endpoint and its 12MB fixture went with Del Mar program
  // ingestion (D113). The SECOND day those assertions built - the one the
  // delete / restore / 410 guards below operate on - is still needed, so it
  // is saved straight from the day fixture that parse used to produce. The
  // entries, program ranks, Best Bet and Bottom Line text are the same rows;
  // only the PDF parse in front of them is gone.
  const dayFixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
  const savePdf = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      track: 'Del Mar', date: dayFixture.date, bankrollCents: 20000,
      perRaceMinCents: 500, races: dayFixture.races, analysis: dayFixture.analysis,
    }),
  });
  const listBoth = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('both days stored side by side', savePdf.status === 201 && listBoth.length === 2);
  const pdfDay = await fetch(`${BASE}/api/race-days/${listBoth.find((d) => d.date === '2026-08-30').id}`).then((r) => r.json());
  check('the fixture day stored 10 races and 98 entries',
    pdfDay.races.length === 10 && pdfDay.races.reduce((a, r) => a + r.entries.length, 0) === 98,
    JSON.stringify({ races: pdfDay.races.length }));
  const bb = pdfDay.races.find((r) => r.number === 4).entries.find((e) => e.best_bet === 1);
  check('fixture day: best bet and program ranks persisted',
    bb?.horse_name === 'Run With Liberty' && bb?.program_rank === 1);
  const raceFourAnalysis = dayFixture.analysis?.find((a) => a.race === 4)?.text;
  check('fixture day: Bottom Line text persists on the matching race',
    typeof raceFourAnalysis === 'string' && raceFourAnalysis.length > 80
      && pdfDay.races.find((r) => r.number === 4)?.bottom_line === raceFourAnalysis);

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

  // Was the engine's generate route until D111 removed it. Human entry is
  // now the cheapest card-writing mutation, and the 410 guard is what is
  // under test here, not which producer trips it.
  const lockOnDeleted = await fetch(`${BASE}/api/race-days/${pdfDay.id}/human-cards`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ race: 1, text: '$20 W 1' }),
  });
  check('mutations against a deleted day -> 410', lockOnDeleted.status === 410, String(lockOnDeleted.status));
  // The second mutation here was the consensus manual-paste route, removed
  // with consensus in D112. The LLM preview route is the surviving second
  // writer that guards on the same day-level check, and it must refuse a
  // deleted day for the same reason.
  const llmOnDeleted = await fetch(`${BASE}/api/race-days/${pdfDay.id}/llm-cards/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ race: 1 }),
  });
  check('a second mutation against a deleted day -> 410', llmOnDeleted.status === 410,
    String(llmOnDeleted.status));
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
      races: dayFixture.races,
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

  // D119: the hole this suite used to have. It checked race_days and entries
  // and stopped, so a table missing from WIPE_ORDER was invisible here - which
  // is exactly what happened to human_race_state, llm_card_requests and
  // llm_notes, added by migrations 015/018/023 after the list was written.
  // They were cleared by FK cascade, so the app LOOKED reset while 169 rows
  // went unreported in the audit event. Read the tables out of the schema
  // rather than listing them, so this assertion cannot go stale the same way.
  {
    const probe = new Database(path.join(tmp, 'check.sqlite'), { readonly: true });
    const tables = probe.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((r) => r.name).filter((t) => t !== 'schema_migrations');
    // strategy_templates is the ONE table that comes back non-empty, and that
    // is correct: the built-in templates are code, not user data, and cards
    // reference them by FK from the first save of the new era.
    const nonEmpty = tables
      .filter((t) => t !== 'strategy_templates')
      .map((t) => [t, probe.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c])
      .filter(([, c]) => c > 0);
    check('after reset: EVERY table is empty, not just the ones anyone thought to check',
      nonEmpty.length === 0, JSON.stringify(nonEmpty));
    const seeded = probe.prepare('SELECT name FROM strategy_templates ORDER BY name').all().map((r) => r.name);
    check('after reset: strategy_templates holds exactly the three surviving producers, reseeded',
      seeded.join(',') === 'equibase-otr,human,llm', seeded.join(','));

    // And the report has to name them all: a reset that destroys rows it does
    // not mention is not auditable, whatever the row counts say.
    const unreported = tables.filter((t) => !(t in resetBody.rowsRemoved));
    check('after reset: rowsRemoved names every table it wiped',
      unreported.length === 0, `unreported: ${unreported.join(', ')}`);
    check('after reset: the tables added since WIPE_ORDER was written are reported explicitly',
      ['human_race_state', 'llm_card_requests', 'llm_notes'].every((t) => t in resetBody.rowsRemoved));
    probe.close();
  }

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

  // ---- bulk delete (race-days list checkbox selection): skips graded days ----
  //
  // "Graded" for a whole day is deliberately the simple definition the user
  // chose over the more granular per-card graded_tickets check: a day HAS
  // RESULTS SAVED. Two fresh days from the same entries fixture; one gets
  // real results saved on it (a minimal but genuine save through the real
  // results endpoint, not a direct DB write, so the date/track matching this
  // endpoint enforces is exercised too), the other stays ungraded.
  const bulkA = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ track: 'Del Mar', date: '2026-02-01', bankrollCents: 20000, perRaceMinCents: 500, races: parsed.races }),
  }).then((r) => r.json());
  const bulkB = await fetch(`${BASE}/api/race-days`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ track: 'Del Mar', date: '2026-02-02', bankrollCents: 20000, perRaceMinCents: 500, races: parsed.races }),
  }).then((r) => r.json());

  const listBeforeGrading = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('list: graded is false before any results are saved',
    [bulkA.id, bulkB.id].every((id) => !listBeforeGrading.find((d) => d.id === id).graded));

  await jpost2(`/api/race-days/${bulkB.id}/results`, {
    track: 'Del Mar', date: '2026-02-02', sourceKind: 'paste',
    races: [{ number: 1, results: [{ programNumber: '4', horseName: "Bit's Tiger Magic", finishPosition: 1, winCents: 500 }] }],
  });

  const listAfterGrading = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('list: graded becomes true once race_results exist for the day',
    Boolean(listAfterGrading.find((d) => d.id === bulkB.id).graded));
  check('list: an ungraded sibling day still reports graded false',
    !listAfterGrading.find((d) => d.id === bulkA.id).graded);

  const bulkDeleteRes = await fetch(`${BASE}/api/race-days/bulk-delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [bulkA.id, bulkB.id, 999999] }),
  });
  const bulkDeleteBody = await bulkDeleteRes.json();
  check('bulk delete: 200 with a deleted/skipped shape',
    bulkDeleteRes.status === 200 && Array.isArray(bulkDeleteBody.deleted) && Array.isArray(bulkDeleteBody.skipped),
    JSON.stringify(bulkDeleteBody));
  check('bulk delete: the ungraded day is deleted',
    bulkDeleteBody.deleted.some((d) => d.id === bulkA.id));
  check('bulk delete: the graded day is skipped with reason "graded", never deleted - ' +
    'server-side and unconditional, not just a disabled checkbox',
    bulkDeleteBody.skipped.some((s) => s.id === bulkB.id && s.reason === 'graded'));
  check('bulk delete: a nonexistent id is skipped with reason "not_found", never a 500',
    bulkDeleteBody.skipped.some((s) => s.id === 999999 && s.reason === 'not_found'));

  const listAfterBulk = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('bulk delete: the deleted day is gone from the default list; the graded day is still there',
    !listAfterBulk.some((d) => d.id === bulkA.id) && listAfterBulk.some((d) => d.id === bulkB.id));

  const deletedAfterBulk = await fetch(`${BASE}/api/race-days?deleted=1`).then((r) => r.json());
  check('bulk delete: the deleted day is a soft delete, restorable from the deleted list',
    deletedAfterBulk.some((d) => d.id === bulkA.id));

  check('bulk delete: a non-array ids field -> 400',
    (await fetch(`${BASE}/api/race-days/bulk-delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: 'nope' }),
    })).status === 400);
  check('bulk delete: an empty ids array -> 400',
    (await fetch(`${BASE}/api/race-days/bulk-delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }),
    })).status === 400);

  await new Promise((r) => setTimeout(r, 300));
  const traceEventsBulk = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('bulk delete: the deleted day logs its own race_day_deleted trace event; the graded day never does',
    traceEventsBulk.some((e) => e.event === 'race_day_deleted' && e.raceDayId === bulkA.id) &&
    !traceEventsBulk.some((e) => e.event === 'race_day_deleted' && e.raceDayId === bulkB.id));

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

  // The unrecognized-track preview warning lived only in the retired
  // plain-text /parse/entries-text route (removed along with
  // shared/entries-parser.js); an unknown track still saves under a derived
  // code either way (canonicalizeTrack, checked above), it just no longer
  // gets a preview-time warning naming it - a pre-existing gap on the
  // Equibase route, not something this removal introduced.

  // ---- Equibase entries page: preview -> save -> read back (D116) ----
  //
  // LAST in the file, deliberately: it saves a day and soft-deletes it, and a
  // tombstone is exactly what the deleted-list and factory-reset assertions
  // above count. Running here means it starts from the reset's empty database
  // and cannot move anyone else's numbers.
  //
  // The ingest path for any track with no automated feed. Asserted through the
  // REAL route rather than the pure parser, because what is under test here is
  // the wiring: that the parser's fields survive insertRaceDay and come back
  // off GET /race-days/:id, which is where a widened INSERT silently drops a
  // column if its value list and its column list disagree.
  {
    const eqHtml = fs.readFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'equibase-entries', 'DMR090626USA-EQB.view-source.html'), 'utf8');
    const capturedAt = '2026-09-06T18:15:00Z';
    const prev = await (await fetch(`${BASE}/api/parse/equibase-entries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: eqHtml, oddsCapturedAt: capturedAt }),
    })).json();
    check('equibase-entries preview: 11 races, 113 entries, no warnings, labelled as its own source',
      prev.races?.length === 11
      && prev.races.reduce((a, r) => a + r.entries.length, 0) === 113
      && prev.warnings.length === 0
      && prev.entriesSource === 'equibase_html',
      JSON.stringify({ r: prev.races?.length, w: prev.warnings?.length, src: prev.entriesSource }));
    check('equibase-entries preview writes NOTHING (invariant 9)',
      (await fetch(`${BASE}/api/race-days`).then((r) => r.json())).every((d) => d.date !== '2026-09-06'));
    check('an empty body is refused 400, not parsed into an empty day',
      (await fetch(`${BASE}/api/parse/equibase-entries`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: '' }),
      })).status === 400);
    const echo = await fetch(`${BASE}/api/parse/equibase-entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'cid-echo' },
      body: JSON.stringify({ html: eqHtml }),
    }).then((r) => r.json());
    check('parse endpoint echoes a supplied correlation id', echo.correlationId === 'cid-echo');

    // The /new page's paste box (no file, so no last-modified time) posts the
    // exact same shape minus oddsCapturedAt - the one place it differs from
    // the file-upload path is that the capture time comes back unknown
    // rather than guessed.
    const pasted = await (await fetch(`${BASE}/api/parse/equibase-entries`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: eqHtml }),
    })).json();
    check('pasted markup (no oddsCapturedAt) parses identically, capture time unknown',
      pasted.races.length === 11
      && pasted.races.reduce((a, r) => a + r.entries.length, 0) === 113
      && pasted.oddsCapturedAt === null);

    // Saved under a date of its own so it cannot collide with the other days
    // this script creates.
    const eqSave = await fetch(`${BASE}/api/race-days`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        track: prev.track, date: '2026-09-20', bankrollCents: 20000, perRaceMinCents: 500,
        entriesSource: prev.entriesSource, oddsCapturedAt: prev.oddsCapturedAt, races: prev.races,
      }),
    });
    const eqBody = await eqSave.json();
    check('equibase day saves', eqSave.status === 201, JSON.stringify(eqBody).slice(0, 160));
    const eqDay = await fetch(`${BASE}/api/race-days/${eqBody.id}`).then((r) => r.json());
    const eqEntries = eqDay.races.flatMap((r) => r.entries);
    check('the day records where it came from, and when the page was captured',
      eqDay.entries_source === 'equibase_html' && eqDay.odds_captured_at === capturedAt,
      JSON.stringify({ src: eqDay.entries_source, at: eqDay.odds_captured_at }));
    check('all 11 races and 113 entries survive the round trip',
      eqDay.races.length === 11 && eqEntries.length === 113,
      JSON.stringify({ r: eqDay.races.length, e: eqEntries.length }));
    // The wager menu is the load-bearing one: TicketBuilder and human-picks.js
    // read races.wager_menu for minimums, and a null there is a silent fallback
    // to BET.minimums rather than a visible failure.
    check('every race stored a wager menu and a race type',
      eqDay.races.every((r) => r.wager_menu && r.race_type),
      JSON.stringify(eqDay.races.map((r) => [r.race_type, (r.wager_menu ?? '').slice(0, 14)])));
    check('conditions stored as prose, not the page navigation or inline script',
      eqDay.races.every((r) => r.conditions && !/Jump to Race|var httpHost/.test(r.conditions)));
    check('the Equibase-only entry fields survive insertRaceDay', (() => {
      const r3 = eqDay.races.find((r) => r.number === 3);
      return eqEntries.filter((e) => e.medication).length === 65
        && eqEntries.filter((e) => e.age_sex).length === 110
        && r3.entries.filter((e) => e.claim_price).length === 13
        && eqEntries.filter((e) => e.also_eligible).length === 6
        && eqEntries.filter((e) => e.scratched).length === 3;
    })(), JSON.stringify({
      med: eqEntries.filter((e) => e.medication).length,
      age: eqEntries.filter((e) => e.age_sex).length,
      ae: eqEntries.filter((e) => e.also_eligible).length,
      scr: eqEntries.filter((e) => e.scratched).length,
    }));
    check('live odds are null across the card and the morning line is untouched - this capture predates wagering',
      eqEntries.every((e) => e.live_odds === null && e.live_odds_decimal === null)
      && eqEntries.filter((e) => !e.scratched).every((e) => e.morning_line));
    await fetch(`${BASE}/api/race-days/${eqBody.id}`, { method: 'DELETE' });
  }
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
