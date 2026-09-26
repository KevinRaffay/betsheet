// Bet math and tunables: every number the card engine plays with lives
// here, life-swipe's balance.js pattern. Change here, then run
// `npm run check-engine`. Money is integer cents throughout.

export const BET = {
  // Track wager-menu minimums, cents, used when a race's own menu is silent.
  minimums: {
    win: 200, place: 200, exacta: 100, quinella: 200, trifecta: 50,
    superfecta: 10, daily_double: 200, pick3: 50, parlay: 200,
    // D436: our own WPS-parlay construct, priced like the win parlay.
    parlay_place: 200, parlay_show: 200,
    // D442: fallbacks for a menu that names Pick 4 / Pick 5 without printing
    // an amount. $1, not the more common 50c, on purpose: a base ABOVE a
    // track's minimum is still a legal ticket, one BELOW it is refused at the
    // window, and $1 is at or above every pick4/pick5 base in the corpus's
    // charts (20c / 50c / $1). The builder labels any fallback as ASSUMED.
    pick4: 100, pick5: 100,
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
    // D48: keyed to the program's Best Bet flag - the one confidence signal a
    // PROGRAM_ONLY day carries. Flat across classifications; the Best Bet race
    // takes the heavy weight. A day with no Best Bet is simply flat.
    'best-bet': { UNANIMOUS: 1.5, SPLIT: 1.5, CHAOS: 1.5, bestBet: 3.0 },
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
    // D436: show ~ 1 + ml*0.065 .. 1 + ml*0.2 per $1. MEASURED, not tuned:
    // the interquartile range of (show_cents/200 - 1) / morning-line decimal
    // over 1,050 in-the-money finishers on the live corpus, 2026-09-26
    // (median 0.125). The same query puts place at 0.167 .. 0.40 (n=713),
    // which is why placeLow/placeHigh above were left alone.
    showLow: 0.065,
    showHigh: 0.2,
    // D442: what a multi-race pool actually pays, per base, as a fraction of
    // the winners' morning-line odds chained (product of 1 / fair ML
    // probability). MEASURED, not tuned: the interquartile range of
    // payout_per_base / prod(1/q_ml) over every stored DD / Pick N payoff on the
    // live corpus, 2026-09-26 - DD n=316 (median 0.567), Pick 3 n=276 (0.443),
    // Pick 4 n=73 (0.317), Pick 5 n=66 (0.235). The shortfall against a
    // chained parlay is the pool's takeout plus the linemaker being wrong
    // about who the crowd will back. Pick 6 is deliberately ABSENT: n=16,
    // median 0.003 - jackpot and carryover pools pay mostly consolations, so
    // no band estimates what a full hit pays.
    poolFactor: {
      daily_double: [0.365, 0.837],
      pick3: [0.235, 0.699],
      pick4: [0.096, 0.595],
      pick5: [0.062, 0.453],
    },
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

// ---------- teller money token (D84) ----------
// The canonical money token the teller grammar emits and parses. Deliberately
// separate from dollars() above, which keeps its prose spellings ("50-cent")
// for engine warning text and the OTR panel: a teller ticket always LEADS with
// the money, so the token has to be uniform enough to detect a line by.

/** Canonical emission: $25, $1, $2.50, $0.50, $0.10. Always leads with '$'. */
export const moneyToken = (cents) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/**
 * Accepts anything a human might write for a stake and canonicalizes it:
 * '$25', '$2.50', '$.50', '.50', '50c', '50¢', '50-cent', '10 cents'.
 * Returns cents, or null when the string is not a money token at all -
 * `parseMoneyToken(moneyToken(c)) === c` for every c >= 1.
 */
export function parseMoneyToken(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const cent = s.match(/^(\d+(?:\.\d+)?)\s*(?:c|¢|-?cents?)$/i);
  if (cent) return Math.round(Number(cent[1]));
  const dollar = s.match(/^\$?(\d*(?:\.\d+)?)$/);
  if (!dollar || dollar[1] === '' || dollar[1] === '.') return null;
  const n = Number(dollar[1]);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// The money token a printed menu leads a bet type with. Deliberately wider
// than "$N or Nc": Woodbine prints "0.20 Trifecta" and Fort Erie prints
// "20 Cent Triactor", and reading neither is what made a legal 20c box unbuildable
// (D213) - the menu said 20c, the parser fell back to BET.minimums' 50c and
// refused the ticket. Three shapes, in order:
//   $1 / $.50 / $0.20   - the dollar-signed token
//   50c / 20¢ / 20 Cent / 20 cents / 20-cent
//   .50 / 0.20          - a BARE DECIMAL, never a bare integer
// The bare form must carry a decimal point. A bare integer would read the
// race numbers in "Double ($1) 9 & 10 Pick 3 ($1) (9-11)" - a real menu in
// this corpus - as a $10 Pick 3, and no menu here prints a whole-dollar
// amount without a '$'. Amounts are converted by parseMoneyToken above, so
// the menu and the teller grammar read money through ONE function.
const MENU_AMOUNT = String.raw`(\$[\d.]+|\d+(?:\.\d+)?\s*(?:¢|-?cents?|c)|\d*\.\d+)`;
const menuRe = (tail) => new RegExp(MENU_AMOUNT + tail, 'i');

// The printed-menu patterns, module level so parseWagerMenu (which minimum?)
// and wagerMenuOffered (is it sold at all?) can never drift apart.
// Exactor/Triactor are the Canadian names for the exacta/trifecta and are what
// Fort Erie and Assiniboia Downs print - the same bet, not a new one.
const MENU_PATTERNS = [
  ['exacta', menuRe(String.raw`\s+Exact(?:a|or)`)],
  ['quinella', menuRe(String.raw`\s+Quinella`)],
  ['trifecta', menuRe(String.raw`\s+Tri(?:fecta|actor)`)],
  ['daily_double', menuRe(String.raw`\s+(?:Rolling\s+)?(?:Daily\s+)?Double`)],
  ['pick3', menuRe(String.raw`\s+(?:Rolling\s+)?Pick\s*(?:3|Three)\b`)],
  // D442: Pick 4/5/6, and the spelled-out names - "$1 Pick Three (Races
  // 1-2-3)" is on 33 stored menus and read as the 50c fallback before this.
  ['pick4', menuRe(String.raw`\s+(?:Rolling\s+)?Pick\s*(?:4|Four)\b`)],
  ['pick5', menuRe(String.raw`\s+(?:Rolling\s+)?Pick\s*(?:5|Five)\b`)],
  ['pick6', menuRe(String.raw`\s+(?:Rolling\s+)?Pick\s*(?:6|Six)\b`)],
  ['parlay', menuRe(String.raw`\s+WPS\s+Parlay`)],
];
const SUPER_FLAT_RE = menuRe(String.raw`\s+Superfecta`);
const menuCents = (tok) => parseMoneyToken(tok);

// The OTHER shape a printed menu takes: the bet type first, its amount in a
// trailing parenthetical - "Exacta ($1), Trifecta (.50), Super (.10), Double
// ($1)" and "$1 Superfecta (10c min)". D214. The parenthetical is the real
// minimum and WINS over any amount printed before the name, which is exactly
// what the older Superfecta-only rule this replaces already did - generalised
// rather than left as one bet type's special case.
const MENU_TRAILING = [
  ['exacta', /Exact(?:a|or)\s*\(([^)]*)\)/i],
  ['quinella', /Quinella\s*\(([^)]*)\)/i],
  ['trifecta', /Tri(?:fecta|actor)\s*\(([^)]*)\)/i],
  ['superfecta', /Super(?:fecta)?\s*\(([^)]*)\)/i],
  ['daily_double', /(?:Rolling\s+|Daily\s+)?Double\s*\(([^)]*)\)/i],
  ['pick3', /(?:Rolling\s+)?Pick\s*(?:3|Three)\s*\(([^)]*)\)/i],
  ['pick4', /(?:Rolling\s+)?Pick\s*(?:4|Four)\s*\(([^)]*)\)/i],
  ['pick5', /(?:Rolling\s+)?Pick\s*(?:5|Five)\s*\(([^)]*)\)/i],
  ['pick6', /(?:Rolling\s+)?Pick\s*(?:6|Six)\s*\(([^)]*)\)/i],
];

/**
 * A trailing parenthetical's amount, or null when it holds something else.
 * Nearly every parenthetical on a real menu is a RACE LIST - "(Races 1-2-3)",
 * "(9-11)", "(4-7)" - so this demands a money MARKER ('$', a decimal point, or
 * a cents word) and refuses a bare integer, the same rule and the same reason
 * as MENU_AMOUNT above: "Pick 4 (4)" is a race, not a $4 minimum.
 */
function menuParenCents(content) {
  // D442: "Minimum" as well as "min" - Remington Park prints "(.50 Cent Minimum)".
  let t = String(content ?? '').trim().replace(/\s*min(?:imum)?\.?$/i, '').trim();
  if (!/[$.]|c\s*$|¢|cents?/i.test(t)) return null;
  // ".50 Cent" / ".10 Cent": a DECIMAL DOLLAR amount with a redundant cents
  // word. Read as the decimal ($0.50 = 50c), which is what both spellings mean;
  // parseMoneyToken would reject the pair, and it stays strict because it is
  // the teller grammar's reader too. Menu-only, so the teller is unaffected.
  const dec = t.match(/^\$?(\d*\.\d+)\s*(?:¢|-?cents?)$/i);
  if (dec) t = dec[1];
  return parseMoneyToken(t);
}

/**
 * A trailing-parenthetical amount for one MENU_TRAILING pattern, or null.
 * D442: the amount may follow a RACE LIST rather than the name -
 * "Pick 3 (Races 3-4-5) (.50 Cent Minimum)" - so when the first parenthetical
 * holds no money, the one right after it is tried. Only one: a menu's next
 * parenthetical beyond that belongs to the next bet type.
 */
function trailingCents(t, re) {
  const m = t.match(re);
  if (!m) return null;
  const first = menuParenCents(m[1]);
  if (first != null) return first;
  const next = t.slice(m.index + m[0].length).match(/^\s*\(([^)]*)\)/);
  return next ? menuParenCents(next[1]) : null;
}

/**
 * Parse a race's printed wager menu ("$1 Exacta / 50c Trifecta / $1
 * Superfecta (10c min) / $2 WPS Parlay") into per-bet minimum stakes in
 * cents. Anything the menu doesn't name falls back to BET.minimums.
 */
export function parseWagerMenu(text) {
  const menu = { ...BET.minimums };
  if (!text) return menu;
  const t = String(text);
  for (const [key, re] of MENU_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const v = menuCents(m[1]);
      if (v) menu[key] = v;
    }
  }
  const superFlat = t.match(SUPER_FLAT_RE);
  if (superFlat) {
    const v = menuCents(superFlat[1]);
    if (v) menu.superfecta = v;
  }
  // "Trifecta (.50)" / "$1 Superfecta (10c min)" - the bet type first, its
  // amount trailing. Applied LAST so the parenthetical wins a disagreement.
  for (const [key, re] of MENU_TRAILING) {
    const v = trailingCents(t, re);
    if (v) menu[key] = v;
  }
  return menu;
}

/**
 * Which bet types the printed menu ACTUALLY names (D84). parseWagerMenu can't
 * answer this - it always returns every key, falling back to BET.minimums, so
 * `menu.trifecta` is 50 even on a race whose menu never says "Trifecta". The
 * builder uses this only to LABEL a minimum honestly ("this race's menu" vs
 * "assumed"); it never gates what can be built, because races.wager_menu is
 * free text and frequently null, and hiding a bet type that is in fact sold is
 * worse than offering one that isn't.
 */
export function wagerMenuOffered(text) {
  const offered = new Set();
  if (!text) return offered;
  const t = String(text);
  for (const [key, re] of MENU_PATTERNS) if (re.test(t)) offered.add(key);
  if (SUPER_FLAT_RE.test(t)) offered.add('superfecta');
  for (const [key, re] of MENU_TRAILING) {
    if (trailingCents(t, re) != null) offered.add(key);
  }
  return offered;
}

// ---------- multi-race pools on a menu (D442) ----------

/** Legs per multi-race pool. */
export const POOL_LEGS = Object.freeze({ daily_double: 2, pick3: 3, pick4: 4, pick5: 5, pick6: 6 });

// The pool's NAME alone, with or without an amount - unlike MENU_PATTERNS,
// which only fire on "amount then name". "Daily Double / Exacta / Trifecta /
// Superfecta / Pick 3 (Races 2-3-4)" prints no amounts at all and still sells
// both pools, so whether a pool is offered cannot depend on a money token.
const POOL_NAME_RE = {
  daily_double: /(?:Rolling\s+|Daily\s+)?Double\b/i,
  pick3: /Pick\s*(?:3|Three)\b/i,
  pick4: /Pick\s*(?:4|Four)\b/i,
  pick5: /Pick\s*(?:5|Five)\b/i,
  pick6: /Pick\s*(?:6|Six)\b/i,
};

/**
 * The race list printed right after a pool's name, as numbers, or null when
 * none is printed (or it cannot be read). Shapes in the corpus:
 * "(Races 2-3-4)", "(Races 1-5)" (a RANGE, for a Pick 5), "($1) (3-5)" (a
 * range after a money parenthetical), and a double's bare "($1) 3 & 4".
 */
function raceListAfter(tail, legs) {
  let rest = String(tail ?? '');
  // Skip a money parenthetical first - "($1)", "(.50)", "(10c min)".
  const money = rest.match(/^\s*\(([^)]*)\)/);
  if (money && menuParenCents(money[1]) != null) rest = rest.slice(money[0].length);
  const paren = rest.match(/^\s*\(\s*(?:Races?\s*)?(\d+(?:\s*[-–,&]\s*\d+)*)\s*\)/i);
  const bare = rest.match(/^\s*(\d+\s*&\s*\d+)/);
  const list = paren?.[1] ?? bare?.[1];
  if (!list) return null;
  const nums = list.split(/\s*[-–,&]\s*/).map(Number).filter(Number.isFinite);
  let races = nums;
  if (nums.length === 2 && legs > 2 && nums[1] - nums[0] + 1 === legs) {
    races = Array.from({ length: legs }, (_, i) => nums[0] + i);
  }
  const consecutive = races.length === legs && races.every((n, i) => i === 0 || n === races[i - 1] + 1);
  // A list IS printed but is not N consecutive races - Gulfstream's "Tropical
  // Turf Pick 3 (Races 2, 6, 9)". That is a real pool, just not one a
  // consecutive-legs builder can express, so it must read as NOT BUILDABLE
  // rather than fall through to "no list, rolling from here", which would
  // have offered a Pick 3 on races 2-3-4 at the $3 base.
  return consecutive ? races : 'unbuildable';
}

/** Did the menu PRINT this bet type's amount (vs parseWagerMenu falling back)? */
function printedMinimum(t, key) {
  const lead = MENU_PATTERNS.find(([k]) => k === key)?.[1];
  const trail = MENU_TRAILING.find(([k]) => k === key)?.[1];
  const a = lead ? t.match(lead) : null;
  if (a && menuCents(a[1])) return true;
  return Boolean(trail && trailingCents(t, trail) != null);
}

/**
 * Which multi-race pools START at this race, per its printed menu.
 * Returns { [pool]: { legs, races, baseCents, baseSource } } where `races`
 * are the leg race numbers (starting at `raceNumber`), `baseCents` the
 * minimum base (parseWagerMenu's reading) and `baseSource` 'menu' when the
 * menu printed it or 'assumed' when it fell back to BET.minimums.
 *
 * A pool whose printed race list starts ANYWHERE ELSE is not offered here:
 * across the corpus, 375 of 376 printed lists start at the race whose menu
 * prints them, and the one exception ("Pick 4 (Races 4-5-6-7)" on a race 9
 * menu) is a source error that must not become a ticket on races 9-12.
 * With no list printed, the pool is read as starting here, the rolling
 * convention every such menu follows.
 */
export function menuPools(text, raceNumber) {
  const out = {};
  if (!text || !Number.isInteger(raceNumber)) return out;
  const t = String(text);
  const menu = parseWagerMenu(t);
  for (const [pool, legs] of Object.entries(POOL_LEGS)) {
    const m = t.match(POOL_NAME_RE[pool]);
    if (!m) continue;
    const listed = raceListAfter(t.slice(m.index + m[0].length, m.index + m[0].length + 48), legs);
    if (listed === 'unbuildable') continue;
    if (listed && listed[0] !== raceNumber) continue;
    out[pool] = {
      legs,
      races: listed ?? Array.from({ length: legs }, (_, i) => raceNumber + i),
      baseCents: menu[pool] ?? null,
      baseSource: printedMinimum(t, pool) ? 'menu' : 'assumed',
    };
  }
  return out;
}

// ---------- payout estimates ----------

/** Win pays exact math at the morning line. */
// A printed morning line ("6/1", "7/2", "4") as the DECIMAL every payout
// function here takes. Moved from shared/entries-parser.js (D109), which the
// pivot deletes: this is odds math, it belongs beside the payout formulas
// that consume it, and shared/parsers/equibase-entries.js needs it to
// outlive its old home.
export function morningLineToDecimal(ml) {
  if (!ml || ml === '-') return null;
  const m = ml.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!den) return null;
  return num / den;
}

export const winPayout = (stakeCents, ml) => Math.round(stakeCents * (ml + 1));

/**
 * The $2 win price a morning line implies - what "$2 to win" would pay if
 * the horse wins, at winPayout's own $2 minimum. D224.
 *
 * NOT A PROMISE: the morning line is the track handicapper's forecast of
 * where the public's money will go, not a live market - the price actually
 * paid at post is usually different (often quite different). What was
 * really paid lives in `race_results.win_cents`, once a day has one.
 */
export const impliedWinPayoutCents = (ml) => (
  typeof ml === 'number' && Number.isFinite(ml) ? winPayout(200, ml) : null
);

/**
 * The implied win probability a decimal morning line encodes, 0-1. D224.
 * `1 / (ml + 1)` is the standard decimal-odds-to-probability conversion -
 * a 5/2 shot (`ml` 2.5) implies 1/3.5, about 29%.
 *
 * Summed across a full field this reads well over 1 (100%) - that is the
 * OVERROUND, the track's built-in take, made visible rather than a bug in
 * this function. Every line already prices in the house edge.
 */
export function impliedWinProbability(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml < 0) return null;
  return 1 / (ml + 1);
}

/** Place is an estimate band - live places at $6.20/$18.60 taught that. */
export function placeEstimate(stakeCents, ml) {
  const { placeLow, placeHigh } = BET.estimates;
  return [
    Math.round(stakeCents * (1 + ml * placeLow)),
    Math.round(stakeCents * (1 + ml * placeHigh)),
  ];
}

/**
 * Show is an estimate band too (D436). See BET.estimates.showLow/showHigh for
 * where the constants came from - a show price is the least predictable of
 * the three, because the pool splits three ways and the other two finishers
 * decide what is left.
 */
export function showEstimate(stakeCents, ml) {
  const { showLow, showHigh } = BET.estimates;
  return [
    Math.round(stakeCents * (1 + ml * showLow)),
    Math.round(stakeCents * (1 + ml * showHigh)),
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

/**
 * "If it hits" for a card's tickets (D91). ONE dispatcher over the validated
 * formulas above, shared by every non-engine picker: server/human-cards.js,
 * server/llm-cards.js (D67) and server/equibase-otr.js (D73) each had their
 * own copy - the OTR one a strict subset of the LLM one - and a third would
 * have arrived with human cards.
 *
 * `mlOf(programNumber) -> decimal odds | null` rather than an entries array:
 * `program_number` / `morning_line_decimal` are DB vocabulary and this file is
 * browser-safe with no imports, so the shape boundary stays at the caller's
 * one-line adapter. It also lets a backfill feed per-race SQL straight in.
 *
 * A ticket is returned UNCHANGED BY IDENTITY when its type has no validated
 * formula here, or when a selection has no morning line. Deliberately absent:
 * show, straight trifecta, superfecta, superfecta_box - no validated formula
 * exists anywhere in this codebase (the engine never emits them) and inventing
 * a multiplier beside BET.estimates' tuned constants would be guessing with
 * money math. Leave them null; the sheet prints an honest dash.
 *
 * NOT to be unified with shared/card-engine.js's inline estimates - which are
 * gone with the engine (D111); this note stays because the estimates they
 * wrote are still on every stored lean card and must not be recomputed. Those
 * are computed mid-construction with context this dispatcher does not have
 * (mlForPlaceRule, the box's own est list, straight exactas priced off the
 * LONGEST-priced under, and the rebalancer rewriting est after a stake moves).
 * Folding them in would change every stored lean estimate and would be an
 * engine change requiring an ENGINE_VERSION bump (invariant 14).
 */
export function estimateTicketPayouts(tickets, mlOf) {
  const shortestFirst = (leg) => (leg ?? []).map(mlOf).filter((m) => m != null).sort((a, b) => a - b);
  const band = (t, [lo, hi]) => ({ ...t, estMinCents: lo, estMaxCents: hi, estIsRange: true });

  return tickets.map((t) => {
    const legs = t.legs ?? [];
    switch (t.betType) {
      case 'win': {
        const ml = mlOf(legs[0]?.[0]);
        if (ml == null) return t;
        const p = winPayout(t.stakeCents, ml);
        return { ...t, estMinCents: p, estMaxCents: p, estIsRange: false };
      }
      case 'place': {
        const ml = mlOf(legs[0]?.[0]);
        return ml == null ? t : band(t, placeEstimate(t.stakeCents, ml));
      }
      case 'exacta': {
        const top = mlOf(legs[0]?.[0]);
        const under = mlOf(legs[1]?.[0]);
        return (top == null || under == null) ? t : band(t, exactaEstimate(t.stakeCents, top, under));
      }
      case 'exacta_box': {
        // The two SHORTEST-priced in the box: the low end of what the box can
        // return. Identical across HUMAN / LLM_GENERATED / EQB_OTR on purpose -
        // it is what keeps those buckets comparable.
        const mls = shortestFirst(legs[0]);
        return mls.length < 2 ? t : band(t, exactaEstimate(t.stakeCents, mls[0], mls[1]));
      }
      case 'trifecta_box': {
        const mls = shortestFirst(legs[0]);
        return mls.length < 3 ? t : band(t, trifectaBoxEstimate(t.stakeCents, mls));
      }
      default:
        return t;
    }
  });
}

// ---------- teller calls (D84) ----------
// The grammar you actually say at the window, and the ONE format this codebase
// emits and parses:
//
//   [Races a-b ] <money> <TYPE> <pos1> [WITH <pos2> [WITH <pos3> ...]]
//
// e.g. "$10 W 5", "$2 EX BOX 2-4-5", "$1 TRI 5 WITH 2-4 WITH 2-4".
//
// The money is the PER-COMBO base, exactly as a teller quotes it - total cost
// is stakeCents x the combination count, never stated. WITH separates finishing
// POSITIONS; '-' separates alternatives within a position (and the horses of a
// box). A race prefix appears only on multi-race tickets, which span races and
// have nowhere else to say so; a single-race ticket is bare, so the string the
// ticket builder composes is byte-identical to the one stored and displayed.
//
// shared/parsers/human-picks.js parses this back; the two are exact inverses
// and scripts/check-human-picks.js proves it over every ticket it builds.

const BET_ABBR = {
  win: 'W', place: 'P', show: 'S',
  exacta: 'EX', exacta_box: 'EX BOX',
  trifecta: 'TRI', trifecta_box: 'TRI BOX',
  superfecta: 'SUPER', superfecta_box: 'SUPER BOX',
  daily_double: 'DD', parlay: 'PARLAY',
  parlay_place: 'PLACE PARLAY', parlay_show: 'SHOW PARLAY',
};

/**
 * The printed type token for a bet. Deliberately no quinella entry: grading it
 * is broken today (shared/grading.js counts a quinella's combinations with the
 * ordered-exotic formula while matching it as an unordered set), so it is not
 * a bet this grammar advertises. It still formats via the generic fallback if
 * something ever constructs one.
 */
export const abbrForBetType = (betType) => {
  const t = String(betType ?? '');
  if (BET_ABBR[t]) return BET_ABBR[t];
  const pick = t.match(/^pick(\d)$/);
  if (pick) return `PICK ${pick[1]}`;
  return t.replace(/_/g, ' ').toUpperCase();
};

export function tellerCall(betType, raceNumbers, stakeCents, legs) {
  const prefix = raceNumbers.length > 1 ? `Races ${raceNumbers.join('-')} ` : '';
  const selections = legs.map((l) => l.join('-')).join(' WITH ');
  return `${prefix}${moneyToken(stakeCents)} ${abbrForBetType(betType)} ${selections}`;
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
