// Race day calendar API (D210, phase C-2 of docs/requirements/race-day-calendar.md):
// GET /api/calendar?date=YYYY-MM-DD - every non-deleted race day for one
// date, with each race placed on the Pacific-anchored hourly grid
// shared/race-calendar.js defines. Read-only, like server/distribution.js
// and server/pl.js: it reports over existing tables and writes nothing.
//
// A race that can't be placed (no parseable post time, or a track with no
// known timezone) is never silently dropped - it lands in that day's own
// `unplaceable` list instead (invariant 11's standing preference for a
// visible gap over a silent one).

import express from 'express';
import { getDb } from './db.js';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { nextRaceAmong, placeRacePacific } from '../shared/race-calendar.js';

export const calendarRouter = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

calendarRouter.get('/calendar', (req, res) => {
  const date = String(req.query.date ?? '').trim();
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });

  const db = getDb();
  const rows = db.prepare(`
    SELECT rd.id AS raceDayId, rd.track, rd.track_code AS trackCode,
           r.number, r.post_time AS postTime
    FROM race_days rd
    JOIN races r ON r.race_day_id = rd.id
    WHERE rd.date = ? AND rd.deleted_at IS NULL
    ORDER BY rd.track, r.number
  `).all(date);

  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.raceDayId)) {
      byDay.set(row.raceDayId, {
        raceDayId: row.raceDayId,
        track: row.track,
        trackCode: row.trackCode,
        timezone: canonicalizeTrack(row.track).timezone,
        races: [],
        unplaceable: [],
      });
    }
    const day = byDay.get(row.raceDayId);
    const placed = placeRacePacific(date, row.postTime, day.timezone);
    if (placed) day.races.push({ number: row.number, postTimePacific: placed.postTimePacific, hourBucket: placed.hourBucket });
    else day.unplaceable.push(row.number);
  }

  const tracks = [...byDay.values()];
  for (const day of tracks) day.races.sort((a, b) => a.hourBucket - b.hourBucket);
  // Earliest post first, so a caller rendering rows in response order already
  // reads top-to-bottom as "who's up soonest" - ties broken by track name.
  tracks.sort((a, b) => (a.races[0]?.hourBucket ?? Infinity) - (b.races[0]?.hourBucket ?? Infinity) || a.track.localeCompare(b.track));

  res.json({ date, tracks });
});

// GET /api/next-race[?now=ISO] (D378): the soonest race still to run across
// every non-deleted race day, for the home page's "Next race" card - the
// same tile the static app's home shows over its bundle, computed by the
// same shared function so the two apps cannot disagree about which race is
// next. `now` is accepted as a query parameter for exactly one reason: a
// check script must be able to pin the clock (shared/race-calendar.js's own
// rule), and a stale-clock diagnosis in production is a URL away. `latest`
// is the most recent stored day (and its last race number, D380), so the
// card has a RACE to send a person to when nothing is still to run - the
// ordinary case on a historical corpus.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

calendarRouter.get('/next-race', (req, res) => {
  const nowRaw = req.query.now;
  const now = nowRaw == null ? new Date() : new Date(String(nowRaw));
  if (nowRaw != null && (!ISO_RE.test(String(nowRaw)) || Number.isNaN(now.getTime()))) {
    return res.status(400).json({ error: 'now must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM[:SS]Z).' });
  }
  // A track's local date can trail the UTC date by a day, so the floor is
  // yesterday-UTC: everything earlier has certainly run, and everything from
  // there on is left to the instant comparison.
  const floor = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  const db = getDb();
  const rows = db.prepare(`
    SELECT rd.id AS raceDayId, rd.track, rd.track_code AS trackCode, rd.date,
           r.number, r.post_time AS postTime,
           (SELECT COUNT(*) FROM entries e WHERE e.race_id = r.id AND e.scratched = 0) AS runners
    FROM race_days rd
    JOIN races r ON r.race_day_id = rd.id
    WHERE rd.deleted_at IS NULL AND rd.date >= ?
    ORDER BY rd.date, rd.track, r.number
  `).all(floor);
  const next = nextRaceAmong(rows.map((row) => ({ ...row, timezone: canonicalizeTrack(row.track).timezone })), now);

  // `lastRaceNumber` (D380): the card's button always opens a RACE, so with
  // nothing still to run it needs the latest day's last race to land on.
  const latest = db.prepare(`
    SELECT rd.id AS raceDayId, rd.track, rd.date,
           (SELECT MAX(number) FROM races r WHERE r.race_day_id = rd.id) AS lastRaceNumber
    FROM race_days rd
    WHERE rd.deleted_at IS NULL ORDER BY rd.date DESC, rd.id DESC LIMIT 1
  `).get() ?? null;

  res.json({
    now: now.toISOString(),
    next: next ? {
      raceDayId: next.raceDayId, track: next.track, trackCode: next.trackCode, date: next.date,
      number: next.number, postTime: next.postTime, postTimePacific: next.postTimePacific,
      at: next.at.toISOString(), runners: next.runners,
    } : null,
    latest,
  });
});
