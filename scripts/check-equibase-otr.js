// Verification for D71 (Equibase "Off to the Races" PDF picker) - exits
// non-zero on any failure. Run: npm run check-equibase-otr
//
// Unit checks the pure parser (shared/parsers/equibase-otr.js) against the
// real committed 2026-09-03 Del Mar fixture (extraction was verified
// byte-for-byte against this exact file before any parser code was
// written - see the D71 ledger row) plus synthetic edge cases, then boots
// the real server and exercises the full upload -> preview -> confirm ->
// three-card round trip, append-only re-upload, per-ticket blocking on an
// unknown program number, the D07 track/date mismatch refusal, bucket
// isolation in P/L, archive/manifest persistence with a from-archive
// re-parse, and the no-engine-version-bump identity.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-otrcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const { parseEquibaseOtrTsv } = await import('../shared/parsers/equibase-otr.js');
const { runPdftotextTsv } = await import('../server/equibase-otr.js');

const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-otr');
const fixturePdf = path.join(FIXTURE_DIR, 'DMR-2026-09-03.pdf');
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'DMR-2026-09-03.expected.json'), 'utf8'));

// ========== 1. Golden parse + structural invariants on the real file ==========

const realTsv = runPdftotextTsv(fixturePdf);
const realParsed = parseEquibaseOtrTsv(realTsv);

check('real fixture: track and date read from the header', realParsed.parsedTrack === golden.parsedTrack && realParsed.parsedDate === golden.parsedDate,
  JSON.stringify({ track: realParsed.parsedTrack, date: realParsed.parsedDate }));
check('real fixture: zero warnings', realParsed.warnings.length === 0, JSON.stringify(realParsed.warnings));
check('real fixture: all 8 races match the golden exactly', realParsed.races.length === 8 && golden.races.every((g) => {
  const r = realParsed.races.find((x) => x.race === g.race);
  return r && r.showPick === g.showPick && r.winPick === g.winPick &&
    JSON.stringify(r.box4) === JSON.stringify(g.box4) && JSON.stringify(r.box3) === JSON.stringify(g.box3);
}), JSON.stringify(realParsed.races.map(({ race, showPick, winPick, box4, box3 }) => ({ race, showPick, winPick, box4, box3 }))));
check('real fixture: every structural invariant holds on all 8 races (box3==box4[:3], box4[0]==show, box4[1]==win)',
  realParsed.races.every((r) => JSON.stringify(r.box3) === JSON.stringify(r.box4.slice(0, 3)) && r.box4[0] === r.showPick && r.box4[1] === r.winPick));

// ========== 2. Header trivia sentence contributes no picks ==========

check('R1 trivia horse "Visually" is not a captured name anywhere', !Object.values(realParsed.races.find((r) => r.race === 1).names).some((n) => n.includes('Visually')));
check('R4 trivia ("#7 Separator...") is not a captured name anywhere', !Object.values(realParsed.races.find((r) => r.race === 4).names).some((n) => n.includes('Separator')));

// ========== synthetic TSV builder ==========

let wordSeq = 0;
const tsvHeaderRow = 'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
function wordRow(page, top, left, text) {
  wordSeq += 1;
  return ['5', String(page), '0', '0', '0', String(wordSeq), String(left), String(top), '20', '10', '100', text].join('\t');
}
/** One printed line: left-tier phrase (words at x<360) + right-tier phrase (words at x>=360). */
function tsvLine(page, top, leftPhrase, rightPhrase) {
  const rows = [];
  (leftPhrase ? leftPhrase.split(' ') : []).forEach((w, i) => rows.push(wordRow(page, top, 10 + i * 30, w)));
  (rightPhrase ? rightPhrase.split(' ') : []).forEach((w, i) => rows.push(wordRow(page, top, 400 + i * 40, w)));
  return rows;
}
function buildSyntheticTsv(lines) {
  const rows = [tsvHeaderRow];
  lines.forEach((l, i) => rows.push(...tsvLine(1, 10 + i * 10, l.left, l.right)));
  return rows.join('\n');
}

// ========== 3. Wrapped 4th box horse on a continuation line ==========

const wrappedTsv = buildSyntheticTsv([
  { left: 'Race 1: #1 Visually is considered the long shot to win this race.' },
  { left: '$2 to Show on #2 Tahini', right: '$2 to Win on #5 Certitude' },
  { left: '$1 Exacta box on #2 Tahini, #5 Certitude, #3 Saratoga Special and', right: '$2 Exacta box on #2 Tahini, #5 Certitude and #3' },
  { left: "#4 Bit's Tiger Magic", right: 'Saratoga Special' },
]);
const wrappedParsed = parseEquibaseOtrTsv(wrappedTsv);
const wrappedR1 = wrappedParsed.races.find((r) => r.race === 1);
check('synthetic: wrapped 4th box horse on a continuation line still yields box4 of length 4',
  wrappedR1 && wrappedR1.box4.length === 4 && JSON.stringify(wrappedR1.box4) === JSON.stringify(['2', '5', '3', '4']),
  JSON.stringify(wrappedR1));
check('synthetic: box3 unaffected by the wrap (length 3)', wrappedR1 && JSON.stringify(wrappedR1.box3) === JSON.stringify(['2', '5', '3']));

// ========== 4. box3 != box4[:3] -> non-blocking otr_structure_warning, race still ingested ==========

const mismatchTsv = buildSyntheticTsv([
  { left: 'Race 1: some trivia sentence.' },
  { left: '$2 to Show on #2 Tahini', right: '$2 to Win on #5 Certitude' },
  { left: '$1 Exacta box on #2 Tahini, #5 Certitude, #3 Saratoga Special', right: '$2 Exacta box on #2 Tahini, #5 Certitude and #9 Some Other Horse' },
]);
const mismatchParsed = parseEquibaseOtrTsv(mismatchTsv);
const mismatchR1 = mismatchParsed.races.find((r) => r.race === 1);
check('synthetic: box3 != box4[:3] -> race still ingested with whatever parsed',
  mismatchR1 && JSON.stringify(mismatchR1.box4) === JSON.stringify(['2', '5', '3']) && JSON.stringify(mismatchR1.box3) === JSON.stringify(['2', '5', '9']));
check('synthetic: otr_structure_warning raised, non-blocking',
  mismatchParsed.warnings.some((w) => w.type === 'otr_structure_warning' && w.race === 1 && w.blocking === false),
  JSON.stringify(mismatchParsed.warnings));

// ========== real server round trip ==========

const API_PORT = 8920;
const BASE = `http://127.0.0.1:${API_PORT}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(API_PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
    BETSHEET_LLM_TEST_MODE: '1',
    BETSHEET_OTR_ARCHIVE_DIR: path.join(tmp, 'archive-equibase-otr'), // isolate from the real committed archive
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jpostPdf = (url, bytes) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/pdf' }, body: bytes,
});
const jget = (url) => fetch(BASE + url).then((r) => r.json());

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server boots', up, serverOut.slice(-400));

  const entriesFixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'entries', 'dmtc-2026-09-03.txt'), 'utf8');
  const parsedEntries = await (await jpost('/api/parse/entries-text', { text: entriesFixture })).json();
  const pdfBytes = fs.readFileSync(fixturePdf);

  // -------- main day: real Del Mar 2026-09-03, real entries --------
  const day = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: parsedEntries.date, bankrollCents: 20000, perRaceMinCents: 500, races: parsedEntries.races,
  })).json();
  check('seeded the real Del Mar 2026-09-03 race day', Number.isInteger(day.id));

  // 5a. Preview: archives + parses, writes nothing.
  const preview = await (await jpostPdf(`/api/race-days/${day.id}/equibase-otr`, pdfBytes)).json();
  check('preview: 8 races resolved', preview.races?.length === 8, JSON.stringify(preview.races?.map((r) => r.race)));
  check('preview: zero BLOCKING warnings (non-blocking name_mismatch warnings for foreign-bred suffixes like "Certitude (FR)" are expected and correct)',
    !preview.warnings.some((w) => w.blocking), JSON.stringify(preview.warnings));
  check('preview: parseToken is the archived file\'s sha256', typeof preview.parseToken === 'string' && preview.parseToken.length === 64);
  check('preview: variant totals are $112 / $112 / $224', preview.variantTotals['some-reward'] === 11200 && preview.variantTotals['higher-reward'] === 11200 && preview.variantTotals.both === 22400, JSON.stringify(preview.variantTotals));

  const beforeConfirm = await jget(`/api/race-days/${day.id}/cards`);
  check('preview writes NOTHING (no cards yet)', beforeConfirm.length === 0);

  // 6. Confirm: three cards, correct ticket counts/costs.
  const confirm = await (await jpost(`/api/race-days/${day.id}/equibase-otr/confirm`, { parseToken: preview.parseToken })).json();
  check('confirm: three cards created', confirm.cards?.length === 3, JSON.stringify(confirm.cards));
  const cardsAfter = await jget(`/api/race-days/${day.id}/cards`);
  const byVariant = Object.fromEntries(cardsAfter.map((c) => [c.variant, c]));
  check('some-reward card: $112, 16 tickets (2 per race x 8)', byVariant['some-reward']?.bankroll_cents === 11200 && byVariant['some-reward']?.tickets === 16, JSON.stringify(byVariant['some-reward']));
  check('higher-reward card: $112, 16 tickets', byVariant['higher-reward']?.bankroll_cents === 11200 && byVariant['higher-reward']?.tickets === 16, JSON.stringify(byVariant['higher-reward']));
  check('both card: $224, 32 tickets', byVariant.both?.bankroll_cents === 22400 && byVariant.both?.tickets === 32, JSON.stringify(byVariant.both));
  check('every card: template equibase-otr, completeness EQB_OTR, engine_version equibase-otr',
    cardsAfter.every((c) => c.template === 'equibase-otr' && c.consensus_completeness === 'EQB_OTR' && c.engine_version === 'equibase-otr'),
    JSON.stringify(cardsAfter));

  // Append-only on re-upload: uploading again adds THREE MORE cards.
  const preview2 = await (await jpostPdf(`/api/race-days/${day.id}/equibase-otr`, pdfBytes)).json();
  await jpost(`/api/race-days/${day.id}/equibase-otr/confirm`, { parseToken: preview2.parseToken });
  const cardsAfterReupload = await jget(`/api/race-days/${day.id}/cards`);
  check('re-upload is append-only: 6 cards total, 3 more card_numbers', cardsAfterReupload.length === 6);

  // -------- 5. unknown program number: blocking for that ticket only --------
  // A race day is one per (track, date) and the sheet's own printed date
  // must match the day (D07, checked in check 7 below) - so this can't be
  // exercised through a second day upload without also re-dating the day
  // to collide with the PDF's own header. Proved directly instead, against
  // the real TSV and the real entries minus #4 (R1's box4[3]) - the exact
  // unit under test, no server needed.
  const strippedRaces = parsedEntries.races.map((r) => r.number === 1
    ? { ...r, entries: r.entries.filter((e) => e.programNumber !== '4') }
    : r);
  const entriesByRaceMissing = {};
  for (const r of strippedRaces) entriesByRaceMissing[r.number] = r.entries.map((e) => ({ program_number: e.programNumber, horse_name: e.horseName }));
  const parsedMissing = parseEquibaseOtrTsv(realTsv, { entriesByRace: entriesByRaceMissing });
  const r1Missing = parsedMissing.races.find((r) => r.race === 1);
  check('unknown program number (#4 removed from entries): flagged blocking on the box ticket',
    parsedMissing.warnings.some((w) => w.type === 'unknown_program' && w.race === 1 && w.blocking === true && w.message.includes('4')),
    JSON.stringify(parsedMissing.warnings.filter((w) => w.race === 1)));
  check('unknown program number: R1 show pick (#2, unaffected) is NOT in blockedTickets', r1Missing && !r1Missing.blockedTickets.includes('show'));
  check('unknown program number: R1 box4 ticket IS in blockedTickets (references #4)', r1Missing && r1Missing.blockedTickets.includes('exacta_box_4'));
  check('unknown program number: every OTHER race parses with zero blocked tickets', parsedMissing.races.filter((r) => r.race !== 1).every((r) => r.blockedTickets.length === 0));

  // -------- 7. track/date mismatch refused (D07) --------
  const wrongDay = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-09-04', bankrollCents: 20000, perRaceMinCents: 500, races: parsedEntries.races,
  })).json();
  const mismatchUpload = await jpostPdf(`/api/race-days/${wrongDay.id}/equibase-otr`, pdfBytes);
  const mismatchBody = await mismatchUpload.json();
  check('track/date mismatch: refused with 422 and the D07 message', mismatchUpload.status === 422 && /Wrong sheet - nothing saved/.test(mismatchBody.error), JSON.stringify(mismatchBody));
  const wrongDayCards = await jget(`/api/race-days/${wrongDay.id}/cards`);
  check('track/date mismatch: nothing saved', wrongDayCards.length === 0);

  const saDay = await (await jpost('/api/race-days', {
    track: 'Santa Anita', date: '2026-09-03', bankrollCents: 20000, perRaceMinCents: 500, races: parsedEntries.races,
  })).json();
  const trackMismatchUpload = await jpostPdf(`/api/race-days/${saDay.id}/equibase-otr`, pdfBytes);
  check('track mismatch (same date, different track): refused with 422', trackMismatchUpload.status === 422);

  // -------- 8. bucket isolation in P/L against the engine's own bucket, HUMAN, LLM_GENERATED --------
  // (This fixture day is seeded from entries-text only, no program PDF, so
  // the live-generated lean card lands in ODDS_ONLY per D40 - not
  // PROGRAM_ONLY. Either way it must never mix with EQB_OTR.)
  // Synthetic results so every card on this day grades (loss is fine -
  // this proves isolation, not payout correctness).
  const resultsRaces = preview.races.map((r) => ({
    number: r.race,
    results: [
      { programNumber: r.winPick, horseName: r.names[r.winPick] ?? 'Winner', finishPosition: 1, winCents: 400, placeCents: 250, showCents: 210 },
      { programNumber: r.showPick, horseName: r.names[r.showPick] ?? 'Placer', finishPosition: 2, winCents: null, placeCents: 260, showCents: 220 },
      { programNumber: r.box3[2], horseName: r.names[r.box3[2]] ?? 'Shower', finishPosition: 3, winCents: null, placeCents: null, showCents: 200 },
    ],
    exotics: [], scratches: [],
  }));
  await jpost(`/api/race-days/${day.id}/results`, { track: 'Del Mar', date: parsedEntries.date, sourceKind: 'paste', races: resultsRaces });

  // A card with zero graded tickets never appears in a P/L bucket (the
  // query inner-joins graded_tickets_latest), so HUMAN/LLM_GENERATED each
  // need one real, gradeable ticket on program #2 (Tahini, real R1 entry).
  await jpost(`/api/race-days/${day.id}/cards`, { bankrollCents: 20000, perRaceMinCents: 500 }); // engine-generated lean card
  await jpost(`/api/race-days/${day.id}/human-cards`, { race: 1, text: 'Win | #2 | $20 | test pick' }); // HUMAN card
  const llmResponse = 'Reasoning: consensus favorite.\n\n<<<TICKETS>>>\nWin | #2 | $20 | Test.\n<<<END TICKETS>>>\n';
  const llmPreview = await (await jpost(`/api/race-days/${day.id}/llm-cards/preview`, { race: 1, __stubResponse: llmResponse })).json();
  await jpost(`/api/race-days/${day.id}/llm-cards`, { race: 1, requestId: llmPreview.requestId, bankrollCents: 2000 }); // LLM_GENERATED card

  const pl = await jget('/api/pl?engineVersion=all');
  const bucketNames = pl.buckets.map((b) => b.completeness);
  const leanBucket = bucketNames.find((k) => k !== 'EQB_OTR' && k !== 'HUMAN' && k !== 'LLM_GENERATED');
  check('P/L: EQB_OTR is its own bucket, distinct from the lean engine bucket/HUMAN/LLM_GENERATED',
    bucketNames.includes('EQB_OTR') && Boolean(leanBucket) && bucketNames.includes('HUMAN') && bucketNames.includes('LLM_GENERATED'), JSON.stringify(bucketNames));
  const eqbBucket = pl.buckets.find((b) => b.completeness === 'EQB_OTR');
  check('P/L: EQB_OTR bucket carries exactly the 6 equibase-otr cards (3 originals + 3 re-upload)', eqbBucket?.cards === 6, JSON.stringify(eqbBucket));
  check('P/L: the lean/HUMAN/LLM_GENERATED buckets each carry exactly their own 1 card, no bleed from EQB_OTR',
    [leanBucket, 'HUMAN', 'LLM_GENERATED'].every((k) => pl.buckets.find((b) => b.completeness === k)?.cards === 1),
    JSON.stringify(pl.buckets));

  // -------- 9. archive + manifest; re-parse from archive matches golden --------
  const otrArchiveDir = path.join(tmp, 'archive-equibase-otr');
  const manifestPath = path.join(otrArchiveDir, 'DMR', 'manifest.json');
  const archivedPdfPath = path.join(otrArchiveDir, 'DMR', `${parsedEntries.date}.pdf`);
  check('archive: PDF file written', fs.existsSync(archivedPdfPath));
  check('archive: manifest.json written with sha256/uploaded_at/bytes', (() => {
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const row = manifest[parsedEntries.date];
    return row && typeof row.sha256 === 'string' && row.sha256.length === 64 && typeof row.uploaded_at === 'string' && row.bytes === pdfBytes.length;
  })(), fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : 'no manifest');
  const archiveTsv = runPdftotextTsv(archivedPdfPath);
  const archiveParsed = parseEquibaseOtrTsv(archiveTsv);
  check('re-run from the archived file produces the identical golden', golden.races.every((g) => {
    const r = archiveParsed.races.find((x) => x.race === g.race);
    return r && r.showPick === g.showPick && r.winPick === g.winPick &&
      JSON.stringify(r.box4) === JSON.stringify(g.box4) && JSON.stringify(r.box3) === JSON.stringify(g.box3);
  }));

  // -------- 10. no engine-version bump; lean identity unchanged --------
  const { ENGINE_VERSION } = await import('../shared/card-engine.js');
  check('shared/card-engine.js ENGINE_VERSION unchanged at lean-1.1', ENGINE_VERSION === 'lean-1.1');
  const leanCard = await jget(`/api/cards/${cardsAfter.find((c) => c.template !== 'equibase-otr')?.id ?? cardsAfter[0].id}`);
  const leanCards = await jget(`/api/race-days/${day.id}/cards`);
  check('a live lean card still generates fine on this day', leanCards.some((c) => c.engine_version === 'lean-1.1'), JSON.stringify(leanCards.map((c) => c.engine_version)));

  // Missing/deleted day guards.
  check('upload to a nonexistent race day -> 404', (await jpostPdf('/api/race-days/999999/equibase-otr', pdfBytes)).status === 404);
  check('confirm without parseToken -> 400', (await jpost(`/api/race-days/${day.id}/equibase-otr/confirm`, {})).status === 400);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
}

if (failures) {
  console.error(`\ncheck-equibase-otr: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-otr: all checks passed');
