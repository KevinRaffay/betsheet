// Verification for the batch backfill runner (D43) - exits non-zero on any
// failure. Run: npm run check-backfill
//
// Layers: (1) pure - blocking classification per warning type, meet
// derivation across both meet boundaries, calendar indexing, regression
// labels, the per-bucket summary; (2) the runner against a FAKE archive
// with stub parsers (dependency-injected): golden halt -> audit -> resume,
// golden drift halt, queue routing for every blocking type, non-blocking
// saves, cross-source check, dry run writes nothing, idempotency (a second
// run saves nothing), --regenerate appends a card and preserves grades,
// the report + sidecar merge; (3) the queue API on the real server:
// list / item / reject (note required) / confirm (runs the commit, 409
// twice) and P/L by meet; (4) the REAL parsers end to end on the real
// 2026-08-30 archive (program + ML sheet + results fixtures) with the
// Equibase chart beside them - saved, graded, cross-source identical -
// plus the new 08-30 ML sheet golden with hand checks.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-backfill-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'unit-logs');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const {
  BLOCKING_TYPES, DEFAULT_PARSERS, TRACK_NAME, archivedRaceDays, classifyWarnings, firstDiff, goldenPaths,
  mergeLines, regressionFor, renderReport, runBackfill, summarize, writeReports,
} = await import('../server/backfill.js');
const { meetFor, meetForDay } = await import('../server/dmtc-crawler.js');
const { openDb } = await import('../server/db.js');
const { parseDmtcResults } = await import('../shared/dmtc-results-parser.js');
const { parseMlSheetPdf } = await import('../server/ml-sheet-parser.js');
const { ENGINE_VERSION } = await import('../shared/card-engine.js');

const FIX = path.join(ROOT, 'tests', 'fixtures');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

console.log('-- pure: blocking classification, meets, calendar, regression, summary --');
const everyType = Object.keys(BLOCKING_TYPES);
const cls = classifyWarnings([...everyType.map((t) => ({ type: t, message: t })), { type: 'index_renumbered', message: 'x' }, { type: 'program_ml_disagreement', field: 'jockey', message: 'y' }, { type: 'owner_trainer_fused', message: 'z' }]);
check('every blocking type routes to blocking; renumbered index / field disagreement / fused owner do not',
  cls.blocking.length === everyType.length && cls.nonBlocking.map((w) => w.type).join(',') === 'index_renumbered,program_ml_disagreement,owner_trainer_fused');
check('the blocking list is exactly the policy-A set (distance, calendar race count, index validation, pgm conflicts, document mismatch)',
  ['no_distance', 'race_count_mismatch', 'index_mismatch', 'no_index', 'program_ml_name_mismatch', 'program_entry_missing', 'ml_entry_missing', 'program_ml_race_count', 'wrong_date', 'wrong_track', 'program_ml_date_mismatch', 'foreign_program'].sort().join() === everyType.sort().join());
check('meet derivation across both boundaries: Jun null, Jul-Sep summer, Oct-Dec fall, Jan null',
  meetFor('2026-06-30') === null && meetFor('2026-07-01') === 'DMR-2026-summer' && meetFor('2026-09-30') === 'DMR-2026-summer' &&
  meetFor('2026-10-01') === 'DMR-2026-fall' && meetFor('2026-12-31') === 'DMR-2026-fall' && meetFor('2027-01-01') === null && meetFor('2025-11-08') === 'DMR-2025-fall');
check('meetForDay: every Del Mar spelling maps, other tracks null',
  ['Del Mar', 'DELMAR', 'Delmar', 'DMR', 'del mar'].every((t) => meetForDay(t, '2026-08-30') === 'DMR-2026-summer') && meetForDay('Santa Anita', '2026-08-30') === null);

const rawA = path.join(tmp, 'rawA');
fs.mkdirSync(path.join(rawA, 'DMR', 'calendar'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'dmtc', 'calendar-2026-08.html'), path.join(rawA, 'DMR', 'calendar', '2026-08.html'));
fs.copyFileSync(path.join(FIX, 'dmtc', 'calendar-2026-09.html'), path.join(rawA, 'DMR', 'calendar', '2026-09.html'));
const cal = archivedRaceDays(rawA);
const calGolden = readJson(path.join(FIX, 'dmtc', 'calendar-2026-08.expected.json'));
const augDays = Array.isArray(calGolden) ? calGolden : calGolden.days;
check('archivedRaceDays: every archived calendar month indexed, date order, meets derived',
  cal.months.join() === '2026-08,2026-09' && cal.days.length > augDays.length && cal.days.slice(0, augDays.length).map((d) => d.date).join() === augDays.map((d) => d.date).join() &&
  cal.days.every((d) => d.meet === 'DMR-2026-summer'), `${cal.months} ${cal.days.length}`);
const FIRST = cal.days[0].date;
check('regression labels: no baseline / pending / identical / expected (D30/D36) / unexplained', (() => {
  const base = { '2026-08-28': { plCents: -1000 } };
  const fig = (pl, graded = true) => ({ plCents: pl, graded });
  return regressionFor({ date: '2026-08-01' }, base) === null &&
    regressionFor({ date: '2026-08-28', figures: fig(-1000) }, null).label === 'no baseline' &&
    regressionFor({ date: '2026-08-28', figures: fig(0, false) }, base).label === 'runner grade pending' &&
    regressionFor({ date: '2026-08-28', figures: fig(-1000) }, base).label === 'identical' &&
    regressionFor({ date: '2026-08-28', figures: fig(-900), balancerMoved: true }, base).label === 'expected (D30/D36)' &&
    regressionFor({ date: '2026-08-28', figures: fig(-900), carveOutFired: true }, base).explainedBy.join() === 'D36 place_money_carve_out' &&
    regressionFor({ date: '2026-08-28', figures: fig(-900) }, base).label === 'unexplained';
})());
const sum = summarize([
  { status: 'saved', completeness: 'FULL', figures: { graded: true, wageredCents: 100, effectiveWageredCents: 90, returnedCents: 150, plCents: 50 }, blocking: [], nonBlocking: [{ type: 'index_renumbered' }] },
  { status: 'saved', completeness: 'PROGRAM_ONLY', figures: { graded: true, wageredCents: 100, effectiveWageredCents: 100, returnedCents: 20, plCents: -80 }, blocking: [{ type: 'no_distance' }], crossSource: { tickets: 3, agree: 2, disagreements: [{}] } },
  { status: 'queued', blocking: [{ type: 'no_distance' }], regression: { label: 'unexplained' } },
]);
check('summarize: per-bucket P/L never pooled, statuses, warnings by type flag blocking, cross-source + unexplained counted',
  Object.keys(sum.plByBucket).join() === 'FULL,PROGRAM_ONLY' && sum.plByBucket.FULL.plCents === 50 && sum.plByBucket.PROGRAM_ONLY.plCents === -80 &&
  sum.byStatus.saved === 2 && sum.byStatus.queued === 1 && sum.warningsByType['no_distance (blocking)'] === 2 && sum.warningsByType.index_renumbered === 1 &&
  sum.crossSource.days === 1 && sum.crossSource.disagreements === 1 && sum.unexplainedRegressions === 1, JSON.stringify(sum));
check('mergeLines: a skipped day keeps the line from the run that saved it',
  (() => { const m = mergeLines([{ date: 'd', status: 'saved', figures: { plCents: 1 }, correlationId: 'a' }], [{ date: 'd', status: 'skipped', correlationId: 'b' }, { date: 'e', status: 'saved' }]); return m.length === 2 && m[0].status === 'saved' && m[0].lastSeenRunId === 'b' && m[1].date === 'e'; })());

// ---------- layer 2: the runner on a fake archive with stub parsers ----------
// Each fake day's three artifacts contain a marker ("DAY:<date>"); the stub
// parsers read it and return synthetic documents built from the REAL
// 2026-08-30 chart golden (program numbers + names) and the real dmtc
// results fixture, with per-date twists that inject each blocking type.

console.log('-- runner: fake archive, stub parsers --');
const chart30 = readJson(path.join(FIX, 'charts', 'dmr-2026-08-30.expected.json'));
const dmtc30 = parseDmtcResults(fs.readFileSync(path.join(FIX, 'dmtc', 'results-2026-08-30.html'), 'utf8'));
const ML_LINES = ['2/1', '3/1', '4/1', '6/1', '8/1', '10/1', '15/1', '20/1', '30/1', '5/2', '7/2', '9/2', '12/1', '5/1'];
function entriesDoc(date, n, { asProgram = false, renameIn = null, dropDistanceIn = null } = {}) {
  const races = [];
  for (let i = 0; i < n; i++) {
    const src = chart30.races[i];
    const dm = dmtc30.races[i];
    const entries = src.results.map((r, k) => ({
      programNumber: String(r.programNumber), postPosition: k + 1,
      horseName: renameIn === i + 1 && k === 0 && asProgram ? `${r.horseName} II` : r.horseName,
      jockey: 'A Jockey', trainer: asProgram ? 'B Trainer' : null, weight: 122, morningLine: ML_LINES[k % ML_LINES.length],
      morningLineDecimal: Number(ML_LINES[k % ML_LINES.length].split('/')[0]) / Number(ML_LINES[k % ML_LINES.length].split('/')[1]),
      scratched: false, alsoEligible: false, scratchReason: null, ...(asProgram ? { programRank: k + 1, bestBet: false, notToBeClaimed: false } : {}),
    }));
    races.push({ number: i + 1, postTime: null, wagerMenu: null, distance: dropDistanceIn === i + 1 ? null : dm.distance, surface: dm.surface, raceType: dm.raceType, purseCents: null, claimingPriceCents: null, conditions: null, entries, scratches: [] });
  }
  const warnings = [];
  if (dropDistanceIn) warnings.push({ type: 'no_distance', race: dropDistanceIn, message: `Race ${dropDistanceIn}: no distance` });
  return { track: 'Del Mar', date, races, warnings };
}
// Per-date twists (all dates are real race days of the archived Aug 2026 calendar).
const TWIST = {};
const stubParsers = {
  ml: (bytes) => { const d = marker(bytes); const t = TWIST[d] ?? {}; const n = t.races ?? 10; return entriesDoc(d, t.mlRaces ?? n, { dropDistanceIn: t.noDistance ?? null }); },
  program: (bytes) => {
    const d = marker(bytes); const t = TWIST[d] ?? {}; const n = t.races ?? 10;
    if (t.foreign) return { track: null, date: d, races: [], analysis: [], index: [], warnings: [{ type: 'no_analysis', message: 'x' }, { type: 'no_index', message: 'x' }, { type: 'foreign_program', message: 'not a Del Mar program (stub)' }], foreign: true };
    const doc = entriesDoc(d, n, { asProgram: true, renameIn: t.renameIn ?? null });
    if (t.programWarnings) doc.warnings.push(...t.programWarnings);
    return doc;
  },
  results: (html, expected) => {
    const d = marker(html); const t = TWIST[d] ?? {}; const n = t.results ?? t.races ?? 10;
    const doc = { ...dmtc30, date: d, races: dmtc30.races.slice(0, n).map((r) => ({ ...r })), warnings: [] };
    if (expected?.races != null && expected.races !== doc.races.length) doc.warnings.push({ type: 'race_count_mismatch', message: `results page has ${doc.races.length} races; calendar says ${expected.races}` });
    return doc;
  },
  chart: () => ({ ...chart30, races: chart30.races.map((r) => ({ ...r })) }),
};
const marker = (buf) => Buffer.from(buf).toString('utf8').match(/DAY:(\d{4}-\d{2}-\d{2})/)[1];

function fakeDay(rawDir, date, { races = 10, chart = false } = {}) {
  const dir = path.join(rawDir, 'DMR', date.replace(/-/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['ml.pdf', 'program.pdf', 'results.html']) fs.writeFileSync(path.join(dir, f), `DAY:${date}`);
  if (chart) fs.writeFileSync(path.join(dir, 'chart.txt'), `DAY:${date}`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ track: 'DMR', date, meet: meetFor(date), calendar: { races }, artifacts: {} }));
}
// The scenario dates: the meet's first archived race day + eight more real Aug race days.
const D = cal.days.filter((d) => d.date.startsWith('2026-08')).map((d) => d.date);
const [dFirst, dNoDist, dCalMismatch, dIndex, dWrongDate, dResMismatch, dPgmConflict, dNonBlocking, dClean] = [FIRST, D[1], D[2], D[3], D[4], D[5], D[6], D[7], D[8]];
TWIST[dNoDist] = { noDistance: 3 };
TWIST[dCalMismatch] = { mlRaces: 9 };                                   // ML sheet 9 races vs calendar 10
TWIST[dIndex] = { programWarnings: [{ type: 'index_mismatch', message: 'index says otherwise' }] };
TWIST[dWrongDate] = { programWarnings: [{ type: 'wrong_date', message: 'program is for another day' }] };
TWIST[dResMismatch] = { races: 9, results: 10 };                         // entries 9 (= manifest 9), results page 10
TWIST[dPgmConflict] = { renameIn: 2 };                                   // program names #x differently -> pgm conflict
TWIST[dNonBlocking] = { programWarnings: [{ type: 'index_renumbered', message: 'renumbered' }] };
const ALL = [dFirst, dNoDist, dCalMismatch, dIndex, dWrongDate, dResMismatch, dPgmConflict, dNonBlocking, dClean];
for (const d of ALL) fakeDay(rawA, d, { races: TWIST[d]?.races ?? 10, chart: d === dClean || d === dFirst });

const goldenA = path.join(tmp, 'goldenA');
const docsA = path.join(tmp, 'docsA');
const dbA = openDb(path.join(tmp, 'a.sqlite'));
const runA = (extra = {}) => runBackfill({ from: dFirst, to: dClean, rawDir: rawA, goldenDir: goldenA, docsDir: docsA, db: dbA, parsers: stubParsers, ...extra });
const count = (db, sql) => db.prepare(sql).get().n;

const r0 = await runA({ dryRun: true });
check('dry run with no golden: would halt at the first race day, writes no candidate, no rows',
  r0.lines.length === 1 && r0.lines[0].status === 'halted' && /would halt/.test(r0.lines[0].note) && !fs.existsSync(goldenPaths(goldenA, 'DMR-2026-summer').candidate) && count(dbA, 'SELECT COUNT(*) n FROM race_days') === 0, JSON.stringify(r0.lines[0]));
const r1 = await runA();
const gp = goldenPaths(goldenA, 'DMR-2026-summer');
check('golden checkpoint: halts at the first race day, writes day.candidate.json + copies the artifacts, saves nothing',
  r1.halted && r1.lines.length === 1 && r1.lines[0].status === 'halted' && fs.existsSync(gp.candidate) && ['ml.pdf', 'program.pdf', 'results.html', 'manifest.json'].every((f) => fs.existsSync(path.join(gp.dir, f))) &&
  count(dbA, 'SELECT COUNT(*) n FROM race_days') === 0, r1.halted);
const cand = readJson(gp.candidate);
check('the candidate freezes every parse of the day (ml, program, merged, results) + the calendar race count',
  cand.date === dFirst && cand.meet === 'DMR-2026-summer' && cand.calendarRaces === 10 && cand.ml.races.length === 10 && cand.program.races[0].entries[0].programRank === 1 && cand.merged.races.length === 10 && cand.results.races.length === 10);
const rMid = await runBackfill({ from: dNoDist, to: dClean, rawDir: rawA, goldenDir: goldenA, docsDir: docsA, db: dbA, parsers: stubParsers });
check('a range that skips the first day of an un-audited meet halts immediately, pointing at the first day',
  rMid.lines.length === 1 && rMid.lines[0].status === 'halted' && rMid.lines[0].note.includes(dFirst) && count(dbA, 'SELECT COUNT(*) n FROM race_days') === 0);

// "Audit" the candidate: it becomes the golden. Resume.
fs.renameSync(gp.candidate, gp.expected);
const r2 = await runA();
const by = (r) => Object.fromEntries(r.lines.map((l) => [l.date, l]));
const L = by(r2);
check('resume after the golden: the first day verifies against the golden and saves; every day in the range gets a line',
  !r2.halted && r2.lines.length === ALL.length && L[dFirst].status === 'saved' && L[dFirst].raceDayId > 0 && L[dFirst].cardId > 0, JSON.stringify(r2.lines.map((l) => [l.date, l.status, l.note])));
check('queue routing: unparsed distance -> queued', L[dNoDist].status === 'queued' && L[dNoDist].blocking.some((w) => w.type === 'no_distance'), L[dNoDist].note);
check('queue routing: ML race count vs calendar -> queued (source ml)', L[dCalMismatch].status === 'queued' && L[dCalMismatch].blocking.some((w) => w.type === 'race_count_mismatch' && w.source === 'ml'), JSON.stringify(L[dCalMismatch].blocking));
check('queue routing: index validation failure -> queued', L[dIndex].status === 'queued' && L[dIndex].blocking.some((w) => w.type === 'index_mismatch'));
check('queue routing: document date mismatch -> queued', L[dWrongDate].status === 'queued' && L[dWrongDate].blocking.some((w) => w.type === 'wrong_date'));
check('queue routing: results race count vs calendar -> queued (source results)', L[dResMismatch].status === 'queued' && L[dResMismatch].blocking.some((w) => w.type === 'race_count_mismatch' && w.source === 'results'), JSON.stringify(L[dResMismatch].blocking));
check('queue routing: program/ML conflict on a program number -> queued', L[dPgmConflict].status === 'queued' && L[dPgmConflict].blocking.some((w) => w.type === 'program_ml_name_mismatch'), JSON.stringify(L[dPgmConflict].blocking));
check('non-blocking warnings save and are reported', L[dNonBlocking].status === 'saved' && L[dNonBlocking].nonBlocking.some((w) => w.type === 'index_renumbered') && L[dNonBlocking].blocking.length === 0);
check('a clean day saves: race day + one card under the current engine version + dmtc results + graded figures',
  L[dClean].status === 'saved' && L[dClean].engineVersion === ENGINE_VERSION && L[dClean].resultsSource === 'dmtc_html' && L[dClean].figures.graded && L[dClean].figures.wageredCents === 20000 &&
  L[dClean].completeness === 'PROGRAM_ONLY' && L[dClean].entriesSource === 'both', JSON.stringify(L[dClean].figures));
check('cross-source check runs when a chart sits beside the day: every ticket agrees (chart == results here)',
  L[dClean].crossSource && L[dClean].crossSource.tickets > 0 && L[dClean].crossSource.agree === L[dClean].crossSource.tickets && L[dFirst].crossSource?.agree === L[dFirst].crossSource?.tickets, JSON.stringify(L[dClean].crossSource));
const dayRow = dbA.prepare('SELECT * FROM race_days WHERE date = ?').get(dClean);
check('the saved day carries meet, entries_source, track and the day correlation id', dayRow.meet === 'DMR-2026-summer' && dayRow.entries_source === 'both' && dayRow.track === TRACK_NAME && dayRow.correlation_id === L[dClean].correlationId);
const queued = dbA.prepare("SELECT * FROM backfill_queue WHERE status = 'pending' ORDER BY date").all();
check('queue rows: one pending row per blocked day with the exact save payload, the results parse, the blocking list',
  queued.length === 6 && queued.map((q) => q.date).join() === [dNoDist, dCalMismatch, dIndex, dWrongDate, dResMismatch, dPgmConflict].join() &&
  queued.every((q) => JSON.parse(q.payload).races.length > 0 && JSON.parse(q.results).races.length > 0 && JSON.parse(q.blocking).length > 0), queued.map((q) => q.date).join());
check('summary: saved 3 / queued 6, warnings by type, P/L in one bucket', r2.summary.byStatus.saved === 3 && r2.summary.byStatus.queued === 6 && r2.summary.warningsByType['no_distance (blocking)'] === 1 && r2.summary.plByBucket.PROGRAM_ONLY.days === 3, JSON.stringify(r2.summary));

const snapshot = () => ({
  days: count(dbA, 'SELECT COUNT(*) n FROM race_days'), cards: count(dbA, 'SELECT COUNT(*) n FROM cards'), grades: dbA.prepare('SELECT ticket_id, engine_version, returned_cents FROM graded_tickets ORDER BY ticket_id, engine_version').all(),
  queue: count(dbA, 'SELECT COUNT(*) n FROM backfill_queue'), results: count(dbA, 'SELECT COUNT(*) n FROM race_results'),
});
const s1 = snapshot();
const r3 = await runA();
const s2 = snapshot();
check('idempotent: a second run saves nothing (skipped / queued lines only), no new rows anywhere',
  firstDiff(s1, s2) === null && r3.lines.every((l) => l.status === 'skipped' || l.status === 'queued') && r3.summary.byStatus.skipped === 3 && r3.summary.byStatus.queued === 6 &&
  by(r3)[dClean].figures.plCents === L[dClean].figures.plCents && by(r3)[dClean].parsedRaces === 10, JSON.stringify(r3.lines.map((l) => [l.date, l.status])));
const r4 = await runA({ dryRun: true });
check('dry run on an existing corpus: reports, writes nothing', firstDiff(s1, snapshot()) === null && r4.dryRun && r4.lines.length === ALL.length);
const r5 = await runA({ regenerate: true });
const s3 = snapshot();
check('--regenerate: one more card per saved day under the current version; every existing grade row untouched (invariant 14); queued days untouched',
  s3.cards === s1.cards + 3 && s3.days === s1.days && s3.queue === s1.queue && s1.grades.every((g, i) => firstDiff(g, s3.grades[i]) === null) && s3.grades.length > s1.grades.length &&
  by(r5)[dClean].status === 'regenerated' && by(r5)[dClean].cardId !== L[dClean].cardId && by(r5)[dClean].engineVersion === ENGINE_VERSION && by(r5)[dNoDist].status === 'queued', JSON.stringify(r5.summary.byStatus));

const written = writeReports(r2, { docsDir: docsA });
writeReports(r3, { docsDir: docsA });
const side = readJson(path.join(docsA, 'DMR-2026-summer.json'));
const md = fs.readFileSync(path.join(docsA, 'DMR-2026-summer.md'), 'utf8');
check('report: one markdown + sidecar per meet; the sidecar merges runs so skipped days keep the line that saved them',
  written.length === 2 && side.lines.length === ALL.length && side.lines.find((l) => l.date === dClean).status === 'saved' && side.lines.find((l) => l.date === dClean).lastSeenStatus === 'skipped' &&
  md.includes('## Days') && md.includes('| ' + dClean + ' | saved |') && md.includes('PROGRAM_ONLY') && md.includes('## Backfill queue') && md.includes('no_distance (blocking)'), md.slice(0, 400));
check('report: the regression section lists the hand-graded days with "no baseline" when the baseline file is absent',
  (() => { const rr = renderReport('m', r2, [{ date: '2026-08-28', status: 'saved', figures: { graded: true, plCents: -100 }, regression: regressionFor({ date: '2026-08-28', figures: { graded: true, plCents: -100 } }, null) }]); return rr.includes('## Regression line') && rr.includes('| 2026-08-28 | - | -$1.00 | - | no baseline |'); })());

// Golden drift: a changed golden halts a fresh corpus at the first day.
const goldenB = path.join(tmp, 'goldenB');
fs.mkdirSync(path.join(goldenB, 'DMR-2026-summer'), { recursive: true });
const drifted = readJson(gp.expected); drifted.merged.races[0].entries[0].horseName = 'Someone Else';
fs.writeFileSync(goldenPaths(goldenB, 'DMR-2026-summer').expected, JSON.stringify(drifted));

// D92 tripwire: analyst notes are an INTERACTIVE input and must never reach a
// batch prompt. previewLlmRace refuses without `interactive: true`, but this
// fails loudly the day someone wires an LLM path into the runner without
// reading that guard - the guard is cheap, discovering a contaminated corpus
// months later is not.
check('a backfill run records no notes-bearing LLM request',
  count(dbA, 'SELECT COUNT(*) n FROM llm_card_requests WHERE notes_present = 1') === 0);

const dbB = openDb(path.join(tmp, 'b.sqlite'));
const rB = await runBackfill({ from: dFirst, to: dClean, rawDir: rawA, goldenDir: goldenB, docsDir: docsA, db: dbB, parsers: stubParsers });
check('golden drift: the current parse differing from the audited golden halts the run before any write',
  rB.halted && /golden drift/.test(rB.halted) && rB.lines.length === 1 && count(dbB, 'SELECT COUNT(*) n FROM race_days') === 0, rB.halted);
dbB.close();
const rMissing = await runBackfill({ from: dFirst, to: dClean, rawDir: rawA, goldenDir: goldenA, docsDir: docsA, db: openDb(path.join(tmp, 'c.sqlite')), parsers: stubParsers, meet: 'DMR-2026-fall' });
check('--meet filters the range to one meet (none here) and the missing-calendar list is empty for archived months', rMissing.lines.length === 0 && rMissing.missingCalendars.length === 0);
const rNoCal = await runBackfill({ from: '2026-11-01', to: '2026-11-30', rawDir: rawA, goldenDir: goldenA, docsDir: docsA, db: openDb(path.join(tmp, 'd.sqlite')), parsers: stubParsers });
check('a month with no archived calendar is reported (never enumerated blindly)', rNoCal.lines.length === 0 && rNoCal.missingCalendars.join() === '2026-11');

// ---------- index source 2 in the runner: a dark month indexed by the meet-dates table, the three-way race-count rule ----------
console.log('-- runner: meet-table days (no calendar count) --');
const rawT = path.join(tmp, 'rawT');
fs.mkdirSync(path.join(rawT, 'DMR', 'calendar'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'dmtc', 'calendar-2026-08.html'), path.join(rawT, 'DMR', 'calendar', '2026-08.html'));
fs.copyFileSync(path.join(FIX, 'dmtc', 'calendar-2025-07.html'), path.join(rawT, 'DMR', 'calendar', '2026-09.html'));   // a DARK September
const meetsT = path.join(tmp, 'meetsT');
fs.mkdirSync(meetsT, { recursive: true });
const [tClean, tMismatch, tForeign] = ['2026-09-04', '2026-09-05', '2026-09-06'];
fs.writeFileSync(path.join(meetsT, 'DMR-2026-summer.json'), JSON.stringify({ meet: 'DMR-2026-summer', track: 'DMR', window: { from: '2026-09-04', to: '2026-09-06', source: 'check' }, probe: { requests: 3 },
  days: [{ date: tClean, raceDay: true, races: 10, httpStatus: 200, url: 'x' }, { date: tMismatch, raceDay: true, races: 10, httpStatus: 200, url: 'x' }, { date: tForeign, raceDay: true, races: 10, httpStatus: 200, url: 'x' }, { date: '2026-09-07', raceDay: false, httpStatus: 404, url: 'x' }] }));
TWIST[tMismatch] = { mlRaces: 9 };
TWIST[tForeign] = { foreign: true };
for (const d of [dFirst, tClean, tMismatch, tForeign]) {
  fakeDay(rawT, d, { races: 10 });
  if (d !== dFirst) { const mp = path.join(rawT, 'DMR', d.replace(/-/g, ''), 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.calendar = null; m.index = { source: 'meet-table', races: 10 }; fs.writeFileSync(mp, JSON.stringify(m)); }
}
const dbT = openDb(path.join(tmp, 't.sqlite'));
const rT = await runBackfill({ from: dFirst, to: tForeign, rawDir: rawT, goldenDir: goldenA, docsDir: path.join(tmp, 'docsT'), meetsDir: meetsT, db: dbT, parsers: stubParsers });
const LT = by(rT);
check('index: the live August calendar (its un-archived days report missing) and the dark September (from the table) index together; the dark day 09-06 is never a line',
  rT.lines.filter((l) => l.status !== 'missing').map((l) => l.date).join() === [dFirst, tClean, tMismatch, tForeign].join() && !rT.lines.some((l) => l.date === '2026-09-07') &&
  rT.darkCalendars.join() === '2026-09' && rT.missingIndex.length === 0 && rT.tablesUsed.length === 1, JSON.stringify(rT.lines.map((l) => [l.date, l.status, l.indexSource])));
check('a table day with no calendar count: ML / program / results agree -> saved, calendarRaces null, indexSource meet-table',
  LT[tClean].status === 'saved' && LT[tClean].calendarRaces === null && LT[tClean].indexSource === 'meet-table' && LT[tClean].blocking.length === 0 && LT[dFirst].indexSource === 'calendar', JSON.stringify({ s: LT[tClean].status, n: LT[tClean].note }));
check('a table day where the documents disagree on the race count (sheet 9 / program 10 / results 10) -> race_count_mismatch (source documents), queued',
  LT[tMismatch].status === 'queued' && LT[tMismatch].blocking.some((w) => w.type === 'race_count_mismatch' && w.source === 'documents'), JSON.stringify(LT[tMismatch].blocking));
check('a foreign program (Breeders Cup official program on a BC day, D46): the sheet alone is the record, race counts compare sheet vs results only, foreign_program blocks -> queued with an ml_sheet payload',
  LT[tForeign].status === 'queued' && LT[tForeign].blocking.map((w) => w.type).join() === 'foreign_program' && LT[tForeign].entriesSource === 'ml_sheet' && LT[tForeign].parsedRaces === 10 &&
  JSON.parse(dbT.prepare('SELECT payload FROM backfill_queue WHERE date = ?').get(tForeign).payload).entriesSource === 'ml_sheet', JSON.stringify({ s: LT[tForeign].status, b: LT[tForeign].blocking, e: LT[tForeign].entriesSource }));
dbT.close();


// ---------- layer 3: the queue API on the real server ----------
console.log('-- server: the Backfill queue API, P/L by meet --');
dbA.close();
const PORT = 8914;
const BASE = `http://127.0.0.1:${PORT}`;
const logDir = path.join(tmp, 'server-logs');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, BETSHEET_PORT: String(PORT), BETSHEET_DB: path.join(tmp, 'a.sqlite'), BETSHEET_LOG_DIR: logDir, BETSHEET_DISABLE_BUILTIN_FETCHERS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = ''; server.stdout.on('data', (d) => { serverOut += d; }); server.stderr.on('data', (d) => { serverOut += d; });
const jpost = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const jget = (url) => fetch(BASE + url).then((r) => r.json());
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); } }
  check('server boots on the runner DB', up, serverOut.slice(-300));
  const q = await jget('/api/backfill/queue');
  check('GET /backfill/queue: six pending, none decided, blocking lists exposed, payloads not in the list', q.pending.length === 6 && q.decided.length === 0 && q.pending[0].blocking.length > 0 && q.pending[0].payload === undefined);
  const item = await jget(`/api/backfill/queue/${q.pending[0].id}`);
  check('GET /backfill/queue/:id: the full read-only preview material (payload races, results, warnings)', item.payload.races.length > 0 && item.results.races.length > 0 && Array.isArray(item.warnings) && item.date === q.pending[0].date);
  check('reject without a note -> 400; nothing changes', (await jpost(`/api/backfill/queue/${item.id}/reject`, {})).status === 400 && (await jget('/api/backfill/queue')).pending.length === 6);
  const rej = await jpost(`/api/backfill/queue/${item.id}/reject`, { note: 'distance missing on race 3; program reprint needed' });
  check('reject with a note -> recorded (status, when, note), no race day written', rej.status === 200 && (await jget('/api/backfill/queue')).decided.find((d) => d.id === item.id)?.decisionNote?.includes('reprint') && (await jget('/api/race-days')).every((d) => d.date !== item.date));
  const second = (await jget('/api/backfill/queue')).pending[0];
  const conf = await jpost(`/api/backfill/queue/${second.id}/confirm`, { note: 'calendar count is wrong for this day, the sheet is right' });
  const confBody = await conf.json();
  const daysNow = await jget('/api/race-days');
  check('confirm -> the same commit an auto-save runs: race day + results + one graded card under the current version, outcome recorded',
    conf.status === 201 && confBody.raceDayId > 0 && confBody.cardId > 0 && confBody.engineVersion === ENGINE_VERSION && confBody.figures.graded && daysNow.some((d) => d.id === confBody.raceDayId && d.date === second.date) &&
    (await jget('/api/backfill/queue')).decided.find((d) => d.id === second.id)?.outcome?.cardId === confBody.cardId, JSON.stringify(confBody).slice(0, 300));
  check('confirm twice -> 409; reject a decided item -> 409; unknown item -> 404',
    (await jpost(`/api/backfill/queue/${second.id}/confirm`)).status === 409 && (await jpost(`/api/backfill/queue/${item.id}/reject`, { note: 'x' })).status === 409 && (await jget('/api/backfill/queue/999999')).error != null);
  const del = await fetch(`${BASE}/api/race-days/${confBody.raceDayId}`, { method: 'DELETE' });
  check('a confirmed day can be soft-deleted afterwards (the ordinary delete route)', del.status === 200 && (await jget('/api/race-days')).every((d) => d.id !== confBody.raceDayId));
  const pl = await jget('/api/pl');
  const plMeet = await jget('/api/pl?meet=DMR-2026-summer');
  const plOther = await jget('/api/pl?meet=DMR-2025-fall');
  check('P/L by meet: meets listed, ?meet= narrows every card row, an unknown meet falls back to all',
    pl.meets.join() === 'DMR-2026-summer' && pl.selectedMeet === 'all' && plMeet.selectedMeet === 'DMR-2026-summer' && plMeet.cards.length === pl.cards.length && plMeet.cards.every((c) => c.meet === 'DMR-2026-summer') && plOther.selectedMeet === 'all', JSON.stringify({ m: pl.meets, n: pl.cards.length }));
  const dbA2 = openDb(path.join(tmp, 'a.sqlite'));
  const rAfter = await runBackfill({ from: dFirst, to: dClean, rawDir: rawA, goldenDir: goldenA, docsDir: docsA, db: dbA2, parsers: stubParsers });
  const LA = by(rAfter);
  check('a later run reports the decisions: confirmed-then-deleted day -> resolved and LEFT OUT (never re-queued, invariant 12), rejected day -> resolved, the rest still queued',
    LA[second.date].status === 'resolved' && /confirmed/.test(LA[second.date].note) && /later deleted/.test(LA[second.date].note) && !LA[second.date].raceDayId && LA[item.date].status === 'resolved' && /rejected/.test(LA[item.date].note) && rAfter.summary.byStatus.queued === 4 &&
    (await jget('/api/backfill/queue')).pending.length === 4, JSON.stringify(rAfter.lines.map((l) => [l.date, l.status, l.note?.slice(0, 40)])));
  dbA2.close();
  await new Promise((rr) => setTimeout(rr, 300));
  const readTrace = (dir) => fs.readFileSync(path.join(dir, 'decision-trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const trace = readTrace(logDir);
  const unitTrace = readTrace(process.env.BETSHEET_LOG_DIR);
  check('trace: backfill_queue_decided under the day correlation id for both decisions; backfill_day per line',
    trace.filter((e) => e.event === 'backfill_queue_decided').length === 2 && trace.some((e) => e.event === 'backfill_queue_decided' && e.decision === 'confirmed' && e.correlationId === second.correlationId && e.cardId === confBody.cardId) &&
    unitTrace.filter((e) => e.event === 'backfill_day').length >= ALL.length && unitTrace.some((e) => e.event === 'backfill_day' && e.status === 'queued' && e.blocking.includes('no_distance')),
    [...trace, ...unitTrace].filter((e) => /backfill/.test(e.event)).map((e) => e.event + ':' + (e.decision ?? e.status)).join());
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
}

// ---------- layer 4: the REAL parsers on the real 2026-08-30 archive ----------
console.log('-- real day: program + ML sheet + dmtc results + Equibase chart (2026-08-30) --');
const mlPdf = path.join(FIX, 'ml-sheets', 'dmr-2026-08-30.pdf');
const mlGolden = readJson(path.join(FIX, 'ml-sheets', 'dmr-2026-08-30.expected.json'));
const mlOut = await parseMlSheetPdf(new Uint8Array(fs.readFileSync(mlPdf)), { track: 'Del Mar', date: '2026-08-30' });
const mlDiff = firstDiff(mlOut, mlGolden);
check('golden: dmr-2026-08-30 ML sheet', !mlDiff, mlDiff ?? '');
check('08-30 sheet hand checks: 10 races, 98 entries, one scratch each in R5 and R10, R7 is the Torrey Pines (G3) at 5:12PM, R1 posts 2:00PM',
  mlOut.races.length === 10 && mlOut.races.reduce((a, r) => a + r.entries.length, 0) === 98 && mlOut.races[4].entries.filter((e) => e.scratched).length === 1 && mlOut.races[9].entries.filter((e) => e.scratched).length === 1 &&
  /Torrey Pines/.test(mlOut.races[6].raceType) && mlOut.races[6].postTime === '5:12PM' && mlOut.races[0].postTime === '2:00PM' && mlOut.warnings.length === 0);
const rawR = path.join(tmp, 'rawR');
fs.mkdirSync(path.join(rawR, 'DMR', 'calendar'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'dmtc', 'calendar-2026-08.html'), path.join(rawR, 'DMR', 'calendar', '2026-08.html'));
const dirR = path.join(rawR, 'DMR', '20260830');
fs.mkdirSync(dirR, { recursive: true });
fs.copyFileSync(path.join(FIX, 'programs', 'delmar-2026-08-30.pdf'), path.join(dirR, 'program.pdf'));
fs.copyFileSync(mlPdf, path.join(dirR, 'ml.pdf'));
fs.copyFileSync(path.join(FIX, 'dmtc', 'results-2026-08-30.html'), path.join(dirR, 'results.html'));
fs.copyFileSync(path.join(FIX, 'charts', 'dmr-2026-08-30.txt'), path.join(dirR, 'chart.txt'));
fs.writeFileSync(path.join(dirR, 'manifest.json'), JSON.stringify({ track: 'DMR', date: '2026-08-30', meet: 'DMR-2026-summer', calendar: { races: 10 }, artifacts: {} }));
const goldenR = path.join(tmp, 'goldenR');
fs.mkdirSync(path.join(goldenR, 'DMR-2026-summer'), { recursive: true });
fs.writeFileSync(goldenPaths(goldenR, 'DMR-2026-summer').expected, '{}');   // not the meet's first day: the golden only has to exist
const dbR = openDb(path.join(tmp, 'r.sqlite'));
const rR = await runBackfill({ from: '2026-08-30', to: '2026-08-30', rawDir: rawR, goldenDir: goldenR, docsDir: path.join(tmp, 'docsR'), db: dbR, parsers: DEFAULT_PARSERS });
const real = rR.lines[0];
check('real 08-30: saved with only non-blocking warnings (renumbered index x2, one jockey spelling), 10/10/10 races, both entries sources, PROGRAM_ONLY',
  real.status === 'saved' && real.blocking.length === 0 && real.nonBlocking.map((w) => w.type).sort().join() === 'index_renumbered,index_renumbered,program_ml_disagreement' && real.calendarRaces === 10 && real.parsedRaces === 10 && real.resultsRaces === 10 &&
  real.entriesSource === 'both' && real.completeness === 'PROGRAM_ONLY' && real.engineVersion === ENGINE_VERSION, JSON.stringify({ s: real.status, n: real.note, w: real.nonBlocking?.map((w) => w.type) }));
check('real 08-30: $200 wagered, every ticket graded from the dmtc page, cross-source vs the Equibase chart identical on every ticket',
  real.figures.graded && real.figures.wageredCents === 20000 && real.resultsSource === 'dmtc_html' && real.crossSource.tickets > 0 && real.crossSource.agree === real.crossSource.tickets, JSON.stringify({ f: real.figures, x: real.crossSource }));
const realDay = dbR.prepare('SELECT * FROM race_days WHERE date = ?').get('2026-08-30');
const realEntries = dbR.prepare('SELECT COUNT(*) n FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ?').get(realDay.id).n;
const rankedEntries = dbR.prepare('SELECT COUNT(*) n FROM entries e JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ? AND e.program_rank IS NOT NULL').get(realDay.id).n;
check('real 08-30: the stored day is the merged document (98 entries, sheet as record, program analysis ranks present), meet stamped',
  realEntries === 98 && realDay.entries_source === 'both' && realDay.meet === 'DMR-2026-summer' && rankedEntries >= 10 && rankedEntries < 98, JSON.stringify({ realEntries, rankedEntries, src: realDay.entries_source, meet: realDay.meet }));
const bottomLineRaces = dbR.prepare('SELECT COUNT(*) n FROM races WHERE race_day_id = ? AND bottom_line IS NOT NULL').get(realDay.id).n;
check('real 08-30: races.bottom_line populated from the program analysis (D59 - dayPayload dropped parsed.merged.analysis before this fix)',
  bottomLineRaces > 0, JSON.stringify({ bottomLineRaces }));
dbR.close();

// ---------- layer 5: every COMMITTED meet golden still matches a fresh parse ----------
// The runner re-verifies a golden only when it reaches the meet's first day;
// this runs the same comparison on every audited golden in the repo so a
// parser change that would halt the next backfill fails here first.
console.log('-- committed meet goldens (tests/fixtures/backfill) --');
const goldenRoot = path.join(FIX, 'backfill');
const { goldenDocument, parseArchivedDay } = await import('../server/backfill.js');
const meets = fs.existsSync(goldenRoot) ? fs.readdirSync(goldenRoot).filter((m) => fs.existsSync(path.join(goldenRoot, m, 'day.expected.json'))) : [];
check('at least one audited meet golden is committed', meets.length > 0, 'none found');
for (const m of meets) {
  const dir = path.join(goldenRoot, m);
  const expected = readJson(path.join(dir, 'day.expected.json'));
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const rawG = path.join(tmp, 'rawG-' + m);
  const dayDirG = path.join(rawG, 'DMR', expected.date.replace(/-/g, ''));
  fs.mkdirSync(dayDirG, { recursive: true });
  for (const a of ['ml.pdf', 'program.pdf', 'results.html', 'manifest.json']) if (fs.existsSync(path.join(dir, a))) fs.copyFileSync(path.join(dir, a), path.join(dayDirG, a));
  // A foreign program is committed by digest only (D46): the archive copy under
  // data/raw stands in when present and must match the digest; without the
  // archive the program verdict is the golden's own (the runner re-verifies
  // it against the archive on every run).
  const digestFile = path.join(dir, 'program.digest.json');
  if (!fs.existsSync(path.join(dir, 'program.pdf')) && fs.existsSync(digestFile)) {
    const digest = readJson(digestFile);
    const archived = path.join(ROOT, 'data', 'raw', 'DMR', expected.date.replace(/-/g, ''), 'program.pdf');
    if (fs.existsSync(archived)) {
      const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(archived)).digest('hex');
      check(`golden ${m}: the archived foreign program matches the committed digest`, sha === digest.sha256 && fs.statSync(archived).size === digest.bytes, `${sha.slice(0, 12)} vs ${digest.sha256.slice(0, 12)}`);
      fs.copyFileSync(archived, path.join(dayDirG, 'program.pdf'));
    } else {
      console.log(`  note  golden ${m}: foreign program is digest-only and the archive is not present here - its verdict is taken from the golden (the runner re-verifies against the archive)`);
      fs.writeFileSync(path.join(dayDirG, 'program.pdf'), 'digest-only');
    }
  }
  const parsers = { ...DEFAULT_PARSERS, program: async (bytes, exp) => (Buffer.from(bytes).toString('utf8') === 'digest-only' ? expected.program : DEFAULT_PARSERS.program(bytes, exp)) };
  const parsed = await parseArchivedDay({ date: expected.date, meet: m, races: manifest.calendar?.races ?? null }, { rawDir: rawG, parsers });
  const d = parsed.missing ? 'missing ' + parsed.missing.join() : firstDiff(goldenDocument({ date: expected.date, meet: m }, parsed), expected);
  check(`golden ${m} (${expected.date}) matches a fresh parse of the artifacts beside it`, !d, d ?? '');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
console.log('');
if (failures) { console.error(`check-backfill: ${failures} failure(s)`); process.exit(1); }
console.log('check-backfill: all checks passed');
