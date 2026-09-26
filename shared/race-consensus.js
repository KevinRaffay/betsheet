// Combined per-race probability model (D434, DA of the combined-parlay plan).
//
// One number per runner out of every pre-race signal this codebase stores for
// a race: the market (the typed live board where one exists, the morning line
// otherwise), the tip sheets, the LLM cards and Equibase's Off to the Races
// sheet. It is the input a multi-race builder (WPS parlays, DD / Pick N) will
// choose legs from - and, before any builder exists, the thing
// scripts/backtest-race-consensus.js measures against real results. "Benchmark
// first, bet later": nothing here stakes, stores or recommends anything.
//
// PURE and browser-safe - no `node:` import, no database, no clock.
//
// THE FORMULA, stated so a findings file can cite it:
//
//   combinedP_i  ∝  marketP_i × exp( min(maxBump, Σ_s w_s · votes_{s,i}) )
//
// renormalised so the race sums to exactly 1. It is a log-linear nudge on the
// market, never a replacement for it: with every weight at zero it returns the
// market unchanged, which is the property check-race-consensus asserts first,
// because it is the one that fails if the combination ever starts inventing
// probability out of nothing.
//
// WHY THE MARKET IS THE BASE AND THE SOURCES ONLY NUDGE IT. A tip sheet, an
// LLM and OTR all name horses; none of them prices one. The only signal in the
// building that says HOW LIKELY a horse is, rather than which one someone
// likes, is a book - so the book supplies the scale and the sources supply the
// tilt. The market reading reuses shared/entry-flags.js's fair probabilities
// (D240), already divided by their own book total over a stated basis, so a
// scratch or two books with different overrounds cannot forge a tilt here.
//
// WHY THE WEIGHTS ARE PRIORS AND NOT FITTED. On 2026-09-26 the corpus held 25
// graded days carrying tip sheets, LLM cards and results together. Fitting six
// weights to that would be fitting noise, and the fit would then be "confirmed"
// by the same races it was fitted on. So DEFAULT_WEIGHTS are stated guesses,
// exported as a contract (the MOVE_THRESHOLDS shape), and the backtest reports
// what they did - including each source alone - rather than choosing them.
//
// THE SOURCES ARE NOT INDEPENDENT, and `maxBump` exists because of it. D179
// puts the day's tip-sheet ranks and OTR tickets into the LLM prompt, so an
// LLM agreeing with the sheets is partly by construction; summing every vote
// as if each were fresh evidence would double-count that agreement. The cap
// bounds how far any pile-up can move one horse (exp(0.8) ≈ 2.2x before
// renormalising) whatever the source count.
//
// ANALYST NOTES ARE NOT READ HERE. They are free text; the LLM cards already
// read them (D63/D149), so they reach this model through the LLM votes and
// nowhere else. Parsing prose into a number here would be a second, untested
// reading of the same notes.
//
// A PROBABILITY IS A LABEL, NOT A RECOMMENDATION - the D240 rule for move
// flags, and it holds with more force here: a high P(hit) is not a positive
// expectation, because the track's take is priced into the base.

import { flagRaceEntries } from './entry-flags.js';

const up = (pgm) => String(pgm).trim().toUpperCase();

/**
 * Log-multiplier per vote. `tipTop` is per tip sheet ranking the horse 1st,
 * `tipNamed` per sheet ranking it 2nd or 3rd; `llmPrimary` per LLM model whose
 * largest win ticket is on it, `llmBacked` per model backing it on any other
 * win/place/show ticket; `otrWin` / `otrShow` for OTR's win and show picks.
 * `maxBump` caps the summed exponent for one horse.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  tipTop: 0.20,
  tipNamed: 0.08,
  llmPrimary: 0.20,
  llmBacked: 0.08,
  otrWin: 0.20,
  otrShow: 0.08,
  maxBump: 0.8,
});

/** Every weight zero: the market alone, the baseline every run compares to. */
export const MARKET_ONLY_WEIGHTS = Object.freeze({
  tipTop: 0, tipNamed: 0, llmPrimary: 0, llmBacked: 0, otrWin: 0, otrShow: 0, maxBump: 0,
});

/**
 * The market's own fair win probabilities for one race, from entries.
 *
 * Uses the typed LIVE board when entry-flags found a comparable set (two or
 * more live runners priced in both books), the MORNING LINE otherwise - and
 * says which in `basis`. A live runner the chosen book did not price (a board
 * typed for most of the field, a horse with no line) is given the smallest
 * share any priced runner has, then the race is renormalised: it is in the
 * race and can win, but no book gave it a price, and "least likely" is the
 * least-inventive reading of that. Returns null when fewer than two live
 * runners carry a price - there is no book to read.
 */
export function marketProbabilities(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const { flags, comparableCount } = flagRaceEntries(list);
  const basis = comparableCount >= 2 ? 'live' : 'ml';
  const field = [];
  list.forEach((e, i) => {
    const scratched = Boolean(e?.scratched);
    const pgm = e?.programNumber ?? e?.program_number;
    if (scratched || pgm === null || pgm === undefined || String(pgm).trim() === '') return;
    const f = flags[i];
    const p = basis === 'live' ? f.liveFairProbability : f.mlFairProbability;
    field.push({ programNumber: up(pgm), p: Number.isFinite(p) && p > 0 ? p : null });
  });
  const priced = field.filter((r) => r.p !== null);
  if (priced.length < 2) return null;
  const floor = Math.min(...priced.map((r) => r.p));
  for (const r of field) if (r.p === null) r.p = floor;
  const total = field.reduce((a, r) => a + r.p, 0);
  return { basis, probs: new Map(field.map((r) => [r.programNumber, r.p / total])) };
}

/**
 * Harville's place and show probabilities from win probabilities: the chance
 * a horse finishes in the top two / top three if every later position is won
 * in proportion to the remaining win probabilities. Known to FLATTER short
 * prices (a favorite's place chance is overstated) - which is why the backtest
 * measures these rather than trusting them. O(n^3), fine for a race.
 *
 * `probs` - Map pgm -> win probability summing to 1. Returns Maps.
 */
export function harville(probs) {
  const keys = [...probs.keys()];
  const p = keys.map((k) => probs.get(k));
  const n = p.length;
  const place = new Array(n).fill(0);
  const show = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let second = 0;
    let third = 0;
    for (let j = 0; j < n; j++) {
      if (j === i || p[j] >= 1) continue;
      const pij = p[j] * (p[i] / (1 - p[j]));           // j wins, i second
      second += pij;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const rest = 1 - p[j] - p[k];
        if (rest <= 0) continue;
        third += p[j] * (p[k] / (1 - p[j])) * (p[i] / rest); // j, k, then i
      }
    }
    place[i] = Math.min(1, p[i] + second);
    show[i] = Math.min(1, p[i] + second + third);
  }
  return {
    place: new Map(keys.map((k, i) => [k, place[i]])),
    show: new Map(keys.map((k, i) => [k, show[i]])),
  };
}

/**
 * Count one race's votes per horse from source role sets
 * (shared/pick-scoring.js's `rolesFromTipPicks` / `rolesFromTickets` shape).
 *
 * `tipRoles` - one roles object per tip sheet; rank 1 is `primary`, ranks 2-3
 *              are the rest of `named`.
 * `llmRoles` - one roles object per LLM MODEL (the caller dedupes to the
 *              newest card per model, so a regeneration never votes twice).
 * `otrRoles` - OTR's roles for the race, or null.
 */
export function countVotes({ tipRoles = [], llmRoles = [], otrRoles = null } = {}) {
  const votes = new Map();
  const at = (pgm) => {
    const k = up(pgm);
    if (!votes.has(k)) votes.set(k, { tipTop: 0, tipNamed: 0, llmPrimary: 0, llmBacked: 0, otrWin: 0, otrShow: 0 });
    return votes.get(k);
  };
  for (const r of tipRoles) {
    if (!r) continue;
    if (r.primary) at(r.primary).tipTop += 1;
    for (const p of r.named ?? []) if (up(p) !== up(r.primary ?? '')) at(p).tipNamed += 1;
  }
  for (const r of llmRoles) {
    if (!r) continue;
    if (r.primary) at(r.primary).llmPrimary += 1;
    const backed = new Set([...(r.winBacked ?? []), ...(r.placeBacked ?? []), ...(r.showBacked ?? [])].map(up));
    if (r.primary) backed.delete(up(r.primary));
    for (const p of backed) at(p).llmBacked += 1;
  }
  if (otrRoles) {
    if (otrRoles.primary) at(otrRoles.primary).otrWin += 1;
    for (const p of otrRoles.showBacked ?? []) at(p).otrShow += 1;
  }
  return votes;
}

/**
 * The combined model for ONE race.
 *
 * `entries` - the race's entries (snake or camel case; scratches included and
 *             skipped), carrying morning line and any typed live board.
 * `tipRoles` / `llmRoles` / `otrRoles` - see `countVotes`.
 * `weights` - DEFAULT_WEIGHTS unless overridden.
 *
 * Returns null when the market cannot be read (see marketProbabilities).
 * Otherwise `{ basis, runners }`, runners sorted by combinedP descending, each
 * `{ programNumber, marketP, combinedP, placeP, showP, votes, bump }`. A vote
 * for a horse not in the live field (a scratch the source did not know about)
 * is dropped - it cannot win - and never redistributed.
 */
export function combineRace({ entries, tipRoles = [], llmRoles = [], otrRoles = null, weights = DEFAULT_WEIGHTS } = {}) {
  const market = marketProbabilities(entries);
  if (!market) return null;
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const votes = countVotes({ tipRoles, llmRoles, otrRoles });
  const none = { tipTop: 0, tipNamed: 0, llmPrimary: 0, llmBacked: 0, otrWin: 0, otrShow: 0 };

  const rows = [...market.probs].map(([programNumber, marketP]) => {
    const v = votes.get(programNumber) ?? none;
    const raw = w.tipTop * v.tipTop + w.tipNamed * v.tipNamed
      + w.llmPrimary * v.llmPrimary + w.llmBacked * v.llmBacked
      + w.otrWin * v.otrWin + w.otrShow * v.otrShow;
    const bump = Math.min(w.maxBump, raw);
    return { programNumber, marketP, votes: { ...v }, bump, score: marketP * Math.exp(bump) };
  });
  const total = rows.reduce((a, r) => a + r.score, 0);
  const combined = new Map(rows.map((r) => [r.programNumber, r.score / total]));
  const { place, show } = harville(combined);

  const runners = rows.map((r) => ({
    programNumber: r.programNumber,
    marketP: r.marketP,
    combinedP: combined.get(r.programNumber),
    placeP: place.get(r.programNumber),
    showP: show.get(r.programNumber),
    votes: r.votes,
    bump: r.bump,
  })).sort((a, b) => b.combinedP - a.combinedP);
  return { basis: market.basis, runners };
}
