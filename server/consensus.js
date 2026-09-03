// Consensus-fetch framework: the runner, robots.txt respect, backoff, the
// fetch audit trail, and the manual paste fallback.
//
// Rules this module owns (invariants 6 and 11):
//   * robots.txt is checked before every automated fetch; a disallowed path
//     is recorded as 'blocked' and never requested.
//   * A source whose recent attempts all failed is BACKED OFF: skipped with
//     a visible audit row, not retried forever. Manual paste always works.
//   * Every attempt - success, failure, skip, manual - lands in BOTH the
//     fetch_attempts table (for the UI) and the fetch-audit log stream (for
//     the Phase 3 analysis feed). A source going quiet is always visible.
//   * A fetched page that names a different track or date than the race day
//     is DISCARDED ('track_date_mismatch'), never partially used.
//   * Re-running replaces that source's picks for the day (refresh
//     semantics, for picks pages that post race-day morning); the audit
//     trail is append-only.

import express from 'express';
import { listFetchers, loadExtraFetchers } from './fetchers/index.js';
import { parsePicksText } from '../shared/picks-parser.js';
import { parseAtrPdfText } from '../shared/parsers/atr-pdf.js';
import { classifyDay } from '../shared/classification.js';
import { extractPdfLines } from './pdf-text.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('fetch-audit');

const FETCH_TIMEOUT_MS = 15000;
// One identifying User-Agent for every automated request (D07 sources and
// the D41 crawler alike); BETSHEET_CONTACT names the human behind it.
export function userAgent(contact = process.env.BETSHEET_CONTACT) {
  return `BetSheet/0.1 (local handicapping tool; ${contact ? `contact: ${contact}` : 'set BETSHEET_CONTACT'})`;
}
const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_WINDOW_HOURS = 6;

// ---------- robots.txt ----------

const robotsCache = new Map(); // origin -> { rules: [prefixes], at: ms }

/** The robots-respecting text fetch handed to fetchers' resolveUrl. */
async function guardedFetchText(url) {
  if (await robotsDisallows(url)) throw new Error(`disallowed by robots.txt: ${url}`);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

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

/**
 * Backoff rule: the last BACKOFF_AFTER_FAILURES attempts in the window all
 * failed. A 'not_published' attempt (D53) is neither a success nor a
 * failure - a morning fetch before the source has posted is normal - so it
 * is left out of the count entirely: three of them never disable a source,
 * and one between two real failures neither resets nor extends the streak.
 */
export function recentFailures(db, raceDayId, sourceId) {
  const rows = db.prepare(`SELECT outcome FROM fetch_attempts
      WHERE race_day_id = ? AND source_id = ?
        AND outcome != 'not_published'
        AND ts >= datetime('now', '-${BACKOFF_WINDOW_HOURS} hours')
      ORDER BY id DESC LIMIT ${BACKOFF_AFTER_FAILURES}`)
    .all(raceDayId, sourceId);
  return rows.length >= BACKOFF_AFTER_FAILURES &&
    rows.every((r) => !['ok', 'manual_paste', 'manual_upload'].includes(r.outcome));
}

// ---------- resolving picks to entries ----------

const nameKey = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'")
  .replace(/\s*\((?:GB|IRE|FR|ARG|CHI|AUS|JPN|GER|NZ|SAF|URU|BRZ|PER|MEX|KOR|CAN)\)\s*$/, '')
  .replace(/\s+/g, ' ').trim();
// Track comparison is letters-only: "Delmar" (program panel letters), "Del
// Mar" (Bottom Line header, SFTB titles) and "DEL MAR" (Equibase) are one
// track. D35 canonicalizes the track at save; until then the runner must
// not discard a page over the spelling (found live 2026-09-02, D53).
export const trackKey = (s) => nameKey(s).replace(/[^A-Z0-9]/g, '');

/**
 * Attach entry ids to raw picks for one race day. A pick that matches no
 * entry keeps its text and gains a warning - visible, never dropped.
 */
export function resolvePicks(races, pickRaces, warnings, sourceName) {
  const resolved = [];
  for (const pr of pickRaces) {
    const race = races.find((r) => r.number === pr.race);
    if (!race) {
      warnings.push({ type: 'unknown_race', message: `${sourceName}: race ${pr.race} is not on this card.` });
      continue;
    }
    const picks = [];
    for (const p of pr.picks) {
      let entry = null;
      if (p.programNumber) entry = race.entries.find((e) => e.program_number === p.programNumber);
      if (!entry && p.horseName) entry = race.entries.find((e) => nameKey(e.horse_name) === nameKey(p.horseName));
      if (!entry) {
        warnings.push({
          type: 'unmatched_pick',
          message: `${sourceName}: race ${pr.race} pick "${p.programNumber ?? p.horseName}" matched no entry.`,
        });
      }
      picks.push({
        entryId: entry?.id ?? null,
        programNumber: entry?.program_number ?? p.programNumber ?? null,
        horseName: entry?.horse_name ?? p.horseName ?? null,
        pickType: p.pickType,
        note: p.note ?? null,
      });
    }
    resolved.push({ raceId: race.id, race: pr.race, picks });
  }
  return resolved;
}

function storePicks(db, sourceId, resolved) {
  const del = db.prepare('DELETE FROM consensus_picks WHERE source_id = ? AND race_id = ?');
  const ins = db.prepare(`INSERT INTO consensus_picks
      (race_id, source_id, entry_id, program_number, horse_name, pick_type, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  const tx = db.transaction(() => {
    for (const r of resolved) {
      del.run(sourceId, r.raceId);
      for (const p of r.picks) {
        ins.run(r.raceId, sourceId, p.entryId, p.programNumber, p.horseName, p.pickType, p.note);
        count++;
      }
    }
  });
  tx();
  return count;
}

// Adapts the ATR PDF parser's {race, topPick, watchFor} shape into the
// same {race, picks: [{programNumber, horseName, pickType}]} shape
// shared/picks-parser.js produces, so it feeds the SAME resolvePicks -
// no new consensus schema, just a new input path into the existing one.
function atrPicksToRaces(picks) {
  return picks.map((p) => ({
    race: p.race,
    picks: [
      { programNumber: p.topPick.programNumber, horseName: p.topPick.name, pickType: 'top' },
      { programNumber: p.watchFor.programNumber, horseName: p.watchFor.name, pickType: 'watch_out' },
    ],
  }));
}

function loadDay(db, id) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  if (!day) return null;
  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(day.id);
  const entriesFor = db.prepare('SELECT * FROM entries WHERE race_id = ?');
  for (const r of races) r.entries = entriesFor.all(r.id);
  return { ...day, races };
}

// ---------- the runner ----------

export async function runFetches(dayId, correlationId) {
  const db = getDb();
  const day = loadDay(db, dayId);
  if (!day) return null;
  await loadExtraFetchers();

  const results = [];
  for (const fetcher of listFetchers()) {
    const sourceId = upsertSource(db, fetcher);
    const base = { raceDayId: day.id, sourceId, correlationId };
    const push = (outcome, extra = {}) => {
      recordAttempt(db, { ...base, outcome, ...extra });
      results.push({ source: fetcher.name, outcome, ...extra });
    };

    if (fetcher.produces === 'entries') continue; // driven by ingest.js (D40)
    if (!fetcher.supports({ track: day.track, date: day.date })) continue;

    if (!db.prepare('SELECT enabled FROM sources WHERE id = ?').get(sourceId).enabled) {
      push('blocked', { fallbackReason: 'source disabled' });
      continue;
    }

    if (recentFailures(db, day.id, sourceId)) {
      push('blocked', { fallbackReason: `backing off after ${BACKOFF_AFTER_FAILURES} straight failures - paste this source manually` });
      continue;
    }

    let url = null;
    // Discovery details ride EVERY row of this attempt (D53), so the
    // audit says which sitemap was read and what slug was looked for even
    // when the post was found and then failed to fetch or parse.
    let audit = {};
    try {
      // A fetcher whose page URL is not constructible from track+date (blog
      // posts, dated slugs) resolves it first; its sub-fetches go through
      // the same robots guard. resolveUrl answers a URL string (legacy) or
      // { url, discovery } - discovery = { sitemapUrl, sitemapStatus,
      // candidateSlug, entriesScanned, nearestSlug, error? }.
      if (fetcher.resolveUrl) {
        const resolved = await fetcher.resolveUrl(
          { track: day.track, date: day.date },
          { fetchText: guardedFetchText },
        );
        const r = resolved && typeof resolved === 'object' ? resolved : { url: resolved ?? null, discovery: {} };
        const d = r.discovery ?? {};
        url = r.url ?? null;
        audit = Object.fromEntries(DISCOVERY_FIELDS.map((k) => [k, d[k] ?? null]));
        if (!url) {
          if (d.sitemapStatus != null && d.sitemapStatus !== 200) {
            // The sitemap itself answered with an error: that IS an HTTP error.
            push('http_error', { ...audit, httpStatus: d.sitemapStatus, fallbackReason: `sitemap HTTP ${d.sitemapStatus}: ${d.sitemapUrl ?? ''}` });
          } else if (d.error && !d.entriesScanned) {
            push('network_error', { ...audit, fallbackReason: d.error });
          } else {
            // Scanned and not there: the source has not posted (yet). Not
            // a failure - see recentFailures.
            push('not_published', {
              ...audit,
              fallbackReason: `no post for ${audit.candidateSlug ?? 'this track/date'} in ${audit.entriesScanned ?? 0} sitemap entries`
                + (audit.nearestSlug ? `; nearest: ${audit.nearestSlug}` : ''),
            });
          }
          continue;
        }
      } else {
        url = fetcher.buildUrl({ track: day.track, date: day.date });
      }
      if (await robotsDisallows(url)) {
        push('blocked', { ...audit, url, fallbackReason: 'disallowed by robots.txt - paste this source manually' });
        continue;
      }
      const res = await fetchWithTimeout(url);
      const body = await res.text();
      if (!res.ok) {
        push('http_error', { ...audit, url, httpStatus: res.status, bytes: body.length, fallbackReason: `HTTP ${res.status}` });
        continue;
      }
      let parsed;
      try {
        parsed = fetcher.parse(body, { track: day.track, date: day.date });
      } catch (err) {
        push('parse_error', { ...audit, url, httpStatus: res.status, bytes: body.length, parseOk: 0, fallbackReason: String(err?.message ?? err) });
        continue;
      }
      // The page must be for this card. A source that says otherwise is
      // discarded whole - a partially wrong consensus is worse than none.
      // Track compared letters-only (trackKey): a spelling is not a mismatch.
      const wrongTrack = parsed.track && trackKey(parsed.track) !== trackKey(day.track);
      const wrongDate = parsed.date && parsed.date !== day.date;
      if (wrongTrack || wrongDate) {
        push('track_date_mismatch', {
          ...audit, url, httpStatus: res.status, bytes: body.length, parseOk: 1,
          fallbackReason: `page covers ${parsed.track ?? day.track} ${parsed.date ?? day.date}`,
        });
        continue;
      }
      const warnings = [...(parsed.warnings ?? [])];
      const resolved = resolvePicks(day.races, parsed.races ?? [], warnings, fetcher.name);
      const count = storePicks(db, sourceId, resolved);
      push('ok', { ...audit, url, httpStatus: res.status, bytes: body.length, parseOk: 1, picksExtracted: count });
      if (warnings.length) log.warn('fetch_warnings', { ...base, source: fetcher.name, warnings });
    } catch (err) {
      push('network_error', { ...audit, url, fallbackReason: String(err?.message ?? err) });
    }
  }
  return { day, results };
}

// ---------- classification (D09) ----------

function picksByRaceNumber(db, day) {
  const rows = db.prepare(`
    SELECT cp.*, s.name AS source_name, s.kind AS source_kind, r.number AS race_number
    FROM consensus_picks cp
    JOIN sources s ON s.id = cp.source_id
    JOIN races r ON r.id = cp.race_id
    WHERE r.race_day_id = ?
  `).all(day.id);
  const byRace = {};
  for (const row of rows) (byRace[row.race_number] ??= []).push(row);
  return byRace;
}

/**
 * Classify every race of a day from stored picks + program analysis, and
 * persist classification, external-source count and contrarian flags onto
 * the races. Re-run after every fetch/refresh and manual confirm so the
 * classification always reflects the picks on file.
 */
export function classifyAndPersist(db, day, correlationId) {
  const entriesByRace = Object.fromEntries(day.races.map((r) => [r.number, r.entries]));
  const results = classifyDay(day.races.map((r) => r.number), entriesByRace, picksByRaceNumber(db, day));
  const update = db.prepare(`UPDATE races
      SET classification = ?, classification_source_count = ?, contrarian_flags = ?
      WHERE race_day_id = ? AND number = ?`);
  const tx = db.transaction(() => {
    for (const r of results) {
      update.run(r.classification, r.externalSourceCount,
        r.contrarianFlags.length ? JSON.stringify(r.contrarianFlags) : null,
        day.id, r.number);
    }
  });
  tx();
  log.info('day_classified', {
    correlationId,
    raceDayId: day.id,
    classes: Object.fromEntries(results.map((r) => [r.number, r.classification])),
    contrarianFlags: results.reduce((a, r) => a + r.contrarianFlags.length, 0),
  });
  return results;
}

// ---------- routes ----------

export const consensusRouter = express.Router();

// Mutations against a soft-deleted day are refused - restore it first.
// Reads stay open so a deleted day remains inspectable.
function deletedGuard(req, res) {
  const row = getDb().prepare('SELECT deleted_at FROM race_days WHERE id = ?')
    .get(Number(req.params.id));
  if (row?.deleted_at) {
    res.status(410).json({ error: 'This race day is deleted. Restore it before modifying it.' });
    return true;
  }
  return false;
}

consensusRouter.post('/race-days/:id/fetch-consensus', async (req, res) => {
  if (deletedGuard(req, res)) return;
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const out = await runFetches(Number(req.params.id), correlationId);
  if (!out) return res.status(404).json({ error: 'No such race day.' });
  const classified = classifyAndPersist(getDb(), out.day, correlationId);
  res.json({
    correlationId,
    results: out.results,
    registered: listFetchers().length,
    classification: classified.map((r) => ({ number: r.number, classification: r.classification })),
  });
});

consensusRouter.post('/race-days/:id/classify', (req, res) => {
  if (deletedGuard(req, res)) return;
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  res.json({ correlationId, races: classifyAndPersist(db, day, correlationId) });
});

consensusRouter.get('/race-days/:id/consensus', (req, res) => {
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const picks = db.prepare(`
    SELECT cp.*, s.name AS source_name, s.kind AS source_kind, r.number AS race_number
    FROM consensus_picks cp
    JOIN sources s ON s.id = cp.source_id
    JOIN races r ON r.id = cp.race_id
    WHERE r.race_day_id = ?
    ORDER BY r.number, s.name, cp.id
  `).all(day.id);
  const attempts = db.prepare(`
    SELECT fa.*, s.name AS source_name
    FROM fetch_attempts fa
    JOIN sources s ON s.id = fa.source_id
    WHERE fa.race_day_id = ?
    ORDER BY fa.id DESC
    LIMIT 100
  `).all(day.id);
  const races = day.races.map((r) => ({
    number: r.number,
    classification: r.classification,
    externalSourceCount: r.classification_source_count,
    contrarianFlags: r.contrarian_flags ? JSON.parse(r.contrarian_flags) : [],
  }));
  res.json({ picks, attempts, races });
});

// Manual fallback, preview-first (invariant 9): the preview parses and
// resolves but writes nothing; the confirm endpoint stores the previewed
// structure.
consensusRouter.post('/race-days/:id/consensus/manual-preview', (req, res) => {
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const sourceName = String(req.body?.sourceName ?? '').trim();
  const parsed = parsePicksText(String(req.body?.text ?? ''));
  const warnings = [...parsed.warnings];
  const resolved = resolvePicks(day.races, parsed.races, warnings, sourceName || 'manual');
  res.json({ sourceName, races: resolved, warnings });
});

consensusRouter.post('/race-days/:id/consensus/manual', (req, res) => {
  if (deletedGuard(req, res)) return;
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const sourceName = String(req.body?.sourceName ?? '').trim();
  const races = req.body?.races;
  if (!sourceName) return res.status(400).json({ error: 'sourceName is required.' });
  if (!Array.isArray(races) || races.length === 0) {
    return res.status(400).json({ error: 'races (from the preview) are required.' });
  }
  const sourceId = upsertSource(db, { name: sourceName, kind: 'manual' });
  const count = storePicks(db, sourceId, races);
  recordAttempt(db, {
    raceDayId: day.id, sourceId, correlationId,
    outcome: 'manual_paste', parseOk: 1, picksExtracted: count,
  });
  classifyAndPersist(db, day, correlationId);
  res.status(201).json({ correlationId, picksStored: count });
});

// At The Races PDF upload (D69): a same-day "print to PDF" of ATR's
// racecard page, covering every race on one file - a faster input path
// into the SAME consensus_picks structure the manual-paste textarea above
// writes to (top pick + watch pick), not a new source type or schema. Same
// trust tier as manual paste (not the D07 automated fetch cycle), so it
// gets its own outcome value on the SAME preview-then-confirm contract
// (invariant 9): preview parses and resolves but writes nothing, confirm
// stores exactly what the preview showed.
consensusRouter.post(
  '/race-days/:id/consensus/atr-pdf-preview',
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  async (req, res) => {
    const db = getDb();
    const day = loadDay(db, Number(req.params.id));
    if (!day) return res.status(404).json({ error: 'No such race day.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the racecard PDF as a raw application/pdf body.' });
    }
    const sourceName = String(req.query.sourceName ?? '').trim() || 'At The Races';
    try {
      const text = await extractPdfLines(new Uint8Array(req.body));
      const parsed = parseAtrPdfText(text);
      const warnings = [...parsed.warnings];
      const resolved = resolvePicks(day.races, atrPicksToRaces(parsed.picks), warnings, sourceName);
      res.json({ sourceName, races: resolved, warnings });
    } catch (err) {
      res.status(422).json({ error: `Could not read that PDF: ${err?.message ?? err}` });
    }
  },
);

consensusRouter.post('/race-days/:id/consensus/atr-pdf', (req, res) => {
  if (deletedGuard(req, res)) return;
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const sourceName = String(req.body?.sourceName ?? '').trim();
  const races = req.body?.races;
  if (!sourceName) return res.status(400).json({ error: 'sourceName is required.' });
  if (!Array.isArray(races) || races.length === 0) {
    return res.status(400).json({ error: 'races (from the preview) are required.' });
  }
  const sourceId = upsertSource(db, { name: sourceName, kind: 'manual' });
  const count = storePicks(db, sourceId, races);
  recordAttempt(db, {
    raceDayId: day.id, sourceId, correlationId,
    outcome: 'manual_upload', parseOk: 1, picksExtracted: count,
  });
  classifyAndPersist(db, day, correlationId);
  res.status(201).json({ correlationId, picksStored: count });
});
