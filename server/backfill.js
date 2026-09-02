// Batch backfill runner (D43): every ARCHIVED race day in date order ->
// race day (ML sheet as the entries record + program as analysis, D40) ->
// one card under the CURRENT engine version with the default recipe ->
// results from the archived dmtc page (D42) -> graded. Reads only the
// D41 raw archive, never the network.
//
// Invariant 9, batch policy A (user decision 2026-09-01): a day is saved
// without a click ONLY when its parse carries zero BLOCKING warnings
// (BLOCKING_TYPES below). Anything blocking lands in backfill_queue with
// the exact payload the save would have written; the Backfill queue view
// shows the read-only preview and the user confirms (commitDay - the same
// commit an auto-save runs) or rejects with a note. Non-blocking warnings
// save and are reported.
//
// Idempotent: a date with a live race day is skipped; --regenerate appends
// a new card under the current version and touches no existing grade
// (invariant 14). Per-meet golden checkpoint: the runner halts at the
// FIRST race day of each meet until tests/fixtures/backfill/<meet>/
// day.expected.json exists (it writes day.candidate.json + copies the
// artifacts to audit), and re-verifies that golden every run.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath, URL } from 'node:url';
import { DEFAULT_RAW_DIR, TRACK_CODE, artifactFile, dayDir, meetFor, parseCalendar, readManifest } from './dmtc-crawler.js';
import { parseMlSheetPdf } from './ml-sheet-parser.js';
import { parseProgramPdf } from './program-parser.js';
import { mergeMlAndProgram } from '../shared/entries-merge.js';
import { parseDmtcResults } from '../shared/dmtc-results-parser.js';
import { parseChart } from '../shared/chart-parser.js';
import { extractPdfLines } from './pdf-text.js';
import { insertRaceDay } from './ingest.js';
import { loadDayFull, persistCard } from './cards.js';
import { saveResults } from './results.js';
import { buildDayResults, gradeCard } from '../shared/grading.js';
import { ENGINE_VERSION } from '../shared/card-engine.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_GOLDEN_DIR = path.join(ROOT, 'tests', 'fixtures', 'backfill');
export const DEFAULT_DOCS_DIR = path.join(ROOT, 'docs', 'backfill');
export const TRACK_NAME = 'Del Mar';
export const BASELINE_FILE = 'hand-graded-baseline.json';
/** The eight days that were hand-graded before the runner existed (regression line). */
export const BASELINE_DAYS = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];

const log = getLogger('app');
const traceLog = getLogger('decision-trace');

/** Warning types that block an auto-save (policy A). Everything else saves and is reported. */
export const BLOCKING_TYPES = {
  no_distance: 'unparsed distance',
  race_count_mismatch: 'race count differs from the calendar',
  index_mismatch: 'program index validation failed',
  no_index: 'program index validation failed (no index found - entries unvalidated)',
  program_ml_name_mismatch: 'program/ML conflict on program numbers',
  program_entry_missing: 'program/ML conflict on program numbers',
  ml_entry_missing: 'program/ML conflict on program numbers',
  program_ml_race_count: 'program/ML conflict on program numbers',
  wrong_date: 'document track/date mismatch',
  wrong_track: 'document track/date mismatch',
  program_ml_date_mismatch: 'document track/date mismatch',
};

export function classifyWarnings(warnings) {
  const blocking = [];
  const nonBlocking = [];
  for (const w of warnings) (w.type in BLOCKING_TYPES ? blocking : nonBlocking).push(w);
  return { blocking, nonBlocking };
}

export const DEFAULT_PARSERS = {
  ml: (bytes, expected) => parseMlSheetPdf(bytes, expected),
  program: (bytes, expected) => parseProgramPdf(bytes, expected),
  results: (html, expected) => parseDmtcResults(html, expected),
  chart: (text) => parseChart(text),
};

// ---------- the archived calendar: which dates are race days ----------

/** Every race day in every ARCHIVED calendar month, date order, with its meet. */
export function archivedRaceDays(rawDir) {
  const dir = path.join(rawDir, TRACK_CODE, 'calendar');
  const days = [];
  const months = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      const m = f.match(/^(\d{4})-(\d{2})\.html$/);
      if (!m) continue;
      months.push(`${m[1]}-${m[2]}`);
      const out = parseCalendar(fs.readFileSync(path.join(dir, f), 'utf8'), { year: Number(m[1]), month: Number(m[2]) });
      days.push(...(Array.isArray(out) ? out : out.days ?? []));
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, months };
}

const monthsInRange = (from, to) => {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key === end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
};

// ---------- per-meet golden checkpoint ----------

export function goldenPaths(goldenDir, meet) {
  const dir = path.join(goldenDir, meet);
  return { dir, expected: path.join(dir, 'day.expected.json'), candidate: path.join(dir, 'day.candidate.json') };
}

/** The document the golden freezes: every parse of the meet's first day, plus the calendar's race count. */
export function goldenDocument(day, parsed) {
  return { meet: day.meet, date: day.date, calendarRaces: parsed.calendarRaces, ml: parsed.ml, program: parsed.program, merged: parsed.merged, results: parsed.results };
}

export function firstDiff(a, b, at = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
  return null;
}

// ---------- parsing one archived day ----------

/**
 * Parse a day's three archived artifacts (plus an Equibase chart when one
 * sits beside them as chart.txt / chart.pdf). Returns the parses, the
 * merged entries, every warning tagged with its source, and the calendar
 * race count; `missing` lists absent artifacts instead.
 */
export async function parseArchivedDay(day, { rawDir, parsers = DEFAULT_PARSERS, manifest = readManifest(rawDir, day.date) } = {}) {
  const dir = dayDir(rawDir, day.date);
  const files = { ml: path.join(dir, artifactFile.ml), program: path.join(dir, artifactFile.program), results: path.join(dir, artifactFile.results) };
  const missing = Object.entries(files).filter(([, f]) => !fs.existsSync(f)).map(([k]) => k);
  if (!manifest) missing.unshift('manifest');
  if (missing.length) return { missing };
  const expected = { track: TRACK_NAME, date: day.date };
  const calendarRaces = manifest?.calendar?.races ?? day.races ?? null;
  const ml = await parsers.ml(new Uint8Array(fs.readFileSync(files.ml)), expected);
  const program = await parsers.program(new Uint8Array(fs.readFileSync(files.program)), expected);
  const merged = mergeMlAndProgram(ml, program);
  const results = parsers.results(fs.readFileSync(files.results, 'utf8'), { races: calendarRaces });
  let chart = null;
  const chartTxt = path.join(dir, 'chart.txt');
  const chartPdf = path.join(dir, 'chart.pdf');
  if (fs.existsSync(chartTxt)) chart = parsers.chart(fs.readFileSync(chartTxt, 'utf8'));
  else if (fs.existsSync(chartPdf)) chart = parsers.chart(await extractPdfLines(new Uint8Array(fs.readFileSync(chartPdf))));

  // The merged document carries the sheet's, the program's and the merge's
  // own warnings; the results page adds its own; the runner adds the
  // calendar race-count check on both entries documents.
  const warnings = [
    ...merged.warnings.map((w) => ({ ...w, source: w.source ?? 'entries' })),
    ...results.warnings.map((w) => ({ ...w, source: 'results' })),
  ];
  if (calendarRaces != null) {
    if (ml.races.length !== calendarRaces) warnings.push({ type: 'race_count_mismatch', source: 'ml', message: `ML sheet has ${ml.races.length} races; the calendar says ${calendarRaces}.` });
    if (program.races.length !== calendarRaces) warnings.push({ type: 'race_count_mismatch', source: 'program', message: `Program has ${program.races.length} races; the calendar says ${calendarRaces}.` });
  }
  return { ml, program, merged, results, chart, warnings, calendarRaces };
}

/** The exact POST /api/race-days body the day would be saved with. */
export function dayPayload(day, parsed, { bankrollCents, perRaceMinCents }) {
  return {
    track: TRACK_NAME, date: day.date, bankrollCents, perRaceMinCents,
    entriesSource: parsed.merged.entriesSource ?? 'both', races: parsed.merged.races,
  };
}

// ---------- figures, cross-source check ----------

/** Wagered / returned / P/L for one card from the latest grade set, plus refunds for the effective figure (D39). */
export function cardFigures(db, cardId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(t.cost_cents), 0) AS wageredCents,
           COALESCE(SUM(gt.returned_cents), 0) AS returnedCents,
           COALESCE(SUM(gt.pl_cents), 0) AS plCents,
           COALESCE(SUM(CASE WHEN gt.outcome = 'refund' THEN t.cost_cents ELSE 0 END), 0) AS refundedCents,
           COUNT(gt.ticket_id) AS gradedTickets, COUNT(t.id) AS tickets
    FROM tickets t LEFT JOIN graded_tickets_latest gt ON gt.ticket_id = t.id
    WHERE t.card_id = ?`).get(cardId);
  return { ...row, effectiveWageredCents: row.wageredCents - row.refundedCents, graded: row.gradedTickets > 0 && row.gradedTickets === row.tickets };
}

/** A results parse (dmtc page or Equibase chart) -> the grader's day map, also-rans and scratches resolved by name against the day's entries. */
export function dayResultsFromParse(parsed, entriesByRace) {
  const key = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const resolve = (raceNumber, x) => {
    if (x.programNumber != null) return String(x.programNumber);
    const hit = (entriesByRace[raceNumber] ?? []).find((e) => key(e.horseName ?? e.horse_name) === key(x.horseName));
    return hit ? String(hit.programNumber ?? hit.program_number) : null;
  };
  return buildDayResults(parsed.races.map((r) => ({
    number: r.number,
    results: (r.results ?? []).map((x) => ({ ...x, programNumber: resolve(r.number, x) })).filter((x) => x.programNumber != null),
    exotics: r.exotics ?? [],
    scratchedPgms: (r.scratches ?? []).map((s) => resolve(r.number, s)).filter((p) => p != null),
  })));
}

/**
 * Cross-source agreement (D42's proof, per day): the card's tickets graded
 * against the Equibase chart in memory versus the stored dmtc grade. A
 * ticket returning different cents is a parser bug, not variance.
 */
export function crossSourceCheck(db, cardId, chart) {
  const card = db.prepare('SELECT race_day_id FROM cards WHERE id = ?').get(cardId);
  const entries = db.prepare(`SELECT r.number AS race, e.program_number, e.horse_name FROM entries e
    JOIN races r ON r.id = e.race_id WHERE r.race_day_id = ?`).all(card.race_day_id);
  const byRace = {};
  for (const e of entries) (byRace[e.race] ??= []).push(e);
  const tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ? ORDER BY sequence').all(cardId).map((t) => {
    const sel = JSON.parse(t.selections);
    return { id: t.id, betType: t.bet_type, races: sel.races, legs: sel.legs, stakeCents: t.stake_cents, costCents: t.cost_cents };
  });
  const { grades } = gradeCard(tickets, dayResultsFromParse(chart, byRace));
  const stored = new Map(db.prepare(`SELECT gt.ticket_id, gt.returned_cents FROM graded_tickets_latest gt
    JOIN tickets t ON t.id = gt.ticket_id WHERE t.card_id = ?`).all(cardId).map((r) => [r.ticket_id, r.returned_cents]));
  const disagreements = grades.filter((g) => stored.get(g.ticket.id) !== g.returnedCents)
    .map((g) => ({ ticketId: g.ticket.id, betType: g.ticket.betType, dmtcCents: stored.get(g.ticket.id) ?? null, equibaseCents: g.returnedCents }));
  return { tickets: tickets.length, agree: tickets.length - disagreements.length, disagreements };
}

// ---------- the commit: day -> results -> card -> grade ----------

/**
 * Write one day exactly as the UI flow would: race day, results (dmtc_html),
 * one card under the current engine version (graded at once because the
 * results are already there). One transaction - a failure anywhere leaves
 * nothing behind. Shared by the auto-save and the queue's Confirm.
 */
export function commitDay(db, { payload, results, chart = null }, correlationId, { template = 'lean', variant = 'default' } = {}) {
  const run = db.transaction(() => {
    const dayId = insertRaceDay(db, payload, correlationId);
    const day = loadDayFull(db, dayId);
    const saved = saveResults(db, day, { ...results, sourceKind: 'dmtc_html' }, correlationId);
    const card = persistCard(db, day, { correlationId, variant, templateName: template });
    return { dayId, card, saved };
  });
  const { dayId, card, saved } = run();
  const trace = card.result.trace ?? [];
  return {
    raceDayId: dayId, cardId: card.cardId, completeness: card.result.completeness, engineVersion: card.result.engineVersion,
    resultsSource: 'dmtc_html', results: saved.counts,
    // For the regression line: did the D30 balancer move remainder cents, did the D36 carve-out fire?
    balancerMoved: trace.some((e) => e.event === 'remainder_distributed' && (e.remainderCents ?? 0) > 0),
    carveOutFired: trace.some((e) => e.event === 'place_money_carve_out'),
    figures: cardFigures(db, card.cardId),
    crossSource: chart ? crossSourceCheck(db, card.cardId, chart) : null,
  };
}

/** --regenerate on an existing day: one more card under the current version; existing grades untouched (invariant 14). */
export function regenerateDay(db, dayId, correlationId, { template = 'lean', variant = 'default' } = {}) {
  const day = loadDayFull(db, dayId);
  const card = persistCard(db, day, { correlationId, variant, templateName: template });
  const trace = card.result.trace ?? [];
  return {
    raceDayId: dayId, cardId: card.cardId, completeness: card.result.completeness, engineVersion: card.result.engineVersion,
    balancerMoved: trace.some((e) => e.event === 'remainder_distributed' && (e.remainderCents ?? 0) > 0),
    carveOutFired: trace.some((e) => e.event === 'place_money_carve_out'),
    figures: cardFigures(db, card.cardId),
  };
}

const liveDay = (db, date) => db.prepare(`SELECT id, correlation_id, meet FROM race_days WHERE date = ? AND deleted_at IS NULL
    AND upper(replace(track, ' ', '')) IN ('DELMAR', 'DMR')`).get(date);
const latestQueueRow = (db, date) => db.prepare('SELECT * FROM backfill_queue WHERE date = ? ORDER BY id DESC LIMIT 1').get(date);
const latestCard = (db, dayId) => db.prepare('SELECT id, engine_version, consensus_completeness FROM cards WHERE race_day_id = ? ORDER BY card_number DESC LIMIT 1').get(dayId);
const resultsSourceOf = (db, dayId) => db.prepare('SELECT source_kind FROM result_charts WHERE race_day_id = ? ORDER BY id DESC LIMIT 1').get(dayId)?.source_kind ?? null;

// ---------- the run ----------

/**
 * Run [from, to] over the archive. Returns { lines, summary, halted }.
 * `onLine` receives each day's report line as it is decided.
 */
export async function runBackfill({
  from, to = from, meet = null, dryRun = false, regenerate = false,
  rawDir = DEFAULT_RAW_DIR, goldenDir = DEFAULT_GOLDEN_DIR, docsDir = DEFAULT_DOCS_DIR,
  db = getDb(), parsers = DEFAULT_PARSERS, template = 'lean',
  bankrollCents = 20000, perRaceMinCents = 500, correlationId = newCorrelationId(), onLine = () => {},
} = {}) {
  const { days: allDays, months } = archivedRaceDays(rawDir);
  const missingCalendars = monthsInRange(from, to).filter((m) => !months.includes(m));
  const days = allDays.filter((d) => d.date >= from && d.date <= to && (!meet || d.meet === meet));
  const firstDayOfMeet = {};
  for (const d of allDays) if (d.meet && !firstDayOfMeet[d.meet]) firstDayOfMeet[d.meet] = d.date;
  const baseline = loadBaseline(docsDir);
  const report = {
    runId: correlationId, from, to, meet, dryRun, regenerate, engineVersion: ENGINE_VERSION, template,
    bankrollCents, perRaceMinCents, missingCalendars, lines: [], halted: null, startedAt: new Date().toISOString(),
  };
  const emit = (line) => { report.lines.push(line); onLine(line); return line; };

  for (const day of days) {
    const dayCid = newCorrelationId();
    const base = { date: day.date, meet: day.meet, correlationId: dayCid, calendarRaces: day.races ?? null };
    let line;
    try {
      line = await processDay({ db, day, base, dryRun, regenerate, rawDir, goldenDir, parsers, template, bankrollCents, perRaceMinCents, firstDayOfMeet, runId: correlationId });
    } catch (err) {
      line = { ...base, status: 'failed', note: String(err?.message ?? err) };
      log.warn('backfill_day_failed', { correlationId: dayCid, runId: correlationId, date: day.date, error: line.note });
    }
    line.regression = regressionFor(line, baseline);
    traceLog.info('backfill_day', { correlationId: dayCid, runId: correlationId, ...traceFields(line) });
    emit(line);
    if (line.status === 'halted') { report.halted = line.note; break; }
  }
  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report.lines);
  log.info('backfill_run', { correlationId, from, to, meet, dryRun, regenerate, engineVersion: ENGINE_VERSION, ...report.summary, halted: report.halted });
  return report;
}

const traceFields = (l) => ({
  date: l.date, meet: l.meet, status: l.status, note: l.note ?? null, raceDayId: l.raceDayId ?? null, cardId: l.cardId ?? null,
  queueId: l.queueId ?? null, blocking: (l.blocking ?? []).map((w) => w.type), nonBlocking: (l.nonBlocking ?? []).map((w) => w.type),
  completeness: l.completeness ?? null, engineVersion: l.engineVersion ?? null, crossSource: l.crossSource ? { tickets: l.crossSource.tickets, agree: l.crossSource.agree } : null,
});

// ---------- one day ----------

async function processDay(ctx) {
  const { db, day, base, dryRun, regenerate, rawDir, goldenDir, parsers, template, bankrollCents, perRaceMinCents, firstDayOfMeet, runId } = ctx;
  const existing = liveDay(db, day.date);
  const queued = latestQueueRow(db, day.date);
  const decision = (q) => `${q.status} from the queue ${q.decided_at ?? ''}${q.decision_note ? ` - ${q.decision_note}` : ''}`.trim();

  if (existing) {
    if (!regenerate) {
      const card = latestCard(db, existing.id);
      return {
        ...base, correlationId: existing.correlation_id, raceDayId: existing.id, cardId: card?.id ?? null,
        status: queued?.status === 'confirmed' ? 'resolved' : 'skipped',
        note: queued?.status === 'confirmed' ? decision(queued) : 'race day already exists (idempotent skip; --regenerate appends a card)',
        queueId: queued?.id ?? null, completeness: card?.consensus_completeness ?? null, engineVersion: card?.engine_version ?? null,
        resultsSource: resultsSourceOf(db, existing.id), figures: card ? cardFigures(db, card.id) : null,
        parsedRaces: db.prepare('SELECT COUNT(*) AS n FROM races WHERE race_day_id = ?').get(existing.id).n,
      };
    }
    if (dryRun) return { ...base, status: 'would-regenerate', raceDayId: existing.id, note: 'would append a card under the current engine version' };
    const out = regenerateDay(db, existing.id, base.correlationId, { template });
    return { ...base, status: 'regenerated', ...out, resultsSource: resultsSourceOf(db, existing.id), note: `card ${out.cardId} appended under ${out.engineVersion}; existing grades untouched` };
  }
  if (queued?.status === 'pending') {
    return { ...base, status: 'queued', queueId: queued.id, correlationId: queued.correlation_id, note: `pending in the Backfill queue since ${queued.created_at}`,
      blocking: JSON.parse(queued.blocking), nonBlocking: JSON.parse(queued.warnings).filter((w) => !(w.type in BLOCKING_TYPES)) };
  }
  if (queued?.status === 'rejected') {
    return { ...base, status: 'resolved', queueId: queued.id, correlationId: queued.correlation_id, note: decision(queued), blocking: JSON.parse(queued.blocking) };
  }

  // Golden gate. A meet with no audited golden only ever proceeds through
  // its FIRST race day (which writes the candidate and halts).
  const gp = day.meet ? goldenPaths(goldenDir, day.meet) : null;
  const isFirst = Boolean(day.meet) && firstDayOfMeet[day.meet] === day.date;
  const hasGolden = Boolean(gp) && fs.existsSync(gp.expected);
  if (gp && !hasGolden && !isFirst) {
    return { ...base, status: 'halted', note: `meet ${day.meet} has no audited golden (${gp.expected}); its first race day is ${firstDayOfMeet[day.meet]} - run from that date, audit the candidate, commit it as day.expected.json, then rerun` };
  }

  const parsed = await parseArchivedDay(day, { rawDir, parsers });
  if (parsed.missing) return { ...base, status: 'missing', note: `not archived: ${parsed.missing.join(', ')} - run: npm run dmtc-fetch -- --from ${day.date} --to ${day.date}` };

  if (gp && isFirst) {
    const doc = goldenDocument(day, parsed);
    if (!hasGolden) {
      if (!dryRun) writeCandidate(gp, doc, rawDir, day.date);
      return { ...base, status: 'halted', note: dryRun ? `would halt for the ${day.meet} golden (first race day of the meet)`
        : `golden checkpoint: wrote ${gp.candidate} and copied the day's artifacts beside it - audit it, rename to day.expected.json, commit, then rerun` };
    }
    const diff = firstDiff(doc, JSON.parse(fs.readFileSync(gp.expected, 'utf8')));
    if (diff) return { ...base, status: 'halted', note: `golden drift on ${day.meet}: the current parse differs from ${gp.expected} at ${diff} - the parser (or the archive) changed; re-audit before continuing` };
  }

  const { blocking, nonBlocking } = classifyWarnings(parsed.warnings);
  const payload = dayPayload(day, parsed, { bankrollCents, perRaceMinCents });
  const common = {
    ...base, blocking, nonBlocking, calendarRaces: parsed.calendarRaces, parsedRaces: parsed.merged.races.length,
    resultsRaces: parsed.results.races.length, hasChart: Boolean(parsed.chart), entriesSource: payload.entriesSource,
  };
  if (blocking.length) {
    const note = `${blocking.length} blocking warning(s): ${[...new Set(blocking.map((w) => BLOCKING_TYPES[w.type]))].join('; ')}`;
    if (dryRun) return { ...common, status: 'would-queue', note };
    const queueId = db.prepare(`INSERT INTO backfill_queue
        (track, date, meet, blocking, warnings, payload, results, chart, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(TRACK_NAME, day.date, day.meet, JSON.stringify(blocking), JSON.stringify(parsed.warnings), JSON.stringify(payload),
        JSON.stringify(parsed.results), parsed.chart ? JSON.stringify(parsed.chart) : null, base.correlationId).lastInsertRowid;
    log.info('backfill_day_queued', { correlationId: base.correlationId, runId, date: day.date, queueId, blocking: blocking.map((w) => w.type) });
    return { ...common, status: 'queued', queueId, note };
  }
  if (dryRun) return { ...common, status: 'would-save', note: nonBlocking.length ? `${nonBlocking.length} non-blocking warning(s)` : 'clean parse' };
  const out = commitDay(db, { payload, results: parsed.results, chart: parsed.chart }, base.correlationId, { template });
  return { ...common, status: 'saved', ...out, note: nonBlocking.length ? `${nonBlocking.length} non-blocking warning(s)` : 'clean parse' };
}

function writeCandidate(gp, doc, rawDir, date) {
  fs.mkdirSync(gp.dir, { recursive: true });
  fs.writeFileSync(gp.candidate, JSON.stringify(doc, null, 2) + '\n');
  const dir = dayDir(rawDir, date);
  for (const f of [...Object.values(artifactFile), 'manifest.json']) {
    if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(gp.dir, f));
  }
}

// ---------- regression line, summary ----------

export function loadBaseline(docsDir) {
  const f = path.join(docsDir, BASELINE_FILE);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/**
 * For the eight hand-graded days: the runner's grade beside the last
 * hand-graded figure. A difference is "expected (D30/D36)" only when this
 * card's trace shows the balancer moved remainder cents or the carve-out
 * fired; otherwise "unexplained" (which blocks D44 acceptance).
 */
export function regressionFor(line, baseline) {
  if (!BASELINE_DAYS.includes(line.date)) return null;
  const b = baseline?.[line.date] ?? null;
  const fig = line.figures ?? null;
  if (!b) return { baseline: null, runner: fig, label: 'no baseline' };
  if (!fig?.graded) return { baseline: b, runner: fig, label: 'runner grade pending' };
  const deltaCents = fig.plCents - (b.plCents ?? 0);
  if (deltaCents === 0) return { baseline: b, runner: fig, deltaCents, label: 'identical' };
  const explainedBy = [line.balancerMoved && 'D30 remainder_distributed', line.carveOutFired && 'D36 place_money_carve_out'].filter(Boolean);
  return { baseline: b, runner: fig, deltaCents, label: explainedBy.length ? 'expected (D30/D36)' : 'unexplained', explainedBy };
}

export function summarize(lines) {
  const byStatus = {};
  const warningsByType = {};
  const byBucket = {};
  let crossDays = 0; let crossDisagreements = 0; let unexplained = 0;
  for (const l of lines) {
    byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
    for (const w of [...(l.blocking ?? []), ...(l.nonBlocking ?? [])]) {
      const k = `${w.type}${w.type in BLOCKING_TYPES ? ' (blocking)' : ''}`;
      warningsByType[k] = (warningsByType[k] ?? 0) + 1;
    }
    if (l.figures?.graded && l.completeness) {
      const b = (byBucket[l.completeness] ??= { days: 0, wageredCents: 0, effectiveWageredCents: 0, returnedCents: 0, plCents: 0 });
      b.days++; b.wageredCents += l.figures.wageredCents; b.effectiveWageredCents += l.figures.effectiveWageredCents;
      b.returnedCents += l.figures.returnedCents; b.plCents += l.figures.plCents;
    }
    if (l.crossSource) { crossDays++; crossDisagreements += l.crossSource.disagreements?.length ?? 0; }
    if (l.regression?.label === 'unexplained') unexplained++;
  }
  return { days: lines.length, byStatus, warningsByType, plByBucket: byBucket, crossSource: { days: crossDays, disagreements: crossDisagreements }, unexplainedRegressions: unexplained };
}

// ---------- the report (docs/backfill/<meet>.md + .json sidecar) ----------

export const usd = (c) => (c == null ? '-' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2)}`);

/** One meet's lines merged over runs: a skipped day keeps the line from the run that saved it. */
export function mergeLines(prior, current) {
  const byDate = new Map((prior ?? []).map((l) => [l.date, l]));
  for (const l of current) {
    const old = byDate.get(l.date);
    byDate.set(l.date, l.status === 'skipped' && old && old.status !== 'skipped' ? { ...old, lastSeenRunId: l.correlationId, lastSeenStatus: 'skipped' } : l);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function renderReport(meet, report, lines) {
  const s = summarize(lines);
  const warn = (l) => `${(l.blocking ?? []).length} / ${(l.nonBlocking ?? []).length}`;
  const cross = (l) => (l.crossSource ? `${l.crossSource.agree}/${l.crossSource.tickets}${l.crossSource.disagreements?.length ? ' DISAGREE' : ' ok'}` : '-');
  const pct = (num, den) => (den ? `${((num / den) * 100).toFixed(1)}%` : '-');
  const out = [];
  out.push(`# Backfill report: ${meet}`, '');
  out.push(`Last run ${report.runId} (${report.startedAt} .. ${report.finishedAt}), range ${report.from}..${report.to}, engine ${report.engineVersion}, template ${report.template}, bankroll ${usd(report.bankrollCents)} / min ${usd(report.perRaceMinCents)}${report.dryRun ? ' - DRY RUN' : ''}${report.regenerate ? ' - regenerate' : ''}.`, '');
  out.push('## Summary', '');
  out.push(`- Days: ${s.days} - ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push(`- Cross-source (dmtc vs Equibase): ${s.crossSource.days} day(s) checked, ${s.crossSource.disagreements} ticket disagreement(s)`);
  out.push(`- Regression line: ${s.unexplainedRegressions} unexplained difference(s)`);
  if (report.halted) out.push(`- HALTED: ${report.halted}`);
  if (report.missingCalendars?.length) out.push(`- Calendars NOT archived: ${report.missingCalendars.join(', ')} (fetch with --what calendar)`);
  out.push('', '### Warnings by type', '');
  if (Object.keys(s.warningsByType).length === 0) out.push('none');
  else for (const [k, v] of Object.entries(s.warningsByType).sort()) out.push(`- ${k}: ${v}`);
  out.push('', '### P/L by completeness bucket (never pooled)', '');
  out.push('| bucket | days | wagered | effective | returned | P/L | ROI | eff. ROI |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, b] of Object.entries(s.plByBucket)) {
    out.push(`| ${k} | ${b.days} | ${usd(b.wageredCents)} | ${usd(b.effectiveWageredCents)} | ${usd(b.returnedCents)} | ${usd(b.plCents)} | ${pct(b.plCents, b.wageredCents)} | ${pct(b.plCents, b.effectiveWageredCents)} |`);
  }
  out.push('', '## Days', '');
  out.push('| date | status | races cal/parsed/results | warnings block/non | completeness | results | cross | engine | wagered | effective | returned | P/L | note |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const l of lines) {
    const f = l.figures;
    out.push(`| ${l.date} | ${l.status} | ${l.calendarRaces ?? '-'}/${l.parsedRaces ?? '-'}/${l.resultsRaces ?? '-'} | ${warn(l)} | ${l.completeness ?? '-'} | ${l.resultsSource ?? '-'} | ${cross(l)} | ${l.engineVersion ?? '-'} | ${usd(f?.wageredCents)} | ${usd(f?.effectiveWageredCents)} | ${usd(f?.returnedCents)} | ${usd(f?.plCents)} | ${(l.note ?? '').replace(/[|]/g, '/')} |`);
  }
  const reg = lines.filter((l) => l.regression);
  if (reg.length) {
    out.push('', '## Regression line (previously hand-graded days)', '');
    out.push('| date | hand-graded P/L | runner P/L | difference | label |', '| --- | --- | --- | --- | --- |');
    for (const l of reg) {
      const r = l.regression;
      out.push(`| ${l.date} | ${usd(r.baseline?.plCents)} | ${usd(r.runner?.plCents)} | ${r.deltaCents == null ? '-' : usd(r.deltaCents)} | ${r.label}${r.explainedBy?.length ? ` (${r.explainedBy.join(', ')})` : ''} |`);
    }
  }
  const decided = lines.filter((l) => l.queueId != null);
  if (decided.length) {
    out.push('', '## Backfill queue', '');
    for (const l of decided) out.push(`- ${l.date}: ${l.status} - ${l.note ?? ''}${(l.blocking ?? []).length ? ` [${l.blocking.map((w) => w.type).join(', ')}]` : ''}`);
  }
  out.push('');
  return out.join('\n');
}

/** Write one report per meet touched by the run, merging with the meet's sidecar from earlier runs. Returns the paths. */
export function writeReports(report, { docsDir = DEFAULT_DOCS_DIR } = {}) {
  const byMeet = new Map();
  for (const l of report.lines) {
    const k = l.meet ?? 'unassigned';
    if (!byMeet.has(k)) byMeet.set(k, []);
    byMeet.get(k).push(l);
  }
  fs.mkdirSync(docsDir, { recursive: true });
  const written = [];
  for (const [meet, lines] of byMeet) {
    const json = path.join(docsDir, `${meet}.json`);
    const prior = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
    const merged = mergeLines(prior?.lines, lines);
    const md = path.join(docsDir, `${meet}.md`);
    fs.writeFileSync(json, JSON.stringify({ meet, lastRun: { ...report, lines: undefined }, lines: merged }, null, 2) + '\n');
    fs.writeFileSync(md, renderReport(meet, report, merged));
    written.push(md, json);
  }
  return written;
}

// ---------- the queue API ----------

export const backfillRouter = express.Router();
const rowOut = (r, full = false) => ({
  id: r.id, track: r.track, date: r.date, meet: r.meet, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
  decisionNote: r.decision_note, correlationId: r.correlation_id, blocking: JSON.parse(r.blocking), warnings: JSON.parse(r.warnings),
  outcome: r.outcome ? JSON.parse(r.outcome) : null,
  ...(full ? { payload: JSON.parse(r.payload), results: r.results ? JSON.parse(r.results) : null, chart: r.chart ? JSON.parse(r.chart) : null } : {}),
});

backfillRouter.get('/backfill/queue', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM backfill_queue ORDER BY date, id').all().map((r) => rowOut(r));
  res.json({ pending: rows.filter((r) => r.status === 'pending'), decided: rows.filter((r) => r.status !== 'pending') });
});

backfillRouter.get('/backfill/queue/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM backfill_queue WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'No such queue item.' });
  res.json(rowOut(row, true));
});

// Confirm = policy A's human click: the read-only preview was shown, the
// user accepts it, and the SAME commit an auto-save runs writes the day.
backfillRouter.post('/backfill/queue/:id/confirm', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM backfill_queue WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'No such queue item.' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Already ${row.status}.` });
  if (liveDay(db, row.date)) return res.status(409).json({ error: `A race day for ${row.date} already exists; reject this item instead.` });
  const out = commitDay(db, { payload: JSON.parse(row.payload), results: JSON.parse(row.results), chart: row.chart ? JSON.parse(row.chart) : null }, row.correlation_id);
  const note = String(req.body?.note ?? '').trim() || null;
  db.prepare("UPDATE backfill_queue SET status = 'confirmed', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), decision_note = ?, outcome = ? WHERE id = ?")
    .run(note, JSON.stringify(out), row.id);
  const ev = { correlationId: row.correlation_id, queueId: row.id, date: row.date, meet: row.meet, decision: 'confirmed', note, raceDayId: out.raceDayId, cardId: out.cardId, blocking: JSON.parse(row.blocking).map((w) => w.type) };
  traceLog.info('backfill_queue_decided', ev);
  log.info('backfill_queue_decided', ev);
  res.status(201).json({ ok: true, ...out });
});

backfillRouter.post('/backfill/queue/:id/reject', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM backfill_queue WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'No such queue item.' });
  if (row.status !== 'pending') return res.status(409).json({ error: `Already ${row.status}.` });
  const note = String(req.body?.note ?? '').trim();
  if (!note) return res.status(400).json({ error: 'A note saying why is required to reject.' });
  db.prepare("UPDATE backfill_queue SET status = 'rejected', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), decision_note = ? WHERE id = ?").run(note, row.id);
  const ev = { correlationId: row.correlation_id, queueId: row.id, date: row.date, meet: row.meet, decision: 'rejected', note, blocking: JSON.parse(row.blocking).map((w) => w.type) };
  traceLog.info('backfill_queue_decided', ev);
  log.info('backfill_queue_decided', ev);
  res.json({ ok: true });
});
