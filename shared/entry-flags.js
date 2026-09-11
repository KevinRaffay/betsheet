// Entry flags (D216): the two signals a person building a HUMAN ticket asked
// to see at a glance, computed once and rendered by every entries table.
//
// D223 added a third reading aid to the same flag object: `mlRank`, the
// predicted order of finish from the morning line alone (1 = the shortest
// line among LIVE, priced runners; ties share a rank and the next rank is
// skipped, so two 5/2 shots are both 1 and the 3/1 behind them is 3). It
// REPLACES the display of `entries.program_rank`, the Del Mar program
// handicapper's rank that D113 stopped ingesting - 0 of 574 entries on an
// active day carried one (D178), so every "Rank" column was a column of
// dashes. The stored column is untouched; only the reading of it moved.
//
// D224 added two more, for a person reading odds rather than building a
// ticket: `mlPayoutCents` (what "$2 to win" implies from the SAME line -
// shared/betmath.js's `impliedWinPayoutCents`) and `mlWinProbability` (the
// same line read as 0-1 odds - `impliedWinProbability`). Both are a
// FORECAST off the printed line, never the actual tote price - a day's
// `race_results.win_cents`, rendered in its own results panel once a day
// is graded, is what was really paid, and this module never reads that
// table (it would be a second, contradicting source of "what did the line
// say" mixed into "what happened"). Both are null for a scratched horse
// (it cannot cash, whatever its line said) and for an unpriced one.
//
// D240 added the LIVE BOARD beside the line, because a price only means
// something next to the price it moved from: `liveDecimal`, `liveWinProbability`
// and `liveRank` (the same three readings as the morning line, off
// `entries.live_odds_decimal` - typed at post time, D232), plus the comparison
// itself - `mlFairProbability` / `liveFairProbability` / `fairRatio` / `move` /
// `rankDelta` / `newFavorite`.
//
// WHY THE COMPARISON IS NORMALISED, AND WHY D224's RAW COLUMN IS NOT WHAT THE
// UI SHOWS ANY MORE. The raw readings stay exactly as they were -
// `mlWinProbability` and `liveWinProbability` are still `1 / (odds + 1)`, still
// sum to 118-136% over a field, and are still what a reader wanting to SEE the
// take should look at (the tables put them in each cell's tooltip). What
// changed is which of the two the columns print, and the reason is that a raw
// delta is not a move.
//
// Measured on a real six-horse race while building this: the morning-line book
// summed to 126% and the typed board to 136%, so every one of the six raw
// deltas carried the same +1.7-point offset before any horse moved at all - a
// 4/1 drifting to 7/2, which is nothing, printed as "+2.2". The six raw deltas
// summed to +10.4 points, which is the difference between the two book totals
// and not an opinion anyone formed. A SCRATCH is the same failure, larger: two
// of ten scratching redistributes their whole share of the pool across the
// survivors, so every remaining runner's raw live probability rises with
// nobody having bet a dollar - a race-wide false STEAM.
//
// So both books are divided by their own total over the BASIS (below), which
// cancels the scratch, cancels the two books having different overrounds, and
// leaves a genuine reallocation of opinion: the deltas across a race now sum to
// zero, and a horse reads as moved only if some other horse moved the other
// way. `fairRatio` and `move` ride on the same figures, so the number in the
// column and the tag on the name can never disagree.
//
// **A FLAG IS A LABEL, NOT A RECOMMENDATION.** `move` says the price moved and
// which way. It does NOT say the horse is worth backing, and this module must
// never grow a rule that does: the two readings of a steamer (follow the money
// / the drifter is now the value) are contradictory, both have a literature,
// and which one pays on THIS corpus is an open question that
// docs/requirements/post-time-odds-llm-comparison.md exists to answer with an
// `n`. Asserting an edge here would be concluding it by UI instead.
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

import { impliedWinPayoutCents, impliedWinProbability, morningLineToDecimal } from './betmath.js';

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

/**
 * When a price move is worth pointing at (D240).
 *
 * `moderateRatio` / `bigRatio` are ratios of NORMALISED win probability
 * (live / morning line), so they are scale-free: 20/1 -> 12/1 and 2/1 -> 6/5
 * are both "the market backed this about 60% harder than the linemaker
 * predicted", and a percentage-point test alone would flag only the second.
 * The linemaker is forecasting THE CROWD, not the horse, so a big ratio is
 * the crowd disagreeing with a professional's read of the crowd.
 *
 * `minDelta` is a noise floor in absolute probability (0.01 = one percentage
 * point) on the RATIO test only, and it exists because the long end of the
 * board is quantised - a tote that prints 50/1, 60/1, 99/1 makes ratios out
 * there mostly rounding. 50/1 -> 30/1 is a 1.6x ratio and +1.3 points, so it
 * survives; 99/1 -> 60/1 is the same ratio and +0.6 points, and does not.
 *
 * `moderateDelta` / `bigDelta` are the OTHER half, and the two tests are ORed
 * rather than ANDed. That is the correction to the obvious design, and it is
 * load-bearing: the ratio test alone systematically MISSES the favorite. A
 * 5/2 shot bet to 8/5 is a 1.24x ratio - under the moderate bar - while being
 * +8 points of the whole book, which is the most money any single move in a
 * race represents. Symmetrically the points test alone misses the entire long
 * end, where nothing can move 5 points. So: a move counts if it is large in
 * PROPORTION (what the crowd did to the price) or large in SHARE (what it did
 * to the book), and the two together cover a board from 2/5 to 50/1.
 *
 * Exported so the thresholds are a stated number rather than a magic literal
 * buried in a branch, and so check-entry-flags can pin them.
 */
export const MOVE_THRESHOLDS = {
  moderateRatio: 1.25,
  bigRatio: 1.6,
  moderateDelta: 0.05,
  bigDelta: 0.1,
  minDelta: 0.01,
};

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
 * The live board as a decimal RATIO, same convention and same fallback shape
 * as `mlDecimal` (D240).
 *
 * `entries.live_odds_decimal` is written by shared/live-odds.js through the
 * very same `morningLineToDecimal`, so the two prices are arithmetically
 * comparable by construction rather than by coincidence.
 */
function liveDecimal(entry) {
  const stored = pick(entry, 'liveOddsDecimal', 'live_odds_decimal');
  if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
  return morningLineToDecimal(pick(entry, 'liveOdds', 'live_odds'));
}

/**
 * Name a move, or return null when there is nothing worth pointing at.
 * `ratio` is normalised live / normalised morning line; `delta` is their
 * difference in absolute probability. EITHER test can fire - see
 * MOVE_THRESHOLDS for why neither is sufficient alone.
 */
function classifyMove(ratio, delta) {
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(delta)) return null;
  const t = MOVE_THRESHOLDS;
  const direction = ratio > 1 ? 'steam' : 'drift';
  const strength = ratio > 1 ? ratio : 1 / ratio;       // how hard, either way
  const size = Math.abs(delta);                          // share of the book
  const byRatio = (bar) => strength >= bar && size >= t.minDelta;
  if (byRatio(t.bigRatio) || size >= t.bigDelta) return { direction, magnitude: 'big', ratio, delta };
  if (byRatio(t.moderateRatio) || size >= t.moderateDelta) return { direction, magnitude: 'moderate', ratio, delta };
  return null;
}

/**
 * Flags for ONE race's entries, aligned by index with the array passed in.
 * Never throws; a race it cannot read simply produces no flags.
 *
 * Returns `{ flags, liveCount, favoriteCount }` where each flag is
 * `{ baffert, favorite, mlRank, mlDecimal, mlPayoutCents, mlWinProbability }`.
 * `mlRank` is null for a scratched or unpriced horse - a scratch has no
 * predicted finish, and "no line" is not "last". `mlPayoutCents` and
 * `mlWinProbability` follow the same rule (see the D224 note above) plus
 * one more: they are null for a SCRATCHED horse even when it carried a
 * price, since a scratch cannot cash.
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
  const flags = list.map((e) => {
    const scratched = Boolean(pick(e, 'scratched', 'scratched'));
    const decimal = mlDecimal(e);
    // Named `board` rather than `liveDecimal` only so the local does not read
    // like the module-scope function of that name two lines below it.
    const board = liveDecimal(e);
    return {
      baffert: isBaffertEntry(e),
      favorite: false,
      mlRank: null,
      mlDecimal: decimal,
      // D224: null for a scratch regardless of what its line said (it
      // cannot cash); impliedWinPayoutCents/impliedWinProbability already
      // return null on their own for an unpriced line.
      mlPayoutCents: scratched ? null : impliedWinPayoutCents(decimal),
      mlWinProbability: scratched ? null : impliedWinProbability(decimal),
      // D240. Null on a scratch for the same reason the two above are: a
      // horse that is out cannot be backed, whatever the board still shows.
      liveDecimal: scratched ? null : board,
      liveWinProbability: scratched ? null : impliedWinProbability(board),
      liveRank: null,
      // The comparison, filled in below only for the COMPARABLE SET. Null
      // here is not "no move" - it is "this horse cannot be compared", which
      // the UI must render as a dash rather than as a zero.
      mlFairProbability: null,
      liveFairProbability: null,
      fairRatio: null,
      move: null,
      rankDelta: null,
      newFavorite: false,
    };
  });

  const live = [];
  list.forEach((e, i) => { if (!pick(e, 'scratched', 'scratched')) live.push({ i, ml: flags[i].mlDecimal }); });
  const liveCount = live.length;
  const priced = live.filter((x) => typeof x.ml === 'number' && Number.isFinite(x.ml));

  // D223: the morning-line rank, on every race regardless of field size.
  // Competition ranking ("1, 1, 3"): a tie is reported as a tie, the same
  // reasoning as co-favorites both being flagged rather than neither.
  const ordered = [...priced].sort((a, b) => a.ml - b.ml);
  ordered.forEach((x, pos) => {
    flags[x.i].mlRank = pos > 0 && ordered[pos - 1].ml === x.ml ? flags[ordered[pos - 1].i].mlRank : pos + 1;
  });

  // ---- the live board (D240) ----------------------------------------------
  // Same three readings as the morning line, off the typed post-time price,
  // and then the one thing neither price can say alone: what CHANGED.
  const livePriced = live.filter((x) => Number.isFinite(flags[x.i].liveDecimal));
  const liveOrdered = [...livePriced].sort((a, b) => flags[a.i].liveDecimal - flags[b.i].liveDecimal);
  liveOrdered.forEach((x, pos) => {
    const prev = pos > 0 ? liveOrdered[pos - 1].i : null;
    flags[x.i].liveRank = prev !== null && flags[prev].liveDecimal === flags[x.i].liveDecimal
      ? flags[prev].liveRank
      : pos + 1;
  });

  // The COMPARABLE SET: live, and carrying BOTH prices. A horse priced in only
  // one book has no move to report - saying "unchanged" for it would be an
  // invention, and including it in either total would make the two books sum
  // over different fields, which is the whole thing normalising is for.
  const comparable = livePriced.filter((x) => Number.isFinite(flags[x.i].mlDecimal));
  const comparing = comparable.length >= 2;
  // THE BASIS - the runners a share is a share OF. With a board it is the
  // comparable set, so both books divide by a total over the SAME horses and
  // the deltas across the race sum to exactly zero. With no board there is
  // nothing to compare against and it falls back to the morning-line-priced
  // live runners, which keeps ML Win% populated everywhere it has ever been
  // (the ingest preview, the static at-track builder) instead of blanking a
  // column that predates this change. One field, one meaning either way:
  // "this horse's share of its own book, over the runners being compared".
  const basis = comparing ? comparable : priced;
  const mlTotal = basis.reduce((a, x) => a + flags[x.i].mlWinProbability, 0);
  if (basis.length >= 2 && mlTotal > 0) {
    for (const x of basis) flags[x.i].mlFairProbability = flags[x.i].mlWinProbability / mlTotal;
  }
  const liveTotal = comparable.reduce((a, x) => a + flags[x.i].liveWinProbability, 0);
  // Two is the smallest field where a share of the book means anything: with
  // one horse both books normalise to 1.0 and every ratio is exactly 1.
  if (comparing && mlTotal > 0 && liveTotal > 0) {
    for (const x of comparable) {
      const f = flags[x.i];
      f.liveFairProbability = f.liveWinProbability / liveTotal;
      f.fairRatio = f.liveFairProbability / f.mlFairProbability;
      f.move = classifyMove(f.fairRatio, f.liveFairProbability - f.mlFairProbability);
      // Positive = moved UP the board (shorter price than the line predicted).
      // Both ranks are over live runners, but over slightly different sets when
      // a horse carries only one of the two prices, so this is reported only
      // where both exist rather than treated as a missing rank being last.
      f.rankDelta = f.mlRank !== null && f.liveRank !== null ? f.mlRank - f.liveRank : null;
      // The single most-read board fact: the crowd made a different favorite
      // than the linemaker did. Distinct from `favorite`, which is the D216
      // five-horse-field morning-line flag and is unrelated.
      f.newFavorite = f.liveRank === 1 && f.mlRank !== null && f.mlRank !== 1;
    }
  }

  const shortest = priced.length ? Math.min(...priced.map((x) => x.ml)) : null;
  let favoriteCount = 0;
  if (liveCount === FAVORITE_FIELD_SIZE && priced.length > 0) {
    for (const x of priced) {
      if (x.ml !== shortest) continue;
      flags[x.i].favorite = true;
      favoriteCount += 1;
    }
  }
  return { flags, liveCount, favoriteCount, livePricedCount: livePriced.length, comparableCount: comparable.length };
}
