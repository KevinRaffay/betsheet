// Verification for the dmtc.com crawler (D41) - exits non-zero on any
// failure. Run: npm run check-dmtc-fetch
//
// Nothing here touches the network: a stub site on a local port serves
// robots.txt, calendar pages (the REAL Aug + Sep 2026 pages as fixtures),
// program / ML / results artifacts with ETags, a path robots disallows, a
// once-flaky 429 endpoint and a 404. Asserts the calendar goldens, the
// plan, dry run = zero requests, >= 1s spacing, the identifying
// User-Agent, conditional requests + 304, manifest sha256/bytes, the
// disallowed path NEVER requested and audited as blocked, backoff, no
// re-download without --refresh, and the audit rows under the race day's
// correlation id once the day exists.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-dmtccheck-'));
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_CONTACT = 'check@example.test';

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

const crawler = await import('../server/dmtc-crawler.js');
const { parseCalendar, meetFor, monthsBetween, artifactUrls, crawl, readManifest, userAgent } = crawler;
const { openDb } = await import('../server/db.js');

console.log('-- calendar parser (real pages) --');
const aug = fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc/calendar-2026-08.html'), 'utf8');
const sep = fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc/calendar-2026-09.html'), 'utf8');
const augDays = parseCalendar(aug, { year: 2026, month: 8 });
const sepDays = parseCalendar(sep, { year: 2026, month: 9 });
const augGolden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/dmtc/calendar-2026-08.expected.json'), 'utf8'));
check('golden: calendar-2026-08', firstDiff(augDays, augGolden) === null, firstDiff(augDays, augGolden) ?? '');
check('August 2026: 18 race days, Thu-Sun, none on a Monday-Wednesday', augDays.length === 18 &&
  augDays.every((d) => [0, 4, 5, 6].includes(new Date(d.date + 'T12:00:00Z').getUTCDay())), augDays.map((d) => d.date.slice(8)).join(','));
check('race counts and stakes read off the cells (08-30: 10 races, Torrey Pines; 08-01: 11 races, two stakes)', (() => {
  const d30 = augDays.find((d) => d.date === '2026-08-30'); const d1 = augDays.find((d) => d.date === '2026-08-01');
  return d30?.races === 10 && /TORREY PINES/.test(d30.stakes[0]) && d1?.races === 11 && d1.stakes.length === 2 && d30.firstPost === '2 PM';
})());
check('past days link Results, upcoming days link the Program PDF, never both',
  augDays.every((d) => d.resultsUrl && !d.programUrl) && sepDays.some((d) => d.programUrl && !d.resultsUrl) && sepDays.find((d) => d.date === '2026-09-03')?.programUrl.endsWith('/racing/programs/20260903.pdf'));
check('every August day is in the summer meet; meets by month', augDays.every((d) => d.meet === 'DMR-2026-summer') &&
  meetFor('2025-11-02') === 'DMR-2025-fall' && meetFor('2026-03-01') === null);
check('months between two dates', JSON.stringify(monthsBetween('2025-11-15', '2026-02-03')) === '[{"year":2025,"month":11},{"year":2025,"month":12},{"year":2026,"month":1},{"year":2026,"month":2}]');
check('artifact URLs follow the verified patterns', (() => {
  const u = artifactUrls('https://www.dmtc.com', '2026-08-16');
  return u.program === 'https://www.dmtc.com/racing/programs/20260816.pdf' && u.ml === 'https://www.dmtc.com/data/pdf/racing/morning-line/20260816.pdf' && u.results === 'https://www.dmtc.com/racing/results/2026-08-16';
})());
check('User-Agent names the tool and the contact', /^BetSheet\/0\.1 \(local handicapping tool; contact: check@example\.test\)$/.test(userAgent()));

console.log('-- crawl against a stub site --');
const STUB_PORT = 8912; const origin = `http://127.0.0.1:${STUB_PORT}`;
const rawDir = path.join(tmp, 'raw');
const hits = {}; const stamps = []; const agents = new Set(); const condHeaders = [];
const PROG = Buffer.from('%PDF-1.4 stub program 20260830'); const ETAG = '"prog-v1"';
let flaky = 0;
const stub = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1; stamps.push(Date.now()); agents.add(req.headers['user-agent'] ?? '');
  if (req.headers['if-none-match'] || req.headers['if-modified-since']) condHeaders.push([req.url, req.headers['if-none-match'] ?? null]);
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /data/pdf\n');
  if (req.url === '/racing/2026/08') return res.end(aug);
  if (req.url === '/racing/programs/20260830.pdf') {
    if (req.headers['if-none-match'] === ETAG) { res.statusCode = 304; return res.end(); }
    res.setHeader('etag', ETAG); res.setHeader('content-type', 'application/pdf'); return res.end(PROG);
  }
  if (req.url === '/racing/results/2026-08-30') return res.end('<html>results 30</html>');
  if (req.url === '/racing/results/2026-08-29') { if (flaky++ === 0) { res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end('slow down'); } return res.end('<html>results 29</html>'); }
  if (req.url === '/racing/results/2026-08-28') { res.statusCode = 503; return res.end('down'); }
  res.statusCode = 404; res.end('no');
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
const db = openDb(path.join(tmp, 'check.sqlite'));
const base = { origin, rawDir, db, correlationId: 'run-cid', minGapMs: 250 };
try {
  const dry0 = await crawl({ ...base, from: '2026-08-29', to: '2026-08-30', dryRun: true });
  check('dry run with nothing archived: zero requests, the missing calendar month named', dry0.performed === 0 && Object.keys(hits).length === 0 &&
    dry0.missingCalendars.join(',') === '2026-08' && dry0.planned.length === 0, JSON.stringify(dry0.missingCalendars));
  const run1 = await crawl({ ...base, from: '2026-08-29', to: '2026-08-30' });
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  check('run 1: calendar fetched, two days planned (program + ml + results each)', run1.calendars[0]?.fetched && run1.days.length === 2 && run1.planned.length === 6,
    JSON.stringify({ cal: run1.calendars, days: run1.days.length, planned: run1.planned.length }));
  check('archived: program 30 + results 30 + results 29 (after one 429 backoff); program 29 is a 404', run1.archived === 4 && run1.errors === 2 && !run1.haltedReason &&
    run1.events.some((e) => e.outcome === 'backoff' && e.date === '2026-08-29') && run1.events.some((e) => e.outcome === 'http_error' && e.httpStatus === 404 && e.kind === 'program'),
    JSON.stringify(run1.events.map((e) => [e.date, e.kind, e.outcome, e.httpStatus])));
  check('robots: /data/pdf is disallowed -> ML blocked for the run and NEVER requested', run1.blocked === 2 && !Object.keys(hits).some((u) => u.startsWith('/data/pdf')) &&
    run1.events.filter((e) => e.kind === 'ml').every((e) => e.outcome === 'blocked'));
  check('politeness: one request at a time, >= minGap between requests, identifying User-Agent on every one',
    gaps.every((g) => g >= 240) && [...agents].every((a) => /BetSheet\/0\.1 .*contact: check@example\.test/.test(a)), JSON.stringify(gaps));
  const man30 = readManifest(rawDir, '2026-08-30');
  check('manifest: url, fetched_at, sha256 of the bytes, bytes, status, etag; calendar facts; meet; the 404 recorded',
    man30.artifacts.program.sha256 === crypto.createHash('sha256').update(PROG).digest('hex') && man30.artifacts.program.bytes === PROG.length &&
    man30.artifacts.program.etag === ETAG && man30.artifacts.program.http_status === 200 && /^\d{4}-/.test(man30.artifacts.program.fetched_at) &&
    man30.calendar.races === 10 && man30.meet === 'DMR-2026-summer' && fs.readFileSync(path.join(rawDir, 'DMR', '20260830', 'program.pdf')).equals(PROG) &&
    man30.artifacts.results.bytes > 0 && readManifest(rawDir, '2026-08-29').artifacts.program.http_status === 404, JSON.stringify(man30));
  const before = { ...hits };
  const run2 = await crawl({ ...base, from: '2026-08-29', to: '2026-08-30' });
  check('run 2 (no --refresh): archived files skipped without a request; the calendar not re-fetched; the 404 retried', run2.skipped === 3 &&
    hits['/racing/programs/20260830.pdf'] === before['/racing/programs/20260830.pdf'] && hits['/racing/results/2026-08-30'] === before['/racing/results/2026-08-30'] &&
    hits['/racing/programs/20260829.pdf'] === before['/racing/programs/20260829.pdf'] + 1 && hits['/racing/2026/08'] === 1, JSON.stringify({ skipped: run2.skipped, hits }));
  const dry1 = await crawl({ ...base, from: '2026-08-29', to: '2026-08-30', dryRun: true });
  check('dry run after archiving: the plan is the missing program plus the two never-archived (robots-blocked) ML sheets, zero requests',
    dry1.planned.map((p) => p.kind + ':' + p.date.slice(8)).sort().join(',') === 'ml:29,ml:30,program:29' && dry1.performed === 0, JSON.stringify(dry1.planned.map((p) => [p.kind, p.date])));
  const run3 = await crawl({ ...base, from: '2026-08-30', to: '2026-08-30', what: ['program', 'results'], refresh: true });
  check('run 3 (--refresh): the conditional request carries the ETag, 304 keeps the file (not_modified), results re-fetched',
    condHeaders.some(([u, e]) => u === '/racing/programs/20260830.pdf' && e === ETAG) && run3.events.some((e) => e.outcome === 'not_modified') &&
    run3.events.some((e) => e.kind === 'results' && e.outcome === 'archived') && readManifest(rawDir, '2026-08-30').artifacts.program.sha256 === man30.artifacts.program.sha256);
  const halted = await crawl({ ...base, from: '2026-08-28', to: '2026-08-28', what: ['results'] });
  check('three straight 5xx -> the run halts and says so', /backing off after 3 straight failures \(HTTP 503\)/.test(halted.haltedReason ?? '') && hits['/racing/results/2026-08-28'] === 3, halted.haltedReason);
  db.prepare("INSERT INTO race_days (track, date, correlation_id) VALUES ('Del Mar', '2026-08-30', 'day-cid')").run();
  await crawl({ ...base, from: '2026-08-30', to: '2026-08-30', what: ['results'], refresh: true });
  const rows = db.prepare('SELECT fa.url, fa.outcome, fa.http_status, fa.correlation_id, s.name FROM fetch_attempts fa JOIN sources s ON s.id = fa.source_id').all();
  check('audit: once the race day exists, fetch_attempts rows land under the DAY\'s correlation id', rows.length === 1 && rows[0].correlation_id === 'day-cid' && rows[0].outcome === 'ok' &&
    rows[0].name === 'dmtc.com crawler' && /results\/2026-08-30$/.test(rows[0].url), JSON.stringify(rows));
  const auditLines = fs.readFileSync(path.join(tmp, 'logs', 'fetch-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.source === 'dmtc.com crawler');
  check('fetch-audit stream: every request incl. the blocked ML, under the run correlation id before the day existed',
    auditLines.some((e) => e.outcome === 'blocked' && e.kind === 'ml') && auditLines.some((e) => e.kind === 'calendar' && e.outcome === 'ok') &&
    auditLines.filter((e) => e.correlationId === 'run-cid').length >= 8 && auditLines.some((e) => e.correlationId === 'day-cid'), `lines=${auditLines.length}`);
} finally {
  stub.close(); db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}
if (failures) { console.error(`\ncheck-dmtc-fetch: ${failures} failure(s)`); process.exit(1); }
console.log('\ncheck-dmtc-fetch: all checks passed');
