// Human ticket parser (D54): pasted text for ONE race -> the same ticket
// shape shared/card-engine.js produces, so a human ticket reads exactly
// like an engine one on the sheet. Pure (browser + Node), never throws -
// problems land in `warnings`, same contract as every other parser in the
// codebase (shared/entries-parser.js, shared/picks-parser.js).
//
// Unlike those, each warning here carries its own `blocking` boolean
// rather than leaving severity to a downstream policy classifier
// (server/backfill.js's BLOCKING_TYPES map): blocking must decide which
// TICKET gets constructed inside one parse call (a bad row is dropped,
// the rest of the race still parses), not gate a whole day's save.
//
// Row grammar, one ticket per non-blank line, columns separated by a tab
// or 2+ spaces:
//
//   <bet type>  <selections>  <stake>  [odds]  [rationale...]
//
// Bet type: case-insensitive, vocabulary below; a trailing parenthetical
// like "(part-wheel)" is stripped before matching. Daily Double / Pick N
// are recognized just far enough to reject them with a pointer at the
// multi-race scope PR 2 (Replay) will cover.
//
// Selections: '#2 Tahini' -> program 2, name cross-checked; '2' or
// 'Tahini' alone both work. Straight bets split legs on '/'; box types
// take one comma-separated leg. Combos are the cartesian product across
// legs with impossible repeats dropped (a horse can't finish in two
// positions at once): '2,4 / 2,4 / 3,5' -> 4 combos, not 8.
//
// Stake is the TOTAL handed to the teller; per-combo = total / combos,
// validated against the wager menu's base unit via shared/betmath.js.
// An optional trailing '($5 x 4 combos)' is cross-checked, never
// authoritative - the stake column always wins.

import { parseWagerMenu, tellerCall } from '../betmath.js';

const BET_TYPES = {
  win: 'win', place: 'place', show: 'show',
  exacta: 'exacta', 'exacta box': 'exacta_box',
  trifecta: 'trifecta', 'trifecta box': 'trifecta_box',
  superfecta: 'superfecta', 'superfecta box': 'superfecta_box',
};
const BOX_TYPES = new Set(['exacta_box', 'trifecta_box', 'superfecta_box']);
const MULTI_RACE_RE = /^(daily\s*double|rolling\s*double|pick\s*\d+)$/i;
const PGM_TOKEN_RE = /^#?(\d+[A-Za-z]?)(?:\s+(.+))?$/;
const PARENTHETICAL_RE = /\(([^)]*)\)/g;
const STAKE_CHECK_RE = /\(\s*\$?\s*([\d.]+)\s*x\s*(\d+)\s*combos?\s*\)/i;
const ODDS_RE = /^\d+(?:\.\d+)?(?:[-/]\d+(?:\.\d+)?)?$/;

const nameKey = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const stripParens = (s) => String(s ?? '').replace(PARENTHETICAL_RE, ' ').replace(/\s+/g, ' ').trim();
const toCents = (s) => {
  const n = Number(String(s ?? '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * win/place/show carry a $2-style minimum but sell in $1 increments above
 * it (a $25 win bet is completely ordinary); exotic types sell only in
 * whole multiples of their own printed base, so minimum and increment are
 * the same number there.
 */
function wagerLimitsFor(betType, menu) {
  if (betType === 'win' || betType === 'place' || betType === 'show') {
    return { minCents: menu.win ?? 200, stepCents: 100 };
  }
  const chartType = betType.replace(/_box$/, '');
  const base = menu[chartType] ?? 100;
  return { minCents: base, stepCents: base };
}

/** Cartesian product across legs, dropping combos where a pgm repeats across positions. */
function enumerateCombos(legs) {
  let combos = [[]];
  for (const leg of legs) {
    const next = [];
    for (const prefix of combos) for (const pgm of leg) next.push([...prefix, pgm]);
    combos = next;
  }
  return combos.filter((c) => new Set(c).size === c.length);
}

/** Resolve one selection token to a program number, or null with a warning pushed. */
function resolveToken(token, entries, race, warnings) {
  const m = token.match(PGM_TOKEN_RE);
  if (m) {
    const pgm = m[1].toUpperCase();
    const claimedName = m[2]?.trim();
    const entry = entries.find((e) => e.program_number === pgm);
    if (!entry) {
      warnings.push({ type: 'unknown_program', blocking: true, race, message: `Race ${race}: no entry with program number ${pgm}.` });
      return null;
    }
    if (claimedName && nameKey(claimedName) !== nameKey(entry.horse_name)) {
      warnings.push({ type: 'name_mismatch', blocking: false, race, message: `Race ${race}: #${pgm} is "${entry.horse_name}", not "${claimedName}".` });
    }
    return pgm;
  }
  // Name-only token: resolve against entries by normalized name.
  const entry = entries.find((e) => nameKey(e.horse_name) === nameKey(token));
  if (!entry) {
    warnings.push({ type: 'unknown_program', blocking: true, race, message: `Race ${race}: no entry matching "${token}".` });
    return null;
  }
  return entry.program_number;
}

/**
 * Parse pasted human tickets for ONE race.
 * `entries`: the race's entry rows [{program_number, horse_name}].
 * `scratchedProgramNumbers`: Set/array of program numbers that did not
 * run (program-time scratches union chart scratches when known) - a
 * human should never be allowed to bet a horse that in fact didn't run.
 * Returns { tickets, warnings, raceCostCents }. Never throws.
 */
export function parseHumanPicksText({ text, race, entries = [], wagerMenu = null, scratchedProgramNumbers = [] }) {
  const warnings = [];
  const tickets = [];
  const scratched = new Set(scratchedProgramNumbers);
  const menu = parseWagerMenu(wagerMenu);

  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cols = line.split(/\t+|[ ]{2,}/).map((c) => c.trim()).filter((c) => c !== '');
    if (cols.length < 3) {
      warnings.push({ type: 'unrecognized_line', blocking: false, race, message: `Race ${race}: unrecognized line: "${line.slice(0, 80)}"` });
      continue;
    }
    const [rawType, rawSelections, rawStake, ...rest] = cols;
    const typeKey = stripParens(rawType).toLowerCase();

    if (MULTI_RACE_RE.test(typeKey)) {
      warnings.push({
        type: 'multi_race_unsupported', blocking: true, race,
        message: `Race ${race}: "${rawType}" is a multi-race ticket - single-race scope only in this release. Multi-race tickets are planned for the Replay PR (D55).`,
      });
      continue;
    }
    const betType = BET_TYPES[typeKey];
    if (!betType) {
      warnings.push({ type: 'unrecognized_bet_type', blocking: true, race, message: `Race ${race}: unrecognized bet type "${rawType}".` });
      continue;
    }

    // Selections -> legs (straight bets split on '/'; box types take one leg).
    const isBox = BOX_TYPES.has(betType);
    const legs = isBox
      ? [rawSelections.split(',').map((t) => t.trim()).filter(Boolean)]
      : rawSelections.split('/').map((leg) => leg.split(',').map((t) => t.trim()).filter(Boolean));

    let blocked = false;
    const resolvedLegs = legs.map((leg) => leg.map((token) => {
      const pgm = resolveToken(token, entries, race, warnings);
      if (pgm == null) { blocked = true; return null; }
      if (scratched.has(pgm)) {
        warnings.push({ type: 'scratched_selection', blocking: true, race, message: `Race ${race}: #${pgm} is scratched.` });
        blocked = true;
      }
      return pgm;
    }));
    if (blocked) continue;

    const combos = isBox
      ? (() => {
          const n = resolvedLegs[0].length;
          const perms = (k, r) => { let out = 1; for (let i = 0; i < r; i++) out *= (k - i); return out; };
          const positions = betType === 'exacta_box' ? 2 : betType === 'trifecta_box' ? 3 : 4;
          if (n < positions) return [];
          // Box combos aren't enumerated as tuples (grading matches the set);
          // one "combo" count is what matters for per-combo stake math.
          return new Array(perms(n, positions)).fill(resolvedLegs[0]);
        })()
      : enumerateCombos(resolvedLegs);

    if (combos.length === 0) {
      warnings.push({ type: 'insufficient_selections', blocking: true, race, message: `Race ${race}: "${rawType}" needs more horses than were given.` });
      continue;
    }

    const totalCostCents = toCents(rawStake);
    if (totalCostCents == null || totalCostCents <= 0) {
      warnings.push({ type: 'unrecognized_stake', blocking: true, race, message: `Race ${race}: could not read a stake from "${rawStake}".` });
      continue;
    }
    if (totalCostCents % combos.length !== 0) {
      warnings.push({ type: 'non_multiple_stake', blocking: true, race, message: `Race ${race}: $${(totalCostCents / 100).toFixed(2)} does not split evenly across ${combos.length} combos.` });
      continue;
    }
    const stakeCents = totalCostCents / combos.length;
    const { minCents, stepCents } = wagerLimitsFor(betType, menu);
    if (stakeCents < minCents) {
      warnings.push({ type: 'below_minimum', blocking: true, race, message: `Race ${race}: $${(stakeCents / 100).toFixed(2)} per combo is below the $${(minCents / 100).toFixed(2)} minimum for ${betType.replace(/_/g, ' ')}.` });
      continue;
    }
    if (stakeCents % stepCents !== 0) {
      warnings.push({ type: 'non_multiple_stake', blocking: true, race, message: `Race ${race}: $${(stakeCents / 100).toFixed(2)} per combo is not a multiple of the $${(stepCents / 100).toFixed(2)} increment for ${betType.replace(/_/g, ' ')}.` });
      continue;
    }

    // Odds column (optional) + rationale (the remainder), both verbatim.
    let oddsAtBet = null;
    let rationaleParts = rest;
    if (rest.length && ODDS_RE.test(rest[0])) {
      oddsAtBet = rest[0];
      rationaleParts = rest.slice(1);
    }
    const rationaleText = rationaleParts.join(' ').trim() || null;

    // Optional "($N x M combos)" cross-check, anywhere in the tail - never
    // authoritative, just a warning if it disagrees with the stake column.
    const tail = rest.join(' ');
    const checkMatch = tail.match(STAKE_CHECK_RE);
    if (checkMatch) {
      const statedPerCombo = toCents(checkMatch[1]);
      const statedCombos = Number(checkMatch[2]);
      if (statedCombos !== combos.length || statedPerCombo !== stakeCents) {
        warnings.push({
          type: 'parenthetical_mismatch', blocking: false, race,
          message: `Race ${race}: "(${checkMatch[0]})" says $${(statedPerCombo / 100).toFixed(2)} x ${statedCombos} combos, but the stake column gives $${(stakeCents / 100).toFixed(2)} x ${combos.length}. The stake column wins.`,
        });
      }
    }

    const raceNumbers = [race];
    tickets.push({
      raceNumbers, betType, legs: resolvedLegs,
      stakeCents, costCents: totalCostCents,
      estMinCents: null, estMaxCents: null, estIsRange: false,
      tellerCall: tellerCall(betType, raceNumbers, stakeCents, resolvedLegs),
      rationale: rationaleText, rationale_text: rationaleText, odds_at_bet: oddsAtBet,
      ruleTags: ['human'],
    });
  }

  const raceCostCents = tickets.reduce((a, t) => a + t.costCents, 0);
  return { tickets, warnings, raceCostCents };
}
