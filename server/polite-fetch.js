// Polite automated fetching and the fetch audit trail.
//
// Relocated verbatim out of server/consensus.js by D112, which deleted the
// consensus runner these helpers were written alongside. They are NOT
// consensus machinery - they are the HTTP manners and the audit record every
// automated request in this codebase goes through, and two callers the pivot
// has not reached yet still depend on them: server/dmtc-crawler.js (D41) and
// server/ingest.js's ML-sheet fetch route (D40).
//
// Rules this module owns (invariants 6 and 11):
//   * robots.txt is checked before every automated fetch; a disallowed path
//     is recorded as 'blocked' and never requested.
//   * Every attempt - success, failure, skip, manual - lands in BOTH the
//     fetch_attempts table (for the UI) and the fetch-audit log stream. A
//     source going quiet is always visible.
//
// The backoff rule (`recentFailures`) went with the runner: it existed to
// stop the consensus loop retrying a dead source forever, and the crawler
// carries its own three-strikes halt. So did `trackKey`, whose job
// shared/track-codes.js took over at D35.

import { getDb } from './db.js';
import { getLogger } from './logging.js';

const log = getLogger('fetch-audit');

const FETCH_TIMEOUT_MS = 15000;
// One identifying User-Agent for every automated request (D07 sources and
// the D41 crawler alike); BETSHEET_CONTACT names the human behind it.
export function userAgent(contact = process.env.BETSHEET_CONTACT) {
  return `BetSheet/0.1 (local handicapping tool; ${contact ? `contact: ${contact}` : 'set BETSHEET_CONTACT'})`;
}

// ---------- robots.txt ----------

const robotsCache = new Map(); // origin -> { rules: [prefixes], at: ms }

export async function robotsDisallows(url) {
  const { origin, pathname } = new URL(url);
  let entry = robotsCache.get(origin);
  if (!entry || Date.now() - entry.at > 60 * 60 * 1000) {
    let rules = [];
    try {
      const res = await fetchWithTimeout(`${origin}/robots.txt`);
      if (res.ok) rules = parseRobots(await res.text());
    } catch {
      rules = []; // unreachable robots.txt = no stated rules
    }
    entry = { rules, at: Date.now() };
    robotsCache.set(origin, entry);
  }
  return entry.rules.some((prefix) => prefix !== '' && pathname.startsWith(prefix));
}

// Minimal parser: Disallow lines from every "User-agent: *" group.
export function parseRobots(text) {
  const rules = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') applies = m[2].trim() === '*';
    else if (field === 'disallow' && applies) rules.push(m[2].trim());
  }
  return rules;
}

export function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: ctl.signal,
    headers: { 'user-agent': userAgent() },
    redirect: 'follow',
  }).finally(() => clearTimeout(timer));
}

// ---------- sources + audit ----------

export function upsertSource(db, { name, kind }) {
  const existing = db.prepare('SELECT id FROM sources WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO sources (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid;
}

// The discovery fields an attempt row carries (D53): what was scanned, what
// the fetcher looked for, and the nearest miss - the same in the DB row
// and the fetch-audit line, so an attempt is auditable from the log alone.
const DISCOVERY_FIELDS = ['sitemapUrl', 'sitemapStatus', 'candidateSlug', 'entriesScanned', 'nearestSlug'];

export function recordAttempt(db, fields) {
  const row = {
    url: null, httpStatus: null, bytes: null, parseOk: null,
    picksExtracted: null, fallbackReason: null,
    sitemapUrl: null, sitemapStatus: null, candidateSlug: null, entriesScanned: null, nearestSlug: null,
    ...fields,
  };
  db.prepare(`INSERT INTO fetch_attempts
      (race_day_id, source_id, url, http_status, outcome, bytes, parse_ok,
       picks_extracted, fallback_reason, correlation_id,
       sitemap_url, sitemap_status, candidate_slug, entries_scanned, nearest_slug)
      VALUES (@raceDayId, @sourceId, @url, @httpStatus, @outcome, @bytes,
              @parseOk, @picksExtracted, @fallbackReason, @correlationId,
              @sitemapUrl, @sitemapStatus, @candidateSlug, @entriesScanned, @nearestSlug)`)
    .run(row);
  log.info('fetch_attempt', fields);
}
