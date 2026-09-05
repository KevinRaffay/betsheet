// Replay (D55): blind race-by-race human play against a stored day, and
// the standing table comparing it to lean. Pure (browser + Node) - no DB,
// no clock. Reuses shared/distribution.js's maxDrawdown directly rather
// than duplicating it.
//
// Blindness is a recorded fact, derived from timestamps, never set by
// hand (invariant 15): a day is PRE_COMMIT if every lock on the card
// (PASS rows included) precedes the earliest reveal on it, else
// SEQUENTIAL; a card that isn't the day's first human card is NON_BLIND
// unconditionally - the D28 replay-of-a-replayed-day case.

export { maxDrawdown } from './distribution.js';

/**
 * `locks`: every picks_locked_at on the card (ISO strings, PASS rows
 * included - a race locked after another race's reveal makes the WHOLE
 * card sequential even if that race itself is never revealed). `reveals`:
 * every results_revealed_at present on the card (nulls filtered out
 * before calling). `isFirstHumanCardOfDay`: false when this card isn't
 * the day's lowest card_number human card (a second playthrough).
 */
export function computeBlindness({ locks = [], reveals = [], isFirstHumanCardOfDay = true }) {
  if (!isFirstHumanCardOfDay) return 'NON_BLIND';
  if (reveals.length === 0) return null; // undetermined - never reached once a card is closed
  const maxLock = locks.reduce((a, t) => (t > a ? t : a), locks[0] ?? '');
  const minReveal = reveals.reduce((a, t) => (t < a ? t : a), reveals[0]);
  return maxLock <= minReveal ? 'PRE_COMMIT' : 'SEQUENTIAL';
}

/**
 * A card is closed once every race of the day has a human_race_state row
 * that's either passed or revealed - the state POST /replay/cards/:id/close
 * guarantees in one call. `raceStates`: [{raceNumber, passed, resultsRevealedAt}].
 */
export function isCardClosed({ raceNumbers, raceStates }) {
  const byNumber = new Map(raceStates.map((s) => [s.raceNumber, s]));
  return raceNumbers.every((n) => {
    const s = byNumber.get(n);
    return s && (s.passed === 1 || s.passed === true || s.resultsRevealedAt != null);
  });
}

/**
 * The human's top pick vs. the program's rank-1 pick, over every played
 * race in scope. `rows`: [{ race, humanWinTickets: [{programNumber,
 * stakeCents}], programRank1Pgm, externalTopPgm, humanTopGraded: {outcome,
 * returnedCents} | null, programTopGraded: {outcome, returnedCents} |
 * null }]. A race with no human win ticket, or a tie for the largest
 * stake, is EXCLUDED (never guessed) and counted with its reason.
 */
export function pickerAgreement(rows) {
  let racesConsidered = 0;
  let excludedNoWinTicket = 0;
  let excludedTiedStakes = 0;
  let matchesProgramRank1 = 0;
  let matchesExternalTop = 0;
  let matchesNeither = 0;
  let externalComparable = 0;
  let humanCost = 0; let humanReturned = 0; let humanWins = 0;
  let programCost = 0; let programReturned = 0; let programWins = 0;
  const FLAT_STAKE_CENTS = 200;

  for (const row of rows) {
    const wins = row.humanWinTickets ?? [];
    if (wins.length === 0) { excludedNoWinTicket++; continue; }
    const maxStake = Math.max(...wins.map((w) => w.stakeCents));
    const top = wins.filter((w) => w.stakeCents === maxStake);
    if (top.length !== 1) { excludedTiedStakes++; continue; }
    racesConsidered++;
    const humanTopPgm = top[0].programNumber;

    if (humanTopPgm === row.programRank1Pgm) matchesProgramRank1++;
    if (row.externalTopPgm != null) {
      externalComparable++;
      if (humanTopPgm === row.externalTopPgm) matchesExternalTop++;
    }
    if (humanTopPgm !== row.programRank1Pgm && (row.externalTopPgm == null || humanTopPgm !== row.externalTopPgm)) matchesNeither++;

    if (row.humanTopGraded) {
      humanCost += FLAT_STAKE_CENTS;
      humanReturned += row.humanTopGraded.returnedCents;
      if (row.humanTopGraded.outcome === 'win') humanWins++;
    }
    if (row.programTopGraded) {
      programCost += FLAT_STAKE_CENTS;
      programReturned += row.programTopGraded.returnedCents;
      if (row.programTopGraded.outcome === 'win') programWins++;
    }
  }

  const roi = (returned, cost) => (cost > 0 ? (returned - cost) / cost : null);
  return {
    racesConsidered,
    excludedRaces: excludedNoWinTicket + excludedTiedStakes,
    excludedReasons: { no_win_ticket: excludedNoWinTicket, tied_stakes: excludedTiedStakes },
    externalComparable,
    matchesProgramRank1,
    matchesExternalTop,
    matchesNeither,
    humanWinPct: racesConsidered > 0 ? humanWins / racesConsidered : null,
    humanFlatRoi: roi(humanReturned, humanCost),
    programWinPct: racesConsidered > 0 ? programWins / racesConsidered : null,
    programFlatRoi: roi(programReturned, programCost),
  };
}
