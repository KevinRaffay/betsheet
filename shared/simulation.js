// Simulation (D19): every strategy template replayed against every stored
// race day that has real results. PURE - the server module feeds it the
// same engine input a live card gets (day + fresh classification) and the
// same stored chart the live grader used, so a simulated day and a live
// card on that day are the exact same computation with a different rule
// set. Invariant 13 rules the roll-up: every number lives inside its
// consensus_completeness bucket and nothing here pools buckets.

import { generateCard } from './card-engine.js';
import { gradeCard } from './grading.js';

export const BUCKET_ORDER = ['FULL', 'PARTIAL', 'PROGRAM_ONLY'];

/**
 * One day under one rule set: generate the card, grade it against the
 * day's results. `input` is exactly generateCard's argument; `dayResults`
 * is buildDayResults()' map. Returns the day row the roll-up consumes plus
 * the per-ticket detail the run persists.
 */
export function simulateDay(input, dayResults) {
  const card = generateCard(input);
  const tickets = card.tickets.map((t) => ({
    sequence: t.sequence, betType: t.betType, races: t.raceNumbers, legs: t.legs,
    stakeCents: t.stakeCents, costCents: t.costCents, ruleTags: t.ruleTags,
  }));
  const { grades, summary } = gradeCard(tickets, dayResults);
  return {
    completeness: card.completeness,
    costCents: summary.costCents,
    returnedCents: summary.returnedCents,
    plCents: summary.plCents,
    tickets: tickets.length,
    wins: summary.outcomes.win ?? 0,
    outcomes: summary.outcomes,
    topTicketShare: summary.topTicketShare,
    ticketDetails: grades.map((g) => ({
      sequence: g.ticket.sequence, betType: g.ticket.betType, races: g.ticket.races, legs: g.ticket.legs,
      stakeCents: g.ticket.stakeCents, costCents: g.ticket.costCents, ruleTags: g.ticket.ruleTags,
      outcome: g.outcome, returnedCents: g.returnedCents, plCents: g.plCents, note: g.note ?? null,
    })),
    warnings: card.warnings,
  };
}

/**
 * Roll a run's day rows up per bucket, with the bankroll-over-time series.
 * `dayRows`: [{ raceDayId, track, date, completeness, costCents,
 *   returnedCents, plCents, tickets, wins }] in any order.
 * `startingBankrollCents` (optional) turns the running P/L into a running
 * bankroll. There is deliberately NO all-bucket total in the result.
 */
export function summarizeRun(dayRows, { startingBankrollCents = null } = {}) {
  const byBucket = new Map();
  const ordered = [...dayRows].sort((a, b) =>
    a.date.localeCompare(b.date) || a.track.localeCompare(b.track) || a.raceDayId - b.raceDayId);
  for (const row of ordered) {
    if (!byBucket.has(row.completeness)) {
      byBucket.set(row.completeness, {
        completeness: row.completeness, days: 0, tickets: 0, wins: 0,
        costCents: 0, returnedCents: 0, plCents: 0, losingDays: 0, series: [],
      });
    }
    const b = byBucket.get(row.completeness);
    b.days++;
    b.tickets += row.tickets;
    b.wins += row.wins;
    b.costCents += row.costCents;
    b.returnedCents += row.returnedCents;
    b.plCents += row.plCents;
    if (row.plCents < 0) b.losingDays++;
    b.series.push({
      raceDayId: row.raceDayId, track: row.track, date: row.date,
      costCents: row.costCents, returnedCents: row.returnedCents, plCents: row.plCents,
      runningCents: b.plCents,
      bankrollCents: startingBankrollCents == null ? null : startingBankrollCents + b.plCents,
    });
  }
  return { buckets: BUCKET_ORDER.filter((k) => byBucket.has(k)).map((k) => byBucket.get(k)) };
}
