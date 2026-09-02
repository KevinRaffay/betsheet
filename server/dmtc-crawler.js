// dmtc.com crawler + raw archive (D41), on the D07 framework's guards.
//
// Indexes race days from the track's calendar pages (never by enumerating
// dates), then archives each day's program PDF, ML sheet PDF and results
// HTML under data/raw/DMR/YYYYMMDD/ with a manifest (url, fetched_at,
// sha256, bytes, http status, etag / last-modified). Parsers run from the
// archive only - re-parsing is free and offline.
//
// Polite by construction: robots.txt first (a disallowed path disables that
// artifact kind for the run and the audit says so - never worked around,
// invariant 6); one request at a time, >= 1s apart; an identifying
// User-Agent (BETSHEET_CONTACT names the human); conditional requests on
// --refresh (ETag / If-Modified-Since); an archived file is never fetched
// again without --refresh; 429 / 5xx back off and, after three straight
// failures, end the run. Every request lands in the fetch audit (invariant
// 11) - the fetch-audit stream always, fetch_attempts when the race day
// already exists (under that day's correlation id).
//
// The results page links to Equibase's chart embed. It is NEVER followed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_ORIGIN = 'https://www.dmtc.com';
export const DEFAULT_RAW_DIR = path.join(ROOT, 'data', 'raw');
export const TRACK_CODE = 'DMR';
export const KINDS = ['program', 'ml', 'results'];

export { userAgent } from './consensus.js';
import { userAgent } from './consensus.js';

/** DMR-<year>-summer (Jul-Sep) / DMR-<year>-fall (Oct-Dec); null otherwise. */
export function meetFor(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month >= 7 && month <= 9) return `${TRACK_CODE}-${m[1]}-summer`;
  if (month >= 10 && month <= 12) return `${TRACK_CODE}-${m[1]}-fall`;
  return null;
}

/** meetFor() for a Del Mar day (any spelling of the track), null for other tracks - until D35 canonicalizes track codes. */
export function meetForDay(track, date) {
  const key = String(track ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return key === 'DELMAR' || key === 'DMR' ? meetFor(date) : null;
}

export const calendarUrl = (origin, year, month) => `${origin}/racing/${year}/${String(month).padStart(2, '0')}`;

/** The three artifacts for one race day (verified URL patterns, 2026-09-01). */
export function artifactUrls(origin, date) {
  const ymd = date.replace(/-/g, '');
  return {
    program: `${origin}/racing/programs/${ymd}.pdf`,
    ml: `${origin}/data/pdf/racing/morning-line/${ymd}.pdf`,
    results: `${origin}/racing/results/${date}`,
  };
}

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#8217;/g, "'").replace(/\s+/g, ' ').trim();

/**
 * The calendar page -> its race days. Cells with class calendar-live-racing
 * carry the day number, "N Races", stakes spans and a Results (past) or
 * Program (upcoming) link; dark days have no such cell.
 */
export function parseCalendar(html, { year, month }) {
  const days = [];
  const cellRe = /<td class="calendar-month-day calendar-live-racing">([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(cellRe)) {
    const cell = m[1];
    const dateDiv = cell.match(/<div class="calendar-date">([\s\S]*?)<\/div>/);
    const dayNum = dateDiv ? Number(strip(dateDiv[1]).replace(/^[A-Za-z]+,\s*/, '').replace(/(st|nd|rd|th)$/, '')) : NaN;
    if (!Number.isInteger(dayNum)) continue;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const races = cell.match(/(\d+)\s+Races/);
    const stakes = [...cell.matchAll(/<span class="text-warning">([\s\S]*?)<\/span>/g)].map((s) => strip(s[1])).filter(Boolean);
    const firstPost = cell.match(/First Post:<\/b>\s*([^<]+)/);
    const results = cell.match(/href="([^"]*\/racing\/results\/[0-9-]+)"/);
    const program = cell.match(/href="([^"]*\/racing\/programs\/\d{8}\.pdf)"/);
    days.push({
      date, meet: meetFor(date),
      races: races ? Number(races[1]) : null,
      stakes,
      firstPost: firstPost ? firstPost[1].trim() : null,
      resultsUrl: results ? results[1] : null,
      programUrl: program ? program[1] : null,
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Months (year, month) spanned by an inclusive date range. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function dayDir(rawDir, date) { return path.join(rawDir, TRACK_CODE, date.replace(/-/g, '')); }
export function calendarPath(rawDir, year, month) { return path.join(rawDir, TRACK_CODE, 'calendar', `${year}-${String(month).padStart(2, '0')}.html`); }

export function readManifest(rawDir, date) {
  const p = path.join(dayDir(rawDir, date), 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
export function writeManifest(rawDir, date, manifest) {
  const dir = dayDir(rawDir, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
export const artifactFile = { program: 'program.pdf', ml: 'ml.pdf', results: 'results.html' };

// ---------- the index: calendar first, then the committed meet-dates table ----------

import { recordAttempt, robotsDisallows, upsertSource } from './consensus.js';
import { getLogger } from './logging.js';
import { parseDmtcResults } from '../shared/dmtc-results-parser.js';

export const DEFAULT_MEETS_DIR = path.join(ROOT, 'data', 'meets');
/** A probe window is bounded by construction: a meet never runs longer than this. */
export const MAX_PROBE_DAYS = 92;

export function meetTablePath(meetsDir, meet) { return path.join(meetsDir, `${meet}.json`); }

/** Every committed meet-dates table (data/meets/*.json). */
export function readMeetTables(meetsDir = DEFAULT_MEETS_DIR) {
  if (!fs.existsSync(meetsDir)) return [];
  return fs.readdirSync(meetsDir).filter((f) => /^DMR-\d{4}-(summer|fall)\.json$/.test(f)).sort()
    .map((f) => ({ file: path.join(meetsDir, f), ...JSON.parse(fs.readFileSync(path.join(meetsDir, f), 'utf8')) }));
}

/**
 * Race days for [from, to], in date order. Index source, in order (user
 * decision 2026-09-02): (1) the archived track calendar for the month when
 * it carries race days with counts; (2) the committed meet-dates table
 * (data/meets/<meet>.json, built once by probeMeetWindow) when the archived
 * calendar for that month is dark - dmtc.com renders past seasons with no
 * racing at all. A month with no archived calendar is `missingCalendars`
 * (fetch it first); a dark month with no table is `missingIndex`. Never a
 * date that neither source names.
 */
export function indexRaceDays({ rawDir = DEFAULT_RAW_DIR, meetsDir = DEFAULT_MEETS_DIR, from = '0000-00-00', to = '9999-12-31' } = {}) {
  const calDir = path.join(rawDir, TRACK_CODE, 'calendar');
  const archived = fs.existsSync(calDir) ? fs.readdirSync(calDir).map((f) => f.match(/^(\d{4})-(\d{2})\.html$/)).filter(Boolean).map((m) => `${m[1]}-${m[2]}`).sort() : [];
  const inRange = (m) => m >= from.slice(0, 7) && m <= to.slice(0, 7);
  const months = archived.filter(inRange);
  const wanted = from === '0000-00-00' ? months : monthsBetween(from, to).map(({ year, month }) => `${year}-${String(month).padStart(2, '0')}`);
  const tables = readMeetTables(meetsDir);
  const out = { days: [], months, missingCalendars: wanted.filter((m) => !archived.includes(m)), darkCalendars: [], tablesUsed: [], missingIndex: [] };
  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    const cal = parseCalendar(fs.readFileSync(path.join(calDir, `${key}.html`), 'utf8'), { year: y, month: m });
    if (cal.length > 0) { out.days.push(...cal.map((d) => ({ ...d, indexSource: 'calendar' }))); continue; }
    out.darkCalendars.push(key);
    const fromTables = [];
    for (const t of tables) {
      for (const d of t.days ?? []) {
        if (!d.raceDay || d.date.slice(0, 7) !== key) continue;
        fromTables.push({ date: d.date, meet: t.meet ?? meetFor(d.date), races: d.races ?? null, stakes: [], firstPost: null, resultsUrl: d.url ?? null, programUrl: null, indexSource: 'meet-table', indexFile: t.file });
        if (!out.tablesUsed.includes(t.file)) out.tablesUsed.push(t.file);
      }
    }
    if (fromTables.length === 0) out.missingIndex.push(key);
    out.days.push(...fromTables);
  }
  out.days = out.days.filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ---------- the polite client every entry point shares ----------

const fetchLog = getLogger('fetch-audit');
const SOURCE = { name: 'dmtc.com crawler', kind: 'program' };
const MAX_STRIKES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newReport(extra = {}) {
  return { calendars: [], missingCalendars: [], darkCalendars: [], missingIndex: [], days: [], planned: [], events: [], performed: 0, archived: 0, skipped: 0, blocked: 0, errors: 0, haltedReason: null, ...extra };
}

/**
 * One polite HTTP client: robots per URL (a disallowed kind is disabled for
 * the run), >= minGapMs between requests, identifying User-Agent,
 * conditional headers on refresh, 429/5xx backoff, halt after MAX_STRIKES
 * straight failures. EVERY request lands in the fetch-audit stream (and in
 * fetch_attempts once the race day exists). Shared by crawl() and
 * probeMeetWindow() so a probe is as polite and as audited as a fetch.
 */
function politeClient({ report, db = null, correlationId = null, refresh = false, minGapMs = 1000, onEvent = () => {} }) {
  const disabledKinds = new Set();
  let lastRequestAt = 0;
  let strikes = 0;
  const sourceId = db ? upsertSource(db, SOURCE) : null;
  const dayRow = (date) => (db
    ? db.prepare(`SELECT id, correlation_id FROM race_days WHERE date = ? AND deleted_at IS NULL
        AND lower(replace(track, ' ', '')) = 'delmar'`).get(date)
    : null);
  const event = (e) => { report.events.push(e); onEvent(e); };
  const audit = (date, kind, url, outcome, extra = {}) => {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? dayRow(date) : null;
    const cid = day?.correlation_id ?? correlationId;
    fetchLog.info('fetch_attempt', { correlationId: cid, source: SOURCE.name, kind, date, url, outcome, ...extra });
    if (day && db) {
      const mapped = ['ok', 'http_error', 'network_error', 'blocked'].includes(outcome) ? outcome : 'http_error';
      recordAttempt(db, { raceDayId: day.id, sourceId, correlationId: cid, url, outcome: mapped, httpStatus: extra.httpStatus ?? null, bytes: extra.bytes ?? null, fallbackReason: extra.detail ?? null });
    }
  };
  // Returns { status, body, headers } or null (blocked / halted).
  async function request(date, kind, url, prior) {
    if (disabledKinds.has(kind)) { event({ date, kind, url, outcome: 'blocked', detail: 'kind disabled by robots.txt for this run' }); report.blocked++; return null; }
    if (await robotsDisallows(url)) {
      disabledKinds.add(kind);
      report.blocked++;
      event({ date, kind, url, outcome: 'blocked', detail: 'disallowed by robots.txt - manual upload stays the way in' });
      audit(date, kind, url, 'blocked', { detail: 'disallowed by robots.txt' });
      return null;
    }
    const headers = { 'user-agent': userAgent() };
    if (refresh && prior?.etag) headers['if-none-match'] = prior.etag;
    if (refresh && prior?.last_modified) headers['if-modified-since'] = prior.last_modified;
    for (let attempt = 1; attempt <= MAX_STRIKES; attempt++) {
      const wait = Math.max(0, minGapMs - (Date.now() - lastRequestAt));
      if (wait) await sleep(wait);
      lastRequestAt = Date.now();
      report.performed++;
      let res;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30000);
        res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' }).finally(() => clearTimeout(timer));
      } catch (err) {
        strikes++; report.errors++;
        event({ date, kind, url, outcome: 'network_error', detail: String(err?.message ?? err) });
        audit(date, kind, url, 'network_error', { detail: String(err?.message ?? err) });
        if (strikes >= MAX_STRIKES) { report.haltedReason = `backing off after ${MAX_STRIKES} straight failures (network) at ${url}`; return null; }
        await sleep(minGapMs * attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        strikes++; report.errors++;
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        event({ date, kind, url, outcome: 'backoff', httpStatus: res.status, detail: `HTTP ${res.status}, attempt ${attempt}` });
        audit(date, kind, url, 'http_error', { httpStatus: res.status, detail: `HTTP ${res.status} (attempt ${attempt})` });
        if (strikes >= MAX_STRIKES) { report.haltedReason = `backing off after ${MAX_STRIKES} straight failures (HTTP ${res.status}) at ${url}`; return null; }
        await sleep(Math.max(retryAfter * 1000, minGapMs * attempt));
        continue;
      }
      strikes = 0;
      const body = res.status === 304 ? null : Buffer.from(await res.arrayBuffer());
      return { status: res.status, body, headers: res.headers };
    }
    return null;
  }
  // robots.txt is the first request of a run and counts toward the spacing.
  const start = async (origin) => { await robotsDisallows(origin + '/'); lastRequestAt = Date.now(); };
  return { request, event, audit, start };
}

const archivedArtifact = (url, body, headers, now) => ({
  url, fetched_at: now, sha256: sha256(body), bytes: body.length, http_status: 200,
  etag: headers.get('etag'), last_modified: headers.get('last-modified'), content_type: headers.get('content-type'),
});

// ---------- the window probe: builds a meet-dates table once ----------

/**
 * Bounded probe of a PUBLISHED meet window [from, to] (both inside `meet`,
 * at most MAX_PROBE_DAYS): one results-page request per date, polite rate,
 * every request audited. A 200 whose page parses to >= 1 race is a race
 * day (its results page is archived on the spot, with a manifest); a 404
 * or a page with no races is a dark day. Writes data/meets/<meet>.json
 * with every date's evidence (status, race count, url) only when the
 * whole window was probed. Blind enumeration outside a published window
 * stays prohibited: the window is an input the caller must justify in
 * `source`, and the table records it.
 */
export async function probeMeetWindow({
  meet, from, to, source, origin = DEFAULT_ORIGIN, rawDir = DEFAULT_RAW_DIR, meetsDir = DEFAULT_MEETS_DIR,
  db = null, correlationId = null, minGapMs = 1000, dryRun = false, onEvent = () => {},
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') || to < from) throw new Error('probe: from/to must be yyyy-mm-dd with from <= to');
  if (!meet || meetFor(from) !== meet || meetFor(to) !== meet) throw new Error(`probe: the window ${from}..${to} must lie inside the meet ${meet} (${meetFor(from)} .. ${meetFor(to)})`);
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (span > MAX_PROBE_DAYS) throw new Error(`probe: ${span} days exceeds the ${MAX_PROBE_DAYS}-day bound of one meet window`);
  if (!String(source ?? '').trim()) throw new Error('probe: --source must say where the published window comes from');
  const dates = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
  const report = newReport({ dryRun, meet, from, to, source, dates: dates.length, probed: [], raceDays: 0, darkDays: 0, tablePath: meetTablePath(meetsDir, meet) });
  if (dryRun) { for (const d of dates) report.events.push({ date: d, kind: 'probe', url: artifactUrls(origin, d).results, outcome: 'planned' }); report.events.forEach(onEvent); return report; }
  const client = politeClient({ report, db, correlationId, minGapMs, onEvent });
  const startedAt = new Date().toISOString();
  await client.start(origin);
  for (const date of dates) {
    const url = artifactUrls(origin, date).results;
    const r = await client.request(date, 'probe', url, null);
    if (report.haltedReason) return report;
    const now = new Date().toISOString();
    const entry = { date, source: 'results-page-probe', url, httpStatus: r?.status ?? null, races: null, raceDay: false, checkedAt: now };
    if (r?.status === 200) {
      const html = r.body.toString('utf8');
      const parsed = parseDmtcResults(html);
      if (parsed.races.length > 0) {
        entry.raceDay = true; entry.races = parsed.races.length; report.raceDays++;
        const manifest = readManifest(rawDir, date) ?? { track: TRACK_CODE, date, meet, calendar: null, artifacts: {} };
        manifest.meet = meet;
        manifest.index = { source: 'meet-table', races: entry.races, probedAt: now };
        manifest.artifacts.results = archivedArtifact(url, r.body, r.headers, now);
        fs.mkdirSync(dayDir(rawDir, date), { recursive: true });
        fs.writeFileSync(path.join(dayDir(rawDir, date), artifactFile.results), r.body);
        writeManifest(rawDir, date, manifest);
        report.archived++;
        client.event({ date, kind: 'probe', url, outcome: 'race_day', httpStatus: 200, bytes: r.body.length, detail: `${entry.races} races - results archived` });
        client.audit(date, 'probe', url, 'ok', { httpStatus: 200, bytes: r.body.length, detail: `race day, ${entry.races} races` });
      } else {
        report.darkDays++;
        client.event({ date, kind: 'probe', url, outcome: 'dark', httpStatus: 200, detail: 'page carries no races' });
        client.audit(date, 'probe', url, 'ok', { httpStatus: 200, bytes: r.body.length, detail: 'dark day (no races on the page)' });
      }
    } else if (r) {
      report.darkDays++;
      client.event({ date, kind: 'probe', url, outcome: 'dark', httpStatus: r.status, detail: `HTTP ${r.status}` });
      client.audit(date, 'probe', url, 'http_error', { httpStatus: r.status, detail: 'dark day (no results page)' });
    } else {
      entry.httpStatus = null; entry.blocked = true;
    }
    report.probed.push(entry);
  }
  const table = {
    meet, track: TRACK_CODE, window: { from, to, source },
    probe: { correlationId, startedAt, finishedAt: new Date().toISOString(), requests: report.performed, userAgent: userAgent(), origin },
    days: report.probed,
  };
  fs.mkdirSync(meetsDir, { recursive: true });
  fs.writeFileSync(report.tablePath, JSON.stringify(table, null, 2) + '\n');
  return report;
}

// ---------- the crawl ----------

/**
 * Crawl [from, to]. `what` lists artifact kinds ('program', 'ml',
 * 'results') and/or 'calendar'. Calendars are always ensured first (they
 * are the index); where an archived calendar month is dark the committed
 * meet-dates table indexes it (see indexRaceDays). A dry run reads only
 * ARCHIVED calendars and tables and reports the months still to fetch.
 * Returns the report; every request is an event.
 */
export async function crawl({
  from, to, what = KINDS, refresh = false, dryRun = false, origin = DEFAULT_ORIGIN, rawDir = DEFAULT_RAW_DIR, meetsDir = DEFAULT_MEETS_DIR,
  db = null, correlationId = null, minGapMs = 1000, onEvent = () => {},
}) {
  const report = newReport({ dryRun });
  const client = politeClient({ report, db, correlationId, refresh, minGapMs, onEvent });
  const { request, event, audit } = client;
  if (!dryRun) await client.start(origin);

  // ----- calendars (the index) -----
  const wantKinds = what.filter((k) => KINDS.includes(k));
  const refreshCalendars = refresh && what.includes('calendar');
  for (const { year, month } of monthsBetween(from, to)) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const file = calendarPath(rawDir, year, month);
    const exists = fs.existsSync(file);
    if (exists && !refreshCalendars) { report.calendars.push({ month: key, archived: true, fetched: false }); continue; }
    if (dryRun) { report.missingCalendars.push(key); event({ date: key, kind: 'calendar', url: calendarUrl(origin, year, month), outcome: 'planned', detail: exists ? 'refresh' : 'not archived' }); continue; }
    const url = calendarUrl(origin, year, month);
    const r = await request(key, 'calendar', url, null);
    if (report.haltedReason) return report;
    if (!r) { report.missingCalendars.push(key); continue; }
    if (r.status === 200) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, r.body);
      report.calendars.push({ month: key, archived: true, fetched: true });
      report.archived++;
      event({ date: key, kind: 'calendar', url, outcome: 'archived', httpStatus: 200, bytes: r.body.length });
      audit(key, 'calendar', url, 'ok', { httpStatus: 200, bytes: r.body.length });
    } else {
      report.errors++; report.missingCalendars.push(key);
      event({ date: key, kind: 'calendar', url, outcome: 'http_error', httpStatus: r.status });
      audit(key, 'calendar', url, 'http_error', { httpStatus: r.status });
    }
  }
  if (what.length === 1 && what[0] === 'calendar') return report;

  // ----- the plan: calendar days, or the meet table where the calendar is dark -----
  const index = indexRaceDays({ rawDir, meetsDir, from, to });
  report.darkCalendars = index.darkCalendars;
  report.missingIndex = index.missingIndex;
  for (const key of index.missingIndex) event({ date: key, kind: 'index', url: null, outcome: 'missing', detail: 'calendar is dark and no meet-dates table covers it - run dmtc-probe for the published meet window' });
  for (const day of index.days) {
    report.days.push(day);
    const manifest = readManifest(rawDir, day.date) ?? { track: TRACK_CODE, date: day.date, meet: day.meet, calendar: null, artifacts: {} };
    manifest.meet = day.meet;
    if (day.indexSource === 'calendar') manifest.calendar = { races: day.races, stakes: day.stakes, firstPost: day.firstPost };
    else { manifest.calendar = null; manifest.index = { ...(manifest.index ?? {}), source: 'meet-table', races: day.races ?? null, file: path.basename(day.indexFile ?? '') }; }
    const urls = artifactUrls(origin, day.date);
    for (const kind of wantKinds) {
      const prior = manifest.artifacts[kind];
      const file = path.join(dayDir(rawDir, day.date), artifactFile[kind]);
      if (prior?.sha256 && fs.existsSync(file) && !refresh) { report.skipped++; event({ date: day.date, kind, url: urls[kind], outcome: 'skipped', detail: 'archived' }); continue; }
      report.planned.push({ date: day.date, kind, url: urls[kind], prior: prior ?? null, manifest, file });
    }
    if (!dryRun) writeManifest(rawDir, day.date, manifest);
  }
  if (dryRun) { for (const p of report.planned) event({ date: p.date, kind: p.kind, url: p.url, outcome: 'planned' }); return report; }

  // ----- the requests -----
  for (const p of report.planned) {
    const r = await request(p.date, p.kind, p.url, p.prior);
    if (report.haltedReason) return report;
    if (!r) continue;
    const now = new Date().toISOString();
    if (r.status === 304) {
      p.manifest.artifacts[p.kind] = { ...p.prior, checked_at: now };
      event({ date: p.date, kind: p.kind, url: p.url, outcome: 'not_modified', httpStatus: 304 });
      audit(p.date, p.kind, p.url, 'ok', { httpStatus: 304 });
    } else if (r.status === 200) {
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      fs.writeFileSync(p.file, r.body);
      p.manifest.artifacts[p.kind] = archivedArtifact(p.url, r.body, r.headers, now);
      report.archived++;
      event({ date: p.date, kind: p.kind, url: p.url, outcome: 'archived', httpStatus: 200, bytes: r.body.length });
      audit(p.date, p.kind, p.url, 'ok', { httpStatus: 200, bytes: r.body.length });
    } else {
      report.errors++;
      p.manifest.artifacts[p.kind] = { ...(p.prior ?? {}), url: p.url, checked_at: now, http_status: r.status };
      event({ date: p.date, kind: p.kind, url: p.url, outcome: 'http_error', httpStatus: r.status });
      audit(p.date, p.kind, p.url, 'http_error', { httpStatus: r.status });
    }
    writeManifest(rawDir, p.date, p.manifest);
  }
  return report;
}
