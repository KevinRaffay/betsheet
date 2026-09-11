// Verification for the live odds capture (D228): shared/live-odds.js and
// server/live-odds.js. Run: npm run check-live-odds
//
// Two halves. The PURE half asserts every refusal the reconciler makes, by
// hand-built captures - because the refusals ARE the deliverable: this path's
// whole job is to add prices and change nothing else, and each assertion below
// pins one thing it must decline to touch.
//
// THE FIXTURE SITUATION, STATED PLAINLY. No real near-post Equibase capture
// exists anywhere in this project. The only real entries pages on file were
// saved BEFORE wagering opened - `docs/requirements/equibase-entries-ingest.md`
// open question 2 records that live odds were empty in all 113 entries of the
// reference capture, and `check-equibase-entries.js:123` asserts exactly that.
// So the priced captures here are SYNTHETIC, built by `page()` below in the
// real page's own table grammar, and they are labelled as such. What is NOT
// synthetic is the most important assertion in the file: the real 4.2MB Del Mar
// page is run through the whole path and must be REFUSED with `no_prices`,
// which is the exact failure mode a person will hit the first time they upload
// a page too early.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { readOdds, reconcileOddsCapture } from '../shared/live-odds.js';
import { parseEquibaseEntriesHtml } from '../shared/parsers/equibase-entries.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-liveodds-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

/**
 * D207's rule, asserted rather than assumed: `ParsePreview.jsx` renders
 * `w.message` and has nothing to fall back on, so a warning without one is a
 * blank bullet on screen. Both Apify parsers shipped that defect and no check
 * caught it, because checks assert on `type` and structured fields.
 */
const checkMessages = (label, warnings) => check(
  `${label}: every warning carries a non-empty message`,
  warnings.length > 0 && warnings.every((w) => typeof w.message === 'string' && w.message.trim().length > 0),
  JSON.stringify(warnings.filter((w) => !w.message?.trim())),
);

const storedDay = (races) => ({ track: 'Del Mar', date: '2026-09-07', races });
const se = (pgm, ml, live = null, scratched = 0) =>
  ({ programNumber: pgm, horseName: `Horse ${pgm}`, morningLine: ml, liveOdds: live, scratched });
const ce = (pgm, live, scratched = false) =>
  ({ programNumber: pgm, horseName: `Horse ${pgm}`, liveOdds: live, scratched });
const cap = (races, track = 'Del Mar', date = '2026-09-07') => ({ track, date, races, warnings: [] });

console.log('\nlive odds - pure reconciler');

// --- readOdds -------------------------------------------------------------
check('readOdds: blank forms are all null',
  ['', '-', '--', null, undefined].every((v) => readOdds(v) === null));
check('readOdds: 9/5 -> 1.8', readOdds('9/5').decimal === 1.8 && readOdds('9/5').text === '9/5');
check('readOdds: 6/1 -> 6', readOdds('6/1').decimal === 6);
check('readOdds: 4.5 -> 4.5', readOdds('4.5').decimal === 4.5);
check('readOdds: an unreadable form KEEPS its text and nulls the decimal',
  readOdds('7-2').text === '7-2' && readOdds('7-2').decimal === null);

// --- the happy path -------------------------------------------------------
{
  const stored = storedDay([{ number: 1, entries: [se('1', '5/2'), se('2', '8/1', '10/1'), se('3', '3/1', '3/1')] }]);
  const r = reconcileOddsCapture({ stored, parsed: cap([{ number: 1, entries: [ce('1', '9/5'), ce('2', '12/1'), ce('3', '3/1')] }]) });
  check('happy: ok', r.ok);
  check('happy: three prices, one first / one changed / one unchanged',
    r.counts.priced === 3 && r.counts.firstPrice === 1 && r.counts.changed === 1 && r.counts.unchanged === 1,
    JSON.stringify(r.counts));
  check('happy: updates carry ONLY raceNumber/programNumber/liveOdds/liveOddsDecimal',
    r.updates.every((u) => Object.keys(u).sort().join(',') === 'liveOdds,liveOddsDecimal,programNumber,raceNumber'),
    JSON.stringify(r.updates[0]));
  check('happy: no update mentions a morning line or a scratch',
    !JSON.stringify(r.updates).includes('morning') && !JSON.stringify(r.updates).includes('scratch'));
  check('happy: the diff row keeps the stored morning line for display',
    r.races[0].entries[0].morningLine === '5/2' && r.races[0].entries[0].newOdds === '9/5');
  check('happy: the previous price is shown beside the new one',
    r.races[0].entries[1].previousOdds === '10/1' && r.races[0].entries[1].newOdds === '12/1'
    && r.races[0].entries[1].state === 'changed');
}

// --- track / date must name THIS day --------------------------------------
for (const [label, t, d] of [['track', 'Saratoga', '2026-09-07'], ['date', 'Del Mar', '2026-09-08']]) {
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2')] }]),
    parsed: cap([{ number: 1, entries: [ce('1', '9/5')] }], t, d),
  });
  check(`${label} mismatch: refused, zero updates`,
    !r.ok && r.updates.length === 0 && r.warnings.some((w) => w.type === 'track_date_mismatch' && w.blocking));
  checkMessages(`${label} mismatch`, r.warnings);
}

// --- a board that never came up -------------------------------------------
{
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2'), se('2', '8/1')] }]),
    parsed: cap([{ number: 1, entries: [ce('1', null), ce('2', '-')] }]),
  });
  check('no prices: refused with no_prices, nothing to write',
    !r.ok && r.updates.length === 0 && r.warnings.some((w) => w.type === 'no_prices' && w.blocking));
  check('no prices: the message names the likely cause (saved too early)',
    r.warnings.find((w) => w.type === 'no_prices').message.includes('before wagering opened'));
}
{
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2')] }]),
    parsed: cap([{ number: 9, entries: [ce('9', '2/1')] }]),
  });
  check('no race matched: refused, and says so distinctly',
    !r.ok && r.warnings.find((w) => w.type === 'no_prices').message.includes('No race in this capture matched'));
}

// --- partial matches are reported, never guessed --------------------------
{
  const stored = storedDay([
    { number: 1, entries: [se('1', '5/2'), se('2', '8/1')] },
    { number: 2, entries: [se('1', '2/1')] },
  ]);
  const r = reconcileOddsCapture({
    stored,
    parsed: cap([
      { number: 1, entries: [ce('1', '9/5'), ce('7', '30/1')] },
      { number: 5, entries: [ce('1', '4/1')] },
    ]),
  });
  check('partial: ok - the matched race still saves', r.ok && r.counts.priced === 1);
  check('partial: a race in the capture but not on the day is skipped, not created',
    r.counts.racesOnlyInCapture === 1 && r.warnings.some((w) => w.type === 'race_not_on_day' && !w.blocking)
    && !r.updates.some((u) => u.raceNumber === 5));
  check('partial: a race on the day but not in the capture is left alone',
    r.counts.racesOnlyOnDay === 1 && r.warnings.some((w) => w.type === 'race_not_in_capture' && !w.blocking));
  check('partial: a horse not in the stored race is reported, never inserted',
    r.counts.unknownEntries === 1 && r.warnings.some((w) => w.type === 'entry_not_on_race' && !w.blocking)
    && !r.updates.some((u) => u.programNumber === '7'));
  check('partial: a stored horse absent from the capture keeps its price',
    r.warnings.some((w) => w.type === 'entry_not_in_capture' && w.programNumber === '2'));
  checkMessages('partial', r.warnings);
}

// --- scratches are REPORTED and never applied -----------------------------
{
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2', null, 0), se('2', '8/1', null, 1)] }]),
    parsed: cap([{ number: 1, entries: [ce('1', '9/5', true), ce('2', '12/1', false)] }]),
  });
  check('scratch drift: both directions warned', r.counts.scratchDrift === 2);
  check('scratch drift: the warning says this refresh never changes a scratch',
    r.warnings.filter((w) => w.type === 'scratch_drift').every((w) => w.message.includes('never changes a scratch')));
  check('scratch drift: prices still recorded for both', r.counts.priced === 2);
  checkMessages('scratch drift', r.warnings);
}

// --- an unreadable price is kept as text, loudly --------------------------
{
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2'), se('2', '8/1')] }]),
    parsed: cap([{ number: 1, entries: [ce('1', '7-2'), ce('2', '6/1')] }]),
  });
  check('unreadable: text stored, decimal null, warned - never dropped',
    r.ok && r.counts.unreadable === 1
    && r.updates.find((u) => u.programNumber === '1').liveOdds === '7-2'
    && r.updates.find((u) => u.programNumber === '1').liveOddsDecimal === null
    && r.warnings.some((w) => w.type === 'odds_unreadable'));
  checkMessages('unreadable', r.warnings);
}

// --- a scratched row with no program number is not an error ---------------
{
  const r = reconcileOddsCapture({
    stored: storedDay([{ number: 1, entries: [se('1', '5/2')] }]),
    parsed: cap([{ number: 1, entries: [ce('1', '9/5'), { programNumber: null, horseName: 'Gone', liveOdds: null, scratched: true }] }]),
  });
  check('D180 scratch row (no program number): ignored silently, no warning about it',
    r.ok && r.counts.unknownEntries === 0 && !r.warnings.some((w) => w.type === 'entry_not_on_race'));
}

// --- degenerate inputs never throw ---------------------------------------
for (const [label, arg] of [['undefined', undefined], ['empty object', {}],
  ['no races', { stored: storedDay([]), parsed: cap([]) }]]) {
  let threw = false; let out = null;
  try { out = reconcileOddsCapture(arg); } catch { threw = true; }
  check(`${label}: returns a refusal rather than throwing`, !threw && out && out.ok === false);
}

// --- the REAL page: saved before wagering, so it must be refused ----------
console.log('\nlive odds - the real Del Mar page (a pre-wagering capture)');
{
  const html = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'equibase-entries', 'DMR090726USA-EQB.view-source.html'), 'utf8');
  const parsed = parseEquibaseEntriesHtml(html);
  check('real page parses to races', parsed.races.length > 0, String(parsed.races.length));
  check('real page: live odds genuinely empty on every entry (the D116 finding, still true)',
    parsed.races.every((r) => r.entries.every((e) => e.liveOdds === null)));
  const stored = storedDay(parsed.races.map((r) => ({
    number: r.number,
    entries: r.entries.filter((e) => e.programNumber).map((e) => se(e.programNumber, e.morningLine)),
  })));
  const r = reconcileOddsCapture({ stored: { ...stored, track: parsed.track, date: parsed.date }, parsed });
  check('real page: REFUSED with no_prices - the first-upload mistake is caught',
    !r.ok && r.updates.length === 0 && r.warnings.some((w) => w.type === 'no_prices'));
  check('real page: races DID match, so the refusal is about the board not the page',
    r.counts.racesMatched === parsed.races.length && r.counts.entriesMatched > 100,
    JSON.stringify({ matched: r.counts.racesMatched, entries: r.counts.entriesMatched }));
}

// ---------------------------------------------------------------------------
// The server half.
// ---------------------------------------------------------------------------

/**
 * A minimal Equibase entries page in the real page's own grammar: the
 * `Track / Month D, YYYY / All Races` header the parser reads, then one
 * `<table class="fullwidth">` per race whose FIRST row is the header (the
 * parser keys columns by header label, never by index - D116's own trap).
 * SYNTHETIC, for the reason given at the top of this file.
 */
function page({ track, date, races }) {
  const head = `<div>Home / Entries / ${track} / ${date} / All Races</div>`;
  const tables = races.map((r) => {
    const cols = ['P#', 'PP', 'Horse', 'A/S', 'Med', 'Jockey', 'Wgt', 'Trainer', 'M/L', 'LiveOdds'];
    const header = `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
    const rows = r.entries.map((e, i) => `<tr>${[
      e.pgm, String(i + 1), e.name, '3 C', 'L', 'A Jockey', '122', 'A Trainer', e.ml ?? '', e.live ?? '',
    ].map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table class="fullwidth">${header}${rows}</table>`;
  }).join('');
  return `<html><body>${head}${tables}</body></html>`;
}

console.log('\nlive odds - the real server');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8903;
  const BASE = `http://127.0.0.1:${PORT}`;
  const srvDb = path.join(tmp, 'srv.sqlite');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: srvDb,
      BETSHEET_LOG_DIR: path.join(tmp, 'srv-logs'), ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const jpost = (u, b = {}) => fetch(BASE + u, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots with the live-odds router mounted', up, out.slice(-400));

    const Database = (await import('better-sqlite3')).default;
    const TRACK = 'Del Mar';
    const ISO = '2026-09-07';
    const PRINTED = 'September 7, 2026';

    const dayId = (await (await jpost('/api/race-days', {
      track: TRACK, date: ISO, bankrollCents: 20000, perRaceMinCents: 500,
      races: [
        { number: 1, postTime: '2:00PM', entries: [
          { programNumber: '1', horseName: 'Alpha', morningLine: '5/2' },
          { programNumber: '2', horseName: 'Bravo', morningLine: '8/1' }] },
        { number: 2, postTime: '2:30PM', entries: [
          { programNumber: '1', horseName: 'Charlie', morningLine: '3/1' }] },
      ],
    })).json()).id;
    check('seed day created', Number.isInteger(dayId), String(dayId));

    const db = new Database(srvDb);
    const oddsOf = () => db.prepare(`SELECT e.program_number p, r.number n, e.live_odds o, e.live_odds_decimal d
      FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ? ORDER BY r.number, e.program_number`).all(dayId);
    const count = (t, where = '') => db.prepare(`SELECT COUNT(*) c FROM ${t} ${where}`).get().c;

    const board1 = page({ track: TRACK, date: PRINTED, races: [
      { entries: [{ pgm: '1', name: 'Alpha', ml: '5/2', live: '9/5' }, { pgm: '2', name: 'Bravo', ml: '8/1', live: '12/1' }] },
      { entries: [{ pgm: '1', name: 'Charlie', ml: '3/1', live: '5/2' }] },
    ] });

    // --- preview writes nothing --------------------------------------------
    const prev = await (await jpost(`/api/race-days/${dayId}/live-odds/preview`, { html: board1 })).json();
    check('preview: ok with 3 prices', prev.ok === true && prev.counts.priced === 3, JSON.stringify(prev.counts ?? prev));
    check('preview: shows the stored morning line beside the new price',
      prev.races[0].entries[0].morningLine === '5/2' && prev.races[0].entries[0].newOdds === '9/5');
    check('preview: WROTE NOTHING - no capture rows, no entry prices',
      count('odds_captures') === 0 && oddsOf().every((e) => e.o === null));
    check('preview: the attempt is still audited (invariant 11)', count('fetch_attempts') === 1);

    // --- confirm writes ------------------------------------------------------
    const CAP1 = '2026-09-07T19:30:00Z';
    const save1 = await (await jpost(`/api/race-days/${dayId}/live-odds`, { html: board1, oddsCapturedAt: CAP1 })).json();
    check('confirm: one capture, three price rows',
      count('odds_captures') === 1 && count('odds_capture_entries') === 3 && save1.capturesOnDay === 1);
    check('confirm: entries.live_odds and its decimal are both populated',
      oddsOf().every((e) => e.o !== null) &&
      oddsOf().find((e) => e.n === 1 && e.p === '1').d === 1.8);
    check('confirm: race_days.odds_captured_at is set to the capture time',
      db.prepare('SELECT odds_captured_at o FROM race_days WHERE id = ?').get(dayId).o === CAP1);
    check('confirm: the morning line was not touched',
      db.prepare("SELECT COUNT(*) c FROM entries e JOIN races r ON r.id=e.race_id WHERE r.race_day_id=? AND e.morning_line IS NULL").get(dayId).c === 0);

    // --- a second capture APPENDS, it never overwrites history --------------
    const CAP2 = '2026-09-07T20:55:00Z';
    const board2 = page({ track: TRACK, date: PRINTED, races: [
      { entries: [{ pgm: '1', name: 'Alpha', ml: '5/2', live: '6/5' }, { pgm: '2', name: 'Bravo', ml: '8/1', live: '20/1' }] },
      { entries: [{ pgm: '1', name: 'Charlie', ml: '3/1', live: '5/2' }] },
    ] });
    await jpost(`/api/race-days/${dayId}/live-odds`, { html: board2, oddsCapturedAt: CAP2 });
    check('second capture: history kept - two captures, six price rows',
      count('odds_captures') === 2 && count('odds_capture_entries') === 6);
    check('second capture: the FIRST board is still readable at its own prices',
      db.prepare(`SELECT live_odds o FROM odds_capture_entries WHERE capture_id =
        (SELECT MIN(id) FROM odds_captures WHERE race_day_id=?) AND race_number=1 AND program_number='1'`).get(dayId).o === '9/5');
    check('second capture: entries.live_odds is the LATEST board',
      oddsOf().find((e) => e.n === 1 && e.p === '1').o === '6/5');
    check('second capture: odds_captured_at moved forward',
      db.prepare('SELECT odds_captured_at o FROM race_days WHERE id = ?').get(dayId).o === CAP2);

    // --- an older page must not make the day read fresher ------------------
    await jpost(`/api/race-days/${dayId}/live-odds`, { html: board1, oddsCapturedAt: CAP1 });
    check('an older capture is stored but does NOT rewind odds_captured_at',
      count('odds_captures') === 3
      && db.prepare('SELECT odds_captured_at o FROM race_days WHERE id = ?').get(dayId).o === CAP2);

    // --- refusals write nothing --------------------------------------------
    const before = count('odds_captures');
    const wrongDay = page({ track: 'Saratoga', date: PRINTED, races: [{ entries: [{ pgm: '1', name: 'Alpha', ml: '5/2', live: '9/5' }] }] });
    const bad = await jpost(`/api/race-days/${dayId}/live-odds`, { html: wrongDay, oddsCapturedAt: CAP2 });
    const badBody = await bad.json();
    check('wrong track: 422 and nothing written',
      bad.status === 422 && count('odds_captures') === before
      && badBody.warnings.some((w) => w.type === 'track_date_mismatch'));
    check('wrong track: the refusal is audited as a parse_error',
      count('fetch_attempts', "WHERE outcome = 'parse_error'") >= 1);

    const early = page({ track: TRACK, date: PRINTED, races: [{ entries: [{ pgm: '1', name: 'Alpha', ml: '5/2', live: '' }] }] });
    const earlyRes = await jpost(`/api/race-days/${dayId}/live-odds`, { html: early, oddsCapturedAt: CAP2 });
    check('a page saved before wagering: 422 and nothing written',
      earlyRes.status === 422 && count('odds_captures') === before);

    check('empty body: 400', (await jpost(`/api/race-days/${dayId}/live-odds`, {})).status === 400);
    check('unknown day: 404', (await jpost('/api/race-days/999999/live-odds', { html: board1 })).status === 404);

    // --- the read-only history endpoint ------------------------------------
    const hist = await (await fetch(`${BASE}/api/race-days/${dayId}/live-odds`)).json();
    check('GET: three captures, newest first',
      hist.captures.length === 3 && hist.captures[0].captured_at === CAP2
      && hist.captures[0].prices === 3);

    // --- a soft-deleted day is invisible here too (invariant 12) -----------
    await fetch(`${BASE}/api/race-days/${dayId}`, { method: 'DELETE' });
    check('soft-deleted day: preview 404s',
      (await jpost(`/api/race-days/${dayId}/live-odds/preview`, { html: board1 })).status === 404);

    db.close();
  } finally {
    server.kill();
  }
}

console.log(failures === 0 ? '\nAll live-odds checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
