// Pure derivations over the bundled payload for the emubets-style screens
// (D364): the stats strip, the next race, the picks on a race, the cashed
// tickets. No React, no I/O - a plain function of the payload, so every
// number on the home and day screens is traceable to a card or grade row
// already in the bundle.

import { localWallClockToUtc, formatPacific } from '@shared/race-calendar.js';

const liveRunners = (race) => race.entries.filter((e) => !e.scratched).length;

/** The headline numbers for ONE day: emubets prints "11 races • 112 runners • Avg field 10". */
export function dayStats(day) {
  const runners = day.races.reduce((n, r) => n + liveRunners(r), 0);
  const graded = day.cards.filter((c) => c.grades?.summary);
  return {
    races: day.races.length,
    runners,
    avgField: day.races.length ? Math.round(runners / day.races.length) : 0,
    cards: day.cards.length,
    graded: graded.length,
    plCents: graded.length ? graded.reduce((n, c) => n + c.grades.summary.plCents, 0) : null,
    hasResults: (day.results?.finishers?.length ?? 0) > 0,
  };
}

/** The same numbers across the whole bundle, for the home screen's strip. */
export function bundleStats(raceDays) {
  const per = raceDays.map(dayStats);
  const graded = per.filter((s) => s.graded > 0);
  return {
    days: raceDays.length,
    tracks: new Set(raceDays.map((d) => d.raceDay.track)).size,
    races: per.reduce((n, s) => n + s.races, 0),
    cards: per.reduce((n, s) => n + s.cards, 0),
    gradedCards: per.reduce((n, s) => n + s.graded, 0),
    plCents: graded.length ? graded.reduce((n, s) => n + s.plCents, 0) : null,
  };
}

const gradeIndex = (card) => new Map((card.grades?.rows ?? []).map((g) => [g.sequence, g]));

/**
 * Every ticket any card on the day placed on race `number`, grouped by card
 * - the "expert selections" block emubets shows per race, with each card
 * standing in for a tipster. A multi-race ticket (a Pick 3 over 4-5-6) is
 * listed once, on its FIRST leg, and says which races it spans.
 */
export function picksForRace(day, number) {
  const groups = [];
  for (const card of day.cards) {
    const grades = gradeIndex(card);
    const tickets = card.tickets
      .filter((t) => (t.selections?.races ?? [])[0] === number)
      .map((t) => ({ ticket: t, grade: grades.get(t.sequence) ?? null }));
    if (tickets.length) groups.push({ card, tickets });
  }
  return groups;
}

/** Top finishers for one race, in finish order, plus that race's exotic payoffs. */
export function resultsForRace(day, number) {
  const finishers = (day.results?.finishers ?? [])
    .filter((f) => f.race_number === number)
    .sort((a, b) => a.finish_position - b.finish_position);
  const exotics = (day.results?.exotics ?? []).filter((x) => x.race_number === number);
  return { finishers, exotics };
}

/**
 * Every graded ticket that returned money, newest day first and biggest
 * return first within a day - emubets' "Recent Winning Selections". Each row
 * carries enough to name the day, the race and the card it came from.
 */
export function cashedTickets(raceDays, limit = 10) {
  const rows = [];
  for (const day of raceDays) {
    for (const card of day.cards) {
      for (const g of card.grades?.rows ?? []) {
        if (g.outcome !== 'win' && g.outcome !== 'partial') continue;
        if (!(g.returned_cents > 0)) continue;
        rows.push({
          day, card, grade: g,
          raceNumber: g.selections?.races?.[0] ?? null,
        });
      }
    }
  }
  rows.sort((a, b) => (b.day.raceDay.date.localeCompare(a.day.raceDay.date))
    || (b.grade.returned_cents - a.grade.returned_cents));
  return rows.slice(0, limit);
}

/**
 * The next race to go, by post time, across every bundled day - emubets'
 * "Next Race" tile. Uses each day's precomputed IANA timezone (the same rule
 * Calendar.jsx follows: the browser never carries the track registry) and
 * prints the post time in Pacific, the only zone a viewer ever sees. `null`
 * when nothing in the bundle is still to run - a historical snapshot.
 */
export function nextRace(raceDays, now = new Date()) {
  let best = null;
  for (const day of raceDays) {
    for (const race of day.races) {
      const at = localWallClockToUtc(day.raceDay.date, race.postTime, day.raceDay.timezone);
      if (!at || at < now) continue;
      if (!best || at < best.at) best = { day, race, at, postTimePacific: formatPacific(at) };
    }
  }
  return best;
}

/**
 * Bundled days ordered the way emubets orders its meetings: today and later
 * first, soonest at the top, then the past, most recent first.
 */
export function orderDays(raceDays, todayIso) {
  const key = (d) => d.raceDay.date;
  const upcoming = raceDays.filter((d) => key(d) >= todayIso).sort((a, b) => key(a).localeCompare(key(b)) || a.raceDay.track.localeCompare(b.raceDay.track));
  const past = raceDays.filter((d) => key(d) < todayIso).sort((a, b) => key(b).localeCompare(key(a)) || a.raceDay.track.localeCompare(b.raceDay.track));
  return { upcoming, past };
}
