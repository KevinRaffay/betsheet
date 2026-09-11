// Live odds capture: reconcile a tote board against a stored race day (D224).
//
// PURE and browser-safe - no `node:` import, ever. It reads no database,
// fetches nothing and writes nothing. Given the races a day already has and
// the races a freshly-captured Equibase entries page parsed to, it returns the
// price updates that capture implies, the per-race diff a preview renders, and
// a warning for every single thing it declined to do.
//
// WHY A RECONCILER AND NOT A RE-INGEST. The day already exists. Re-running the
// entries ingest over it would mean `?replace=1`, which HARD-DELETES the day
// and cascades away every card and ticket on it (the D204 gotcha, which cost
// real work live: 14 races, 168 entries and 98 human tickets destroyed to make
// room for a re-pull). A board refresh must therefore be additive by
// construction, and this module is where "additive" is enforced: the only
// thing it ever emits is a price.
//
// THE FOUR THINGS IT WILL NOT TOUCH, each a deliberate refusal:
//
//   * The MORNING LINE. It is the other half of the comparison this whole
//     capture exists to make - `morning_line` vs the board - so overwriting it
//     with a live price would destroy the measurement in the act of taking it.
//   * The ENTRY LIST. A horse in the capture that is not on the stored race is
//     reported, never inserted; a stored horse absent from the capture is
//     reported, never deleted. A tote board is a price source, not a source of
//     truth about who is in the race.
//   * The SCRATCHED flag. A near-post board genuinely knows scratches the
//     morning page did not, and it is tempting to fold them in. It is out of
//     scope on purpose: `scratched` changes how every existing card on this day
//     GRADES (invariant 1's refund rule reads it), so a price refresh that
//     silently re-graded settled work would be exactly the kind of quiet
//     side-effect this codebase keeps getting bitten by. Drift is surfaced as a
//     visible warning instead - see `scratch_drift` below - and acting on it
//     stays a separate, deliberate decision.
//   * ANY RACE THAT DID NOT MATCH. Reconciliation is by race number against the
//     stored day, and an unmatched number produces a warning, not a guess.
//
// EVERY WARNING CARRIES A `message` STRING. `ParsePreview.jsx` renders
// `w.message` with nothing to fall back on, so a warning without one is an
// empty bullet on screen - the exact defect D207 found sitting in both Apify
// parsers for as long as they had existed. `checkMessages()` in
// `scripts/check-live-odds.js` asserts it on every warning this module can
// produce.

import { morningLineToDecimal } from './betmath.js';

const up = (pgm) => String(pgm ?? '').trim().toUpperCase();
const blank = (v) => v == null || v === '' || v === '-' || v === '--';

/**
 * A price the board actually showed, and the number we can do arithmetic on.
 *
 * `morningLineToDecimal` reads the `6/1`, `7/2`, `9/5`, `4.5` grammar and
 * returns null for anything else - a dash-separated `7-2`, an `EVN`, a `SCR`.
 * When it returns null the TEXT is still kept and the caller warns: a price
 * this codebase cannot parse is a visible gap, never a dropped row. That is
 * the D213 lesson (a money token the parser could not see failed CLOSED and
 * silently refused a legal bet) applied one layer up.
 */
export function readOdds(raw) {
  if (blank(raw)) return null;
  const text = String(raw).trim();
  return { text, decimal: morningLineToDecimal(text) };
}

/**
 * Reconcile one capture against one stored day.
 *
 * `stored` - { track, date, races: [{ number, entries: [{ programNumber,
 *             horseName, morningLine, liveOdds, scratched }] }] }
 * `parsed` - the shape `parseEquibaseEntriesHtml` returns: { track, date,
 *             races: [{ number, entries: [{ programNumber, horseName,
 *             liveOdds, scratched }] }] }
 *
 * Returns { ok, races, updates, warnings, counts }. `ok` is false when there is
 * nothing safe to write; `updates` is what the caller may persist and nothing
 * else. Never throws - a malformed capture comes back as warnings, the
 * convention every parser under `shared/parsers/` already follows.
 */
export function reconcileOddsCapture({ stored, parsed } = {}) {
  const warnings = [];
  const races = [];
  const updates = [];
  const counts = {
    racesMatched: 0, entriesMatched: 0, priced: 0, changed: 0, unchanged: 0,
    firstPrice: 0, unreadable: 0, unknownEntries: 0, unpricedEntries: 0,
    racesOnlyInCapture: 0, racesOnlyOnDay: 0, scratchDrift: 0,
  };
  const fail = (type, message) => {
    warnings.push({ type, blocking: true, message });
    return { ok: false, races, updates, warnings, counts };
  };

  if (!stored || !Array.isArray(stored.races)) return fail('no_stored_day', 'No stored race day was supplied to reconcile against.');
  if (!parsed || !Array.isArray(parsed.races)) return fail('no_capture', 'The capture parsed to no races at all.');

  // Track and date must name THIS day. The same rule `server/results.js`
  // applies to a chart, for the same reason it gives: data saved onto the
  // wrong day silently poisons every grade and every figure built on it, and
  // is far harder to notice than a refusal.
  const sameTrack = String(stored.track ?? '').trim().toLowerCase() === String(parsed.track ?? '').trim().toLowerCase();
  const sameDate = String(stored.date ?? '').trim() === String(parsed.date ?? '').trim();
  if (!sameTrack || !sameDate) {
    return fail('track_date_mismatch',
      `This capture is for ${parsed.track ?? '?'} on ${parsed.date ?? '?'}, but the race day is `
      + `${stored.track ?? '?'} on ${stored.date ?? '?'}. Nothing was read from it.`);
  }

  const storedByNumber = new Map(stored.races.map((r) => [Number(r.number), r]));
  const capturedNumbers = new Set();

  for (const capRace of parsed.races) {
    const number = Number(capRace?.number);
    capturedNumbers.add(number);
    const storedRace = storedByNumber.get(number);
    if (!storedRace) {
      counts.racesOnlyInCapture += 1;
      warnings.push({
        type: 'race_not_on_day', race: number, blocking: false,
        message: `Race ${number} is in the capture but not on this race day - skipped.`,
      });
      continue;
    }
    counts.racesMatched += 1;

    const storedEntries = new Map((storedRace.entries ?? [])
      .filter((e) => e && e.programNumber !== null && e.programNumber !== undefined)
      .map((e) => [up(e.programNumber), e]));
    const seen = new Set();
    const rows = [];

    for (const capEntry of capRace.entries ?? []) {
      // A scratched row on an Equibase page can carry no program number at all
      // (D180 - the cell is replaced by an SCR marker), so there is nothing to
      // match on and nothing to price. Not a defect, not a warning.
      if (capEntry?.programNumber === null || capEntry?.programNumber === undefined) continue;
      const pgm = up(capEntry.programNumber);
      const storedEntry = storedEntries.get(pgm);
      if (!storedEntry) {
        counts.unknownEntries += 1;
        warnings.push({
          type: 'entry_not_on_race', race: number, programNumber: pgm, blocking: false,
          message: `Race ${number}: #${pgm}${capEntry.horseName ? ` ${capEntry.horseName}` : ''} is in the `
            + 'capture but not in this race\'s stored entries - no price was recorded for it.',
        });
        continue;
      }
      seen.add(pgm);
      counts.entriesMatched += 1;

      if (Boolean(capEntry.scratched) !== Boolean(storedEntry.scratched)) {
        counts.scratchDrift += 1;
        warnings.push({
          type: 'scratch_drift', race: number, programNumber: pgm, blocking: false,
          message: `Race ${number}: #${pgm} reads `
            + `${capEntry.scratched ? 'SCRATCHED in the capture but live on the stored card' : 'live in the capture but scratched on the stored card'}`
            + ' - recorded here only. This refresh never changes a scratch.',
        });
      }

      const odds = readOdds(capEntry.liveOdds);
      if (!odds) {
        counts.unpricedEntries += 1;
        rows.push({
          programNumber: pgm, horseName: storedEntry.horseName ?? capEntry.horseName ?? null,
          morningLine: storedEntry.morningLine ?? null,
          previousOdds: storedEntry.liveOdds ?? null, newOdds: null, newOddsDecimal: null,
          state: 'unpriced',
        });
        continue;
      }
      if (odds.decimal === null) {
        counts.unreadable += 1;
        warnings.push({
          type: 'odds_unreadable', race: number, programNumber: pgm, odds: odds.text, blocking: false,
          message: `Race ${number}: #${pgm} shows "${odds.text}", which is not a price this app can do `
            + 'arithmetic on. The text is stored as-is; nothing derived from it will use a number.',
        });
      }
      counts.priced += 1;
      const previous = storedEntry.liveOdds ?? null;
      const state = previous === null ? 'first' : (previous === odds.text ? 'unchanged' : 'changed');
      if (state === 'first') counts.firstPrice += 1;
      else if (state === 'changed') counts.changed += 1;
      else counts.unchanged += 1;

      rows.push({
        programNumber: pgm, horseName: storedEntry.horseName ?? null,
        morningLine: storedEntry.morningLine ?? null,
        previousOdds: previous, newOdds: odds.text, newOddsDecimal: odds.decimal,
        state,
      });
      updates.push({ raceNumber: number, programNumber: pgm, liveOdds: odds.text, liveOddsDecimal: odds.decimal });
    }

    for (const [pgm, e] of storedEntries) {
      if (seen.has(pgm)) continue;
      warnings.push({
        type: 'entry_not_in_capture', race: number, programNumber: pgm, blocking: false,
        message: `Race ${number}: #${pgm}${e.horseName ? ` ${e.horseName}` : ''} is on the stored card but `
          + 'not in the capture - its price is left exactly as it was.',
      });
    }

    rows.sort((a, b) => String(a.programNumber).localeCompare(String(b.programNumber), undefined, { numeric: true }));
    races.push({ number, entries: rows });
  }

  for (const number of storedByNumber.keys()) {
    if (capturedNumbers.has(number)) continue;
    counts.racesOnlyOnDay += 1;
    warnings.push({
      type: 'race_not_in_capture', race: number, blocking: false,
      message: `Race ${number} is on this race day but not in the capture - its prices are unchanged.`,
    });
  }

  races.sort((a, b) => a.number - b.number);

  // A capture that priced nothing is refused, and the reason is worth stating
  // because the opposite call is defensible right up until you make it. An
  // empty save here is indistinguishable from an entries page saved BEFORE
  // wagering opened - which is not a hypothetical, it is the only real capture
  // this project has ever taken (all 113 entries blank,
  // docs/requirements/equibase-entries-ingest.md open question 2). Storing that
  // as a capture would write a row asserting "the board was read and showed
  // nothing", stamp `odds_captured_at`, and make D117's staleness indicator
  // report a fresh board that does not exist.
  if (counts.priced === 0) {
    return fail('no_prices',
      counts.racesMatched === 0
        ? 'No race in this capture matched a race on this day, so no price was read.'
        : 'This capture carried no live odds at all - the usual cause is a page saved before '
          + 'wagering opened. Nothing was written; re-save the page once the board is up.');
  }

  return { ok: true, races, updates, warnings, counts };
}
