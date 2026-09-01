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

  // Saving the PDF parse for its own (different) date must coexist with the
  // pasted day rather than conflict.
  const savePdf = await fetch(`${BASE}/api/race-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      track: 'Del Mar', date: pdfParsed.date, bankrollCents: 20000,
      perRaceMinCents: 500, races: pdfParsed.races,
    }),
  });
  const listBoth = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('both days stored side by side', savePdf.status === 201 && listBoth.length === 2);
  const pdfDay = await fetch(`${BASE}/api/race-days/${(await savePdf.json?.(), listBoth.find((d) => d.date === '2026-08-30').id)}`).then((r) => r.json());
  const bb = pdfDay.races.find((r) => r.number === 4).entries.find((e) => e.best_bet === 1);
  check('pdf day: best bet and program ranks persisted',
    bb?.horse_name === 'Run With Liberty' && bb?.program_rank === 1);
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
