// The card model for the static builder (D151), and the ONE place a race's
// pasted text becomes tickets in the browser.
//
// The parse is not a re-implementation and must never become one: it calls
// shared/parsers/human-picks.js and shared/betmath.js - the identical modules
// server/human-cards.js runs. Both are pure and browser-safe by contract
// (human-picks.js carries a "MUST STAY BROWSER-SAFE" banner because
// TicketBuilder.jsx already imports it), so the phone validates a ticket with
// the same code the home server will re-parse it with on import.
//
// That is what keeps invariant 9 intact across a machine boundary. The static
// app previews; the home import still re-parses the stored text itself and
// still refuses on any blocking warning. This file being the same code makes
// the two agree - it does not excuse the second parse.

import { parseHumanPicksText } from '@shared/parsers/human-picks.js';
import { estimateTicketPayouts } from '@shared/betmath.js';

/** Randomly generated once per device, so two phones can never mint the same card id. */
export function newDeviceId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newCardId(deviceId) {
  const stamp = Date.now().toString(36);
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${deviceId}-${stamp}${salt}`;
}

export function newCard({ deviceId, raceDay, payloadHash, name = null }) {
  return {
    cardId: newCardId(deviceId),
    deviceId,
    raceDayId: raceDay.raceDayId,
    payloadHash,
    // Frozen at creation, exactly like the desktop's cards.name (D137) and
    // cards.llm_model (D76) - a card's label never drifts mid-comparison.
    name: name && name.trim() ? name.trim() : null,
    bankrollCents: raceDay.bankrollCents ?? null,
    createdAt: new Date().toISOString(),
    // Set the moment a reference card is actually revealed, never on load and
    // never cleared. A HUMAN card built while reading the LLM card is not an
    // independent source, and this is what turns that from an unknown into a
    // labeled fact (D150).
    sawReferenceCards: false,
    // raceNumber -> {text, tickets, lockedAt, passed}
    races: {},
    exportedAt: null,
  };
}

export const raceOf = (payload, raceNumber) => payload.races.find((r) => r.number === raceNumber) ?? null;

/** Program numbers scratched in this race - the same union the server builds, minus the chart half (a payload day has no results). */
export const scratchedIn = (race) => (race?.entries ?? []).filter((e) => e.scratched).map((e) => e.program_number);

/**
 * Preview one race's text. Same call, same argument names and same ordering
 * as server/human-cards.js's previewHumanRace, including running the payout
 * estimator AFTER the parse so the preview is exactly what a save would
 * store.
 */
export function previewRace(payload, raceNumber, text) {
  const race = raceOf(payload, raceNumber);
  if (!race) return { tickets: [], warnings: [{ type: 'no_such_race', blocking: true, race: raceNumber, message: `No race ${raceNumber} in this payload.` }], raceCostCents: 0 };

  const parsed = parseHumanPicksText({
    text,
    race: raceNumber,
    entries: race.entries,
    wagerMenu: race.wagerMenu,
    scratchedProgramNumbers: scratchedIn(race),
  });
  const mlOf = (pgm) => race.entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null;
  parsed.tickets = estimateTicketPayouts(parsed.tickets, mlOf);
  return parsed;
}

export const blockingWarnings = (warnings = []) => warnings.filter((w) => w.blocking);

export const lockedRaces = (card) => Object.entries(card.races ?? {})
  .filter(([, r]) => r.lockedAt)
  .map(([n]) => Number(n))
  .sort((a, b) => a - b);

export const cardTickets = (card) => lockedRaces(card)
  .flatMap((n) => (card.races[n].tickets ?? []).map((t) => ({ ...t, race: n })));

export const cardCostCents = (card) => cardTickets(card).reduce((a, t) => a + (t.costCents ?? 0), 0);

/** Entries in the casing TicketBuilder.jsx wants; the payload keeps the parser's snake_case. */
export const builderEntries = (race) => (race?.entries ?? []).map((e) => ({
  programNumber: e.program_number,
  horseName: e.horse_name,
  morningLine: e.morning_line,
  scratched: e.scratched,
}));
