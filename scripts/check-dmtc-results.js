// Verification for the dmtc results parser (D42) - exits non-zero on any
// failure. Run: npm run check-dmtc-results
//
// The real test is cross-source: for 2026-08-28/29/30 the same tickets
// graded from the dmtc results page and from the Equibase chart must
// return IDENTICAL cents per ticket. A ticket that grades differently is a
// parser bug, not variance. Layers: (1) page goldens + hand checks, (2)
// the pure cross-source grade on a broad synthetic ticket set per day and
// the real 08-30 card, (3) the server: parse endpoint, from-archive with
// the calendar race-count hard error, save as dmtc_html replaces the chart
// and regrades to the same cents.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { livePgms, makeHumanCard, winAndBoxText } from './lib/test-cards.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-dmtcres-'));
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
const { parseDmtcResults, parseHeader, parsePayoffs, distanceWords, dmtcNameKey } = await import('../shared/dmtc-results-parser.js');
const { buildDayResults, gradeCard } = await import('../shared/grading.js');

const DAYS = ['2026-08-28', '2026-08-29', '2026-08-30'];
const load = (d) => ({
  html: fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc', `results-${d}.html`), 'utf8'),
  golden: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc', `results-${d}.expected.json`), 'utf8')),
  chart: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts', `dmr-${d}.expected.json`), 'utf8')),
});

console.log('-- page goldens + hand checks --');
const pages = {};
for (const d of DAYS) {
  const { html, golden, chart } = load(d);
  const out = parseDmtcResults(html);
  pages[d] = { out, chart };
  const diff = firstDiff(out, golden);
  check(`golden: results-${d}`, !diff, diff ?? '');
  check(`${d}: track/date from the Equibase link text, race count matches the chart`, out.track === 'Del Mar' && out.date === d && out.races.length === chart.races.length, `${out.track} ${out.date} ${out.races.length}`);
}
const d30 = pages['2026-08-30'].out;
check('08-30 R1: header, top three with prices, also-rans as 4th-6th, no scratches', (() => {
  const r = d30.races[0];
  return r.surface === 'DIRT' && r.distance === 'Seven Furlongs' && r.raceType === 'STARTER OPTIONAL CLAIMING' && r.purseCents === 41000_00 && r.postTime === '2:00PM' &&
    r.results.slice(0, 3).map((x) => `${x.programNumber}:${x.winCents ?? '-'}/${x.placeCents ?? '-'}/${x.showCents ?? '-'}`).join(' ') === '1:280/220/210 6:-/620/340 5:-/-/280' &&
    r.results.slice(3).map((x) => `${x.finishPosition}:${x.horseName}`).join(',') === '4:Letmein,5:Kid Charlemagne,6:Cruisin for Cali' &&
    r.scratches.length === 0 && r.finalTime === '1:22.69' && r.trackCondition === 'Fast';
})(), JSON.stringify(d30.races[0]).slice(0, 300));
check('08-30 R2: four scratches by name, daily double from the payoff line', d30.races[1].scratches.map((s) => s.horseName).join('|') === "Angels Revenge|Tapit's Ghost|City of Forza|Vern Gosdin" &&
  d30.races[1].exotics.some((e) => e.betType === 'daily_double' && e.baseCents === 200 && e.combination === '1-1' && e.payoutCents === 2500));
check('08-30 R7: stakes header names the race', d30.races[6].raceType === 'STAKES - Torrey Pines Stakes (G3)' && d30.races[6].distance === 'One Mile');
const r10 = d30.races[9];
check('08-30 R10: every exotic incl. multi-winner legs, Place Pick All, Turf Pick 3, Super High Five, 3X3, carryovers', (() => {
  const by = (t) => r10.exotics.find((e) => e.betType === t);
  return by('pick5')?.combination === '11-3-1/4-4-2' && by('place_pick_all')?.combination === '8 OF 10' && by('turfpick3')?.combination === '11-4-2' &&
    by('super_high_five')?.baseCents === 100 && by('super_high_five')?.payoutCents === 0 && by('3x3')?.combination === '3/4 OF 9' &&
    r10.carryovers.map((c) => c.pool + '=' + c.amountCents).join(',') === 'Super High-5=3132123,3X3=186999';
})(), JSON.stringify(r10.exotics.map((e) => [e.betType, e.combination])));
check('08-28 R8: pick 6 consolation carries correct/of, pick 4 with a two-winner leg', (() => {
  const r8 = pages['2026-08-28'].out.races[7];
  const p6 = r8.exotics.find((e) => e.betType === 'pick6');
  return p6 && p6.correct === 5 && p6.of === 6 && p6.combination === '3/4-1/4-3-1/8-4-3' && r8.exotics.find((e) => e.betType === 'pick4')?.combination === '3-1/8-4-3';
})());
check('08-29 R10: 1 3/8 miles turf stakes header', pages['2026-08-29'].out.races[9].distance === 'One Mile And Three Eighths' && pages['2026-08-29'].out.races[9].surface === 'TURF');
check('ALSO RAN is finish order: every race, names 4th onward equal the Equibase chart order (08-29 R1 chart lacks the 4th)', DAYS.every((d) => pages[d].out.races.every((r) => {
  const chartRace = pages[d].chart.races.find((c) => c.number === r.number);
  const chartRest = chartRace.results.filter((x) => x.finishPosition >= 4).sort((a, b) => a.finishPosition - b.finishPosition).map((x) => dmtcNameKey(x.horseName));
  const mine = r.results.filter((x) => x.finishPosition >= 4).map((x) => dmtcNameKey(x.horseName));
  return chartRest.length === 0 || JSON.stringify(mine) === JSON.stringify(chartRest);
})));
check('helpers: distance words, header without a post time, unknown wager warned not dropped', distanceWords('6 1/2 FURLONGS') === 'Six And One Half Furlongs' &&
  parseHeader('TURF, 1 MILE / CLAIMING / PURSE: $31,000').raceType === 'CLAIMING' && (() => { const w = []; const p = parsePayoffs('$1 Mystery Bet paid $9.00 (1-2)', w, 3); return p.exotics[0].betType === 'mystery_bet' && w[0].type === 'unrecognized_mutuel'; })());
check('a page with no race blocks warns, never throws', parseDmtcResults('<html></html>').warnings.some((w) => w.type === 'no_races'));

console.log('-- cross-source: the same tickets graded from both sources --');
// Grading views. Scratches carry names on both sources in the pure layer;
// the server layer below resolves them through the day's entries.
const view = (doc) => buildDayResults(doc.races.map((r) => ({ number: r.number, results: r.results.filter((x) => x.programNumber), exotics: r.exotics, scratchedPgms: [] })));
// A broad synthetic ticket set built off the CHART: every WPS on the top
// three, every exotic combination the chart paid (multi-winner legs
// included), plus losing / boxed / partial tickets.
function syntheticTickets(chart) {
  const tickets = [];
  let seq = 0;
  const add = (t) => tickets.push({ id: ++seq, ...t });
  for (const r of chart.races) {
    const top = r.results.filter((x) => x.finishPosition <= 3).sort((a, b) => a.finishPosition - b.finishPosition).map((x) => x.programNumber);
    for (const bt of ['win', 'place', 'show']) for (const p of top) add({ betType: bt, races: [r.number], legs: [[p]], stakeCents: 200, costCents: 200 });
    add({ betType: 'win', races: [r.number], legs: [['99']], stakeCents: 200, costCents: 200 });
    for (const x of r.exotics) {
      if (!['exacta', 'quinella', 'trifecta', 'superfecta', 'daily_double', 'pick3', 'pick4', 'pick5'].includes(x.betType)) continue;
      const legs = x.combination.split('-').map((part) => part.split('/'));
      const multi = x.betType === 'daily_double' || /^pick\d$/.test(x.betType);
      const races = multi ? Array.from({ length: legs.length }, (_, i) => r.number - legs.length + 1 + i) : [r.number];
      if (multi && races[0] < 1) continue;
      add({ betType: x.betType, races, legs, stakeCents: x.baseCents, costCents: x.baseCents * legs.reduce((a, l) => a * l.length, 1) });
    }
    if (top.length === 3) {
      add({ betType: 'exacta_box', races: [r.number], legs: [[top[0], top[1], '99']], stakeCents: 100, costCents: 600 });
      add({ betType: 'trifecta_box', races: [r.number], legs: [[top[0], top[1], top[2], '99']], stakeCents: 50, costCents: 1200 });
      add({ betType: 'exacta', races: [r.number], legs: [[top[1]], [top[0]]], stakeCents: 100, costCents: 100 });
    }
  }
  return tickets;
}
for (const d of DAYS) {
  const { out, chart } = pages[d];
  const tickets = syntheticTickets(chart);
  const a = gradeCard(tickets, view(chart)).grades; const b = gradeCard(tickets, view(out)).grades;
  const diffs = a.map((g, i) => [g, b[i]]).filter(([x, y]) => x.returnedCents !== y.returnedCents || x.outcome !== y.outcome)
    .map(([x, y]) => `${x.ticket.betType} R${x.ticket.races.join('-')} ${JSON.stringify(x.ticket.legs)}: chart ${x.returnedCents}/${x.outcome} vs dmtc ${y.returnedCents}/${y.outcome}`);
  const winners = a.filter((g) => g.returnedCents > 0).length;
  check(`${d}: ${tickets.length} synthetic tickets grade to identical cents from both sources (${winners} cash)`, diffs.length === 0 && winners > 20, diffs.slice(0, 4).join(' | '));
}
// The real 08-30 card: program golden + SFTB + a second source -> card -> both views.
const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/days/delmar-2026-08-30.entries.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const toDb = (e) => ({ program_number: e.programNumber, horse_name: e.horseName, morning_line: e.morningLine, morning_line_decimal: e.morningLineDecimal, program_rank: e.programRank, best_bet: e.bestBet ? 1 : 0, scratched: e.scratched ? 1 : 0 });
const entriesByRace = Object.fromEntries(prog.races.map((r) => [r.number, r.entries.map(toDb)]));
const picks = {};
for (const r of sftb.races) { picks[r.race] = r.picks.map((p) => ({ source_name: 'SFTB', source_kind: 'algorithmic', pick_type: p.pickType, program_number: p.programNumber, horse_name: p.horseName, note: p.note })); picks[r.race].push({ source_name: 'Digest', source_kind: 'manual', pick_type: 'top', program_number: r.picks[0].programNumber, horse_name: r.picks[0].horseName, note: null }); }
// The D09 classification built here fed the engine; D111 froze the card it
// produced and D112 removed classification. The pick set above is left in
// place because the golden's entries are what the chart's scratches resolve
// against.
// Frozen engine output since D111 deleted shared/card-engine.js - the same
// 30-ticket lean-1.1 card this used to generate inline. The cross-source
// proof is unchanged: identical tickets, graded from both sources.
const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/engine-cards/delmar-2026-08-30.lean-1.1.json'), 'utf8'));
const realTickets = card.tickets.map((t) => ({ id: t.sequence, betType: t.betType, races: t.raceNumbers, legs: t.legs, stakeCents: t.stakeCents, costCents: t.costCents }));
{
  const a = gradeCard(realTickets, view(pages['2026-08-30'].chart)); const b = gradeCard(realTickets, view(d30));
  const diffs = a.grades.filter((g, i) => g.returnedCents !== b.grades[i].returnedCents).map((g, i) => `${g.ticket.betType} ${JSON.stringify(g.ticket.legs)}`);
  check(`08-30: the real ${realTickets.length}-ticket card grades identically from both sources (P/L ${a.summary.plCents})`, diffs.length === 0 && a.summary.plCents === b.summary.plCents && a.summary.returnedCents > 0, diffs.join(' | '));
}

console.log('-- server: parse endpoint, from-archive, save as dmtc_html replaces + regrades --');
const PORT = 8913; const BASE = `http://127.0.0.1:${PORT}`;
const rawDir = path.join(tmp, 'raw');
fs.mkdirSync(path.join(rawDir, 'DMR', '20260830'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tests/fixtures/dmtc/results-2026-08-30.html'), path.join(rawDir, 'DMR', '20260830', 'results.html'));
const manifestPath = path.join(rawDir, 'DMR', '20260830', 'manifest.json');
const writeManifest = (races) => fs.writeFileSync(manifestPath, JSON.stringify({ track: 'DMR', date: '2026-08-30', meet: 'DMR-2026-summer', calendar: { races, stakes: [], firstPost: '2 PM' }, artifacts: { results: { fetched_at: '2026-09-02T00:00:00Z', sha256: 'x', bytes: 1, http_status: 200 } } }));
writeManifest(10);
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: path.join(tmp, 'check.sqlite'), BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'), BETSHEET_DISABLE_BUILTIN_FETCHERS: '1', BETSHEET_RAW_DIR: rawDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = ''; server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
const jpost = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const jget = (url) => fetch(BASE + url).then((r) => r.json());
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); } }
  check('server boots', up, serverOut.slice(-300));
  const html = pages['2026-08-30'] && fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc/results-2026-08-30.html'), 'utf8');
  const parsedApi = await (await jpost('/api/parse/results-html', { html })).json();
  check('POST /parse/results-html == the pure parser, sourceKind dmtc_html', parsedApi.sourceKind === 'dmtc_html' && firstDiff({ ...parsedApi, correlationId: undefined, sourceKind: undefined }, d30) === null);
  check('POST /parse/results-html: empty body -> 400', (await jpost('/api/parse/results-html', { html: '' })).status === 400);
  const day = await (await jpost('/api/race-days', { track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500, races: prog.races })).json();
  // Was an engine-generated card until D111. The cross-source proof below is
  // about the GRADER returning identical cents from two different result
  // sources, so any card with real tickets on this day serves; a human card
  // needs no engine, no PDF and no model call.
  const storedDay = await jget(`/api/race-days/${day.id}`);
  const dayPgms = livePgms(storedDay);
  const liveCardId = await makeHumanCard(jpost, day.id, storedDay.races
    .map((r) => ({ race: r.number, text: winAndBoxText(dayPgms[r.number] ?? []) }))
    .filter((r) => (dayPgms[r.race] ?? []).length >= 3));
  const liveCard = { id: liveCardId };
  const chart = pages['2026-08-30'].chart;
  const saveChart = await jpost(`/api/race-days/${day.id}/results`, { track: chart.track, date: chart.date, sourceKind: 'pdf', races: chart.races });
  const gradesChart = await jget(`/api/cards/${liveCard.id}/grades`);
  // The archived page used to be previewed through
  // POST .../results/from-archive, which read the raw archive the dmtc
  // crawler built. D113 removed the crawler and that route; the SAME page is
  // still parsed here, through the /parse/results-html endpoint a person uses
  // when they upload the file themselves. The cross-source proof below - the
  // point of this whole file - is unchanged, because it never depended on
  // where the HTML came from.
  const archivedHtml = fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc/results-2026-08-30.html'), 'utf8');
  const archivedRes = await jpost('/api/parse/results-html', { html: archivedHtml });
  const archived = await archivedRes.json();
  check('the dmtc page previews through the upload endpoint, all 10 races',
    archivedRes.status === 200 && archived.races.length === 10,
    JSON.stringify(archived.error ?? archived.races?.length));
  const saveDmtc = await jpost(`/api/race-days/${day.id}/results`, { track: archived.track, date: archived.date, sourceKind: 'dmtc_html', races: archived.races });
  const saveBody = await saveDmtc.json();
  const gradesDmtc = await jget(`/api/cards/${liveCard.id}/grades`);
  check('save as dmtc_html: replaces the chart results, resolves also-rans and scratches by name, regrades', saveChart.status === 201 && saveDmtc.status === 201 &&
    saveBody.results === 90 && saveBody.unresolvedFinishers === 0 && saveBody.scratches === 8 && gradesDmtc.grades.length === gradesChart.grades.length, JSON.stringify(saveBody));
  const diffs = gradesChart.grades.map((g, i) => [g, gradesDmtc.grades[i]]).filter(([a, b]) => a.returned_cents !== b.returned_cents || a.outcome !== b.outcome);
  check(`cross-source on the server: every ticket of the live card returns identical cents from the chart and from the dmtc page (P/L ${gradesDmtc.summary.plCents})`,
    diffs.length === 0 && gradesChart.summary.plCents === gradesDmtc.summary.plCents, diffs.slice(0, 3).map(([a, b]) => `${a.bet_type}: ${a.returned_cents} vs ${b.returned_cents}`).join(' | '));
  const stored = await jget(`/api/race-days/${day.id}/results`);
  check('provenance: newest result_charts row is dmtc_html, the earlier equibase_pdf row kept', stored.charts[0].source_kind === 'dmtc_html' && stored.charts[1].source_kind === 'equibase_pdf', JSON.stringify(stored.charts));
  // Three from-archive guards lived here - a race-count mismatch against the
  // crawler's calendar manifest (422), a missing archived page (404), and an
  // unknown day (404). All three were about the ARCHIVE, which D113 deleted
  // along with the manifest they read. The upload path's own guard is what
  // remains to check: empty input is refused rather than parsed into nothing.
  check('the results-html endpoint refuses empty input -> 400',
    (await jpost('/api/parse/results-html', { html: '' })).status === 400);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}
if (failures) { console.error(`\ncheck-dmtc-results: ${failures} failure(s)`); process.exit(1); }
console.log('\ncheck-dmtc-results: all checks passed');
