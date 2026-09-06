// Human ticket parser (D54): pasted text for ONE race -> the same ticket
// shape shared/card-engine.js produces, so a human ticket reads exactly
// like an engine one on the sheet. Pure (browser + Node), never throws -
// problems land in `warnings`, same contract as every other parser in the
// codebase (shared/entries-parser.js, shared/picks-parser.js).
//
// MUST STAY BROWSER-SAFE: client/src/components/TicketBuilder.jsx imports
// this through the @shared vite alias for its live combo count and minimum
// feedback, so it may never grow a `node:` import.
//
// Unlike those, each warning here carries its own `blocking` boolean
// rather than leaving severity to a downstream policy classifier
// (server/backfill.js's BLOCKING_TYPES map): blocking must decide which
// TICKET gets constructed inside one parse call (a bad row is dropped,
// the rest of the race still parses), not gate a whole day's save.
//
// TWO grammars are accepted, decided per line before any splitting - '/'
// means "next ticket" in one and "next position" in the other, so the
// decision cannot wait until after a split.
//
// 1. TELLER (D84) - what you say at the window, and what the ticket builder
//    composes. A line whose first token is money:
//
//      $10 W 5 / $2 EX BOX 2-4-5 / $1 TRI 5 WITH 2-4 WITH 2-4 (9/2 overlay)
//
//    Tickets are separated by ' / '. The money comes FIRST and is the
//    PER-COMBO base, exactly as a teller quotes it - the total is derived,
//    never stated. WITH (or OVER) separates finishing POSITIONS; '-' (or
//    ',') separates alternatives within a position and the horses of a box.
//    An optional trailing parenthetical carries odds and/or a rationale,
//    and is masked before the ' / ' split so a rationale containing " / "
//    can never cut a ticket in half. shared/betmath.js's tellerCall emits
//    exactly this; the two are exact inverses (check-human-picks proves it
//    over every ticket it builds). No tolerance for the pre-D84 format.
//
// 2. COLUMNS - the spreadsheet/LLM grammar, one ticket per line:
//
//      <bet type> | <selections> | <stake> | [odds] | [rationale...]
//
//    Columns split on '|' when the line has one, else on a tab or 2+
//    spaces. Detected per line, never mixed within one row. Here the stake
//    is the ticket TOTAL and per-combo is total/combos. server/llm-cards.js
//    parses a model's ticket block with this grammar (ruleTag 'llm'), and
//    spreadsheet paste already carries tabs, so it is not going anywhere.
//
// Bet type: case-insensitive; a parenthetical like "(part-wheel)" is
// stripped before matching in the column grammar. Daily Double / Pick N are
// recognized just far enough to reject them (single-race scope, D88).
//
// Selections: '#2 Tahini' -> program 2, name cross-checked; '2' or 'Tahini'
// alone both work. Combos are the cartesian product across positions with
// impossible repeats dropped (a horse can't finish in two positions at
// once): '5 WITH 2-4 WITH 2-4' -> 2 combos, not 4.

import { parseWagerMenu, parseMoneyToken, tellerCall } from '../betmath.js';

const BET_TYPES = {
  win: 'win', place: 'place', show: 'show',
  exacta: 'exacta', 'exacta box': 'exacta_box',
  trifecta: 'trifecta', 'trifecta box': 'trifecta_box',
  superfecta: 'superfecta', 'superfecta box': 'superfecta_box',
};
const BOX_TYPES = new Set(['exacta_box', 'trifecta_box', 'superfecta_box']);
const WPS_TYPES = new Set(['win', 'place', 'show']);
/** Finishing positions each exotic needs. Boxes take one leg holding the set. */
const STRAIGHT_POSITIONS = { exacta: 2, trifecta: 3, superfecta: 4 };
const BOX_POSITIONS = { exacta_box: 2, trifecta_box: 3, superfecta_box: 4 };

// Teller type phrases, LONGEST FIRST so 'SUPER' beats 'S' and 'EX BOX' beats
// 'EX'. Pick N is a regex instead (the digit varies) and is tried first.
const TELLER_PHRASES = [
  ['DAILY DOUBLE', 'daily_double'], ['ROLLING DOUBLE', 'daily_double'],
  ['SUPERFECTA BOX', 'superfecta_box'], ['SUPER BOX', 'superfecta_box'],
  ['TRIFECTA BOX', 'trifecta_box'], ['TRI BOX', 'trifecta_box'],
  ['EXACTA BOX', 'exacta_box'], ['EXA BOX', 'exacta_box'], ['EX BOX', 'exacta_box'],
  ['SUPERFECTA', 'superfecta'], ['SUPER', 'superfecta'],
  ['TRIFECTA', 'trifecta'], ['TRI', 'trifecta'],
  ['EXACTA', 'exacta'], ['EXA', 'exacta'], ['EX', 'exacta'],
  ['DOUBLE', 'daily_double'], ['DD', 'daily_double'],
  ['PLACE', 'place'], ['SHOW', 'show'], ['WIN', 'win'],
  ['PL', 'place'], ['SH', 'show'],
  ['W', 'win'], ['P', 'place'], ['S', 'show'],
].sort((a, b) => b[0].length - a[0].length);

const PICK_N_RE = /^PICK\s*(\d)(?=\s|$)/;
const RACE_PREFIX_RE = /^races?\s+(\d+(?:\s*-\s*\d+)*)\s*,?\s+/i;
const WITH_RE = /\s+(?:WITH|OVER)\s+/i;
const TRAILING_PAREN_RE = /\s*\(([^)]*)\)\s*$/;
const PGM_TOKEN_RE = /^#?(\d+[A-Za-z]?)(?:\s+(.+))?$/;
const PARENTHETICAL_RE = /\(([^)]*)\)/g;
const STAKE_CHECK_RE = /\(?\s*\$?\s*([\d.]+)\s*x\s*(\d+)\s*combos?\s*\)?/i;
const ODDS_RE = /^\d+(?:\.\d+)?(?:[-/]\d+(?:\.\d+)?)?$/;

/**
 * A line is TELLER when it leads with money (optionally after a race
 * prefix). Provably disjoint from the column grammar, whose first column is
 * always a bet-type word - no bet type starts with '$', '.' or a digit.
 */
const TELLER_LINE_RE = /^(?:races?\s+\d+(?:\s*-\s*\d+)*\s*,?\s+)?(?:\$|\.\d|\d+\s*(?:c|¢|-?cents?)(?=\s|$))/i;

// Exported (D125) so every other file that matches horse names imports this
// ONE implementation instead of keeping its own copy - five near-identical
// copies existed before this, none stripping a bred-country/state suffix
// like "Eternal Reign (IRE)", which is why a chart's plain "Eternal Reign"
// failed to resolve against an entries row printing the full name.
export const stripParens = (s) => String(s ?? '').replace(PARENTHETICAL_RE, ' ').replace(/\s+/g, ' ').trim();
export const nameKey = (s) => stripParens(s).toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const toCents = (s) => {
  const n = Number(String(s ?? '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/**
 * win/place/show carry a $2-style minimum but sell in $1 increments above
 * it (a $25 win bet is completely ordinary); exotic types sell only in
 * whole multiples of their own printed base, so minimum and increment are
 * the same number there. Exported (D84) so the ticket builder shows the
 * same limits the server validates against, never a second copy.
 */
export function wagerLimitsFor(betType, menu) {
  if (WPS_TYPES.has(betType)) return { minCents: menu.win ?? 200, stepCents: 100 };
  const chartType = betType.replace(/_box$/, '');
  const base = menu[chartType] ?? 100;
  return { minCents: base, stepCents: base };
}

/** Permutations nPr - a box's combination count. */
function perms(n, r) {
  let out = 1;
  for (let i = 0; i < r; i++) out *= (n - i);
  return out;
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

/**
 * How many combinations a ticket covers, per bet type (D84). Exported so the
 * builder's live "6 combos x $2 = $12" line is the same arithmetic the parser
 * charges by. A WPS "leg" of k horses is k separate tickets, not k combos -
 * see the wps_split rule in buildTickets.
 */
export function comboCountFor(betType, legs) {
  if (!Array.isArray(legs) || legs.length === 0) return 0;
  if (WPS_TYPES.has(betType)) return legs[0].length;
  if (BOX_TYPES.has(betType)) {
    const n = legs[0].length;
    const positions = BOX_POSITIONS[betType];
    return n < positions ? 0 : perms(n, positions);
  }
  return enumerateCombos(legs).length;
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
 * Split a teller line into its ticket strings on ' / '. Scanned rather than
 * split so a separator inside a parenthetical is skipped: a rationale reading
 * "(good spot / bad post)" would otherwise be cut in half and neither piece
 * would parse. Requires whitespace on both sides, so odds like 9/2 are safe
 * even outside parentheses.
 */
function splitTellerTickets(line) {
  const s = String(line);
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const isSeparator = depth === 0 && ch === '/'
      && /\s/.test(s[i - 1] ?? '') && /\s/.test(s[i + 1] ?? '');
    if (isSeparator) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

/** Longest-match the printed type token off the front of a teller ticket's tail. */
function matchTellerType(s) {
  const upper = s.toUpperCase();
  const pick = upper.match(PICK_N_RE);
  if (pick) return { betType: `pick${pick[1]}`, rest: s.slice(pick[0].length).trim() };
  for (const [phrase, betType] of TELLER_PHRASES) {
    if (upper === phrase) return { betType, rest: '' };
    if (upper.startsWith(`${phrase} `)) return { betType, rest: s.slice(phrase.length).trim() };
  }
  return null;
}

/**
 * One teller ticket string -> a parse spec, or null with a warning pushed.
 * Selections split on '-' or ',' within a position, so a teller ticket names
 * horses by program number; a hyphenated horse NAME is a column-grammar thing.
 */
function parseTellerTicketString(str, race, warnings) {
  let s = str.trim();

  let parenContent = null;
  const paren = s.match(TRAILING_PAREN_RE);
  if (paren) {
    parenContent = paren[1].trim();
    s = s.slice(0, paren.index).trim();
  }

  let raceNumbers = null;
  const prefix = s.match(RACE_PREFIX_RE);
  if (prefix) {
    raceNumbers = prefix[1].split('-').map((n) => Number(n.trim()));
    s = s.slice(prefix[0].length).trim();
  }

  const gap = s.indexOf(' ');
  const stakeCents = parseMoneyToken(gap === -1 ? s : s.slice(0, gap));
  if (stakeCents == null || stakeCents <= 0) {
    warnings.push({
      type: 'unrecognized_stake', blocking: true, race,
      message: `Race ${race}: could not read a stake from "${str.slice(0, 60)}" - a teller ticket leads with the money, e.g. "$10 W 5".`,
    });
    return null;
  }

  const typed = matchTellerType(gap === -1 ? '' : s.slice(gap + 1).trim());
  if (!typed) {
    warnings.push({
      type: 'unrecognized_bet_type', blocking: true, race,
      message: `Race ${race}: unrecognized bet type in "${str.slice(0, 60)}".`,
    });
    return null;
  }

  const rawLegs = typed.rest
    ? typed.rest.split(WITH_RE).map((pos) => pos.split(/[,\-]/).map((t) => t.trim()).filter(Boolean))
    : [];

  let odds = null;
  let rationale = null;
  let checkTail = '';
  if (parenContent) {
    if (STAKE_CHECK_RE.test(parenContent)) {
      checkTail = parenContent;
    } else {
      const parts = parenContent.split(/\s+/);
      if (parts.length && ODDS_RE.test(parts[0])) {
        odds = parts[0];
        rationale = parts.slice(1).join(' ').trim() || null;
      } else {
        rationale = parenContent || null;
      }
    }
  }

  if (raceNumbers && raceNumbers.length === 1 && raceNumbers[0] !== race) {
    warnings.push({
      type: 'race_mismatch', blocking: false, race,
      message: `Race ${race}: "${str.slice(0, 40)}" names race ${raceNumbers[0]}. Saving it against race ${race}.`,
    });
  }

  return {
    betType: typed.betType, rawLegs, stakeMode: 'perCombo', amountCents: stakeCents,
    odds, rationale, checkTail, label: str.slice(0, 60),
    isMultiRace: Boolean(raceNumbers && raceNumbers.length > 1),
  };
}

/** One column-grammar row -> a parse spec, or null with a warning pushed. */
function parseColumnRow(line, race, warnings) {
  const cols = (line.includes('|') ? line.split('|') : line.split(/\t+|[ ]{2,}/))
    .map((c) => c.trim()).filter((c) => c !== '');
  if (cols.length < 3) {
    warnings.push({ type: 'unrecognized_line', blocking: false, race, message: `Race ${race}: unrecognized line: "${line.slice(0, 80)}"` });
    return null;
  }
  const [rawType, rawSelections, rawStake, ...rest] = cols;
  const typeKey = stripParens(rawType).toLowerCase();

  if (/^(daily\s*double|rolling\s*double|pick\s*\d+)$/i.test(typeKey)) {
    return { betType: 'daily_double', isMultiRace: true, label: rawType };
  }
  const betType = BET_TYPES[typeKey];
  if (!betType) {
    warnings.push({ type: 'unrecognized_bet_type', blocking: true, race, message: `Race ${race}: unrecognized bet type "${rawType}".` });
    return null;
  }

  // Straight bets split legs on '/' for POSITION (leg 1, leg 2, ...); box
  // types take one leg with no positional meaning at all, so a human writing
  // "#1 / #6" means the same thing as "#1,#6" - both ',' and '/' are accepted
  // as equivalent horse separators there.
  const rawLegs = BOX_TYPES.has(betType)
    ? [rawSelections.split(/[,/]/).map((t) => t.trim()).filter(Boolean)]
    : rawSelections.split('/').map((leg) => leg.split(',').map((t) => t.trim()).filter(Boolean));

  const totalCostCents = toCents(rawStake);
  if (totalCostCents == null || totalCostCents <= 0) {
    warnings.push({ type: 'unrecognized_stake', blocking: true, race, message: `Race ${race}: could not read a stake from "${rawStake}".` });
    return null;
  }

  let odds = null;
  let rationaleParts = rest;
  if (rest.length && ODDS_RE.test(rest[0])) {
    odds = rest[0];
    rationaleParts = rest.slice(1);
  }

  return {
    betType, rawLegs, stakeMode: 'total', amountCents: totalCostCents,
    odds, rationale: rationaleParts.join(' ').trim() || null,
    checkTail: rest.join(' '), label: rawType, isMultiRace: false,
  };
}

/**
 * The shared tail both grammars converge on: structural validation, token
 * resolution, combo math, the wager-menu limits, and ticket construction.
 * Pushes onto `tickets`/`warnings` rather than returning, because one spec can
 * legitimately produce several tickets (the WPS split below).
 */
function buildTickets(spec, ctx) {
  const { race, entries, scratched, menu, ruleTag, warnings, tickets } = ctx;
  const { betType, rawLegs } = spec;

  if (spec.isMultiRace || betType === 'daily_double' || /^pick\d$/.test(betType)) {
    warnings.push({
      type: 'multi_race_unsupported', blocking: true, race,
      message: `Race ${race}: "${spec.label}" is a multi-race ticket - single-race scope only. Multi-race tickets are planned (D88).`,
    });
    return;
  }

  // Structural checks first: they need no entries, and they give a far better
  // message than resolving horses only to fail on the shape afterward.
  const needed = WPS_TYPES.has(betType) || BOX_TYPES.has(betType) ? 1 : STRAIGHT_POSITIONS[betType];
  if (rawLegs.length < needed) {
    warnings.push({
      type: 'insufficient_selections', blocking: true, race,
      message: `Race ${race}: a ${betType.replace(/_/g, ' ')} needs ${needed} position${needed === 1 ? '' : 's'}, got ${rawLegs.length}.`,
    });
    return;
  }
  if (rawLegs.length > needed) {
    warnings.push({
      type: 'too_many_positions', blocking: true, race,
      message: `Race ${race}: a ${betType.replace(/_/g, ' ')} takes ${needed} position${needed === 1 ? '' : 's'}, got ${rawLegs.length}.`,
    });
    return;
  }

  let blocked = false;
  const resolvedLegs = rawLegs.map((leg) => leg.map((token) => {
    const pgm = resolveToken(token, entries, race, warnings);
    if (pgm == null) { blocked = true; return null; }
    if (scratched.has(pgm)) {
      warnings.push({ type: 'scratched_selection', blocking: true, race, message: `Race ${race}: #${pgm} is scratched.` });
      blocked = true;
    }
    return pgm;
  }));
  if (blocked) return;

  const combos = comboCountFor(betType, resolvedLegs);
  if (combos === 0) {
    warnings.push({
      type: 'insufficient_selections', blocking: true, race,
      message: `Race ${race}: "${spec.label}" needs more horses than were given.`,
    });
    return;
  }

  // The one real difference between the grammars: teller states the per-combo
  // base a teller quotes, columns state the ticket total.
  let stakeCents;
  if (spec.stakeMode === 'perCombo') {
    stakeCents = spec.amountCents;
  } else {
    if (spec.amountCents % combos !== 0) {
      warnings.push({
        type: 'non_multiple_stake', blocking: true, race,
        message: `Race ${race}: ${money(spec.amountCents)} does not split evenly across ${combos} combos.`,
      });
      return;
    }
    stakeCents = spec.amountCents / combos;
  }

  const { minCents, stepCents } = wagerLimitsFor(betType, menu);
  if (stakeCents < minCents) {
    warnings.push({
      type: 'below_minimum', blocking: true, race,
      message: `Race ${race}: ${money(stakeCents)} per combo is below the ${money(minCents)} minimum for ${betType.replace(/_/g, ' ')}.`,
    });
    return;
  }
  if (stakeCents % stepCents !== 0) {
    warnings.push({
      type: 'non_multiple_stake', blocking: true, race,
      message: `Race ${race}: ${money(stakeCents)} per combo is not a multiple of the ${money(stepCents)} increment for ${betType.replace(/_/g, ' ')}.`,
    });
    return;
  }

  // Optional "($N x M combos)" cross-check - never authoritative, just a
  // warning if it disagrees with the stated stake.
  const checkMatch = String(spec.checkTail ?? '').match(STAKE_CHECK_RE);
  if (checkMatch) {
    const statedPerCombo = toCents(checkMatch[1]);
    const statedCombos = Number(checkMatch[2]);
    if (statedCombos !== combos || statedPerCombo !== stakeCents) {
      warnings.push({
        type: 'parenthetical_mismatch', blocking: false, race,
        message: `Race ${race}: "${checkMatch[0].trim()}" says ${money(statedPerCombo)} x ${statedCombos} combos, but the ticket gives ${money(stakeCents)} x ${combos}. The stated stake wins.`,
      });
    }
  }

  // A win/place/show bet on k horses is k TICKETS, which is what the window
  // sells - not one ticket covering k "combos". Kept as one ticket it was also
  // mis-graded: shared/grading.js reads only legs[0][0], so the second horse
  // was paid for and never settled.
  const horses = WPS_TYPES.has(betType) ? resolvedLegs[0] : null;
  if (horses && horses.length > 1) {
    warnings.push({
      type: 'wps_split', blocking: false, race,
      message: `Race ${race}: ${money(stakeCents)} ${betType} on ${horses.length} horses is ${horses.length} separate tickets, ${money(stakeCents * horses.length)} in total.`,
    });
  }
  const legSets = horses ? horses.map((p) => [[p]]) : [resolvedLegs];

  for (const legs of legSets) {
    const costCents = stakeCents * comboCountFor(betType, legs);
    tickets.push({
      raceNumbers: [race], betType, legs,
      stakeCents, costCents,
      estMinCents: null, estMaxCents: null, estIsRange: false,
      tellerCall: tellerCall(betType, [race], stakeCents, legs),
      rationale: spec.rationale, rationale_text: spec.rationale, odds_at_bet: spec.odds,
      ruleTags: [ruleTag],
    });
  }
}

/**
 * Parse pasted human tickets for ONE race.
 * `entries`: the race's entry rows [{program_number, horse_name}].
 * `scratchedProgramNumbers`: Set/array of program numbers that did not
 * run (program-time scratches union chart scratches when known) - a
 * human should never be allowed to bet a horse that in fact didn't run.
 * `ruleTag`: stamped onto each ticket's ruleTags (D63: 'llm' for an LLM
 * card's picks, reusing this exact parser/validation for a model's ticket
 * block same as a human's pasted text - defaults to 'human' so every
 * existing caller is unaffected).
 * Returns { tickets, warnings, raceCostCents }. Never throws.
 */
export function parseHumanPicksText({ text, race, entries = [], wagerMenu = null, scratchedProgramNumbers = [], ruleTag = 'human' }) {
  const warnings = [];
  const tickets = [];
  const ctx = {
    race, entries, scratched: new Set(scratchedProgramNumbers),
    menu: parseWagerMenu(wagerMenu), ruleTag, warnings, tickets,
  };

  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Grammar is decided BEFORE any splitting: '/' means "next ticket" in the
    // teller grammar and "next position" in the column grammar.
    if (TELLER_LINE_RE.test(line)) {
      for (const piece of splitTellerTickets(line)) {
        const spec = parseTellerTicketString(piece, race, warnings);
        if (spec) buildTickets(spec, ctx);
      }
    } else {
      const spec = parseColumnRow(line, race, warnings);
      if (spec) buildTickets(spec, ctx);
    }
  }

  const raceCostCents = tickets.reduce((a, t) => a + t.costCents, 0);
  return { tickets, warnings, raceCostCents };
}
