// TIPSHEET staking (D171): a ranked tip sheet -> real tickets.
//
// PURE and browser-safe - no `node:` import, ever. It takes a race's picks, a
// per-race budget and a morning-line lookup, and returns tickets. It reads no
// database, calls no model, and decides no bankroll: the caller computes the
// budget (server/llm-cards.js's `perRaceBankrollCents`, D163's whole-dollar
// floor) and passes it in.
//
// THREE VARIANTS, NOT ONE - the D71 precedent. Rather than guess which shape
// of bet a tip sheet is worth, generate the comparable ones as separate cards
// and let backtesting decide. D170 measures whether a source's picks are any
// good; this measures whether a way of betting them makes money, and the two
// questions are answered by different cards.
//
// WHAT THIS DELIBERATELY DOES NOT DO. The supplied draft sized bets from the
// gap between the morning line and LIVE odds, skipping favourites the market
// agreed with. That logic is not here, because its input does not exist:
// `entries.live_odds` is populated on 0 of 13,710 rows across 0 of 169 race
// days, and D113 removed every fetcher that might fill it (invariant 6 - every
// source is now a file a person uploaded, and an Equibase entries page prints
// the morning line, not live prices). Run against the two real tip sheets this
// project has actually extracted, that draft produced ZERO bets and zero
// exclusions - a silently empty card, because `morningLineToDecimal(undefined)`
// is null and every NaN comparison is false. It is a good strategy waiting on
// a live-odds capture path; it is not one that can run today.
//
// WHAT IT KEEPS FROM THE DRAFT: the longshot place-money rule, which is the
// one part that works from the morning line alone.

import { tellerCall, morningLineToDecimal, boxCost } from './betmath.js';

/**
 * 8/1 and up - the threshold the place-money rule fires at.
 *
 * The supplied draft set this to 9, commented `8/1 -> decimal 9.0`. That is
 * correct for EUROPEAN DECIMAL odds (which include the stake), and wrong for
 * this codebase: `morningLineToDecimal('8/1')` returns 8, the fractional
 * RATIO, as `winPayout`'s `stake * (ml + 1)` proves. Carried over unchanged,
 * the threshold would have fired only at 9/1 and up, leaving an 8/1 horse -
 * exactly the case the rule was written for, paying $18 on a $2 win - with no
 * place money at all. Caught by this deliverable's own check.
 */
export const LONGSHOT_DECIMAL = 8;

export const TIP_VARIANTS = ['win-only', 'across-the-board', 'exacta-box-top2'];

/**
 * The variant a bucket TOTAL counts (D175).
 *
 * The three variants are MUTUALLY EXCLUSIVE alternatives - three ways to bet
 * the same picks, of which only one is ever real money - so summing them into
 * one bucket total reports three times the money that could have been staked.
 * A $500 bankroll on one race read as ~$1,498 spent, which is what surfaced
 * this.
 *
 * The headline is therefore ONE fixed variant, and fixed is the whole point:
 * picking the best-performing one per day would be cherry-picking and would
 * inflate every reported figure. `win-only` is the choice because it is the
 * simplest structure and the cheapest to reason about - the honest reading of
 * the bucket total is now "if you had bet the top pick to win, every time".
 * The other two are reported beside it as a breakdown, never added to it.
 */
export const TIP_HEADLINE_VARIANT = 'win-only';

export const TIP_VARIANT_LABEL = {
  'win-only': 'Win on the top pick',
  'across-the-board': 'Across the board on the top pick',
  'exacta-box-top2': 'Exacta box, top two picks',
};

const WPS_MIN_CENTS = 200;   // no wager menu overrides the $2 WPS floor (D146)
const WPS_STEP_CENTS = 100;

/** Largest legal stake at or below `budget`, or null when even the min won't fit. */
function fit(budget, minCents, stepCents) {
  if (budget < minCents) return null;
  return Math.floor(budget / stepCents) * stepCents;
}

/**
 * The house ticket shape: camelCase `betType`/`legs`/`stakeCents`, exactly what
 * `estimateTicketPayouts` reads and what server/equibase-otr.js passes around.
 * Emitting snake_case here made the estimator a SILENT NO-OP - its switch is on
 * `t.betType`, so every ticket fell through unpriced, which is the same class
 * of bug D67, D73 and D91 each had to repair after the fact.
 *
 * `legs` stays separate from the stored `selections`: the database column is
 * `{races, legs}` (see the real corpus), and only the SERVER knows the race
 * number, so it composes that.
 */
const ticket = (betType, legs, stakeCents, costCents, rationale) => ({
  betType,
  legs,
  stakeCents,
  costCents,
  tellerCall: tellerCall(betType, [], stakeCents, legs),
  rationale,
});

/**
 * Stake ONE race, for ONE variant. Never throws.
 *
 * `picks`       the stored ranked list
 * `perRaceCents` this race's budget (already floored to whole dollars by the caller)
 * `mlOf(pgm)`   morning line as a fraction string, or null
 * `menu`        parsed wager menu ({ exacta: 100, ... }); a null one is Del Mar's default
 * `scratched`   program numbers scratched
 *
 * Returns `{ tickets, warnings }`, each warning carrying its own `blocking`
 * boolean the way every parser here does. A race that cannot be staked comes
 * back with NO tickets and a reason - never a stake that no window would take.
 */
export function stakeTipRace(input) {
  // `input ?? {}`, not a destructuring default: a default only fires on
  // `undefined`, so an explicit null throws. Same slip as shared/tip-scoring.js
  // (D170) - made twice now, so it is written down here as well.
  const {
    picks = [], variant, perRaceCents = 0, mlOf = () => null, menu = null, scratched = [],
  } = input ?? {};
  const warnings = [];
  const warn = (code, message, blocking = false) => warnings.push({ code, message, blocking });
  if (!TIP_VARIANTS.includes(variant)) {
    warn('unknown_variant', `Unknown variant ${JSON.stringify(variant)}.`, true);
    return { tickets: [], warnings };
  }

  const scr = new Set(scratched.filter(Boolean).map((s) => String(s).toUpperCase()));
  const live = [...picks]
    .sort((a, b) => a.rank - b.rank)
    .filter((p) => !scr.has(String(p.horse_no).toUpperCase()));
  if (live.length === 0) { warn('all_scratched', 'Every pick was scratched.', false); return { tickets: [], warnings }; }
  if (perRaceCents < WPS_MIN_CENTS) {
    warn('budget_too_small', `The per-race budget is ${perRaceCents}c, below the $2 minimum wager.`, true);
    return { tickets: [], warnings };
  }

  const top = live[0];
  const legsFor = (pgms) => [pgms.map((p) => String(p))];
  const tickets = [];

  if (variant === 'exacta-box-top2') {
    if (live.length < 2) { warn('too_few_picks', 'An exacta box needs two live picks; this sheet has one.', false); return { tickets, warnings }; }
    const base = menu?.exacta ?? 100;
    const pair = [top.horse_no, live[1].horse_no];
    // A box of two is 2 combinations, so the per-combo stake is half the budget.
    const stake = fit(Math.floor(perRaceCents / 2), base, base);
    if (stake === null) {
      warn('budget_too_small', `A $${(base / 100).toFixed(2)} exacta box of two costs $${(base * 2 / 100).toFixed(2)}; the budget is $${(perRaceCents / 100).toFixed(2)}.`, true);
      return { tickets, warnings };
    }
    tickets.push(ticket('exacta_box', legsFor(pair), stake, boxCost(stake, 2, 2),
      `Top two picks (ranks ${top.rank} and ${live[1].rank}), boxed.`));
    return { tickets, warnings };
  }

  // Both remaining variants back the top LIVE pick - the horse someone reading
  // this sheet at the window would actually have bet once a scratch was up.
  if (top.rank !== picks[0]?.rank) {
    warn('top_pick_substituted', `Rank ${picks[0]?.rank} was scratched; backing rank ${top.rank} (#${top.horse_no}).`, false);
  }
  const ml = morningLineToDecimal(mlOf(top.horse_no));
  const longshot = ml !== null && ml >= LONGSHOT_DECIMAL;

  // The DRAFT'S RULE, kept: a win bet on 8/1 or better carries matching place
  // money, funded from the same per-race budget rather than added on top of it.
  // It is the only part of the supplied draft that runs without live odds, and
  // the reason it exists is a real one - live longshots ran 2nd at $6.20 and
  // $18.60 place prices with win-only money on them.
  const legs = ['win', 'place', 'show'];
  const wanted = variant === 'across-the-board' ? legs
    : longshot ? ['win', 'place'] : ['win'];

  const each = fit(Math.floor(perRaceCents / wanted.length), WPS_MIN_CENTS, WPS_STEP_CENTS);
  if (each === null) {
    // Not enough to fund every leg: fall back to a win bet rather than a stake
    // no window would take, and say so.
    const solo = fit(perRaceCents, WPS_MIN_CENTS, WPS_STEP_CENTS);
    if (solo === null) { warn('budget_too_small', 'Not enough budget for a $2 win bet.', true); return { tickets, warnings }; }
    warn('reduced_to_win', `$${(perRaceCents / 100).toFixed(2)} will not fund ${wanted.length} legs at $2 each; placing win only.`, false);
    tickets.push(ticket('win', legsFor([top.horse_no]), solo, solo, `Top pick, rank ${top.rank}.`));
    return { tickets, warnings };
  }

  for (const leg of wanted) {
    const why = leg === 'place' && longshot && variant !== 'across-the-board'
      ? `Rank ${top.rank} at ${mlOf(top.horse_no)} - matching place money on an 8/1+ pick.`
      : `Top pick, rank ${top.rank}.`;
    tickets.push(ticket(leg, legsFor([top.horse_no]), each, each, why));
  }
  if (longshot && variant === 'win-only') {
    warn('longshot_place_added', `#${top.horse_no} is ${mlOf(top.horse_no)}; matching place money added.`, false);
  }
  return { tickets, warnings };
}
