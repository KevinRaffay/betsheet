// How old are the entries in front of you? (D117)
//
// A race day ingested from a saved Equibase page carries ONE
// `odds_captured_at` for the whole card, because that is what the source can
// supply - the page prints no per-race capture time. Later races are therefore
// staler than earlier ones by construction. That is the design, not a defect,
// and this module exists to make it visible rather than to paper over it.
//
// Pure - browser + Node, no I/O, no Date.now() of its own. `now` is always
// passed in, so a view can render deterministically and a check script can
// assert a fixed clock.
//
// WHAT IT WILL AND WILL NOT CLAIM
//
// The capture age is EXACT: `odds_captured_at` and `now` are both absolute
// instants, so "saved 43 minutes ago" is a fact.
//
// Whether a race has already run is NOT exact, and the module refuses to
// pretend otherwise. `races.post_time` is a printed local string ("2:00PM")
// with no zone - the parser reads a zone off the page ("PT") but nothing
// stores it. Comparing that to a viewer's clock silently assumes the viewer
// sits in the track's timezone, which is wrong for a Californian card read
// from the east coast, and wrong by an hour twice a year even locally.
//
// So the post-time comparison is only made when it needs no zone at all:
//
//   * the day's date is BEFORE the viewer's today  -> every race has run
//   * the day's date is AFTER the viewer's today   -> no race has run
//   * the day's date IS the viewer's today         -> compare, and SAY the
//                                                     comparison assumes the
//                                                     viewer's own clock
//
// The first two are true in any timezone on earth. Only the third carries an
// assumption, and `assumesViewerClock` is how a caller knows to label it.

/**
 * Entries older than this read as stale rather than current. 75 minutes is
 * roughly two race intervals at a typical track, so a page saved before the
 * card began is flagged by the time you are betting the third race.
 *
 * Exported rather than inlined so a caller can tune it in one place, and so a
 * check script asserts against the same number the UI renders.
 */
export const STALE_AFTER_MINUTES = 75;

const MINUTE = 60 * 1000;

/** "2:00PM" / "2:00 PM" -> minutes past local midnight, or null. */
export function postTimeMinutes(printed) {
  const m = String(printed ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M?$/i);
  if (!m) return null;
  const hour12 = Number(m[1]);
  const mins = Number(m[2]);
  if (hour12 < 1 || hour12 > 12 || mins > 59) return null;
  const pm = m[3].toUpperCase() === 'P';
  const hour = (hour12 % 12) + (pm ? 12 : 0);
  return hour * 60 + mins;
}

/** YYYY-MM-DD for a Date, in the VIEWER's local zone (not UTC). */
const localDay = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * `{ capturedAt, raceDate, postTime, now, staleAfterMinutes }` ->
 * `{ known, minutesOld, state, ran, assumesViewerClock, label }`.
 *
 * `state`: 'unknown' (no capture time on file - every ingest path but the
 * Equibase one leaves it null, and that must not read as "fresh"), 'fresh',
 * or 'stale'. `ran`: true / false / null, null meaning "cannot say without
 * knowing the track's timezone".
 */
export function entriesStaleness({
  capturedAt = null,
  raceDate = null,
  postTime = null,
  now = new Date(),
  staleAfterMinutes = STALE_AFTER_MINUTES,
} = {}) {
  const at = capturedAt ? new Date(capturedAt) : null;
  const known = Boolean(at) && !Number.isNaN(at.getTime());
  const minutesOld = known ? Math.floor((now.getTime() - at.getTime()) / MINUTE) : null;

  // A capture from the future is a clock disagreement, not freshness. Treat
  // it as unknown rather than reporting a negative age.
  const state = !known ? 'unknown'
    : minutesOld < 0 ? 'unknown'
      : minutesOld <= staleAfterMinutes ? 'fresh' : 'stale';

  let ran = null;
  let assumesViewerClock = false;
  const today = localDay(now);
  if (raceDate && raceDate < today) ran = true;
  else if (raceDate && raceDate > today) ran = false;
  else if (raceDate === today) {
    const mins = postTimeMinutes(postTime);
    if (mins != null) {
      ran = (now.getHours() * 60 + now.getMinutes()) > mins;
      assumesViewerClock = true;
    }
  }

  // The AGE leads, because it is the exact part and the part a person acts
  // on. The absolute time follows in the viewer's own local zone: a stored
  // UTC instant rendered as UTC on a race card is a small trap - nobody at a
  // track thinks in UTC, and "04:10" against a 2:00PM post reads as a bug.
  const age = minutesOld == null || minutesOld < 0 ? null
    : minutesOld < 60 ? `${minutesOld} min ago`
      : `${Math.floor(minutesOld / 60)}h ${minutesOld % 60}m ago`;

  const clock = known
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;

  const label = !known ? 'Entries age unknown'
    : age == null ? `Entries stamped ${clock}, later than this clock - check the times`
      : `Entries saved ${age} (${clock})`;

  return { known, minutesOld, state, ran, assumesViewerClock, label };
}
