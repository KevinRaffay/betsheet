// Verification for the ML-sheet ingest (D40) - exits non-zero on any failure.
// Run: npm run check-ml
//
// Three layers: (1) the real Del Mar ML sheet for Sunday 2026-08-16 parsed
// pure - golden diff + hand checks read off the printed sheet; (2) the
// pure merge (sheet = record, program = analysis) on synthetic inputs;
// (3) a server round trip: parse / merge / fetch endpoints (the fetch
// against a stub source on a local port, never the network), an ML-only
// save -> a card in the ODDS_ONLY tier -> its own P/L bucket.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-mlcheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
function firstDiff(a, b, at = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  return null;
}

const { parseMlSheetPdf, distanceWords, parseSummary } = await import('../server/ml-sheet-parser.js');
const { mergeMlAndProgram } = await import('../shared/entries-merge.js');
const { mlSheetUrl } = await import('../server/fetchers/dmtc-ml.js');

console.log('-- the real sheet: dmr-2026-08-16 --');
const PDF = path.join(ROOT, 'tests', 'fixtures', 'ml-sheets', 'dmr-2026-08-16.pdf');
const GOLDEN = path.join(ROOT, 'tests', 'fixtures', 'ml-sheets', 'dmr-2026-08-16.expected.json');
const out = await parseMlSheetPdf(PDF, { track: 'Del Mar', date: '2026-08-16' });
const diff = firstDiff(out, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
check('golden: dmr-2026-08-16.pdf', !diff, diff ?? '');
check('track and date from the header', out.track === 'Del Mar' && out.date === '2026-08-16', `${out.track} ${out.date}`);
check('no warnings on a clean sheet', out.warnings.length === 0, JSON.stringify(out.warnings));
check('10 races, numbered 1-10', out.races.length === 10 && out.races.every((r, i) => r.number === i + 1));
const counts = out.races.map((r) => r.entries.length);
check('entry counts per race (AE and scratched rows included)', JSON.stringify(counts) === '[6,8,10,8,6,13,7,11,11,14]', JSON.stringify(counts));
check('post times 2:00PM .. 6:49PM, every race has one (the line prints above the NEXT title)',
  out.races.map((r) => r.postTime).join(',') === '2:00PM,2:29PM,3:04PM,3:38PM,4:10PM,4:43PM,5:18PM,5:49PM,6:19PM,6:49PM', out.races.map((r) => r.postTime).join(','));
check('distances from the abbreviations', out.races.map((r) => r.distance).join('|') ===
  'One Mile And One Sixteenth|Five And One Half Furlongs|Six Furlongs|Five Furlongs|Six And One Half Furlongs|One Mile And One Sixteenth|One Mile|One Mile|Five Furlongs|Five And One Half Furlongs', out.races.map((r) => r.distance).join('|'));
check('surfaces: turf in R1, R4, R7, R9', out.races.map((r) => r.surface).join(',') === 'TURF,DIRT,DIRT,TURF,DIRT,DIRT,TURF,DIRT,TURF,DIRT');
check('race types incl. the Rancho Bernardo stakes title', out.races.map((r) => r.raceType).join('|') ===
  'MAIDEN|CLAIMING|MAIDEN|ALLOWANCE/CLAIMING|STAKES - Rancho Bernardo Stakes (Grade III)|MAIDEN CLAIMING|ALLOWANCE/CLAIMING|CLAIMING|ALLOWANCE/CLAIMING|MAIDEN CLAIMING', out.races.map((r) => r.raceType).join('|'));
check('purses and claiming prices', out.races[0].purseCents === 80000_00 && out.races[4].purseCents === 100000_00 &&
  out.races[1].claimingPriceCents === 16000_00 && out.races[7].claimingPriceCents === 8000_00 && out.races[0].claimingPriceCents === null);
check('wager menus carry the full line set (R4 names its Turf Pick 3 legs, R10 its Super High 5)', /Turf Pick 3 \(R4-7-9\)/.test(out.races[3].wagerMenu) && /Super High 5/.test(out.races[9].wagerMenu));
const scr = out.races.flatMap((r) => r.scratches.map((s) => `${r.number}:${s.programNumber} ${s.horseName}`)).join('|');
check('scratches: R6 #1 Elusive Con + #13 Sigma Boy, R10 #14 Awesome Olga', scr === '6:1 Elusive Con|6:13 Sigma Boy|10:14 Awesome Olga', scr);
check('scratched rows carry no jockey/weight/ML and the reason', out.races[5].entries[0].scratched && out.races[5].entries[0].jockey === null &&
  out.races[5].entries[0].morningLine === null && /ML sheet/.test(out.races[5].entries[0].scratchReason));
const ae = out.races.flatMap((r) => r.entries.filter((e) => e.alsoEligible).map((e) => `${r.number}:${e.programNumber}`)).join(',');
check('also-eligibles: R8 #11, R10 #13 + #14', ae === '8:11,10:13,10:14', ae);
const r1e4 = out.races[0].entries[3];
check('R1 #4 Bull Shoals: J Morelos, 120, 7/5 -> 1.4, Lasix', r1e4.horseName === 'Bull Shoals' && r1e4.jockey === 'J Morelos' && r1e4.weight === 120 &&
  r1e4.morningLine === '7/5' && r1e4.morningLineDecimal === 1.4 && r1e4.equipment === 'L');
check('whole-number odds read as N/1 (R1 #1 3 -> 3/1)', out.races[0].entries[0].morningLine === '3/1' && out.races[0].entries[0].morningLineDecimal === 3);
check('R2: every horse claims for $16,000', out.races[1].entries.every((e) => e.claimingPriceCents === 16000_00));
check('R4 #6 Piper\'s Causeway: claim WAIVED', out.races[3].entries[5].horseName === "Piper's Causeway" && out.races[3].entries[5].claimWaived && out.races[3].entries[5].claimingPriceCents === null);
check('R10 #11 Southern Riff: a band split across two text lines still reads whole (A Husain, 113, 30/1)',
  out.races[9].entries[10].horseName === 'Southern Riff' && out.races[9].entries[10].jockey === 'A Husain' && out.races[9].entries[10].weight === 113 && out.races[9].entries[10].morningLine === '30/1');
check('R5 stakes: no meds on Antifona (FR) and Sweet Azteca, L0 on the rest', out.races[4].entries.map((e) => e.equipment ?? '-').join(',') === 'L0,L0,-,L0,-,L0');
check('every non-scratched entry has name, jockey, weight and odds', out.races.every((r) => r.entries.filter((e) => !e.scratched).every((e) =>
  e.horseName && e.jockey && e.weight && e.morningLineDecimal > 0)));
check('distance words: units and fractions', distanceWords('6F') === 'Six Furlongs' && distanceWords('4 1/2F') === 'Four And One Half Furlongs' &&
  distanceWords('1M') === 'One Mile' && distanceWords('1 1/8M') === 'One Mile And One Eighth' && distanceWords('1 1/4M') === 'One Mile And One Quarter' && distanceWords('7F') === 'Seven Furlongs');
check('summary line: Turf flag stripped from the type, CA Bred note kept in conditions',
  parseSummary('5F. (Turf). Allowance/claiming. Purse $81,000. 3 yo\'s & up. Clm Price $20,000(CA Bred)').raceType === 'ALLOWANCE/CLAIMING');
check('wrong expected date/track -> warnings, never a throw', (await parseMlSheetPdf(PDF, { track: 'Santa Anita', date: '2026-08-17' })).warnings.map((w) => w.type).sort().join(',') === 'wrong_date,wrong_track');

console.log('-- the merge: sheet is the record, program is analysis --');
const mlDoc = { track: 'Del Mar', date: '2026-08-16', warnings: [], races: [{ number: 1, entries: [
  { programNumber: '1', horseName: 'Royal Rumor', jockey: 'E Jaramillo', weight: 125, morningLine: '3/1', scratched: false },
  { programNumber: '2', horseName: 'Doing Time', jockey: 'A Lezcano', weight: 120, morningLine: '8/1', scratched: true },
  { programNumber: '3', horseName: 'Big Vengeance', jockey: 'V Espinoza', weight: 120, morningLine: '5/1', scratched: false },
] }] };
const progDoc = { track: 'DELMAR', date: '2026-08-16', warnings: [{ type: 'index_renumbered', message: 'x' }], analysis: [{ race: 1, picks: ['Royal Rumor'] }], races: [{ number: 1, entries: [
  { programNumber: '1', horseName: 'Royal Rumor', jockey: 'Emisael Jaramillo', weight: 125, morningLine: '7/2', scratched: false, programRank: 1, bestBet: true, trainer: 'Doug F. O\'Neill(L. Mora)', owner: 'Stable', breeding: '3y.o.' },
  { programNumber: '2', horseName: 'Doing Time', jockey: 'Abel Lezcano', weight: 120, morningLine: '8/1', scratched: false, programRank: 3 },
  { programNumber: '3', horseName: 'Somebody Else', jockey: 'V Espinoza', weight: 120, morningLine: '5/1', scratched: false, programRank: 2 },
  { programNumber: '4', horseName: 'Ghost Entry', programRank: 4 },
] }] };
const merged = mergeMlAndProgram(mlDoc, progDoc);
const types = merged.warnings.map((w) => w.type + (w.field ? ':' + w.field : '')).sort().join(',');
check('merge: analysis lands where pgm + name agree; sheet keeps its odds/jockey/scratch',
  merged.entriesSource === 'both' && merged.races[0].entries[0].programRank === 1 && merged.races[0].entries[0].bestBet === true &&
  merged.races[0].entries[0].trainer === 'Doug F. O\'Neill(L. Mora)' && merged.races[0].entries[0].morningLine === '3/1' && merged.races[0].entries[0].jockey === 'E Jaramillo' &&
  merged.races[0].entries[1].scratched === true && merged.races[0].entries[1].programRank === 3);
check('merge: disagreements per field (odds R1 #1, scratch R1 #2); initial+surname jockeys do NOT disagree',
  types.split(',').filter((t) => t.startsWith('program_ml_disagreement')).join(',') === 'program_ml_disagreement:morningLine,program_ml_disagreement:scratched', types);
check('merge: name mismatch on #3 -> analysis NOT applied + warning; program-only #4 -> warning, not saved',
  merged.races[0].entries[2].programRank === undefined && /program_ml_name_mismatch/.test(types) && /ml_entry_missing/.test(types) && merged.races[0].entries.length === 3);
check('merge: program warnings ride along prefixed, analysis passes through', merged.warnings.some((w) => /^Program: /.test(w.message)) && merged.analysis.length === 1);
const mlOnly = mergeMlAndProgram(mlDoc, null);
check('merge: sheet alone -> entriesSource ml_sheet, no analysis', mlOnly.entriesSource === 'ml_sheet' && mlOnly.analysis.length === 0 && mlOnly.races[0].entries[0].programRank === undefined);
check('fetcher: predictable URL per date, none for a bad date', mlSheetUrl('2026-08-16') === 'https://www.dmtc.com/data/pdf/racing/morning-line/20260816.pdf' && mlSheetUrl('bad') === null);

console.log('-- server round trip --');
const STUB_PORT = 8910; const PORT = 8911; const BASE = `http://127.0.0.1:${PORT}`;
const pdfBytes = fs.readFileSync(PDF);
const hits = {};
const stub = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1;
  if (req.url === '/robots.txt') res.end('User-agent: *\nDisallow: /private\n');
  else if (req.url === '/ml/20260816.pdf') { res.setHeader('content-type', 'application/pdf'); res.end(pdfBytes); }
  else if (req.url.startsWith('/private/')) { res.setHeader('content-type', 'application/pdf'); res.end(pdfBytes); }
  else { res.statusCode = 404; res.end('no sheet'); }
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const fetchersPath = path.join(tmp, 'stub-entries-fetchers.mjs');
fs.writeFileSync(fetchersPath, `export default [
  { id: 'stub-ml', name: 'Stub ML sheet', kind: 'program', produces: 'entries', supports: ({ track }) => /del ?mar/i.test(track),
    buildUrl: ({ date }) => 'http://127.0.0.1:${STUB_PORT}/ml/' + date.replace(/-/g, '') + '.pdf', parse: () => { throw new Error('entries'); } },
  { id: 'stub-ml-private', name: 'Stub private sheet', kind: 'program', produces: 'entries', supports: ({ track }) => /santa anita/i.test(track),
    buildUrl: ({ date }) => 'http://127.0.0.1:${STUB_PORT}/private/' + date + '.pdf', parse: () => { throw new Error('entries'); } },
];`);
const logDir = path.join(tmp, 'server-logs');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: path.join(tmp, 'check.sqlite'), BETSHEET_LOG_DIR: logDir,
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1', BETSHEET_EXTRA_FETCHERS: fetchersPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = ''; server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
const jpost = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jget = (url) => fetch(BASE + url).then((r) => r.json());
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); } }
  check('server boots', up, serverOut.slice(-300));
  const parsed = await (await fetch(`${BASE}/api/parse/ml-pdf?track=Del%20Mar&date=2026-08-16`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdfBytes })).json();
  check('POST /parse/ml-pdf: the upload parses to the same document as the pure parser',
    firstDiff({ ...parsed, correlationId: undefined, entriesSource: undefined }, { ...out, correlationId: undefined, entriesSource: undefined }) === null && parsed.entriesSource === 'ml_sheet');
  const mergedApi = await (await jpost('/api/parse/merge', { ml: mlDoc, program: progDoc })).json();
  check('POST /parse/merge == the pure merge', firstDiff({ ...mergedApi, correlationId: undefined }, { ...merged, correlationId: undefined }) === null);
  check('POST /parse/merge: bad body -> 400', (await jpost('/api/parse/merge', { program: progDoc })).status === 400);
  const fetched = await jpost('/api/fetch/ml-sheet', { track: 'Del Mar', date: '2026-08-16' });
  const fetchedBody = await fetched.json();
  check('POST /fetch/ml-sheet: stub source fetched, parsed, previewed (never saved)', fetched.status === 200 && fetchedBody.races.length === 10 &&
    /\/ml\/20260816\.pdf$/.test(fetchedBody.fetchedFrom) && hits['/ml/20260816.pdf'] === 1 && (await jget('/api/race-days')).length === 0,
    JSON.stringify(fetchedBody.error ?? fetchedBody.fetchedFrom));
  check('fetch: missing sheet -> 404, robots-disallowed path NEVER requested (403), unknown track -> 404',
    (await jpost('/api/fetch/ml-sheet', { track: 'Del Mar', date: '2026-08-17' })).status === 404 &&
    (await jpost('/api/fetch/ml-sheet', { track: 'Santa Anita', date: '2026-08-16' })).status === 403 && !Object.keys(hits).some((u) => u.startsWith('/private/')) &&
    (await jpost('/api/fetch/ml-sheet', { track: 'Golden Gate', date: '2026-08-16' })).status === 404);
  const saved = await (await jpost('/api/race-days', { track: 'Del Mar', date: '2026-08-16', bankrollCents: 20000, perRaceMinCents: 500, entriesSource: 'ml_sheet', races: fetchedBody.races })).json();
  const day = await jget(`/api/race-days/${saved.id}`);
  check('ML-only save: entries_source recorded, scratches + odds persisted', day.entries_source === 'ml_sheet' && day.races.length === 10 &&
    day.races[5].entries.filter((e) => e.scratched).length === 2 && day.races[0].entries.find((e) => e.program_number === '4').morning_line === '7/5',
    JSON.stringify({ src: day.entries_source, races: day.races?.length }));
  const refetch = await jpost('/api/fetch/ml-sheet', { track: 'Del Mar', date: '2026-08-16' });
  const attempts = await jget(`/api/race-days/${saved.id}/consensus`);
  check('fetch after the day exists: audited in fetch_attempts as well', refetch.status === 200 && JSON.stringify(attempts).includes('Stub ML sheet'));
  const card = await (await jpost(`/api/race-days/${saved.id}/cards`, { variant: 'default' })).json();
  check('a card on an ML-only day lands in the ODDS_ONLY tier under engine lean-1.0.1, morning-line fallback traced',
    card.completeness === 'ODDS_ONLY' && card.engineVersion === 'lean-1.0.1' && card.tickets.length > 0 &&
    card.trace.some((e) => e.event === 'rule_fired' && e.rule === 'ml_order_fallback'), JSON.stringify({ c: card.completeness, v: card.engineVersion, n: card.tickets?.length, err: card.error }));
  const pl = await jget('/api/pl');
  check('P/L: an ODDS_ONLY card waits ungraded in its own tier, never pooled', pl.ungraded.some((c) => c.cardId === card.id && c.completeness === 'ODDS_ONLY'));
  await new Promise((rr) => setTimeout(rr, 300));
  const audit = fs.readFileSync(path.join(logDir, 'fetch-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('fetch-audit stream: every ML fetch attempt landed (ok, http_error, blocked)',
    ['ok', 'http_error', 'blocked'].every((o) => audit.some((e) => e.event === 'fetch_attempt' && /Stub/.test(e.source ?? '') && e.outcome === o)),
    JSON.stringify(audit.filter((e) => e.event === 'fetch_attempt').map((e) => [e.source, e.outcome])));
} finally {
  server.kill(); stub.close();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}
if (failures) { console.error(`\ncheck-ml: ${failures} failure(s)`); process.exit(1); }
console.log('\ncheck-ml: all checks passed');
