// The card-generation engine: race day + consensus -> a fully costed
// betting card, with the complete decision trace (invariant 7) emitted
// alongside every dollar. Pure functions - no DB, no clock, no network -
// so the Phase 3 simulator replays exactly what generated live cards.
//
// The "lean" methodology from the Del Mar session, encoded exactly:
//   * Heaviest allocations to UNANIMOUS races; minimum stake on 2yo-debut
//     and other guesswork races; mid-size on CHAOS weighted toward exotics.
//   * Cut hedges, keep stacks: never 3+ win bets in one race; tickets
//     covering different outcomes of one thesis stay.
//   * Fade the favorite's PRICE, not the favorite: a legit odds-on favorite
//     goes on top of exactas over live longshots instead of a win bet.
//   * MANDATORY place-money rule (invariant 1): every win bet at 8-1+
//     carries matching place money. The engine self-enforces this in a
//     final sweep - a construction path that missed it is corrected and
//     the correction traced.
//   * Longshots go ON TOP of exotics for lottery upside.
//   * Mid-priced program horses (5-1..8-1) are not excluded from exotic
//     coverage just because no source mentions them.
//   * Any horse flagged by 2+ sources gets small coverage even in lean
//     mode (known failure mode #2).
//   * One consensus win parlay + daily doubles connecting strong races,
//     costed against the budget.
//   * The wager menu's own minimums are respected; every allocation sums
//     exactly to the bankroll (invariant 2 - warn, never block).
//
// Structure-layer rules are individually toggleable via `rules` so the
// simulator (D18/D19) can benchmark construction on any card; defaults are
// the live methodology. Signal-layer input (classification) arrives
// precomputed - the engine never re-decides it.

import {
  BET, parseWagerMenu, winPayout, placeEstimate, exactaEstimate,
  trifectaBoxEstimate, doubleEstimate, parlayPayout, tellerCall,
  comboCost, boxCost, dollars,
} from './betmath.js';

// Both re-exported from their new homes (D109) so this file's own consumers
// keep working until it is deleted. They moved because KEPT code imports
// them: server/grading.js needs the version, CardView.jsx the notices.
// Imported AND re-exported: `export { X } from` alone re-exports without
// binding X in this module's scope, and both are used below.
import { ENGINE_VERSION } from './version.js';
import { FAILURE_MODE_WARNINGS } from './card-notices.js';
export { ENGINE_VERSION };

export const DEFAULT_RULES = {
  placeMoneyRule: true,
  hedgeCut: true,
  fadeThePrice: true,
  chaosTrifectaBox: true,
  coverageAdds: true,
  midPriceCoverage: true,
  longshotOnTop: true,
  parlays: true,
  allocationCurve: 'lean',
  // D48 knobs (template-driven, never a hardcoded branch): exotic ticket
  // construction on/off, win stake = the branch's share or the per-race
  // minimum, and how many horses the split exacta box takes (0 = no split
  // box at all, D49 straight-only; the mid-price straight exacta is its own
  // knob, midPriceCoverage).
  exoticTickets: true,
  winStake: 'share',
  hedgeBoxDepth: 2,
};

export { FAILURE_MODE_WARNINGS } from './card-notices.js';

const ml = (e) => e?.morning_line_decimal ?? null;
const isGuessRace = (race) => {
  const text = `${race.race_type ?? ''} ${race.conditions ?? ''}`;
  // "TWO YEARS OLD", "TWO YEAR OLDS", "TWO-YEAR-OLD", "2 YEAR OLDS", "2yo".
  return /MAIDEN/i.test(text) && /\b(?:TWO|2)[- ]?YEARS?[- ]?OLDS?\b|\b2YO\b/i.test(text);
};

/**
 * Generate a card.
 * `races`: [{ number, race_type, conditions, wager_menu, entries (DB rows),
 *   classification: classifyDay() result for the race }]
 * Returns { completeness, allocations, tickets, warnings, trace }.
 */
export function generateCard({ bankrollCents, perRaceMinCents, races, sourcesUsed = [], sourcesUnavailable = [], rules: ruleOverrides = {}, template = null, engineVersion = ENGINE_VERSION }) {
  const rules = { ...DEFAULT_RULES, ...ruleOverrides };
  const trace = [];
  const warnings = [];
  let seq = 0;
  const emit = (event, data) => trace.push({ seq: seq++, event, ...data });

  emit('inputs_snapshot', {
    engineVersion,
    bankrollCents,
    perRaceMinCents,
    raceCount: races.length,
    entries: races.map((r) => ({ race: r.number, entries: r.entries.filter((e) => !e.scratched).length })),
    sourcesUsed,
    sourcesUnavailable,
    template,
    rules,
  });

  // ----- signal recap into the trace (the votes that produced each call) -----
  for (const race of races) {
    const c = race.classification;
    emit('consensus_table', { race: race.number, table: c.table });
    emit('race_classified', {
      race: race.number,
      classification: c.classification,
      externalSourceCount: c.externalSourceCount,
      agreement: c.agreement,
      cappedFromUnanimous: c.cappedFromUnanimous,
      topVotes: c.topVotes,
      contrarianFlags: c.contrarianFlags,
    });
  }

  // ----- completeness (user-confirmed boundary, 2026-09-01) -----
  const extCounts = races.map((r) => r.classification.externalSourceCount);
  // ODDS_ONLY (D40): no external sources AND no program analysis anywhere
  // on the day - the morning line is the only signal.
  const hasAnalysis = races.some((r) => r.entries.some((e) => e.program_rank != null));
  const completeness = extCounts.every((n) => n >= 2) ? 'FULL'
    : extCounts.some((n) => n > 0) ? 'PARTIAL' : hasAnalysis ? 'PROGRAM_ONLY' : 'ODDS_ONLY';
  emit('completeness_decided', { completeness, externalSourcesPerRace: extCounts, programAnalysis: hasAnalysis });

  // ----- multi-race reserve -----
  const strongRaces = races.filter((r) => r.classification.classification === 'UNANIMOUS' && !isGuessRace(r));
  let reserve = 0;
  if (rules.parlays && strongRaces.length >= 2) {
    reserve = BET.parlayStakeCents +
      BET.doubleStakeCents * Math.min(BET.maxDoubles, Math.max(0, strongRaces.length - 1));
    emit('rule_fired', { rule: 'multi_race_reserve', reserveCents: reserve, strongRaces: strongRaces.map((r) => r.number) });
  } else {
    emit('rule_suppressed', { rule: 'multi_race_reserve', reason: !rules.parlays ? 'disabled_by_template' : 'fewer_than_two_strong_races', strongRaces: strongRaces.map((r) => r.number) });
  }

  // ----- allocation -----
  const guessRaces = races.filter(isGuessRace);
  const weighted = races.filter((r) => !isGuessRace(r));
  const curve = BET.allocationCurves[rules.allocationCurve] ?? BET.allocationCurves.lean;
  // D48: a curve may key on the program's Best Bet flag (best-bet curve):
  // the flagged race takes curve.bestBet, every other race its class weight.
  const hasBestBet = (r) => r.entries.some((e) => e.best_bet && !e.scratched);
  const weightFor = (r) => (curve.bestBet != null && hasBestBet(r) ? curve.bestBet : (curve[r.classification.classification] ?? 1.5));
  if (curve.bestBet != null) {
    const flagged = weighted.filter(hasBestBet);
    for (const r of flagged) emit('rule_fired', { rule: 'best_bet_weight', race: r.number, weight: curve.bestBet, reason: 'the program Best Bet takes the heavy weight' });
    if (!flagged.length) emit('rule_suppressed', { rule: 'best_bet_weight', reason: 'no_best_bet' });
  }
  const guessTotal = guessRaces.length * perRaceMinCents;
  const pool = bankrollCents - guessTotal - reserve;
  const totalWeight = weighted.reduce((a, r) => a + weightFor(r), 0) || 1;

  const allocations = [];
  let allocated = 0;
  for (const race of weighted) {
    const raw = (pool * weightFor(race)) / totalWeight;
    const amount = Math.max(perRaceMinCents, Math.round(raw / 100) * 100);
    allocations.push(makeAllocation(race, amount, race.classification.classification, `${rules.allocationCurve}_weight_${weightFor(race)}`));
    allocated += amount;
  }
  for (const race of guessRaces) {
    allocations.push(makeAllocation(race, perRaceMinCents, 'GUESS', 'guesswork_minimum'));
    emit('rule_fired', { rule: 'guesswork_minimum', race: race.number, amountCents: perRaceMinCents, reason: '2yo/debut-type race - minimum stake' });
  }
  // Rounding drift lands on the biggest allocation.
  let drift = pool - allocated;
  if (drift !== 0 && allocations.length) {
    const biggest = allocations.filter((a) => a.confidence !== 'GUESS').sort((a, b) => b.amountCents - a.amountCents)[0];
    if (biggest) { biggest.amountCents += drift; drift = 0; }
  }
  for (const a of allocations) {
    emit('allocation_decided', { race: a.race, amountCents: a.amountCents, confidence: a.confidence, rule: a.rule });
  }

  // ----- per-race ticket construction -----
  const tickets = [];
  const addTicket = (t, provenance) => {
    t.sequence = tickets.length + 1;
    t.ruleTags = provenance;
    tickets.push(t);
    emit('ticket_added', {
      race: t.raceNumbers.length === 1 ? t.raceNumbers[0] : null,
      races: t.raceNumbers,
      betType: t.betType,
      selections: t.legs,
      stakeCents: t.stakeCents,
      costCents: t.costCents,
      rules: provenance,
    });
  };

  for (const alloc of allocations.sort((a, b) => a.race - b.race)) {
    const race = races.find((r) => r.number === alloc.race);
    buildRaceTickets({ race, alloc, rules, addTicket, emit, warnings, perRaceMinCents });
    carveOutPlaceMoney({ race, alloc, tickets, rules, emit });
  }
  if (!races.some((r) => r.classification.classification === 'CHAOS')) {
    emit('rule_suppressed', { rule: 'chaos_trifecta_box', reason: 'no_chaos_race' });
  }

  // ----- parlay + doubles from the reserve -----
  if (reserve > 0) {
    const legs = strongRaces.slice(0, BET.parlayLegsMax)
      .map((r) => ({ race: r.number, entry: topEntry(r) }))
      .filter((l) => l.entry);
    if (legs.length >= 2) {
      const mls = legs.map((l) => ml(l.entry));
      addTicket({
        raceNumbers: legs.map((l) => l.race),
        betType: 'parlay',
        legs: legs.map((l) => [l.entry.program_number]),
        stakeCents: BET.parlayStakeCents,
        costCents: BET.parlayStakeCents,
        est: [parlayPayout(BET.parlayStakeCents, mls), parlayPayout(BET.parlayStakeCents, mls)],
        estIsRange: false,
        rationale: 'Consensus win parlay across the strongest races',
      }, ['consensus_parlay']);
    }
    let doubles = 0;
    for (let i = 0; i + 1 < legs.length && doubles < BET.maxDoubles; i++) {
      const [a, b] = [legs[i], legs[i + 1]];
      addTicket({
        raceNumbers: [a.race, b.race],
        betType: 'daily_double',
        legs: [[a.entry.program_number], [b.entry.program_number]],
        stakeCents: BET.doubleStakeCents,
        costCents: BET.doubleStakeCents,
        est: doubleEstimate(BET.doubleStakeCents, ml(a.entry), ml(b.entry)),
        estIsRange: true,
        rationale: 'Daily double connecting consensus picks',
      }, ['consensus_double']);
      doubles++;
    }
  }

  // ----- MANDATORY place-money sweep (invariant 1) -----
  if (rules.placeMoneyRule) {
    for (const t of [...tickets]) {
      if (t.betType !== 'win') continue;
      const entryMl = t.mlForPlaceRule;
      if (entryMl == null) { emit('rule_suppressed', { rule: 'place_money_rule', race: t.raceNumbers[0], horse: t.legs[0][0], reason: 'no_morning_line' }); continue; }
      if (entryMl < BET.placeMoneyThresholdMl) { emit('rule_suppressed', { rule: 'place_money_rule', race: t.raceNumbers[0], horse: t.legs[0][0], ml: entryMl, reason: 'below_odds_threshold' }); continue; }
      const has = tickets.some((p) => p.betType === 'place' &&
        p.raceNumbers[0] === t.raceNumbers[0] && p.legs[0][0] === t.legs[0][0] &&
        p.stakeCents === t.stakeCents);
      if (!has) {
        emit('rule_fired', {
          rule: 'place_money_rule', race: t.raceNumbers[0],
          horse: t.legs[0][0], stakeCents: t.stakeCents,
          reason: `win bet at ${entryMl}-1 (>= ${BET.placeMoneyThresholdMl}-1) must carry matching place money`,
        });
        addTicket({
          raceNumbers: t.raceNumbers,
          betType: 'place',
          legs: t.legs,
          stakeCents: t.stakeCents,
          costCents: t.stakeCents,
          est: placeEstimate(t.stakeCents, entryMl),
          estIsRange: true,
          mlForPlaceRule: entryMl,
          rationale: `Mandatory place money behind the ${entryMl}-1 win bet`,
        }, ['place_money_rule']);
      }
    }
  } else {
    emit('rule_suppressed', { rule: 'place_money_rule', reason: 'disabled_by_template' });
  }

  // ----- bankroll balancing (invariant 2: exact sum, warn never block) -----
  balance({ tickets, allocations, bankrollCents, emit });

  const totalCents = tickets.reduce((a, t) => a + t.costCents, 0);
  if (totalCents !== bankrollCents) {
    warnings.push(`Card total ${dollars(totalCents)} differs from bankroll ${dollars(bankrollCents)} - minimums made an exact match impossible.`);
  }
  warnings.push(...FAILURE_MODE_WARNINGS);

  const finished = tickets.map(finishTicket);
  emit('card_finalized', {
    engineVersion,
    totalCents,
    bankrollCents,
    ticketCount: finished.length,
    completeness,
    perRace: allocations.map((a) => ({
      race: a.race,
      allocatedCents: a.amountCents,
      spentCents: finished.filter((t) => t.raceNumbers.length === 1 && t.raceNumbers[0] === a.race)
        .reduce((s, t) => s + t.costCents, 0),
    })),
    warnings,
  });

  return { engineVersion, completeness, allocations, tickets: finished, warnings, trace };
}

// ---------- per-race construction ----------

function makeAllocation(race, amountCents, confidence, rule) {
  return {
    race: race.number, amountCents, confidence, rule,
    thesis: null, triggers: [],
  };
}

const byNumber = (race, pgm) => race.entries.find((e) => e.program_number === pgm && !e.scratched);

function topEntry(race) {
  const v = race.classification.topVotes?.[0];
  return v ? byNumber(race, v.programNumber) : programPick(race, 1);
}
function secondChoice(race) {
  const v2 = race.classification.topVotes?.[1];
  if (v2) return byNumber(race, v2.programNumber);
  const table = race.classification.table ?? [];
  for (const s of table) {
    const e = s.second?.programNumber && byNumber(race, s.second.programNumber);
    if (e) return e;
  }
  return programPick(race, 2);
}
// The program's ranked pick - or, on a race with NO program analysis (an
// ML-sheet-only day, D40), the morning-line order: favorite first. The
// fallback is traced once per race so the card says where its picks came
// from.
const programPick = (race, rank) => {
  const ranked = race.entries.find((e) => e.program_rank === rank && !e.scratched);
  if (ranked) return ranked;
  if (race.entries.some((e) => e.program_rank != null)) return null;
  const byMl = race.entries.filter((e) => !e.scratched && ml(e) != null).sort((a, b) => ml(a) - ml(b));
  return byMl[rank - 1] ?? null;
};

// Position in morning-line order (1 = favorite) - only meaningful on a race
// without program analysis; Infinity otherwise so it never competes.
function mlRank(race, entry) {
  if (race.entries.some((e) => e.program_rank != null)) return Infinity;
  const byMl = race.entries.filter((e) => !e.scratched && ml(e) != null).sort((a, b) => ml(a) - ml(b));
  const k = byMl.indexOf(entry);
  return k < 0 ? Infinity : k + 1;
}

function liveLongshots(race) {
  const counts = race.classification.sourceCounts ?? {};
  return race.entries.filter((e) => !e.scratched && ml(e) >= BET.longshotMl &&
    ((counts[e.program_number] ?? 0) >= 1 || (e.program_rank != null && e.program_rank <= 3) || mlRank(race, e) <= 3));
}

function buildRaceTickets({ race, alloc, rules, addTicket, emit, warnings, perRaceMinCents = 500 }) {
  const A = alloc.amountCents;
  const menu = parseWagerMenu(race.wager_menu);
  const cls = alloc.confidence;
  if (!race.entries.some((e) => e.program_rank != null) && !race.classification.topVotes?.length) {
    emit('rule_fired', { rule: 'ml_order_fallback', race: race.number, reason: 'no program analysis and no external picks - morning-line order stands in for the ranking' });
  }
  const top = topEntry(race);
  if (!top) {
    warnings.push(`Race ${race.number}: no usable top pick; allocation left to the balancing pass.`);
    alloc.thesis = 'No usable signal - skipped.';
    return;
  }
  const second = secondChoice(race);
  const flags = race.classification.contrarianFlags ?? [];
  const counts = race.classification.sourceCounts ?? {};
  const usedPgms = new Set();
  // D48: suppression verdicts (machine-readable reasons) and the knobs.
  const sup = (rule, reason, extra = {}) => emit('rule_suppressed', { rule, race: race.number, reason, ...extra });
  const exotics = rules.exoticTickets !== false;
  const minWin = rules.winStake === 'minimum';
  const winShare = (share) => (minWin ? perRaceMinCents : share);
  const external = race.classification.externalSourceCount ?? 0;

  const win = (entry, stakeCents, rationale, tags) => {
    stakeCents = Math.max(menu.win, Math.round(stakeCents / 100) * 100);
    addTicket({
      raceNumbers: [race.number], betType: 'win', holdStake: minWin,
      legs: [[entry.program_number]], stakeCents, costCents: stakeCents,
      est: [winPayout(stakeCents, ml(entry)), winPayout(stakeCents, ml(entry))],
      estIsRange: false, mlForPlaceRule: ml(entry), rationale,
    }, tags);
    usedPgms.add(entry.program_number);
  };
  const exacta = (topE, unders, stakeCents, rationale, tags) => {
    stakeCents = Math.max(menu.exacta, Math.round(stakeCents / menu.exacta) * menu.exacta);
    const legs = [[topE.program_number], unders.map((u) => u.program_number)];
    addTicket({
      raceNumbers: [race.number], betType: 'exacta', legs,
      stakeCents, costCents: comboCost(stakeCents, legs),
      est: exactaEstimate(stakeCents, ml(topE), Math.max(...unders.map(ml))),
      estIsRange: true, rationale,
    }, tags);
    usedPgms.add(topE.program_number);
    unders.forEach((u) => usedPgms.add(u.program_number));
  };

  if (cls === 'GUESS') {
    // Every rule answers on every race (D48): a guesswork race declines them all.
    sup('fade_favorite_price', !rules.fadeThePrice ? 'disabled_by_template' : external === 0 ? 'no_algo_order' : 'not_unanimous');
    sup('chaos_trifecta_box', 'not_chaos_classification');
    sup('hedge_cut', 'not_split_classification');
    win(top, A, 'Guesswork race - minimum stake on the best-backed pick', ['guesswork_minimum']);
    alloc.thesis = 'Debut/guesswork race: nobody knows, so the card risks the minimum.';
    return;
  }

  if (cls === 'UNANIMOUS') {
    sup('chaos_trifecta_box', 'not_chaos_classification');
    sup('hedge_cut', 'not_split_classification');
    const shots = liveLongshots(race);
    if (rules.fadeThePrice && exotics && ml(top) != null && ml(top) <= BET.oddsOnMl) {
      emit('rule_fired', { rule: 'fade_favorite_price', race: race.number, favorite: top.program_number, ml: ml(top), reason: 'legit odds-on favorite is unbettable to win; goes on TOP of exactas instead' });
      emit('rule_suppressed', { rule: 'win_bet', race: race.number, reason: `top pick at ${ml(top)}-1 is below the ${BET.oddsOnMl}-1 win floor` });
      const unders = dedupeEntries([...(shots.length ? shots : []), second].filter(Boolean)).slice(0, 3);
      exacta(top, unders, A * 0.55 / Math.max(1, unders.length), `Favorite on top over the live prices (${unders.map((u) => u.horse_name).join(', ')})`, ['fade_favorite_price']);
      const shot = shots[0] ?? second;
      if (rules.longshotOnTop && shot) {
        emit('rule_fired', { rule: 'longshot_on_top', race: race.number, horse: shot.program_number });
        exacta(shot, [top], A * 0.45, 'The flip: longshot on top for the lottery upside', ['longshot_on_top', 'keep_stacks']);
      } else sup('longshot_on_top', !rules.longshotOnTop ? 'disabled_by_template' : 'no_live_longshot');
      alloc.thesis = `${top.horse_name} is legit but unbettable at ${top.morning_line}; the money is in the exotics under and over.`;
      alloc.triggers.push(`If #${top.program_number} drifts above even money, the win bet becomes playable.`);
      if (shot) alloc.triggers.push(`If #${shot.program_number} drifts past 15-1, added value on the flip.`);
    } else {
      sup('fade_favorite_price', !rules.fadeThePrice ? 'disabled_by_template' : !exotics ? 'no_exotic_tickets' : ml(top) == null ? 'no_morning_line' : 'above_odds_on', { ml: ml(top) });
      win(top, exotics ? winShare(A * 0.45) : winShare(A), 'Unanimous top pick - bet it hardest', ['unanimous_win']);
      if (!exotics) sup('unanimous_exacta', 'no_exotic_tickets');
      if (second && exotics) {
        exacta(top, [second], A * 0.33, 'Straight exacta on the thesis', ['unanimous_exacta']);
        exacta(second, [top], A * 0.22, 'The flip - same thesis, different order (keep stacks)', ['keep_stacks']);
      }
      alloc.thesis = `Every source lands on ${top.horse_name}; the card bets the agreement and stacks the exacta both ways.`;
    }
  } else if (cls === 'SPLIT') {
    const backers = (pgm) => race.classification.topVotes?.find((v) => v.programNumber === pgm)?.sources.length ?? 0;
    sup('chaos_trifecta_box', 'not_chaos_classification');
    sup('fade_favorite_price', !rules.fadeThePrice ? 'disabled_by_template' : external === 0 ? 'no_algo_order' : 'not_unanimous');
    win(top, exotics ? winShare(A * 0.4) : winShare(A), 'Better-backed side of the split', ['split_primary_win']);
    if (!second) {
      sup('hedge_cut', 'no_second_choice');
    } else if (rules.hedgeCut && backers(second.program_number) >= 2) {
      win(second, winShare(A * 0.2), 'Second side carries real backing too', ['split_secondary_win']);
      sup('hedge_cut', 'sufficient_backing', { second: second.program_number, backers: backers(second.program_number) });
    } else if (!rules.hedgeCut) {
      win(second, winShare(A * 0.2), 'Second side bet too - hedge cut disabled', ['split_secondary_win']);
      sup('hedge_cut', 'disabled_by_template', { second: second.program_number });
    } else {
      emit('rule_fired', { rule: 'hedge_cut', race: race.number, cut: second.program_number, reason: 'thin backing - cut to the best one, not dutched' });
    }
    // D49: hedgeBoxDepth 0 switches the split box OFF on its own (straight-only)
    // while the mid-price straight exacta below still fires; the balancer
    // then tops the race up toward its allocation through the win ticket.
    const boxOff = Number(rules.hedgeBoxDepth) === 0;
    if (second && !exotics) sup('split_exacta_box', 'no_exotic_tickets');
    else if (second && boxOff) sup('split_exacta_box', 'disabled_by_template');
    if (second && exotics && !boxOff) {
      // The split exacta box: two horses under lean; a template may take the
      // top THREE program ranks (D48 box-depth-3), sized inside the same
      // share. With win stakes held at the minimum (exacta-primary) the box
      // absorbs the allocation instead, leaving room for the mid-price exacta.
      const depth = Math.max(2, Number(rules.hedgeBoxDepth) || 2);
      const third = depth >= 3 ? programPick(race, 3) : null;
      const horses = dedupeEntries([top, second, third].filter(Boolean)).slice(0, depth);
      if (depth >= 3 && horses.length < 3) sup('split_exacta_box', 'no_third_pick');
      const combos = boxCost(1, horses.length, 2);
      const budget = minWin ? Math.max(0, A - perRaceMinCents - menu.exacta) : A * 0.4;
      const boxBase = Math.max(menu.exacta, (minWin ? Math.floor : Math.round)(budget / combos / menu.exacta) * menu.exacta);
      addTicket({
        raceNumbers: [race.number], betType: 'exacta_box',
        legs: [horses.map((h) => h.program_number)],
        stakeCents: boxBase, costCents: boxCost(boxBase, horses.length, 2),
        est: exactaEstimate(boxBase, ml(top), ml(second)), estIsRange: true,
        boxN: horses.length, boxUnit: menu.exacta, estMls: [ml(top), ml(second)],
        rationale: horses.length > 2 ? 'Exacta box across the top three program ranks' : 'Exacta box across the split',
      }, ['split_exacta_box']);
      horses.forEach((h) => usedPgms.add(h.program_number));
    }
    alloc.thesis = `Sources split between ${top.horse_name} and ${second?.horse_name ?? 'the field'}; win the better-backed side, box the pair.`;
  } else { // CHAOS
    sup('hedge_cut', 'not_split_classification');
    sup('fade_favorite_price', !rules.fadeThePrice ? 'disabled_by_template' : external === 0 ? 'no_algo_order' : 'not_unanimous');
    win(top, exotics ? winShare(Math.max(menu.win, A * 0.25)) : winShare(A), 'Small win on the best-backed pick in a wide-open race', ['chaos_anchor_win']);
    const shots = liveLongshots(race);
    if (!rules.chaosTrifectaBox || !exotics) sup('chaos_trifecta_box', !rules.chaosTrifectaBox ? 'disabled_by_template' : 'no_exotic_tickets');
    if (rules.chaosTrifectaBox && exotics) {
      const horses = dedupeEntries([top, second, shots[0], programPick(race, 3)].filter(Boolean)).slice(0, 4);
      if (horses.length >= 3) {
        const budget = A * (BET.chaosExoticShare - 0.2);
        const base = Math.max(menu.trifecta,
          Math.floor(budget / boxCost(1, horses.length, 3) / menu.trifecta) * menu.trifecta);
        addTicket({
          raceNumbers: [race.number], betType: 'trifecta_box',
          legs: [horses.map((h) => h.program_number)],
          stakeCents: base, costCents: boxCost(base, horses.length, 3),
          est: trifectaBoxEstimate(base, horses.map(ml)), estIsRange: true,
          rationale: 'Chaos race: the exotics carry the upside',
        }, ['chaos_trifecta_box']);
        horses.forEach((h) => usedPgms.add(h.program_number));
      } else sup('chaos_trifecta_box', 'insufficient_horses', { horses: horses.length });
    }
    if (!rules.longshotOnTop || !exotics || !shots[0]) sup('longshot_on_top', !rules.longshotOnTop ? 'disabled_by_template' : !exotics ? 'no_exotic_tickets' : 'no_live_longshot');
    if (rules.longshotOnTop && exotics && shots[0]) {
      emit('rule_fired', { rule: 'longshot_on_top', race: race.number, horse: shots[0].program_number });
      exacta(shots[0], [top], A * 0.2, 'Longshot over the anchor - lottery upside', ['longshot_on_top']);
    }
    alloc.thesis = `Three-plus opinions - spread it, let the exotics carry the day.`;
  }

  // Contrarian triggers ride the race notes.
  for (const f of flags) {
    if (f.type === 'corroborated_longshot') alloc.triggers.push(`Two sources independently on #${f.programNumber} (${f.horseName}); if the board drifts them further, press.`);
    if (f.type === 'algo_fades_favorite') alloc.triggers.push(`The algorithm fades the favorite (#${f.programNumber}); watch for a beatable price on top.`);
  }

  // Known failure mode #2: 2+-source horses get small coverage even lean.
  if (!exotics) sup('two_source_coverage', 'no_exotic_tickets');
  else if (!rules.coverageAdds) sup('two_source_coverage', 'disabled_by_template');
  let coverageFired = false;
  if (rules.coverageAdds && exotics) {
    for (const [pgm, n] of Object.entries(counts)) {
      if (n < 2 || usedPgms.has(pgm)) continue;
      const e = byNumber(race, pgm);
      if (!e) continue;
      emit('rule_fired', { rule: 'two_source_coverage', race: race.number, horse: pgm, sources: n });
      exacta(e, [top], Math.max(menu.exacta, BET.coverageStakeCents), `${n} sources flag #${pgm} - small coverage even in lean mode`, ['two_source_coverage']);
      coverageFired = true;
    }
    if (!coverageFired) sup('two_source_coverage', 'no_multi_source_horse');
  }

  // Mid-priced program horses stay in the exotic picture.
  if (!exotics) sup('mid_price_coverage', 'no_exotic_tickets');
  else if (!rules.midPriceCoverage) sup('mid_price_coverage', 'disabled_by_template');
  if (rules.midPriceCoverage && exotics) {
    const [lo, hi] = BET.midPriceRange;
    const mid = race.entries.find((e) => !e.scratched && e.program_rank != null &&
      ml(e) >= lo && ml(e) <= hi && !usedPgms.has(e.program_number));
    if (mid) {
      emit('rule_fired', { rule: 'mid_price_coverage', race: race.number, horse: mid.program_number, ml: ml(mid), reason: 'unmentioned mid-priced program horse is how moonshots die' });
      exacta(top, [mid], menu.exacta, `Mid-priced program horse #${mid.program_number} under the top`, ['mid_price_coverage']);
    } else sup('mid_price_coverage', 'no_mid_priced_horse');
  }
}

const dedupeEntries = (list) => {
  const seen = new Set();
  return list.filter((e) => e && !seen.has(e.program_number) && seen.add(e.program_number));
};

// ---------- place-money carve-out (D36, allocation integrity) ----------
//
// The mandatory place ticket (invariant 1) used to be ADDED on top of an
// 8-1+ win bet, pushing the race past its allocation and making the
// balancer shave every other race (2026-08-20 R5: $32 allocated, $44
// spent). The pair is now carved OUT of the allocation: with E = the race's
// exotic cost, the win tickets share (A - E) as before, except a win that
// will carry place money counts twice - so a lone 8-1+ win gets
// floor((A - E) / 2) and its place the same. The sweep then matches it.
function carveOutPlaceMoney({ race, alloc, tickets, rules, emit }) {
  if (!rules.placeMoneyRule) return;
  const mine = tickets.filter((t) => t.raceNumbers.length === 1 && t.raceNumbers[0] === race.number);
  const wins = mine.filter((t) => t.betType === 'win');
  const paired = wins.filter((t) => t.mlForPlaceRule != null && t.mlForPlaceRule >= BET.placeMoneyThresholdMl);
  if (!paired.length) return;
  const exoticCost = mine.filter((t) => t.betType !== 'win' && t.betType !== 'place').reduce((a, t) => a + t.costCents, 0);
  const budget = alloc.amountCents - exoticCost;
  const weight = wins.reduce((a, t) => a + t.stakeCents * (paired.includes(t) ? 2 : 1), 0);
  if (budget <= 0 || weight <= 0) return;
  const k = budget / weight;
  const menuWin = 200;
  for (const t of wins) {
    const before = t.stakeCents;
    const next = Math.max(menuWin, Math.floor((before * k) / 100) * 100);
    if (next === before) continue;
    t.stakeCents = next;
    t.costCents = next;
    if (t.mlForPlaceRule != null) { const p = winPayout(next, t.mlForPlaceRule); t.est = [p, p]; }
    emit('rule_fired', {
      rule: 'place_money_carve_out', race: race.number, horse: t.legs[0][0],
      fromCents: before, toCents: next, allocatedCents: alloc.amountCents, exoticCents: exoticCost,
      reason: paired.includes(t)
        ? `8-1+ win carries matching place money; the pair is sized inside the allocation (win = place = ${next / 100})`
        : 'win money rescaled so the race lands on its allocation with the place pair carved out',
    });
  }
}

// ---------- balancing ----------
//
// Ticket minimums and stake rounding leave each race a little off its
// allocation; the difference is absorbed in win stakes (they have no
// combinatorics). Two phases, both ONE $1 step per race per pass, a
// place-money pair moving together at $2 a step:
//   1. DEFICITS first - a race below its allocation is topped up toward
//      it (largest deficit first), a race above it is trimmed toward it;
//   2. the rest ROUND-ROBIN, larger allocations first, so no race is ever
//      more than one step ahead of another (D30).
// Guesswork races stay at their minimum unless nothing else can take the
// money. Races that cannot take a step are listed as skipped with the
// reason, so the trace says why money did not land there.
function balance({ tickets, allocations, bankrollCents, emit }) {
  const total = () => tickets.reduce((a, t) => a + t.costCents, 0);
  const remainderCents = bankrollCents - total();
  if (remainderCents === 0) return;
  let diff = remainderCents;

  const spentIn = (race) => tickets.filter((t) => t.raceNumbers.length === 1 && t.raceNumbers[0] === race).reduce((a, t) => a + t.costCents, 0);
  const allocOf = new Map(allocations.map((a) => [a.race, a]));
  const byRace = new Map();
  const heldRaces = new Set(tickets.filter((t) => t.betType === 'win' && t.holdStake).map((t) => t.raceNumbers[0]));
  for (const t of tickets) {
    if (t.betType !== 'win' || t.holdStake) continue;
    const race = t.raceNumbers[0];
    const cur = byRace.get(race);
    if (cur && cur.win.stakeCents >= t.stakeCents) continue;
    const place = tickets.find((p) => p.betType === 'place' &&
      p.raceNumbers[0] === race && p.legs[0][0] === t.legs[0][0] &&
      p.stakeCents === t.stakeCents) ?? null;
    byRace.set(race, {
      race, win: t, place, unit: place ? 200 : 100,
      allocatedCents: allocOf.get(race)?.amountCents ?? 0,
      guess: allocOf.get(race)?.confidence === 'GUESS',
      amountCents: 0, steps: 0,
    });
  }
  // D48: a race whose win stakes are HELD by the template (exacta-primary)
  // absorbs remainder in its exacta box instead - one base unit a step.
  for (const t of tickets) {
    if (t.betType !== 'exacta_box' || !t.boxUnit) continue;
    const race = t.raceNumbers[0];
    if (!heldRaces.has(race) || byRace.has(race)) continue;
    const straight = tickets.find((x) => x.betType === 'exacta' && x.raceNumbers.length === 1 && x.raceNumbers[0] === race && x.legs.length === 2 && x.legs[1].length === 1) ?? null;
    byRace.set(race, { race, box: t, straight, unit: t.boxUnit * boxCost(1, t.boxN, 2), allocatedCents: allocOf.get(race)?.amountCents ?? 0, guess: false, amountCents: 0, steps: 0 });
  }
  const candidates = [...byRace.values()]
    .sort((a, b) => b.allocatedCents - a.allocatedCents || a.race - b.race);
  const skipped = allocations
    .filter((a) => !byRace.has(a.race))
    .map((a) => ({ race: a.race, reason: heldRaces.has(a.race) ? 'stake_held_by_template' : 'no_win_ticket' }));

  const dir = Math.sign(diff);
  let passes = 0;
  const step = (c) => {
    if (c.box && Math.abs(diff) < c.unit && c.straight) {
      // Less than a box step left: the race's straight exacta takes $1 steps.
      const unit = c.box.boxUnit;
      if (Math.abs(diff) < unit) return false;
      const nextBase = c.straight.stakeCents + dir * unit;
      if (nextBase < unit) return false;
      c.straight.stakeCents = nextBase; c.straight.costCents = comboCost(nextBase, c.straight.legs);
      c.amountCents += dir * unit; c.steps++;
      diff -= dir * unit;
      return true;
    }
    if (Math.abs(diff) < c.unit) return false;
    if (c.box) {
      const nextBase = c.box.stakeCents + dir * c.box.boxUnit;
      if (nextBase < c.box.boxUnit) return false;
      c.box.stakeCents = nextBase; c.box.costCents = boxCost(nextBase, c.box.boxN, 2);
      c.box.est = exactaEstimate(nextBase, c.box.estMls[0], c.box.estMls[1]);
      c.amountCents += dir * c.unit; c.steps++;
      diff -= dir * c.unit;
      return true;
    }
    const next = c.win.stakeCents + dir * 100;
    if (next < 200) return false; // keep the $2 win minimum
    c.win.stakeCents = next; c.win.costCents = next;
    if (c.place) { c.place.stakeCents = next; c.place.costCents = next; }
    c.amountCents += dir * c.unit; c.steps++;
    diff -= dir * c.unit;
    return true;
  };
  // Phase 1: toward each race's own allocation (deficit when adding money,
  // surplus when taking it back), guesswork races excluded.
  const wanting = () => candidates.filter((c) => !c.guess && dir * (c.allocatedCents - spentIn(c.race)) >= c.unit)
    .sort((a, b) => dir * ((b.allocatedCents - spentIn(b.race)) - (a.allocatedCents - spentIn(a.race))));
  let moved = true;
  while (moved && diff !== 0) {
    moved = false;
    for (const c of wanting()) if (step(c)) moved = true;
    if (moved) passes++;
  }
  // Phase 2: whatever is left, round-robin, guesswork races last.
  for (const tier of [candidates.filter((c) => !c.guess), candidates.filter((c) => c.guess)]) {
    moved = true;
    while (moved && diff !== 0) {
      moved = false;
      for (const c of tier) if (step(c)) moved = true;
      if (moved) passes++;
    }
  }
  for (const c of candidates) {
    if (c.steps === 0 && c.guess) skipped.push({ race: c.race, reason: 'guesswork_floor' });
  }

  // Payout estimates track the new stakes: win is exact morning-line
  // math, place is the labeled range - recompute, never approximate.
  for (const c of candidates) {
    if (c.steps === 0 || !c.win) continue;
    if (c.win.mlForPlaceRule != null) {
      const p = winPayout(c.win.stakeCents, c.win.mlForPlaceRule);
      c.win.est = [p, p];
    }
    if (c.place && c.place.mlForPlaceRule != null) {
      c.place.est = placeEstimate(c.place.stakeCents, c.place.mlForPlaceRule);
    }
  }

  emit('remainder_distributed', {
    remainderCents,
    passes,
    races: candidates.filter((c) => c.steps > 0).map((c) => ({
      race: c.race,
      amountCents: c.amountCents,
      steps: c.steps,
      ticket: (c.win ?? c.box).sequence,
      withPlace: Boolean(c.place),
      allocatedCents: c.allocatedCents,
    })),
    skipped,
    undistributedCents: diff,
  });
  emit('bankroll_balanced', { adjusted: diff === 0, remainingCents: diff });
}

// ---------- finishing ----------

function finishTicket(t) {
  return {
    raceNumbers: t.raceNumbers,
    betType: t.betType,
    legs: t.legs,
    stakeCents: t.stakeCents,
    costCents: t.costCents,
    estMinCents: t.est?.[0] ?? null,
    estMaxCents: t.est?.[1] ?? null,
    estIsRange: Boolean(t.estIsRange),
    tellerCall: tellerCall(t.betType, t.raceNumbers, t.stakeCents, t.legs),
    rationale: t.rationale ?? null,
    ruleTags: t.ruleTags ?? [],
    sequence: t.sequence,
  };
}
