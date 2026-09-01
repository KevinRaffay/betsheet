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
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('fetch-audit');

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'BetSheet/0.1 (local handicapping tool)';
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

async function robotsDisallows(url) {
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

function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: ctl.signal,
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  }).finally(() => clearTimeout(timer));
}

// ---------- sources + audit ----------

function upsertSource(db, { name, kind }) {
  const existing = db.prepare('SELECT id FROM sources WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO sources (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid;
}

function recordAttempt(db, fields) {
  db.prepare(`INSERT INTO fetch_attempts
      (race_day_id, source_id, url, http_status, outcome, bytes, parse_ok,
       picks_extracted, fallback_reason, correlation_id)
      VALUES (@raceDayId, @sourceId, @url, @httpStatus, @outcome, @bytes,
              @parseOk, @picksExtracted, @fallbackReason, @correlationId)`)
    .run({
      url: null, httpStatus: null, bytes: null, parseOk: null,
      picksExtracted: null, fallbackReason: null, ...fields,
    });
  log.info('fetch_attempt', fields);
}

function recentFailures(db, raceDayId, sourceId) {
  const rows = db.prepare(`SELECT outcome FROM fetch_attempts
      WHERE race_day_id = ? AND source_id = ?
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
    try {
      // A fetcher whose page URL is not constructible from track+date (blog
      // posts, dated slugs) resolves it first; its sub-fetches go through
      // the same robots guard.
      if (fetcher.resolveUrl) {
        url = await fetcher.resolveUrl(
          { track: day.track, date: day.date },
          { fetchText: guardedFetchText },
        );
        if (!url) {
          push('http_error', { fallbackReason: 'no published page found for this track/date' });
          continue;
        }
      } else {
        url = fetcher.buildUrl({ track: day.track, date: day.date });
      }
      if (await robotsDisallows(url)) {
        push('blocked', { url, fallbackReason: 'disallowed by robots.txt - paste this source manually' });
        continue;
      }
      const res = await fetchWithTimeout(url);
      const body = await res.text();
      if (!res.ok) {
        push('http_error', { url, httpStatus: res.status, bytes: body.length, fallbackReason: `HTTP ${res.status}` });
        continue;
      }
      let parsed;
      try {
        parsed = fetcher.parse(body, { track: day.track, date: day.date });
      } catch (err) {
        push('parse_error', { url, httpStatus: res.status, bytes: body.length, parseOk: 0, fallbackReason: String(err?.message ?? err) });
        continue;
      }
      // The page must be for this card. A source that says otherwise is
      // discarded whole - a partially wrong consensus is worse than none.
      const wrongTrack = parsed.track && nameKey(parsed.track) !== nameKey(day.track);
      const wrongDate = parsed.date && parsed.date !== day.date;
      if (wrongTrack || wrongDate) {
        push('track_date_mismatch', {
          url, httpStatus: res.status, bytes: body.length, parseOk: 1,
          fallbackReason: `page covers ${parsed.track ?? day.track} ${parsed.date ?? day.date}`,
        });
        continue;
      }
      const warnings = [...(parsed.warnings ?? [])];
      const resolved = resolvePicks(day.races, parsed.races ?? [], warnings, fetcher.name);
      const count = storePicks(db, sourceId, resolved);
      push('ok', { url, httpStatus: res.status, bytes: body.length, parseOk: 1, picksExtracted: count });
      if (warnings.length) log.warn('fetch_warnings', { ...base, source: fetcher.name, warnings });
    } catch (err) {
      push('network_error', { url, fallbackReason: String(err?.message ?? err) });
    }
  }
  return { day, results };
}

// ---------- routes ----------

export const consensusRouter = express.Router();

consensusRouter.post('/race-days/:id/fetch-consensus', async (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const out = await runFetches(Number(req.params.id), correlationId);
  if (!out) return res.status(404).json({ error: 'No such race day.' });
  res.json({ correlationId, results: out.results, registered: listFetchers().length });
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
  res.json({ picks, attempts });
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
  res.status(201).json({ correlationId, picksStored: count });
});
