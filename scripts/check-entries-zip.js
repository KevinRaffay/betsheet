// Verification for the bulk entries-zip ingest (server/entries-zip.js).
// Run: npm run check-entries-zip
//
// Boots the REAL server against a temp database and drives it over HTTP, so
// what is proved is the route a browser will actually call - not a function
// called directly with a hand-built payload.
//
// The archives are BUILT HERE from the committed entries fixtures, so this
// needs no multi-megabyte zip in the repo and the contents are known exactly.
// The zip WRITER is deliberately a different implementation from the reader
// under test: it is Node's `deflateRawSync` plus hand-written headers, so a
// pass means the two agree on the format rather than sharing a bug.

import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'equibase-entries');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-zipcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- a zip writer, independent of the reader under test ----------

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

function buildZip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const when = e.when ?? new Date(2026, 8, 6, 8, 40, 0);
    const raw = Buffer.from(e.data);
    const body = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
    lfh.writeUInt16LE(dosTime(when), 10); lfh.writeUInt16LE(dosDate(when), 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(body.length, 18); lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(dosTime(when), 12); cd.writeUInt16LE(dosDate(when), 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + body.length;
  }
  const localPart = Buffer.concat(locals); const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const postZip = (route, zip, query = '') => fetch(`${BASE}${route}${query}`, {
  method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip,
});

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
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const delMar = fs.readFileSync(path.join(FIXTURES, 'DMR090626USA-EQB.view-source.html'), 'utf8');
const woodbine = fs.readFileSync(path.join(FIXTURES, 'WO090726CAN-EQB.surfaces.html'), 'utf8');
const indexPage = fs.readFileSync(path.join(FIXTURES, 'KD090626-index-page.html'), 'utf8');

try {
  check('server boots on a temp db', await waitForHealth(), serverOut.slice(-400));

  console.log('\n-- preview: what the archive holds, and what saving it would do --');
  const good = buildZip([
    { name: 'DMR090626USA-EQB.html', data: delMar, when: new Date(2026, 8, 6, 8, 40, 0) },
    { name: 'WO090726CAN-EQB.html', data: woodbine, when: new Date(2026, 8, 7, 9, 15, 0) },
  ]);
  const prevRes = await postZip('/api/parse/equibase-entries-zip', good);
  const prev = await prevRes.json();
  check('a two-track archive previews both', prevRes.status === 200 && prev.files.length === 2,
    `${prevRes.status} ${JSON.stringify(prev).slice(0, 160)}`);
  check('each file reports its track, date and counts',
    prev.files.every((f) => f.track && f.date && f.races > 0 && f.entries > 0),
    JSON.stringify(prev.files.map((f) => [f.track, f.date, f.races, f.entries])));
  check('both are new days, so both say create',
    prev.files.every((f) => f.disposition === 'create'));
  check('EACH day carries its OWN capture time from its own zip entry, not one for the upload',
    prev.files[0].oddsCapturedAt !== prev.files[1].oddsCapturedAt
    && prev.files.every((f) => /^\d{4}-\d{2}-\d{2}T/.test(f.oddsCapturedAt)),
    JSON.stringify(prev.files.map((f) => f.oddsCapturedAt)));
  check('an archive spanning two dates says so - "a day\'s entries" is the intended shape',
    prev.spansMultipleDates === true && prev.dates.length === 2, JSON.stringify(prev.dates));
  check('the preview does not ship the whole parse back to the client',
    prev.files.every((f) => f._parsed === undefined));

  const beforeDays = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('PREVIEW WROTE NOTHING (invariant 9)', beforeDays.length === 0, String(beforeDays.length));

  console.log('\n-- save --');
  const saveRes = await postZip('/api/race-days/from-zip', good, '?bankrollCents=25000&perRaceMinCents=500');
  const save = await saveRes.json();
  check('both days save', saveRes.status === 201 && save.saved.length === 2 && save.skipped.length === 0,
    `${saveRes.status} ${JSON.stringify(save).slice(0, 200)}`);
  const days = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('and are really there afterwards', days.length === 2, String(days.length));

  const dmr = await fetch(`${BASE}/api/race-days/${save.saved.find((s) => s.track === 'Del Mar').id}`)
    .then((r) => r.json());
  check('the saved day is the real thing - 11 races, 113 entries',
    dmr.races.length === 11 && dmr.races.reduce((a, r) => a + r.entries.length, 0) === 113,
    `${dmr.races.length} races`);
  check('provenance is equibase_html, not the pasted-text default',
    dmr.entries_source === 'equibase_html', String(dmr.entries_source));
  check('the wager menu survived, so tickets are not costed at Del Mar defaults elsewhere',
    dmr.races.every((r) => r.wager_menu));
  check('the bankroll from the query is what was stored',
    dmr.bankroll_cents === 25000, String(dmr.bankroll_cents));

  console.log('\n-- policy A: a bad file does not take the good ones with it --');
  const mixed = buildZip([
    { name: 'KD-index.html', data: indexPage },
    { name: 'WO090726CAN-EQB.html', data: woodbine },
    { name: 'notes.txt', data: 'ignore me' },
  ]);
  await fetch(`${BASE}/api/race-days/${days.find((d) => d.track === 'Woodbine').id}`, { method: 'DELETE' });
  const mixedPrev = await postZip('/api/parse/equibase-entries-zip', mixed).then((r) => r.json());
  check('a non-html entry is not treated as a page at all', mixedPrev.files.length === 2,
    JSON.stringify(mixedPrev.files.map((f) => f.file)));
  check('the race-card INDEX page is called out as the wrong page, not "no races"',
    mixedPrev.files.find((f) => f.file === 'KD-index.html')?.disposition === 'skip_not_entries_page');

  const mixedSave = await postZip('/api/race-days/from-zip', mixed, '?replace=1').then((r) => r.json());
  check('the good day still saves while the bad one is skipped',
    mixedSave.saved.length === 1 && mixedSave.skipped.length === 1
    && mixedSave.skipped[0].disposition === 'skip_not_entries_page',
    JSON.stringify({ saved: mixedSave.saved.length, skipped: mixedSave.skipped.map((s) => s.disposition) }));

  console.log('\n-- an existing day is replaced only when asked --');
  const again = await postZip('/api/race-days/from-zip', good).then((r) => r.json());
  check('without ?replace=1 an existing day is left alone',
    again.saved.length === 0 && again.skipped.every((s) => s.disposition === 'skip_exists'),
    JSON.stringify({ saved: again.saved.length, skipped: again.skipped.map((s) => s.disposition) }));
  const replaced = await postZip('/api/race-days/from-zip', good, '?replace=1').then((r) => r.json());
  check('with ?replace=1 both are replaced', replaced.saved.length === 2);
  const afterReplace = await fetch(`${BASE}/api/race-days`).then((r) => r.json());
  check('replacing does not leave a duplicate day behind', afterReplace.length === 2,
    String(afterReplace.length));

  console.log('\n-- bad archives are refused, and say why --');
  for (const [name, body, pattern] of [
    ['not a zip at all', Buffer.from('just some prose'), /not a zip file/i],
    ['an empty body', Buffer.alloc(0), /raw application\/zip body/i],
    ['a zip with no html in it', buildZip([{ name: 'readme.txt', data: 'nothing here' }]), /no \.html files/i],
  ]) {
    const r = await postZip('/api/parse/equibase-entries-zip', body);
    const b = await r.json().catch(() => ({}));
    check(`${name} -> 400 naming the problem`, r.status === 400 && pattern.test(b.error ?? ''),
      `${r.status} ${b.error ?? ''}`);
  }

  console.log('\n-- the whole thing is traceable --');
  await new Promise((r) => setTimeout(r, 300));
  const appLog = fs.readFileSync(path.join(tmp, 'logs', 'app.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('the zip parse and the bulk save both land in the app log',
    appLog.some((e) => e.event === 'parse_completed' && e.kind === 'equibase_entries_zip')
    && appLog.some((e) => e.event === 'race_days_saved_from_zip'));
  const traceFile = path.join(tmp, 'logs', 'decision-trace.jsonl');
  const trace = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  check('a day replaced by the bulk path documents its supersession, like the single path does',
    trace.some((e) => e.event === 'race_day_superseded'));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
}

if (failures) {
  console.error(`\ncheck-entries-zip: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-entries-zip: all checks passed');
