// Bet math and tunables: every number the card engine plays with lives
// here, life-swipe's balance.js pattern. Change here, then run
// `npm run check-engine`. Money is integer cents throughout.

export const BET = {
  // Track wager-menu minimums, cents, used when a race's own menu is silent.
  minimums: {
    win: 200, place: 200, exacta: 100, quinella: 200, trifecta: 50,
    superfecta: 10, daily_double: 200, pick3: 50, parlay: 200,
  },

  // --- structure-layer thresholds (the Del Mar rules) ---
  placeMoneyThresholdMl: 8,   // win bets at 8-1+ carry matching place money
  oddsOnMl: 1.0,              // at or below: fade the price, not the horse
  midPriceRange: [5, 8],      // unmentioned program horses in this band still get exotic coverage
  longshotMl: 10,             // "longshot" for lottery-upside placement
  maxWinBetsPerRace: 2,       // cut hedges, keep stacks

  // --- allocation curves (selected by rules.allocationCurve, D18) ---
  allocationCurves: {
    lean: { UNANIMOUS: 2.5, SPLIT: 1.5, CHAOS: 1.8 },   // the live methodology
    spread: { UNANIMOUS: 1.7, SPLIT: 1.5, CHAOS: 1.7 }, // flatter: trust agreement less
  },
  chaosExoticShare: 0.65,     // chaos money leans toward exotics

  // --- multi-race reserve ---
  parlayStakeCents: 200,
  doubleStakeCents: 200,
  maxDoubles: 2,
  parlayLegsMax: 4,

  coverageStakeCents: 100,    // the 2+-source small-coverage adds

  // --- payout-estimate heuristics (ranges, always labeled estimates) ---
  estimates: {
    placeLow: 0.2,            // place price ~ml*0.2 .. ml*0.5 on top of stake
    placeHigh: 0.5,
    exactaFactor: 0.55,       // exacta ~ (mlA+1)(mlB+1)*factor per $1
    trifectaFactor: 0.35,
    doubleFactor: 0.6,
    rangeSpread: 0.35,        // ± band around exotic point estimates
  },
};

export const dollars = (cents) => {
  if (cents % 100 === 0) return `$${cents / 100}`;
  if (cents === 50) return '50-cent';
  if (cents === 10) return '10-cent';
  return `$${(cents / 100).toFixed(2)}`;
};

/**
 * Parse a race's printed wager menu ("$1 Exacta / 50c Trifecta / $1
 * Superfecta (10c min) / $2 WPS Parlay") into per-bet minimum stakes in
 * cents. Anything the menu doesn't name falls back to BET.minimums.
 */
export function parseWagerMenu(text) {
  const menu = { ...BET.minimums };
  if (!text) return menu;
  const t = String(text);
  const grab = (re) => {
    const m = t.match(re);
    if (!m) return null;
    if (m[1].endsWith('c')) return Number(m[1].slice(0, -1));
    return Math.round(Number(m[1].replace('$', '')) * 100);
  };
  const patterns = [
    ['exacta', /(\$[\d.]+|\d+c)\s+Exacta/i],
    ['quinella', /(\$[\d.]+|\d+c)\s+Quinella/i],
    ['trifecta', /(\$[\d.]+|\d+c)\s+Trifecta/i],
    ['daily_double', /(\$[\d.]+|\d+c)\s+(?:Rolling\s+)?(?:Daily\s+)?Double/i],
    ['pick3', /(\$[\d.]+|\d+c)\s+(?:Rolling\s+)?Pick\s*3/i],
    ['parlay', /(\$[\d.]+|\d+c)\s+WPS\s+Parlay/i],
  ];
  for (const [key, re] of patterns) {
    const v = grab(re);
    if (v) menu[key] = v;
  }
  // "$1 Superfecta (10c min)" - the parenthetical minimum wins.
  const superMin = t.match(/Superfecta\s*\((\d+)c\s*min\)/i);
  const superFlat = t.match(/(\$[\d.]+|\d+c)\s+Superfecta/i);
  if (superMin) menu.superfecta = Number(superMin[1]);
  else if (superFlat) menu.superfecta = superFlat[1].endsWith('c')
    ? Number(superFlat[1].slice(0, -1))
    : Math.round(Number(superFlat[1].replace('$', '')) * 100);
  return menu;
}

// ---------- payout estimates ----------

/** Win pays exact math at the morning line. */
export const winPayout = (stakeCents, ml) => Math.round(stakeCents * (ml + 1));

/** Place is an estimate band - live places at $6.20/$18.60 taught that. */
export function placeEstimate(stakeCents, ml) {
  const { placeLow, placeHigh } = BET.estimates;
  return [
    Math.round(stakeCents * (1 + ml * placeLow)),
    Math.round(stakeCents * (1 + ml * placeHigh)),
  ];
}

const band = (point) => {
  const s = BET.estimates.rangeSpread;
  return [Math.round(point * (1 - s)), Math.round(point * (1 + s))];
};

/** Straight exacta A over B, stake per combination. */
export function exactaEstimate(stakeCents, mlTop, mlUnder) {
  return band(stakeCents * (mlTop + 1) * (mlUnder + 1) * BET.estimates.exactaFactor);
}

/** Trifecta box: estimate for the three shortest-priced horses hitting. */
export function trifectaBoxEstimate(baseCents, mls) {
  const three = [...mls].sort((a, b) => a - b).slice(0, 3);
  const point = baseCents * three.reduce((a, m) => a * (m + 1), 1) * BET.estimates.trifectaFactor;
  return band(point);
}

export function doubleEstimate(stakeCents, mlA, mlB) {
  return band(stakeCents * (mlA + 1) * (mlB + 1) * BET.estimates.doubleFactor);
}

/** Win parlay pays exact math at the morning lines. */
export const parlayPayout = (stakeCents, mls) =>
  Math.round(mls.reduce((a, m) => a * (m + 1), stakeCents));

// ---------- teller calls ----------
// "Race N, $X bet type, numbers" - program numbers, never horse names.

export function tellerCall(betType, raceNumbers, stakeCents, legs) {
  const races = raceNumbers.length > 1
    ? `Races ${raceNumbers.join('-')}`
    : `Race ${raceNumbers[0]}`;
  const money = dollars(stakeCents);
  switch (betType) {
    case 'win':
    case 'place':
    case 'show':
      return `${races}, ${money} ${betType}, ${legs[0].join(',')}`;
    case 'exacta':
      return `${races}, ${money} exacta, ${legs[0].join(',')} over ${legs[1].join(',')}`;
    case 'exacta_box':
      return `${races}, ${money} exacta box, ${legs[0].join('-')}`;
    case 'trifecta_box':
      return `${races}, ${money} trifecta box, ${legs[0].join('-')}`;
    case 'daily_double':
      return `${races}, ${money} daily double, ${legs[0].join(',')} with ${legs[1].join(',')}`;
    case 'pick3':
      return `${races}, ${money} Pick 3, ${legs.map((l) => l.join(',')).join(' with ')}`;
    case 'parlay':
      return `${races}, ${money} win parlay, ${legs.map((l) => l.join(',')).join(' with ')}`;
    default:
      return `${races}, ${money} ${betType}, ${legs.map((l) => l.join(',')).join(' / ')}`;
  }
}

/** Cost of a straight exotic across legs (product of leg sizes) at stake per combo. */
export const comboCost = (stakeCents, legs) =>
  stakeCents * legs.reduce((a, l) => a * l.length, 1);

/** Cost of an n-horse box at base stake: n*(n-1) for exacta, n*(n-1)*(n-2) for tri. */
export const boxCost = (baseCents, n, positions) => {
  let perms = 1;
  for (let i = 0; i < positions; i++) perms *= (n - i);
  return baseCents * perms;
};
