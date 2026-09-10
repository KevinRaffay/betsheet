// Race day calendar: placing a track's printed local post time on a shared,
// Pacific-anchored hourly grid (D209, docs/requirements/race-day-calendar.md).
//
// The user is always Pacific (2026-09-10 decision) - both the COLUMN a race
// lands in and the TIME PRINTED in its cell must be Pacific, never a mix of
// track-local and converted. `races.post_time` is a printed LOCAL string
// with no zone of its own (shared/staleness.js documents why in full), so
// placing it correctly needs the track's real IANA timezone
// (shared/track-codes.js's registry, D209) to convert into an actual instant
// before it can be read back out in Pacific.
//
// Pure - browser + Node, no I/O, no Date.now() of its own. Every function
// here is a plain function of its inputs (a calendar date, a printed time, a
// zone) so a check script can pin exact conversions, including across a DST
// boundary, without a fake clock.

import { postTimeMinutes } from './staleness.js';

export const PACIFIC_ZONE = 'America/Los_Angeles';

// The grid's first column is 7:00 AM Pacific; column 23 is 6:00 AM Pacific
// the following calendar day - 24 columns covering one full racing day.
export const CALENDAR_START_HOUR = 7;
export const CALENDAR_COLUMNS = 24;

/**
 * A track's printed local post time ("2:00 PM") on a given calendar date
 * ("2026-09-10"), in a given IANA zone, as a real UTC instant - or `null`
 * when the date/time can't be parsed or the zone is unknown/invalid. Never
 * guesses a substitute zone; a caller with no zone decides separately how to
 * report an unplaceable race (see docs/requirements/race-day-calendar.md's
 * `unplaceable` shape).
 *
 * DST-safe for any IANA zone via the standard two-pass technique: format a
 * first guess (treating the wall clock as if it already were UTC) back in
 * the target zone, then correct by the resulting offset. No dependency,
 * matching this codebase's existing preference for a hand-rolled conversion
 * over a library (the same call `server/zip-read.js` made for D127).
 */
export function localWallClockToUtc(dateStr, timeStr, ianaZone) {
  const dm = String(dateStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mins = postTimeMinutes(timeStr);
  if (!dm || mins == null || !ianaZone) return null;

  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const guess = new Date(`${dateStr}T${hh}:${mm}:00.000Z`);
  if (Number.isNaN(guess.getTime())) return null;

  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  } catch {
    return null; // an unrecognized/invalid IANA zone name - refuse, never guess
  }

  // What guess (an instant) reads as in ianaZone, re-parsed as if that
  // reading were itself UTC - the offset between the two IS the zone's real
  // offset for this exact date, DST included.
  const readBack = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return new Date(guess.getTime() + (guess.getTime() - readBack));
}

/** The column index 0-23 a UTC instant falls in on the 7:00 AM Pacific grid, or `null`. */
export function hourBucket(utcInstant) {
  if (!(utcInstant instanceof Date) || Number.isNaN(utcInstant.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_ZONE, hourCycle: 'h23', hour: '2-digit' });
  const ptHour = Number(fmt.format(utcInstant)) % 24;
  return (ptHour - CALENDAR_START_HOUR + CALENDAR_COLUMNS) % CALENDAR_COLUMNS;
}

/** A UTC instant as "H:MM AM/PM PST"/"PDT" - the ONLY time string a viewer ever sees. */
export function formatPacific(utcInstant) {
  if (!(utcInstant instanceof Date) || Number.isNaN(utcInstant.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_ZONE,
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(utcInstant);
}

/**
 * The one call a caller (the future `/api/calendar` endpoint) actually
 * needs: a track's printed local post time, placed on the Pacific grid and
 * printed in Pacific, in one step - or `null` when it cannot be placed at
 * all (unparseable time, or no known zone for the track), so the caller can
 * route it to an `unplaceable` count instead of guessing a column.
 */
export function placeRacePacific(dateStr, postTime, ianaZone) {
  const utc = localWallClockToUtc(dateStr, postTime, ianaZone);
  if (!utc) return null;
  return { hourBucket: hourBucket(utc), postTimePacific: formatPacific(utc) };
}
