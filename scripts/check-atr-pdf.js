// Verification for the At The Races racecard-PDF consensus upload (D69) -
// exits non-zero on any failure. Run: npm run check-atr-pdf
//
// Unit checks the pure parser (shared/parsers/atr-pdf.js) against the real
// committed fixture plus two synthetic edge cases, then boots the real
// server and exercises the full upload -> preview -> confirm -> audit
// flow against that same fixture, seeded onto the real Del Mar 2026-09-03
// card (tests/fixtures/entries/dmtc-2026-09-03.txt) so program numbers
// resolve to real entries exactly like check-consensus.js's manual-paste
// checks do.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API_PORT = 8916;
const BASE = `http://127.0.0.1:${API_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-atrpdfcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- unit checks (no server needed) ----------

const { parseAtrPdfText } = await import('../shared/parsers/atr-pdf.js');
const { extractPdfLines } = await import('../server/pdf-text.js');

const fixturePdf = path.join(ROOT, 'tests', 'fixtures', 'atr-pdf', 'delmar-2026-09-03.pdf');
const fixtureText = await extractPdfLines(fixturePdf);

// 1. All 8 races extract with correct {name, programNumber} pairs for both
// Top Tip and Watch out for.
const EXPECTED = [
  { race: 1, top: ["BIT'S TIGER MAGIC", '4'], watch: ['TAHINI', '2'] },
  { race: 2, top: ['SUGAR REIGN', '8'], watch: ['GOOD GOLLY DOLLY', '2'] },
  { race: 3, top: ['DAZZLE COMM', '10'], watch: ['FARMER TOM', '4'] },
  { race: 4, top: ['UNBINDING', '1'], watch: ['NOT A SINNER', '4'] },
  { race: 5, top: ['PLAGARIST', '5'], watch: ['TRUTH OR DARE', '4'] },
  { race: 6, top: ['DEA MATRONA', '4'], watch: ['THE WHITE LADY', '7'] },
  { race: 7, top: ['CHRISTEL CLEAN', '2'], watch: ['PAVEL IS APPEALING', '4'] },
  { race: 8, top: ['HEROIC DOSE', '1'], watch: ['HIGH KING', '5'] },
];
const fixtureParsed = parseAtrPdfText(fixtureText);
check('real fixture: all 8 races extract, zero warnings',
  fixtureParsed.picks.length === 8 && fixtureParsed.warnings.length === 0,
  JSON.stringify(fixtureParsed));
check('real fixture: every Top Tip / Watch out for pair matches exactly', EXPECTED.every((e) => {
  const p = fixtureParsed.picks.find((x) => x.race === e.race);
  return p && p.topPick.name === e.top[0] && p.topPick.programNumber === e.top[1] &&
    p.watchFor.name === e.watch[0] && p.watchFor.programNumber === e.watch[1];
}), JSON.stringify(fixtureParsed.picks));

// 2. A synthetic block missing the Top Tip line -> missing_verdict warning
// for that race number, other races unaffected.
const synthMissing = `
Race 1 - Allowance Optional Claiming
Verdict: some prose here.
Top Tip: BIT'S TIGER MAGIC (4)
Watch out for: TAHINI (2)
Race 2 - Claiming
Verdict: some other prose.
Watch out for: GOOD GOLLY DOLLY (2)
Race 3 - Maiden Claiming
Verdict: more prose.
Top Tip: DAZZLE COMM (10)
Watch out for: FARMER TOM (4)
`;
const missingParsed = parseAtrPdfText(synthMissing);
check('synthetic: race missing Top Tip warns missing_verdict for that race only',
  missingParsed.picks.map((p) => p.race).join(',') === '1,3' &&
  missingParsed.warnings.length === 1 &&
  missingParsed.warnings[0].type === 'missing_verdict' &&
  missingParsed.warnings[0].race === 2,
  JSON.stringify(missingParsed));

// 3. Running header/footer noise between blocks does not cause mis-scoping
// of race numbers (no picks bleed into the wrong race).
const synthNoise = `
Race 1 - Allowance Optional Claiming
Top Tip: BIT'S TIGER MAGIC (4)
Watch out for: TAHINI (2)
ASCOT RACECARDS RESULTS BEST ODDS ATR PLAYER GREYHOUNDS NEWS TIPS BLOGS
Racecards, odds & results Today's Cards Tomorrow's Cards Market Movers Replays ATR App Top O
FREE BETS
https://www.attheraces.com/racecards/Del-Mar/03-September-2026 5/11
Last Updated: 03 Sep 2026 06:26:41
Make this tab my default
Race 2 - Claiming
Top Tip: SUGAR REIGN (8)
Watch out for: GOOD GOLLY DOLLY (2)
`;
const noiseParsed = parseAtrPdfText(synthNoise);
check('synthetic: header/footer noise between blocks does not bleed into either race',
  noiseParsed.picks.length === 2 &&
  noiseParsed.picks[0].race === 1 && noiseParsed.picks[0].topPick.programNumber === '4' &&
  noiseParsed.picks[1].race === 2 && noiseParsed.picks[1].topPick.programNumber === '8' &&
  noiseParsed.warnings.length === 0,
  JSON.stringify(noiseParsed));

// ---------- end-to-end (real server, real DB) ----------

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(API_PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body, headers = {}) => fetch(BASE + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const jpostPdf = (url, bytes) => fetch(BASE + url, {
  method: 'POST',
  headers: { 'content-type': 'application/pdf' },
  body: bytes,
});

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server boots', up, serverOut.slice(-400));

  const entriesFixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'entries', 'dmtc-2026-09-03.txt'), 'utf8');
  const parsedEntries = await (await jpost('/api/parse/entries-text', { text: entriesFixture })).json();
  const saved = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: parsedEntries.date, bankrollCents: 20000, perRaceMinCents: 500, races: parsedEntries.races,
  })).json();
  const dayId = saved.id;
  check('seeded the real Del Mar 2026-09-03 race day', Number.isInteger(dayId));

  const pdfBytes = fs.readFileSync(fixturePdf);

  // 4a. Preview: parses, resolves against real entries, writes nothing.
  const preview = await (await jpostPdf(`/api/race-days/${dayId}/consensus/atr-pdf-preview?sourceName=At+The+Races`, pdfBytes)).json();
  check('preview: 8 races resolved, top pick #4 Bit\'s Tiger Magic and watch #2 Tahini for race 1', (() => {
    const r1 = preview.races.find((r) => r.race === 1);
    const top = r1?.picks.find((p) => p.pickType === 'top');
    const watch = r1?.picks.find((p) => p.pickType === 'watch_out');
    return preview.races.length === 8 &&
      top?.programNumber === '4' && top?.horseName === "Bit's Tiger Magic" && top?.entryId != null &&
      watch?.programNumber === '2' && watch?.horseName === 'Tahini' && watch?.entryId != null;
  })(), JSON.stringify(preview.races.find((r) => r.race === 1)));
  check('preview: no warnings on the real fixture against the real card', preview.warnings.length === 0, JSON.stringify(preview.warnings));

  const beforeConfirm = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  check('preview writes NOTHING', !beforeConfirm.picks.some((p) => p.source_name === 'At The Races'));

  // 4b. Confirm: stores exactly what the preview showed - same row shape a
  // manual "Race 1: 4, 2" paste would have produced for the same data.
  const confirm = await (await jpost(`/api/race-days/${dayId}/consensus/atr-pdf`, {
    sourceName: preview.sourceName, races: preview.races,
  })).json();
  const after = await (await fetch(`${BASE}/api/race-days/${dayId}/consensus`)).json();
  const atrPicks = after.picks.filter((p) => p.source_name === 'At The Races');
  check('confirm stores 16 picks (8 races x top + watch)',
    confirm.picksStored === 16 && atrPicks.length === 16, `stored=${confirm.picksStored} rows=${atrPicks.length}`);
  check('confirmed row shape matches what a manual "Race 1: 4 | watch: 2" paste would have produced', (() => {
    const r1Top = atrPicks.find((p) => p.race_number === 1 && p.pick_type === 'top');
    const r1Watch = atrPicks.find((p) => p.race_number === 1 && p.pick_type === 'watch_out');
    return r1Top?.program_number === '4' && r1Top?.entry_id != null &&
      r1Watch?.program_number === '2' && r1Watch?.entry_id != null;
  })(), JSON.stringify(atrPicks.filter((p) => p.race_number === 1)));

  // 5. Fetch-audit row: method distinguishable from an automated fetch or a
  // pasted paste (D69 reuses the pre-existing 'manual_upload' outcome,
  // which already existed in the schema for exactly this purpose but had
  // no write-site before this PR).
  check('fetch-audit row written with outcome=manual_upload, correct source and picks count',
    after.attempts.some((a) => a.source_name === 'At The Races' && a.outcome === 'manual_upload' && a.picks_extracted === 16));

  // Save without a preview payload -> 400, same contract as manual paste.
  check('atr-pdf save without a preview payload -> 400',
    (await jpost(`/api/race-days/${dayId}/consensus/atr-pdf`, { sourceName: 'X' })).status === 400);
  check('atr-pdf preview with a non-PDF body -> 400',
    (await jpostPdf(`/api/race-days/${dayId}/consensus/atr-pdf-preview`, Buffer.alloc(0))).status === 400);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
}

if (failures) {
  console.error(`\ncheck-atr-pdf: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-atr-pdf: all checks passed');
