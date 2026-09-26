// WPS parlay builder (D436, DB of the combined-parlay plan): pick the legs of
// a cross-race win / place / show parlay with the highest chance that EVERY
// leg hits, subject to an estimated payout floor.
//
// PURE and browser-safe - no `node:` import, no database, no clock. Its input
// is shared/race-consensus.js's per-race model; its output is candidate
// tickets in the stored ticket shape, which server/combined-cards.js previews
// and saves.
//
// ONE KIND PER PARLAY. A `parlay` is all win legs, `parlay_place` all place,
// `parlay_show` all show - the grader (shared/grading.js) prices every leg of
// one ticket off one column of the chart, and a mixed ticket would need a
// per-leg kind the stored selections shape has nowhere to put.
//
// EXHAUSTIVE, NOT GREEDY. Every choice of 2..legsMax races crossed with the
// top few runners per race, per kind: a 12-race day at 4 legs and 3
// candidates is C(12,4)*3^4 = 40,095 products per kind - small enough that a
// heuristic would only add a way to be wrong.
//
// THE PAYOUT FLOOR IS CHECKED AGAINST THE LOW END of the estimate band, so
// "at least 2x" means the pessimistic reading clears 2x. Win legs price
// exactly at the odds (betmath's `winPayout`); place and show are bands
// (`placeEstimate` / `showEstimate`), because a place or show price depends on
// who else finished in the money. The odds read are the typed live board where
// one exists and the morning line otherwise - the same basis the model used.
//
// A P(HIT) HERE IS A MODEL ESTIMATE, NOT A CALIBRATED ONE. The D434 backtest
// (docs/findings/combined-parlay-v1.md) measured the combined model's show
// probabilities 3-7 points high above 50%, and 2-leg show parlays predicted at
// 72.9% hit 54.1% (20/37 days). So every candidate says so in `calibration`,
// and every candidate carries BOTH the combined model's P and the market's own
// P for the same legs - that backtest found the market at least as good, and
// a reader deserves to see both numbers rather than the flattering one.
//
// A CANDIDATE IS A LABEL, NOT A RECOMMENDATION (the D240 rule). The take is
// paid once per leg, and a parlay that cashes often can still lose money:
// every show-parlay configuration in that backtest lost 29-78%.

import {
  BET, winPayout, placeEstimate, showEstimate, tellerCall,
} from './betmath.js';

export const KIND_BET_TYPE = Object.freeze({ win: 'parlay', place: 'parlay_place', show: 'parlay_show' });
export const WPS_KINDS = Object.freeze(['win', 'place', 'show']);
export const CALIBRATION_NOTE = 'model estimate, not calibrated - see docs/findings/combined-parlay-v1.md';

const P_KEY = { win: 'combinedP', place: 'placeP', show: 'showP' };

/** Estimated return per $1 for one leg: [low, high], or null with no odds. */
export function legMultiplier(kind, odds) {
  if (typeof odds !== 'number' || !Number.isFinite(odds) || odds < 0) return null;
  if (kind === 'win') {
    const m = winPayout(100, odds) / 100;
    return [m, m];
  }
  const [lo, hi] = (kind === 'place' ? placeEstimate : showEstimate)(100, odds);
  return [lo / 100, hi / 100];
}

/**
 * Candidate legs for one race and one kind: the top `n` runners by the
 * SELECTION model's probability for that kind, each carrying both models'
 * probability and its estimate band. A runner with no readable odds is kept
 * (it can still hit) but has a null band, so it can never satisfy a floor.
 */
function raceCandidates(race, kind, selection, n) {
  const key = P_KEY[kind];
  const market = new Map((race.market?.runners ?? []).map((r) => [r.programNumber, r]));
  const combined = new Map((race.combined?.runners ?? []).map((r) => [r.programNumber, r]));
  const source = selection === 'market' ? market : combined;
  return [...source.values()]
    .sort((a, b) => b[key] - a[key])
    .slice(0, n)
    .map((r) => {
      const odds = race.oddsOf?.(r.programNumber) ?? null;
      return {
        raceNumber: race.raceNumber,
        programNumber: r.programNumber,
        pHit: r[key],
        combinedPHit: combined.get(r.programNumber)?.[key] ?? null,
        marketPHit: market.get(r.programNumber)?.[key] ?? null,
        odds,
        multiplier: legMultiplier(kind, odds),
        votes: combined.get(r.programNumber)?.votes ?? null,
      };
    });
}

/**
 * Build WPS parlay candidates for a day.
 *
 * `races` - [{ raceNumber, combined, market, oddsOf }], where `combined` and
 *           `market` are combineRace() outputs (market = MARKET_ONLY_WEIGHTS)
 *           and `oddsOf(pgm)` returns the decimal odds (board, else ML).
 *           Races whose model is null are skipped and reported.
 * `kinds` - subset of WPS_KINDS. `legsMin` / `legsMax` - 2..4.
 * `payoutFloor` - minimum LOW-end estimated return as a multiple of the
 *           stake (2 = the pessimistic estimate doubles the money), or null.
 * `stakeCents` - per ticket; must meet the bet type's minimum.
 * `selection` - 'combined' (default) or 'market': which model chooses legs.
 * `limit` - how many candidates to return, best first.
 *
 * Returns `{ candidates, skippedRaces, error }`. `error` is set (and nothing
 * built) for an input that cannot be honoured, never thrown.
 */
export function buildWpsParlays({
  races = [], kinds = WPS_KINDS, legsMin = 2, legsMax = 3, payoutFloor = null,
  stakeCents = 200, selection = 'combined', candidatesPerRace = 3, limit = 5,
} = {}) {
  const fail = (error) => ({ candidates: [], skippedRaces: [], error });
  const maxLegs = BET.parlayLegsMax;
  if (!Number.isInteger(legsMin) || !Number.isInteger(legsMax) || legsMin < 2 || legsMax > maxLegs || legsMin > legsMax) {
    return fail(`legs must be whole numbers with 2 <= legsMin <= legsMax <= ${maxLegs}`);
  }
  const wanted = (Array.isArray(kinds) ? kinds : []).filter((k) => WPS_KINDS.includes(k));
  if (wanted.length === 0) return fail('kinds must include at least one of win, place, show');
  if (selection !== 'combined' && selection !== 'market') return fail("selection must be 'combined' or 'market'");
  if (payoutFloor !== null && !(Number.isFinite(payoutFloor) && payoutFloor > 0)) return fail('payoutFloor must be a positive number or null');
  for (const k of wanted) {
    const min = BET.minimums[KIND_BET_TYPE[k]];
    if (!Number.isInteger(stakeCents) || stakeCents < min) return fail(`stake must be a whole number of cents, at least ${min} for a ${k} parlay`);
  }

  const usable = races.filter((r) => r && r.combined && r.market).sort((a, b) => a.raceNumber - b.raceNumber);
  const skippedRaces = races.filter((r) => !r || !r.combined || !r.market).map((r) => r?.raceNumber ?? null);

  const found = [];
  for (const kind of wanted) {
    const perRace = usable.map((r) => raceCandidates(r, kind, selection, candidatesPerRace)).filter((c) => c.length);
    for (let n = legsMin; n <= Math.min(legsMax, perRace.length); n++) {
      const chosen = [];
      const walk = (start) => {
        if (chosen.length === n) {
          const low = chosen.every((c) => c.multiplier) ? chosen.reduce((a, c) => a * c.multiplier[0], 1) : null;
          if (payoutFloor !== null && (low === null || low < payoutFloor)) return;
          found.push({ kind, legs: [...chosen], pHit: chosen.reduce((a, c) => a * c.pHit, 1), low });
          return;
        }
        for (let i = start; i < perRace.length; i++) {
          for (const c of perRace[i]) { chosen.push(c); walk(i + 1); chosen.pop(); }
        }
      };
      walk(0);
    }
  }

  // Best first: highest P(all legs hit); ties go to the larger pessimistic
  // payout, then fewer legs (a shorter ticket is the simpler claim).
  found.sort((a, b) => (b.pHit - a.pHit) || ((b.low ?? 0) - (a.low ?? 0)) || (a.legs.length - b.legs.length));

  const candidates = found.slice(0, Math.max(0, limit)).map((f) => toTicket(f, stakeCents, selection));
  return { candidates, skippedRaces, error: null };
}

function toTicket({ kind, legs, pHit }, stakeCents, selection) {
  const betType = KIND_BET_TYPE[kind];
  const raceNumbers = legs.map((l) => l.raceNumber);
  const pgmLegs = legs.map((l) => [l.programNumber]);
  const product = (key) => (legs.every((l) => typeof l[key] === 'number') ? legs.reduce((a, l) => a * l[key], 1) : null);
  const priced = legs.every((l) => l.multiplier);
  const low = priced ? legs.reduce((a, l) => a * l.multiplier[0], 1) : null;
  const high = priced ? legs.reduce((a, l) => a * l.multiplier[1], 1) : null;
  return {
    betType,
    kind,
    raceNumbers,
    legs: pgmLegs,
    stakeCents,
    costCents: stakeCents,
    selection,
    pHit,
    combinedPHit: product('combinedPHit'),
    marketPHit: product('marketPHit'),
    calibration: CALIBRATION_NOTE,
    estMinCents: low === null ? null : Math.round(stakeCents * low),
    estMaxCents: high === null ? null : Math.round(stakeCents * high),
    estIsRange: kind !== 'win',
    tellerCall: tellerCall(betType, raceNumbers, stakeCents, pgmLegs),
    legDetail: legs.map((l) => ({
      race: l.raceNumber, programNumber: l.programNumber, odds: l.odds,
      pHit: l.pHit, combinedPHit: l.combinedPHit, marketPHit: l.marketPHit,
      multiplier: l.multiplier, votes: l.votes,
    })),
  };
}
