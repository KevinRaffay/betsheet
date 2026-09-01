// Ticket grading: a card's tickets + the day's actual results -> outcome,
// money returned and P/L for every ticket. Pure functions (no DB, clock,
// network) so the Phase 3 simulator replays the exact grader that scored
// live cards.
//
// Payout conventions (the chart's own):
//   * WPS prices are per $2: returned = stake * price / 200.
//   * Exotic payoffs are per their printed base: returned =
//     stake / baseCents * payoutCents (stake is per combination).
//   * A chart combination part may name two winners ("1/4" - dead heats,
//     all-win legs); a part matches if ANY of its alternatives is covered.
//
// Scratch and refund policy (documented, deliberately conservative):
//   * WPS on a scratched horse: full refund.
//   * Single-race exotic: combinations involving a scratched selection are
//     refunded at the per-combination stake; surviving combinations grade
//     normally. All combinations scratched = full refund.
//   * Multi-race pool bets (double, pick N): if our only selection in a
//     leg scratched, the ticket is refunded whole. (Tracks pay
//     consolations/rollovers here; the conservative refund never
//     overstates P/L. Revisit with real consolation data.)
//   * Win parlay (our own construct, not a pool): a scratched leg passes
//     through at factor 1.0, standard parlay practice.
//
// Outcomes: 'win' (money came back from a hit, refunds included or not),
// 'refund' (stake back, nothing won), 'partial' (some combinations
// refunded, the rest lost), 'loss'.

const partMatches = (part, selectionSet) =>
  part.split('/').some((alt) => selectionSet.has(alt));

const perms = (n, k) => {
  let out = 1;
  for (let i = 0; i < k; i++) out *= (n - i);
  return out;
};

/**
 * Grade one ticket.
 * `ticket`: { betType, races: [raceNumbers], legs: [[pgms]], stakeCents, costCents }
 * `dayResults`: Map raceNumber -> {
 *   finishByPos: Map pos -> Set(pgm), priceOf: Map pgm -> {win,place,show},
 *   exotics: [{betType, baseCents, combination, payoutCents}],
 *   scratched: Set(pgm),
 * }
 */
export function gradeTicket(ticket, dayResults) {
  const { betType, races, legs, stakeCents, costCents } = ticket;
  const detail = { legs, races };
  const done = (outcome, returnedCents, note) => ({
    outcome, returnedCents, plCents: returnedCents - costCents, note: note ?? null, detail,
  });

  const r = (n) => dayResults.get(n);
  const missing = races.filter((n) => !r(n));
  if (missing.length) return done('loss', 0, `no results for race ${missing.join(', ')} - ungradable`);

  // ---------- WPS ----------
  if (betType === 'win' || betType === 'place' || betType === 'show') {
    const race = r(races[0]);
    const pgm = legs[0][0];
    if (race.scratched.has(pgm)) return done('refund', costCents, 'selection scratched');
    const need = betType === 'win' ? 1 : betType === 'place' ? 2 : 3;
    for (let pos = 1; pos <= need; pos++) {
      if (race.finishByPos.get(pos)?.has(pgm)) {
        const price = race.priceOf.get(pgm)?.[betType];
        if (price == null) return done('loss', 0, `finished ${pos} but no ${betType} price in the chart`);
        return done('win', Math.round(stakeCents * price / 200));
      }
    }
    return done('loss', 0);
  }

  // ---------- win parlay (our construct; graded off win prices) ----------
  if (betType === 'parlay') {
    let factor = 1;
    let liveLegs = 0;
    for (let i = 0; i < races.length; i++) {
      const race = r(races[i]);
      const pgm = legs[i][0];
      if (race.scratched.has(pgm)) continue; // pass-through leg
      liveLegs++;
      if (!race.finishByPos.get(1)?.has(pgm)) return done('loss', 0, `leg ${races[i]} lost`);
      factor *= (race.priceOf.get(pgm)?.win ?? 0) / 200;
    }
    if (liveLegs === 0) return done('refund', costCents, 'every leg scratched');
    return done('win', Math.round(stakeCents * factor), liveLegs < races.length ? 'scratched leg(s) passed through' : null);
  }

  // ---------- multi-race pool bets ----------
  if (betType === 'daily_double' || /^pick\d$/.test(betType)) {
    const settleRace = r(races[races.length - 1]);
    for (let i = 0; i < races.length; i++) {
      if (legs[i].every((p) => r(races[i]).scratched.has(p))) {
        return done('refund', costCents, `leg ${races[i]} scratched out`);
      }
    }
    const row = settleRace.exotics.find((x) => x.betType === betType);
    if (!row) return done('loss', 0, `no ${betType} payoff in the chart`);
    const parts = row.combination.split('-');
    if (parts.length !== legs.length) return done('loss', 0, 'combination shape mismatch');
    const hit = parts.every((part, i) => partMatches(part, new Set(legs[i])));
    return hit
      ? done('win', Math.round(stakeCents / row.baseCents * row.payoutCents))
      : done('loss', 0);
  }

  // ---------- single-race exotics ----------
  const race = r(races[0]);
  const straight = { exacta: 2, trifecta: 3, superfecta: 4, quinella: 2 };
  const boxed = { exacta_box: 2, trifecta_box: 3, superfecta_box: 4 };

  if (betType in straight || betType in boxed) {
    const positions = straight[betType] ?? boxed[betType];
    const chartType = betType.replace(/_box$/, '');
    const row = race.exotics.find((x) => x.betType === chartType);

    // Refund accounting: combinations that involved a scratched selection.
    let combosTotal;
    let combosScratched;
    if (betType in boxed) {
      const set = legs[0];
      const live = set.filter((p) => !race.scratched.has(p));
      combosTotal = perms(set.length, positions);
      combosScratched = combosTotal - perms(live.length, positions);
    } else {
      combosTotal = legs.reduce((a, l) => a * l.length, 1);
      const liveCombos = legs.reduce((a, l) => a * l.filter((p) => !race.scratched.has(p)).length, 1);
      combosScratched = combosTotal - liveCombos;
    }
    const refundCents = Math.round(costCents * (combosScratched / combosTotal));
    if (combosScratched === combosTotal) return done('refund', costCents, 'all combinations scratched');

    if (!row) {
      return combosScratched > 0
        ? done('partial', refundCents, 'no payoff row; scratched combinations refunded')
        : done('loss', 0, `no ${chartType} payoff in the chart`);
    }
    const parts = row.combination.split('-');
    let hit;
    if (betType === 'quinella' || betType in boxed) {
      const set = new Set(legs[0] ?? legs.flat());
      hit = parts.length === positions && parts.every((part) => partMatches(part, set));
    } else {
      hit = parts.length === positions && parts.every((part, i) => partMatches(part, new Set(legs[i])));
    }
    if (hit) {
      const winCents = Math.round(stakeCents / row.baseCents * row.payoutCents);
      return done('win', winCents + refundCents, combosScratched ? 'hit + scratched combinations refunded' : null);
    }
    return combosScratched > 0
      ? done('partial', refundCents, 'scratched combinations refunded, the rest lost')
      : done('loss', 0);
  }

  return done('loss', 0, `unknown bet type "${betType}" - graded as no return`);
}

/**
 * Build the grading view of a day's stored results.
 * `races`: [{ number, results: [{programNumber, finishPosition, winCents,
 *   placeCents, showCents}], exotics: [...], scratchedPgms: [pgms] }]
 */
export function buildDayResults(races) {
  const map = new Map();
  for (const race of races) {
    const finishByPos = new Map();
    const priceOf = new Map();
    for (const res of race.results) {
      if (res.finishPosition != null) {
        if (!finishByPos.has(res.finishPosition)) finishByPos.set(res.finishPosition, new Set());
        finishByPos.get(res.finishPosition).add(res.programNumber);
      }
      priceOf.set(res.programNumber, {
        win: res.winCents, place: res.placeCents, show: res.showCents,
      });
    }
    map.set(race.number, {
      finishByPos,
      priceOf,
      exotics: race.exotics ?? [],
      scratched: new Set(race.scratchedPgms ?? []),
    });
  }
  return map;
}

/** Grade a whole card. Returns per-ticket grades + the card summary. */
export function gradeCard(tickets, dayResults) {
  const grades = tickets.map((t) => ({ ticket: t, ...gradeTicket(t, dayResults) }));
  const summary = {
    costCents: grades.reduce((a, g) => a + g.ticket.costCents, 0),
    returnedCents: grades.reduce((a, g) => a + g.returnedCents, 0),
    outcomes: grades.reduce((a, g) => ((a[g.outcome] = (a[g.outcome] ?? 0) + 1), a), {}),
  };
  summary.plCents = summary.returnedCents - summary.costCents;
  // Known failure mode #3 relative: how dependent was the day on one ticket?
  const best = Math.max(0, ...grades.map((g) => g.returnedCents));
  summary.topTicketShare = summary.returnedCents > 0 ? best / summary.returnedCents : 0;
  return { grades, summary };
}
