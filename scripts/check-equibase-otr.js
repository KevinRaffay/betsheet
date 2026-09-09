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

// ========== 1b. all 16 archived files (D71 follow-up: single-file verification missed this) ==========
//
// D71 shipped verified against ONE file (2026-09-03). Running the SAME
// method over every archived file (16 files, 143 races) found race 9 of
// every 10-race day corrupted: race 10's trivia sentence sometimes prints
// on its own y-line, absorbed into race 9's still-open column. Fixed by a
// trivia-line guard (independent of the header) plus grammar-anchored box
// extraction (a box list follows "#a, #b, #c and #d" - collect through the
// first # after "and", flag anything left over as otr_trailing_tokens
// rather than silently including it). All 16 must now be clean.

const ALL_FIXTURE_DATES = [
  '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-13', '2026-08-14',
  '2026-08-15', '2026-08-16', '2026-08-20', '2026-08-21', '2026-08-22',
  '2026-08-23', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30',
  '2026-09-03',
];
const TEN_RACE_DAYS = new Set(['2026-08-08', '2026-08-15', '2026-08-16', '2026-08-29', '2026-08-30']);

const allParsed = {};
let totalRaces = 0;
for (const date of ALL_FIXTURE_DATES) {
  const pdfPath = path.join(FIXTURE_DIR, `DMR-${date}.pdf`);
  const goldenPath = path.join(FIXTURE_DIR, `DMR-${date}.expected.json`);
  const tsv = runPdftotextTsv(pdfPath);
  const parsed = parseEquibaseOtrTsv(tsv);
  const dayGolden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  allParsed[date] = parsed;
  totalRaces += parsed.races.length;

  check(`${date}: matches its golden, zero warnings`, parsed.warnings.length === 0 && dayGolden.races.every((g) => {
    const r = parsed.races.find((x) => x.race === g.race);
    return r && r.showPick === g.showPick && r.winPick === g.winPick &&
      JSON.stringify(r.box4) === JSON.stringify(g.box4) && JSON.stringify(r.box3) === JSON.stringify(g.box3);
  }), JSON.stringify(parsed.warnings));

  if (TEN_RACE_DAYS.has(date)) {
    const r9 = parsed.races.find((r) => r.race === 9);
    const r10 = parsed.races.find((r) => r.race === 10);
    check(`${date}: race 9 has exactly 4 box4 numbers (was 5 before the fix)`, r9?.box4.length === 4, JSON.stringify(r9));
    check(`${date}: race 10 parses normally too`, r10?.box4.length === 4 && r10?.box3.length === 3, JSON.stringify(r10));
  }
}
check('all 16 files together: 143 races total', totalRaces === 143, `got ${totalRaces}`);

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
  // 12 units/word keeps up to ~29 words under OTR_COLUMN_BOUNDARY (360) -
  // a long left phrase (a box line with several horse names) must never
  // drift into right-tier x territory and get misread as a second column.
  const rows = [];
  (leftPhrase ? leftPhrase.split(' ') : []).forEach((w, i) => rows.push(wordRow(page, top, 10 + i * 12, w)));
  (rightPhrase ? rightPhrase.split(' ') : []).forEach((w, i) => rows.push(wordRow(page, top, 400 + i * 12, w)));
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

// ========== 4b. a stray 5th "#" after the box's printed close -> otr_trailing_tokens, box4 still length 4 ==========
// (the exact shape of the D71 follow-up's real bug: an unrecognized line's
// own program-number reference bleeding in AFTER the grammar's "and #N" close)

const trailingTsv = buildSyntheticTsv([
  { left: 'Race 1: some trivia sentence.' },
  { left: '$2 to Show on #2 Tahini', right: '$2 to Win on #5 Certitude' },
  { left: '$1 Exacta box on #2 Tahini, #5 Certitude, #3 Saratoga Special and #4 Bit\'s Tiger Magic #7 Stray Horse', right: '$2 Exacta box on #2 Tahini, #5 Certitude and #3 Saratoga Special' },
]);
const trailingParsed = parseEquibaseOtrTsv(trailingTsv);
const trailingR1 = trailingParsed.races.find((r) => r.race === 1);
check('synthetic: a stray 5th "#" after the box\'s close still yields box4 of length 4',
  trailingR1 && JSON.stringify(trailingR1.box4) === JSON.stringify(['2', '5', '3', '4']),
  JSON.stringify(trailingR1));
check('synthetic: the stray token is reported as otr_trailing_tokens, non-blocking, never silently absorbed',
  trailingParsed.warnings.some((w) => w.type === 'otr_trailing_tokens' && w.race === 1 && w.blocking === false && w.message.includes('#7')),
  JSON.stringify(trailingParsed.warnings));

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

  // Frozen output of the retired plain-text pasted-entries parser
  // (shared/entries-parser.js) - this day's own program numbers line up
  // with the OTR PDF fixture below, which is why it is frozen rather than
  // dropped. See tests/fixtures/days/README.md.
  const parsedEntries = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'days', 'dmtc-2026-09-03.entries.json'), 'utf8'));
  const pdfBytes = fs.readFileSync(fixturePdf);

  // -------- main day: real Del Mar 2026-09-03, real entries --------
  const day = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: parsedEntries.date, bankrollCents: 20000, perRaceMinCents: 500, races: parsedEntries.races,
  })).json();
  check('seeded the real Del Mar 2026-09-03 race day', Number.isInteger(day.id));

  // 5a. Preview: archives + parses, writes nothing.
  const preview = await (await jpostPdf(`/api/race-days/${day.id}/equibase-otr`, pdfBytes)).json();
  check('preview: 8 races resolved', preview.races?.length === 8, JSON.stringify(preview.races?.map((r) => r.race)));
  check('preview: zero BLOCKING warnings',
    !preview.warnings.some((w) => w.blocking), JSON.stringify(preview.warnings));
  // D125: this fixture's entries carry real foreign-bred suffixes (R2 "Certitude
  // (FR)" among them) while the OTR sheet's own picks print the bare name - before
  // the shared nameKey stripped parenthetical suffixes this produced a non-blocking
  // name_mismatch warning on every such horse the sheet happened to pick. A genuine,
  // unrelated name_mismatch survives on this same fixture ("Dats Ms. Blame" vs "Dats
  // Ms Blame" - a real punctuation difference, not a suffix), so the assertion is
  // narrowed to the specific suffix case rather than "zero name_mismatch warnings".
  check('preview: no name_mismatch warning for the Certitude (FR) suffix difference',
    !preview.warnings.some((w) => w.type === 'name_mismatch' && w.message.includes('Certitude')),
    JSON.stringify(preview.warnings.filter((w) => w.type === 'name_mismatch')));
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

  // D74 made the confirm ALSO write consensus_picks and re-run D09
  // classification, in the same transaction as the three cards. D112 removed
  // consensus, so the inverse is what must hold now: a confirm writes cards
  // and NOTHING else. Asserted rather than assumed, because a half-removed
  // write would be invisible until a stale row surfaced in some later count.
  {
    const { openDb } = await import('../server/db.js');
    const vdb = openDb(path.join(tmp, 'check.sqlite'));
    const rows = vdb.prepare(
      'SELECT COUNT(*) AS n FROM consensus_picks WHERE race_id IN (SELECT id FROM races WHERE race_day_id = ?)',
    ).get(day.id).n;
    check('D112: a confirm writes no consensus rows at all', rows === 0, `got ${rows}`);
    const src = vdb.prepare("SELECT COUNT(*) AS n FROM sources WHERE name = 'Equibase Off to the Races'").get().n;
    check('D112: the sheet is no longer registered as a consensus source', src === 0, `got ${src}`);
    vdb.close();
  }

  // -------- "If it hits" estimates (bug report: every equibase-otr ticket showed "-") --------
  const bothCardId = cardsAfter.find((c) => c.variant === 'both').id;
  const bothCard = await jget(`/api/cards/${bothCardId}`);
  const showTickets = bothCard.tickets.filter((t) => t.bet_type === 'show');
  const winTickets = bothCard.tickets.filter((t) => t.bet_type === 'win');
  const boxTickets = bothCard.tickets.filter((t) => t.bet_type === 'exacta_box');
  // D91: the shared estimator has branches (place, straight exacta,
  // trifecta box) this path can never reach. Assert that rather than argue it -
  // if buildRaceTickets ever emits a new type, this fails and the estimate
  // assertions below stop being a complete account of the card.
  check('every OTR ticket is show / win / exacta_box - the estimator branches this path reaches',
    bothCard.tickets.every((t) => ['show', 'win', 'exacta_box'].includes(t.bet_type)),
    JSON.stringify([...new Set(bothCard.tickets.map((t) => t.bet_type))]));
  check('win tickets: "If it hits" estimate populated (exact, at the morning line)',
    winTickets.length === 8 && winTickets.every((t) => t.est_payout_min_cents != null && t.est_payout_max_cents === t.est_payout_min_cents && t.est_is_range === 0),
    JSON.stringify(winTickets.map((t) => ({ selections: t.selections, min: t.est_payout_min_cents, max: t.est_payout_max_cents, range: t.est_is_range }))));
  check('exacta box tickets: "If it hits" estimate populated (a range)',
    boxTickets.length === 16 && boxTickets.every((t) => t.est_payout_min_cents != null && t.est_payout_max_cents > t.est_payout_min_cents && t.est_is_range === 1),
    JSON.stringify(boxTickets.slice(0, 2).map((t) => ({ selections: t.selections, min: t.est_payout_min_cents, max: t.est_payout_max_cents }))));
  check('show tickets: no estimate (no validated formula anywhere in this codebase, same D67 reasoning)',
    showTickets.length === 8 && showTickets.every((t) => t.est_payout_min_cents == null),
    JSON.stringify(showTickets.map((t) => t.est_payout_min_cents)));
  // Hand-check race 1: win #5 at ML 3.0 -> winPayout($200, 3.0) = $800 exact.
  const r1Win = winTickets.find((t) => t.selections.legs[0][0] === '5' && t.race_id === bothCard.races.find((r) => r.number === 1)?.id);
  check('hand-checked: race 1 win #5 (ML 3/1) -> exact $8.00', r1Win?.est_payout_min_cents === 800, JSON.stringify(r1Win));

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
  // (This fixture day carries entries only, no program PDF, so the
  // live-generated lean card lands in ODDS_ONLY per D40 - not
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
  await jpost(`/api/race-days/${day.id}/human-cards`, { race: 1, text: 'Win | #2 | $20 | test pick' }); // HUMAN card
  const llmResponse = 'Reasoning: consensus favorite.\n\n<<<TICKETS>>>\nWin | #2 | $20 | Test.\n<<<END TICKETS>>>\n';
  const llmPreview = await (await jpost(`/api/race-days/${day.id}/llm-cards/preview`, { race: 1, __stubResponse: llmResponse })).json();
  const llmSave = await (await jpost(`/api/race-days/${day.id}/llm-cards`, { race: 1, requestId: llmPreview.requestId, bankrollCents: 2000 })).json(); // LLM_GENERATED card

  // D74 gave the sheet its own sentence in the LLM prompt, in its own
  // show-pick/win-pick/box vocabulary. The prompt's whole CONSENSUS section
  // went with D112, so there is nothing to name there any more - the inverse
  // is asserted instead, that no prompt still carries the block.
  {
    const stub = 'Reasoning: stub.\n\n<<<TICKETS>>>\nWin | #2 | $20 | Test.\n<<<END TICKETS>>>\n';
    await jpost(`/api/race-days/${day.id}/llm-cards/preview`, { race: 1, __stubResponse: stub });
    const { openDb } = await import('../server/db.js');
    const vdb = openDb(path.join(tmp, 'check.sqlite'));
    const row = vdb.prepare(
      'SELECT prompt_text FROM llm_card_requests WHERE race_day_id = ? ORDER BY id DESC',
    ).get(day.id);
    vdb.close();
    // D112 removed the CONSENSUS section, and that stays removed - the word,
    // the classification and the "no external consensus on file" fallback are
    // all gone for good. D179 then put the SHEET back, under a different
    // heading and for a different reason: not as consensus to be classified,
    // but as one labelled baseline opinion among several. Both halves are
    // asserted together so neither can drift back into the other.
    check('D112: the CONSENSUS section is still gone from the prompt',
      Boolean(row) && !row.prompt_text.includes('CONSENSUS')
        && !row.prompt_text.includes('No external consensus on file'),
      row?.prompt_text?.slice(0, 400));
    check('D179: but the sheet IS named, under BASELINE PICKS, as printed tickets',
      Boolean(row) && row.prompt_text.includes('BASELINE PICKS')
        && row.prompt_text.includes('Equibase Off to the Races (the free at-track sheet'),
      row?.prompt_text?.slice(row?.prompt_text?.indexOf('BASELINE PICKS'), 400));
  }

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

  // -------- 11. batch CLI (D71 follow-up): ingest all 16 real files at once --------
  // Runs the ACTUAL CLI (scripts/ingest-otr.js) as a subprocess, never the
  // in-process function directly - server/equibase-otr.js reads
  // BETSHEET_OTR_ARCHIVE_DIR once at module load, and this check script's
  // own process already imported that module (for runPdftotextTsv above)
  // before any archive-dir override could apply; a real subprocess with
  // its own environment is the only way to keep this run off the
  // committed archive, exactly the isolation server/dmtc-crawler.js's
  // rawDir parameter and this same file's earlier check already rely on.
  {
    const { openDb } = await import('../server/db.js');
    const { insertRaceDay } = await import('../server/ingest.js');
    const { seedTemplates } = await import('../server/templates.js');

    const batchDbPath = path.join(tmp, 'batch.sqlite');
    const batchSourceDir = path.join(tmp, 'batch-source');
    const batchArchiveDir = path.join(tmp, 'archive-equibase-otr-batch');
    const batchLogDir = path.join(tmp, 'batch-logs');
    fs.mkdirSync(batchSourceDir, { recursive: true });

    const seedDb = openDb(batchDbPath);
    seedTemplates(seedDb); // scripts/ingest-otr.js calls getDb() directly, not server/index.js's boot - seed here so 'equibase-otr' exists as a real strategy_templates row
    for (const date of ALL_FIXTURE_DATES) {
      fs.copyFileSync(path.join(FIXTURE_DIR, `DMR-${date}.pdf`), path.join(batchSourceDir, `${date}.pdf`));
      const dayParsed = allParsed[date];
      const races = dayParsed.races.map((r) => {
        const referenced = [r.showPick, r.winPick, ...r.box4, ...r.box3].map(Number);
        const max = Math.max(...referenced, 1);
        return {
          number: r.race, raceType: 'CLAIMING', conditions: 'synthetic (batch CLI check)',
          entries: Array.from({ length: max }, (_, i) => ({
            programNumber: String(i + 1), horseName: `Horse ${i + 1}`, morningLine: '5/1', morningLineDecimal: 5,
          })),
        };
      });
      insertRaceDay(seedDb, { track: 'Del Mar', date, bankrollCents: 20000, perRaceMinCents: 500, races }, `batch-seed-${date}`);
    }
    seedDb.close();

    const runCli = (extraArgs = []) => new Promise((resolve) => {
      let out = '';
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ingest-otr.js'), ...extraArgs, batchSourceDir], {
        env: {
          ...process.env, BETSHEET_DB: batchDbPath, BETSHEET_LOG_DIR: batchLogDir,
          BETSHEET_OTR_ARCHIVE_DIR: batchArchiveDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });

    const run1 = await runCli();
    check('batch CLI: 16 file(s) seen, 16 ingested, 0 queued', /16 file\(s\) seen: 16 ingested, 0 queued/.test(run1), run1);
    check('batch CLI: 48 cards written (16 days x 3 variants)', /48 card\(s\) written/.test(run1), run1);

    const verifyDb = openDb(batchDbPath);
    const cardCount = verifyDb.prepare("SELECT COUNT(*) AS n FROM cards WHERE engine_version = 'equibase-otr'").get().n;
    check('batch CLI: exactly 48 equibase-otr cards actually persisted', cardCount === 48, `got ${cardCount}`);
    verifyDb.close();

    const run2 = await runCli();
    check('batch CLI re-run: idempotent - 0 ingested, 16 skipped, 0 new cards', /16 file\(s\) seen: 0 ingested, 0 queued, 16 skipped/.test(run2), run2);

    const verifyDb2 = openDb(batchDbPath);
    const cardCount2 = verifyDb2.prepare("SELECT COUNT(*) AS n FROM cards WHERE engine_version = 'equibase-otr'").get().n;
    check('batch CLI re-run: still exactly 48 cards - a re-run never appends duplicates', cardCount2 === 48, `got ${cardCount2}`);
    verifyDb2.close();

    // D74's `--consensus-only` batch mode and its four assertions went with
    // consensus itself (D112). What replaces them is the guarantee that the
    // ordinary batch never writes a consensus row either.
    {
      const verifyDb4 = openDb(batchDbPath);
      const n = verifyDb4.prepare('SELECT COUNT(*) AS n FROM consensus_picks').get().n;
      check('D112: a full 16-file batch writes zero consensus rows', n === 0, `got ${n}`);
      verifyDb4.close();
    }
  }

  // -------- 10. no engine-version bump --------
  // ENGINE_VERSION is a legacy label post-pivot (D109): nothing mints a new
  // lean-* card any more, and the value survives only so the stored corpus
  // stays readable. Asserting it is unchanged is still the guard against an
  // accidental bump silently re-bucketing every historical card.
  const { ENGINE_VERSION } = await import('../shared/version.js');
  check('shared/version.js ENGINE_VERSION unchanged at lean-1.1', ENGINE_VERSION === 'lean-1.1');
  const dayCards = await jget(`/api/race-days/${day.id}/cards`);
  check('every card on this day comes from a surviving producer, none from the engine',
    dayCards.every((c) => ['equibase-otr', 'human', 'llm'].includes(c.engine_version)),
    JSON.stringify(dayCards.map((c) => c.engine_version)));

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
