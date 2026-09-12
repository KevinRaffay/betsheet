// Display-time formatting (D382): stored UTC -> the zone a person reads.
//
// PURE and browser-safe - no `node:` import, ever. `CardSheet.jsx` imports
// this, and the static at-track app imports `CardSheet.jsx`, so this file is
// on the static bundle's import surface (see the D168 gotcha in CLAUDE.md).
//
// Every timestamp this app STORES is UTC: `server/llm-cards.js`'s `now()`
// writes `2026-09-11T21:48:09Z`, and the schema's own defaults write the same
// instant either as `...Z` or as SQLite's naive `2026-09-11 21:48:09` (which
// is `datetime('now')`, UTC by definition). Until D382 every UI surface
// printed those strings verbatim, and the user did the zone arithmetic. This
// converts at the READ edge only - nothing about storage, logging, hashing or
// the static payload changes, and `shared/staleness.js` keeps doing its own
// arithmetic on the stored instant.
//
// The zone is a CONSTANT, not the browser's. The app is single-user and
// local-only (invariant 10), the user is in the Pacific zone (user decision
// 2026-09-11), and a phone at a racetrack in another zone must still read the
// same clock the desktop showed - an at-track surface that silently shifted
// every time by three hours would be worse than a raw UTC string.

export const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

/** A calendar DATE with no time is not an instant and must never be shifted. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SQLite's naive form: `YYYY-MM-DD HH:MM[:SS[.fff]]` (or with a `T`) and NO
 * zone. `new Date()` would read that as LOCAL time, which is wrong for every
 * row this schema writes - they are all UTC - so the `Z` is restored first.
 */
const NAIVE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function toInstant(raw) {
  const m = NAIVE_UTC.exec(raw);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `formatPacific(value, {dateOnly})` -> `'2026-09-11 3:37 PM PDT'`, or
 * `'2026-09-11'` with `dateOnly`. Returns null for null/empty (so a caller
 * can fall back to its own dash), a bare date UNCHANGED, and anything
 * unparseable VERBATIM - a stored value must never disappear from the screen
 * because the formatter did not recognise it.
 */
export function formatPacific(value, { dateOnly = false, timeZone = DISPLAY_TIME_ZONE } = {}) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (BARE_DATE.test(raw)) return raw;
  const d = toInstant(raw);
  if (!d) return raw;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== 'literal') p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  if (dateOnly) return date;
  return `${date} ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}
