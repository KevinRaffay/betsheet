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

// ---------- the runner ----------

import { recordAttempt, robotsDisallows, upsertSource } from './consensus.js';
import { getLogger } from './logging.js';

const fetchLog = getLogger('fetch-audit');
const SOURCE = { name: 'dmtc.com crawler', kind: 'program' };
const MAX_STRIKES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crawl [from, to]. `what` lists artifact kinds ('program', 'ml',
 * 'results') and/or 'calendar'. Calendars are always ensured first (they
 * are the index); a dry run reads only ARCHIVED calendars and reports the
 * months still to fetch. Returns the report; every request is an event.
 */
export async function crawl({
  from, to, what = KINDS, refresh = false, dryRun = false, origin = DEFAULT_ORIGIN, rawDir = DEFAULT_RAW_DIR,
  db = null, correlationId = null, minGapMs = 1000, onEvent = () => {},
}) {
  const report = {
    dryRun, calendars: [], missingCalendars: [], days: [], planned: [], events: [],
    performed: 0, archived: 0, skipped: 0, blocked: 0, errors: 0, haltedReason: null,
  };
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

  // One polite request: robots, spacing, UA, conditional headers, backoff.
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

  // robots.txt is the first request of the run and counts toward the
  // spacing like any other (it is cached per origin afterwards).
  if (!dryRun) { await robotsDisallows(origin + '/'); lastRequestAt = Date.now(); }

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

  // ----- the plan -----
  for (const { month } of report.calendars) {
    const [y, m] = month.split('-').map(Number);
    const html = fs.readFileSync(calendarPath(rawDir, y, m), 'utf8');
    for (const day of parseCalendar(html, { year: y, month: m })) {
      if (day.date < from || day.date > to) continue;
      report.days.push(day);
      const manifest = readManifest(rawDir, day.date) ?? { track: TRACK_CODE, date: day.date, meet: day.meet, calendar: null, artifacts: {} };
      manifest.calendar = { races: day.races, stakes: day.stakes, firstPost: day.firstPost };
      manifest.meet = day.meet;
      const urls = artifactUrls(origin, day.date);
      for (const kind of wantKinds) {
        const prior = manifest.artifacts[kind];
        const file = path.join(dayDir(rawDir, day.date), artifactFile[kind]);
        if (prior?.sha256 && fs.existsSync(file) && !refresh) { report.skipped++; event({ date: day.date, kind, url: urls[kind], outcome: 'skipped', detail: 'archived' }); continue; }
        report.planned.push({ date: day.date, kind, url: urls[kind], prior: prior ?? null, manifest, file });
      }
      if (!dryRun) writeManifest(rawDir, day.date, manifest);
    }
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
      p.manifest.artifacts[p.kind] = {
        url: p.url, fetched_at: now, sha256: sha256(r.body), bytes: r.body.length, http_status: 200,
        etag: r.headers.get('etag'), last_modified: r.headers.get('last-modified'), content_type: r.headers.get('content-type'),
      };
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
