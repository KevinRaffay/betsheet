// Entry flags (D216): the two signals a person building a HUMAN ticket asked
// to see at a glance, computed once and rendered by every entries table.
//
// PURE and browser-safe - no `node:` import, ever (the same contract
// shared/tip-staking.js holds, and for the same reason: this file is reached
// from the static at-track builder through @client/components/EntriesTable.jsx).
//
// **This DECIDES NOTHING and STAKES NOTHING.** It is a reading aid on top of
// entries that are already stored; no card, no ticket, no bucket and no
// `engine_version` is involved, which is exactly why it needs none of the
// machinery a rule-based card PRODUCER would (invariants 13 and 14). The
// person looks at the flag and builds the ticket by hand.
//
// WHY THE TRAINER TEST IS A SUBSTRING AND NOT AN EQUALITY. `entries.trainer`
// is whatever the source printed, and this corpus holds THREE spellings of
// the same person - `Bob Baffert(J. Barnes)` (160 entries), `B Baffert` (9)
// and `B. Baffert` (8); the parenthetical is the assistant trainer, which
// some Equibase captures append and others do not. A literal
// `trainer === 'B Baffert'` reaches 7 of the 163 runners in graded races -
// 4% - so an equality test here would be a silently near-empty highlight
// rather than a visibly broken one. A case-insensitive substring is what the
// request asked for and is the only form that survives the three spellings.
// It is deliberately NOT a canonicalized trainer registry
// (shared/track-codes.js's shape): that is the right answer for a staking
// rule that must be reproducible across sources, and overkill for a highlight.

import { morningLineToDecimal } from './betmath.js';

/**
 * The field size the favorite flag fires at.
 *
 * Counted over LIVE runners, not entered ones: a six-horse race that scratches
 * to five is a five-horse race by the time money is bet, and at ingest time
 * (when nothing is scratched yet) the two counts are the same anyway. The
 * consequence is deliberate and worth knowing - the flag can APPEAR on a race
 * later in the day as scratches come in, and disappear from one that shrank
 * past five.
 */
export const FAVORITE_FIELD_SIZE = 5;

const BAFFERT_RE = /baffert/i;

// Entries reach this file in three different shapes - a raw DB row
// (snake_case), the parse preview's parser output and server/replay.js's
// `entriesPayload` (both camelCase) - so both spellings are read HERE rather
// than each of the four call sites normalizing first. `EntriesTable.jsx`'s own
// `normalizeEntry` stays as it is: it feeds the RENDER, this feeds the math.
const pick = (e, camel, snake) => e?.[camel] ?? e?.[snake] ?? null;

/** Does this entry's trainer name contain "Baffert", however it was printed? */
export function isBaffertEntry(entry) {
  const trainer = entry?.trainer;
  return typeof trainer === 'string' && BAFFERT_RE.test(trainer);
}

/**
 * The morning line as a decimal RATIO (`morningLineToDecimal`'s convention -
 * "8/1" is 8, not 9; see shared/tip-staking.js's LONGSHOT_DECIMAL note).
 *
 * The stored column wins when a caller has it, because that is what the parser
 * computed and what every payout estimate already reads. `entriesPayload`
 * (replay, and so the blind race view) carries the printed string only, which
 * is why the fallback exists rather than being defensive padding.
 */
function mlDecimal(entry) {
  const stored = pick(entry, 'morningLineDecimal', 'morning_line_decimal');
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  return morningLineToDecimal(pick(entry, 'morningLine', 'morning_line'));
}

/**
 * Flags for ONE race's entries, aligned by index with the array passed in.
 * Never throws; a race it cannot read simply produces no flags.
 *
 * Returns `{ flags, liveCount, favoriteCount }` where each flag is
 * `{ baffert, favorite }`.
 *
 * A scratched horse can still be flagged `baffert` - the row is already struck
 * through, and "the Baffert horse is the one that scratched" is worth seeing -
 * but is never counted in the field and can never be the favorite.
 *
 * CO-FAVORITES ARE ALL FLAGGED rather than none. A tie means there is no
 * single favorite, and showing two `FAV` tags says that plainly, where showing
 * nothing would look identical to "this race does not qualify". Rare in
 * practice: 5 of 1,526 stored races tie at the morning-line minimum, and none
 * of them is a five-horse field.
 */
export function flagRaceEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const flags = list.map((e) => ({ baffert: isBaffertEntry(e), favorite: false }));

  const live = [];
  list.forEach((e, i) => { if (!pick(e, 'scratched', 'scratched')) live.push({ i, ml: mlDecimal(e) }); });
  const liveCount = live.length;
  if (liveCount !== FAVORITE_FIELD_SIZE) return { flags, liveCount, favoriteCount: 0 };

  const priced = live.filter((x) => typeof x.ml === 'number' && Number.isFinite(x.ml));
  if (priced.length === 0) return { flags, liveCount, favoriteCount: 0 };

  const shortest = Math.min(...priced.map((x) => x.ml));
  let favoriteCount = 0;
  for (const x of priced) {
    if (x.ml !== shortest) continue;
    flags[x.i].favorite = true;
    favoriteCount += 1;
  }
  return { flags, liveCount, favoriteCount };
}
