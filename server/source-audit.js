// The fetch audit trail: sources, and one row per attempt.
//
// Was server/polite-fetch.js for exactly one deliverable. D112 relocated it out
// of the deleted server/consensus.js because two callers still fetched things
// politely - the dmtc crawler and the ML-sheet route - and D113 deleted both.
// Nothing in this codebase fetches anything automatically any more, so the
// robots.txt guard, the timeout wrapper and the identifying User-Agent went
// with them: `userAgent`, `robotsDisallows`, `parseRobots` and
// `fetchWithTimeout` had no callers left, and keeping a robots checker that
// nothing can call would be theatre.
//
// Renamed rather than left as `polite-fetch.js`, because a file by that name
// containing no fetching misleads the next reader.
//
// What survives is invariant 11's half: every attempt to bring data in - now
// only the Equibase OTR upload - lands in BOTH the `fetch_attempts` table and
// the fetch-audit log stream, so a source going quiet is always visible.
//
// **Invariant 6 still binds and is not weakened by this.** "Never scrape
// Equibase" is now enforced structurally rather than by a runtime check:
// there is no fetcher, no registry and no HTTP client left to scrape with.
// Every source of data is a file a person chose to upload or paste.

import { getDb } from './db.js';
import { getLogger } from './logging.js';

const log = getLogger('fetch-audit');

export function upsertSource(db, { name, kind }) {
  const existing = db.prepare('SELECT id FROM sources WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO sources (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid;
}

// The discovery fields an attempt row carries (D53): what was scanned, what
// the fetcher looked for, and the nearest miss - the same in the DB row and
// the fetch-audit line, so an attempt is auditable from the log alone. They
// are all null for an upload, which is the only kind of attempt left; the
// columns stay because shipped migrations are immutable and every historical
// row still carries them.
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
