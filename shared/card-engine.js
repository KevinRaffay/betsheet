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

// The engine version (D34, invariant 14). ONE place in code; bump it in
// every PR that changes generation, allocation, ticket construction or
// grading behavior. Every card and every grade records the version it was
// produced under, so "the algorithm improved" and "I regraded under
// different rules" are distinguishable and never overwrite each other.
// 'lean-0' is reserved for cards that predate versioning.
export const ENGINE_VERSION = 'lean-1.0.1';

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
};

export const FAILURE_MODE_WARNINGS = [
  'Unanimous consensus is not certainty: a 7/2 shot everyone agrees on still loses most of the time - and when it loses, the race often comes apart completely.',
  'On chaos days, second-tier "watch out for" horses win at prices - small coverage on 2+-source horses is on this card for that reason.',
  'Expert sources and the public draw from the same well; a card of double-digit winners beats every source simultaneously. This card promises nothing variance does not allow.',
];

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
  }

  // ----- allocation -----
  const guessRaces = races.filter(isGuessRace);
  const weighted = races.filter((r) => !isGuessRace(r));
  const curve = BET.allocationCurves[rules.allocationCurve] ?? BET.allocationCurves.lean;
  const weightFor = (r) => curve[r.classification.classification] ?? 1.5;
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
    buildRaceTickets({ race, alloc, rules, addTicket, emit, warnings });
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
      if (entryMl == null || entryMl < BET.placeMoneyThresholdMl) continue;
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
    emit('rule_suppressed', { rule: 'place_money_rule', reason: 'disabled by template' });
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

function buildRaceTickets({ race, alloc, rules, addTicket, emit, warnings }) {
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

  const win = (entry, stakeCents, rationale, tags) => {
    stakeCents = Math.max(menu.win, Math.round(stakeCents / 100) * 100);
    addTicket({
      raceNumbers: [race.number], betType: 'win',
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
    win(top, A, 'Guesswork race - minimum stake on the best-backed pick', ['guesswork_minimum']);
    alloc.thesis = 'Debut/guesswork race: nobody knows, so the card risks the minimum.';
    return;
  }

  if (cls === 'UNANIMOUS') {
    const shots = liveLongshots(race);
    if (rules.fadeThePrice && ml(top) != null && ml(top) <= BET.oddsOnMl) {
      emit('rule_fired', { rule: 'fade_favorite_price', race: race.number, favorite: top.program_number, ml: ml(top), reason: 'legit odds-on favorite is unbettable to win; goes on TOP of exactas instead' });
      emit('rule_suppressed', { rule: 'win_bet', race: race.number, reason: `top pick at ${ml(top)}-1 is below the ${BET.oddsOnMl}-1 win floor` });
      const unders = dedupeEntries([...(shots.length ? shots : []), second].filter(Boolean)).slice(0, 3);
      exacta(top, unders, A * 0.55 / Math.max(1, unders.length), `Favorite on top over the live prices (${unders.map((u) => u.horse_name).join(', ')})`, ['fade_favorite_price']);
      const shot = shots[0] ?? second;
      if (rules.longshotOnTop && shot) {
        emit('rule_fired', { rule: 'longshot_on_top', race: race.number, horse: shot.program_number });
        exacta(shot, [top], A * 0.45, 'The flip: longshot on top for the lottery upside', ['longshot_on_top', 'keep_stacks']);
      }
      alloc.thesis = `${top.horse_name} is legit but unbettable at ${top.morning_line}; the money is in the exotics under and over.`;
      alloc.triggers.push(`If #${top.program_number} drifts above even money, the win bet becomes playable.`);
      if (shot) alloc.triggers.push(`If #${shot.program_number} drifts past 15-1, added value on the flip.`);
    } else {
      win(top, A * 0.45, 'Unanimous top pick - bet it hardest', ['unanimous_win']);
      if (second) {
        exacta(top, [second], A * 0.33, 'Straight exacta on the thesis', ['unanimous_exacta']);
        exacta(second, [top], A * 0.22, 'The flip - same thesis, different order (keep stacks)', ['keep_stacks']);
      }
      alloc.thesis = `Every source lands on ${top.horse_name}; the card bets the agreement and stacks the exacta both ways.`;
    }
  } else if (cls === 'SPLIT') {
    const backers = (pgm) => race.classification.topVotes?.find((v) => v.programNumber === pgm)?.sources.length ?? 0;
    win(top, A * 0.4, 'Better-backed side of the split', ['split_primary_win']);
    if (second && rules.hedgeCut && backers(second.program_number) >= 2) {
      win(second, A * 0.2, 'Second side carries real backing too', ['split_secondary_win']);
    } else if (second) {
      emit('rule_fired', { rule: 'hedge_cut', race: race.number, cut: second.program_number, reason: 'thin backing - cut to the best one, not dutched' });
    }
    if (second) {
      const boxBase = Math.max(menu.exacta, Math.round((A * 0.4) / 2 / menu.exacta) * menu.exacta);
      addTicket({
        raceNumbers: [race.number], betType: 'exacta_box',
        legs: [[top.program_number, second.program_number]],
        stakeCents: boxBase, costCents: boxCost(boxBase, 2, 2),
        est: exactaEstimate(boxBase, ml(top), ml(second)), estIsRange: true,
        rationale: 'Exacta box across the split',
      }, ['split_exacta_box']);
      usedPgms.add(top.program_number).add(second.program_number);
    }
    alloc.thesis = `Sources split between ${top.horse_name} and ${second?.horse_name ?? 'the field'}; win the better-backed side, box the pair.`;
  } else { // CHAOS
    win(top, Math.max(menu.win, A * 0.25), 'Small win on the best-backed pick in a wide-open race', ['chaos_anchor_win']);
    const shots = liveLongshots(race);
    if (rules.chaosTrifectaBox) {
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
      }
    }
    if (rules.longshotOnTop && shots[0]) {
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
  if (rules.coverageAdds) {
    for (const [pgm, n] of Object.entries(counts)) {
      if (n < 2 || usedPgms.has(pgm)) continue;
      const e = byNumber(race, pgm);
      if (!e) continue;
      emit('rule_fired', { rule: 'two_source_coverage', race: race.number, horse: pgm, sources: n });
      exacta(e, [top], Math.max(menu.exacta, BET.coverageStakeCents), `${n} sources flag #${pgm} - small coverage even in lean mode`, ['two_source_coverage']);
    }
  }

  // Mid-priced program horses stay in the exotic picture.
  if (rules.midPriceCoverage) {
    const [lo, hi] = BET.midPriceRange;
    const mid = race.entries.find((e) => !e.scratched && e.program_rank != null &&
      ml(e) >= lo && ml(e) <= hi && !usedPgms.has(e.program_number));
    if (mid) {
      emit('rule_fired', { rule: 'mid_price_coverage', race: race.number, horse: mid.program_number, ml: ml(mid), reason: 'unmentioned mid-priced program horse is how moonshots die' });
      exacta(top, [mid], menu.exacta, `Mid-priced program horse #${mid.program_number} under the top`, ['mid_price_coverage']);
    }
  }
}

const dedupeEntries = (list) => {
  const seen = new Set();
  return list.filter((e) => e && !seen.has(e.program_number) && seen.add(e.program_number));
};

// ---------- balancing ----------
//
// Ticket minimums and stake rounding leave each race spending a little
// more or less than its allocation; the difference is absorbed in win
// stakes (they have no combinatorics). The remainder is spread ROUND-ROBIN:
// each pass hands ONE $1 step to every race's primary win ticket (a win
// bound by the place-money pairing moves with its place, $2 a step),
// larger allocations first, so no race is ever more than one step ahead of
// another. Guesswork races stay at their minimum unless nothing else can
// take the money. Found live (every card since D10): the old rule parked
// the whole remainder on the single biggest win ticket - card 16 R1 was
// allocated $37, spent $65, $51 of it on one horse.

function balance({ tickets, allocations, bankrollCents, emit }) {
  const total = () => tickets.reduce((a, t) => a + t.costCents, 0);
  const remainderCents = bankrollCents - total();
  if (remainderCents === 0) return;
  let diff = remainderCents;

  // One candidate per race: its biggest win ticket (+ paired place).
  const allocOf = new Map(allocations.map((a) => [a.race, a]));
  const byRace = new Map();
  for (const t of tickets) {
    if (t.betType !== 'win') continue;
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
  const candidates = [...byRace.values()]
    .sort((a, b) => b.allocatedCents - a.allocatedCents || a.race - b.race);
  const tiers = [candidates.filter((c) => !c.guess), candidates.filter((c) => c.guess)];

  const dir = Math.sign(diff);
  let passes = 0;
  for (const tier of tiers) {
    let moved = true;
    while (moved && diff !== 0) {
      moved = false;
      for (const c of tier) {
        if (Math.abs(diff) < c.unit) continue;
        const next = c.win.stakeCents + dir * 100;
        if (next < 200) continue; // keep the $2 win minimum
        c.win.stakeCents = next;
        c.win.costCents = next;
        if (c.place) { c.place.stakeCents = next; c.place.costCents = next; }
        c.amountCents += dir * c.unit;
        c.steps++;
        diff -= dir * c.unit;
        moved = true;
      }
      if (moved) passes++;
    }
  }

  // Payout estimates track the new stakes: win is exact morning-line
  // math, place is the labeled range - recompute, never approximate.
  for (const c of candidates) {
    if (c.steps === 0) continue;
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
      ticket: c.win.sequence,
      withPlace: Boolean(c.place),
      allocatedCents: c.allocatedCents,
    })),
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
