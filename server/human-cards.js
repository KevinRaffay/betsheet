// Human cards (D54): a human's pasted tickets become a first-class card -
// same tables, same grader as every engine card, template 'human',
// consensus_completeness 'HUMAN' (never pools with an engine bucket,
// invariant 13). No PR here changes card generation or grading: the
// engine (deleted in D111; it was never called from here anyway) and human tickets are
// graded by the existing shared/grading.js grader exactly like any other
// ticket.
//
// Preview-first (invariant 9): /human-cards/preview never writes. The
// save endpoint takes the pasted text itself (not a pre-shaped ticket
// array) and re-parses it server-side, refusing (422) if any warning
// comes back `blocking: true` - the same rule the preview already showed,
// enforced independently rather than trusted from the client.

import express from 'express';
import { parseHumanPicksText, nameKey } from '../shared/parsers/human-picks.js';
import { estimateTicketPayouts } from '../shared/betmath.js';
import { getDb } from './db.js';
import { gradeAndPersist } from './grading.js';
import { templateIdFor } from './templates.js';
import { getLogger, newCorrelationId } from './logging.js';

const traceLog = getLogger('decision-trace');
const appLog = getLogger('app');

export const humanCardsRouter = express.Router();

class HumanCardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Shared with server/llm-cards.js (D63) - same race/scratch resolution for either picker. */
export function loadRace(db, dayId, raceNumber) {
  const race = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(dayId, raceNumber);
  if (!race) throw new HumanCardError(404, `No race ${raceNumber} on this race day.`);
  const entries = db.prepare('SELECT * FROM entries WHERE race_id = ?').all(race.id);
  return { race, entries };
}

/** Program-time scratches union chart scratches (resolved to program numbers), for this one race. */
export function scratchedProgramNumbersFor(db, dayId, race, entries) {
  const scratched = new Set(entries.filter((e) => e.scratched).map((e) => e.program_number));
  const chartScratches = db.prepare(
    'SELECT program_number, horse_name FROM result_scratches WHERE race_day_id = ? AND race_number = ?',
  ).all(dayId, race.number);
  for (const s of chartScratches) {
    if (s.program_number != null) { scratched.add(s.program_number); continue; }
    const entry = entries.find((e) => nameKey(e.horse_name) === nameKey(s.horse_name));
    if (entry) scratched.add(entry.program_number);
  }
  return scratched;
}

/**
 * Preview-only: parse pasted text for one race against the day's stored
 * entries/scratches/wager menu. Never writes. If `cardId` is given, also
 * reports the running cost of that card vs. its bankroll - a warning,
 * never a block (invariant 2).
 */
export function previewHumanRace(db, day, raceNumber, text, cardId) {
  const { race, entries } = loadRace(db, day.id, raceNumber);
  const scratched = scratchedProgramNumbersFor(db, day.id, race, entries);
  const parsed = parseHumanPicksText({
    text, race: raceNumber, entries, wagerMenu: race.wager_menu,
    scratchedProgramNumbers: scratched,
  });
  // D91: fill "If it hits" from the day's morning line, the same
  // dispatcher server/llm-cards.js and server/equibase-otr.js use.
  // D54 left these null ("a human already knows their own bet"); the
  // Replay day sheet now shows the column, so an empty one would read as
  // broken rather than deliberate. Types with no validated formula (show,
  // straight trifecta, superfecta, superfecta box) stay null by design.
  const mlOf = (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null;
  parsed.tickets = estimateTicketPayouts(parsed.tickets, mlOf);

  let cardCostCents = null;
  let bankrollCents = null;
  let overBankroll = false;
  if (cardId) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId));
    if (card && card.race_day_id === day.id) {
      bankrollCents = card.bankroll_cents;
      const spent = db.prepare(`
        SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets t
        JOIN races r ON r.id = t.race_id
        WHERE t.card_id = ? AND r.number != ?
      `).get(card.id, raceNumber).n;
      cardCostCents = spent + parsed.raceCostCents;
      overBankroll = cardCostCents > bankrollCents;
    }
  }

  return { ...parsed, cardCostCents, bankrollCents, overBankroll };
}

/**
 * The one writer for a human race lock/pass. `cardId` omitted always
 * starts a NEW human card (next card_number); given, appends to that
 * exact card (404 if missing/wrong day/not template 'human'). Refuses
 * (409) a race already revealed on the named card - the D28 rule: start
 * a new card by omitting cardId. Re-parses `text` itself and refuses
 * (422) on any blocking warning; `pass: true` skips parsing entirely.
 */
export function persistHumanRace(db, day, { race: raceNumber, text, pass = false, bankrollCents, cardId, correlationId }) {
  const { race, entries } = loadRace(db, day.id, raceNumber);

  let card = null;
  if (cardId) {
    card = db.prepare(`
      SELECT c.*, st.name AS template FROM cards c
      LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
      WHERE c.id = ?
    `).get(Number(cardId));
    if (!card || card.race_day_id !== day.id || card.template !== 'human') {
      throw new HumanCardError(404, 'No such human card on this race day.');
    }
  }

  if (card) {
    const existingState = db.prepare(
      'SELECT * FROM human_race_state WHERE card_id = ? AND race_number = ?',
    ).get(card.id, raceNumber);
    if (existingState?.results_revealed_at) {
      throw new HumanCardError(409,
        `Race ${raceNumber} has already been revealed on card #${card.card_number} - ` +
        'per the D28 rule, an edit after reveal is a new card. Omit cardId to start one.');
    }
  }

  let parsed = { tickets: [], warnings: [], raceCostCents: 0 };
  if (!pass) {
    const scratched = scratchedProgramNumbersFor(db, day.id, race, entries);
    parsed = parseHumanPicksText({
      text, race: raceNumber, entries, wagerMenu: race.wager_menu,
      scratchedProgramNumbers: scratched,
    });
    const blocking = parsed.warnings.filter((w) => w.blocking);
    if (blocking.length) {
      const err = new HumanCardError(422, `Race ${raceNumber}: ${blocking.length} blocking warning(s) - nothing saved.`);
      err.warnings = parsed.warnings;
      throw err;
    }
    // Same estimator the preview ran, applied at the same point relative to
    // the blocking check, so the preview is exactly what Save stores
    // (invariant 9) - mirrors persistLlmRace's ordering.
    const mlOf = (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null;
    parsed.tickets = estimateTicketPayouts(parsed.tickets, mlOf);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  let isNewCard = false;

  const result = db.transaction(() => {
    // Whether ANY human card on this day has ever locked a race before now
    // - decides whether this call sets race_days.replayed_at.
    const priorLocks = db.prepare(`
      SELECT COUNT(*) AS n FROM human_race_state hrs
      JOIN cards c ON c.id = hrs.card_id
      WHERE c.race_day_id = ?
    `).get(day.id).n;

    if (!card) {
      isNewCard = true;
      const cardNumber = db.prepare(
        'SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?',
      ).get(day.id).n;
      const newCardId = db.prepare(`INSERT INTO cards
          (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
           per_race_min_cents, status, correlation_id, consensus_completeness, engine_version)
          VALUES (?, ?, 'default', ?, ?, ?, 'final', ?, 'HUMAN', 'human')`)
        .run(day.id, cardNumber, templateIdFor(db, 'human'), bankrollCents ?? day.bankroll_cents,
          day.per_race_min_cents ?? null, correlationId).lastInsertRowid;
      card = db.prepare('SELECT * FROM cards WHERE id = ?').get(newCardId);
    }

    // Re-locking an unrevealed race replaces its tickets/allocation.
    db.prepare('DELETE FROM tickets WHERE card_id = ? AND race_id = ?').run(card.id, race.id);
    db.prepare('DELETE FROM allocations WHERE card_id = ? AND race_id = ?').run(card.id, race.id);

    if (!pass && parsed.tickets.length) {
      const nextSeq = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM tickets WHERE card_id = ?').get(card.id).n;
      const insTicket = db.prepare(`INSERT INTO tickets
          (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
           est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rationale,
           rule_tags, rationale_text, odds_at_bet)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      parsed.tickets.forEach((t, i) => {
        insTicket.run(
          card.id, race.id, nextSeq + i + 1, t.betType,
          JSON.stringify({ races: t.raceNumbers, legs: t.legs }),
          t.stakeCents, t.costCents, t.estMinCents, t.estMaxCents, t.estIsRange ? 1 : 0,
          t.tellerCall, t.rationale, JSON.stringify(t.ruleTags), t.rationale_text, t.odds_at_bet,
        );
      });
      db.prepare(`INSERT INTO allocations (card_id, race_id, amount_cents, confidence, rule, thesis)
          VALUES (?, ?, ?, 'HUMAN', 'human_pick', NULL)`)
        .run(card.id, race.id, parsed.raceCostCents);
    }

    db.prepare(`INSERT INTO human_race_state (card_id, race_number, picks_locked_at, passed)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(card_id, race_number) DO UPDATE SET picks_locked_at = excluded.picks_locked_at, passed = excluded.passed`)
      .run(card.id, raceNumber, now, pass ? 1 : 0);

    if (priorLocks === 0) {
      db.prepare('UPDATE race_days SET replayed_at = ? WHERE id = ? AND replayed_at IS NULL').run(now, day.id);
    }

    return card;
  })();

  if (isNewCard) {
    traceLog.info('card_generated', {
      correlationId, cardId: result.id, raceDayId: day.id, engineVersion: 'human', template: 'human',
    });
  }
  for (const t of parsed.tickets) {
    traceLog.info('ticket_added', {
      correlationId, cardId: result.id, raceDayId: day.id,
      race: raceNumber, betType: t.betType, selections: t.legs,
      stakeCents: t.stakeCents, costCents: t.costCents, rationaleText: t.rationale_text,
    });
  }
  traceLog.info('human_race_locked', {
    correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, pass: Boolean(pass),
  });
  appLog.info('human_race_locked', {
    correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, pass: Boolean(pass),
    tickets: parsed.tickets.length, costCents: parsed.raceCostCents,
  });

  let graded = null;
  const hasResults = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id);
  if (hasResults) {
    graded = gradeAndPersist(db, result.id, correlationId, { engineVersion: 'human' });
  }

  const cardCostCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets WHERE card_id = ?').get(result.id).n;
  return {
    cardId: result.id, correlationId, tickets: parsed.tickets,
    raceCostCents: parsed.raceCostCents, cardCostCents, warnings: parsed.warnings, graded,
  };
}

/**
 * Delete ONE ticket from a locked, unrevealed race on a human card (D103).
 *
 * The day builder locks whatever is previewed when it closes, so a mistake
 * now lands in the database rather than evaporating with the dialog - and the
 * remedy has to be delete, not edit. Editing a locked race re-stamps
 * `picks_locked_at`, which is exactly what `computeBlindness` reads (invariant
 * 15); deleting a ticket touches no timestamp at all, so the card's derived
 * blindness is the same before and after.
 *
 * Two refusals, both about not rewriting a record someone has already read:
 *  - a REVEALED race is closed to change (the D28 remedy is a new card, the
 *    same rule persistHumanRace enforces on a re-lock);
 *  - a card with ANY grade set is closed too - deleting a graded ticket would
 *    move a P/L figure that has already been reported (invariant 14's spirit).
 *
 * Deleting the LAST ticket of a race retires the race entirely: its allocation
 * and its human_race_state row go, so it reads "Not played" again and can be
 * built afresh. `race_days.replayed_at` is deliberately NOT rolled back - it
 * records that this day was played at all, which stays true.
 */
export function deleteHumanTicket(db, { cardId, ticketId, correlationId }) {
  const card = db.prepare(`
    SELECT c.*, st.name AS template FROM cards c
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.id = ?
  `).get(Number(cardId));
  if (!card || card.template !== 'human') throw new HumanCardError(404, 'No such human card.');

  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(card.race_day_id);
  if (day?.deleted_at) throw new HumanCardError(410, 'This race day is deleted. Restore it first.');

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND card_id = ?').get(Number(ticketId), card.id);
  if (!ticket) throw new HumanCardError(404, 'No such ticket on this card.');

  const race = db.prepare('SELECT * FROM races WHERE id = ?').get(ticket.race_id);
  const state = db.prepare(
    'SELECT * FROM human_race_state WHERE card_id = ? AND race_number = ?',
  ).get(card.id, race.number);
  if (state?.results_revealed_at) {
    throw new HumanCardError(409,
      `Race ${race.number} has already been revealed on card #${card.card_number} - ` +
      'its tickets are the record of what you played. Start a new card to play it differently.');
  }

  const anyGrade = db.prepare(`
    SELECT 1 FROM graded_tickets gt JOIN tickets t ON t.id = gt.ticket_id
    WHERE t.card_id = ? LIMIT 1
  `).get(card.id);
  if (anyGrade) {
    throw new HumanCardError(409,
      `Card #${card.card_number} has been graded against results - deleting a ticket now would ` +
      'move a P/L figure that has already been reported. Start a new card instead.');
  }

  const out = db.transaction(() => {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    const remaining = db.prepare(
      'SELECT COALESCE(SUM(cost_cents), 0) AS cost, COUNT(*) AS n FROM tickets WHERE card_id = ? AND race_id = ?',
    ).get(card.id, race.id);
    if (remaining.n > 0) {
      db.prepare('UPDATE allocations SET amount_cents = ? WHERE card_id = ? AND race_id = ?')
        .run(remaining.cost, card.id, race.id);
    } else {
      db.prepare('DELETE FROM allocations WHERE card_id = ? AND race_id = ?').run(card.id, race.id);
      db.prepare('DELETE FROM human_race_state WHERE card_id = ? AND race_number = ?').run(card.id, race.number);
    }
    return remaining;
  })();

  traceLog.info('human_ticket_deleted', {
    correlationId: correlationId ?? card.correlation_id, cardId: card.id, raceDayId: card.race_day_id,
    race: race.number, ticketId: ticket.id, betType: ticket.bet_type,
    tellerCall: ticket.teller_call, costCents: ticket.cost_cents,
    raceRetired: out.n === 0,
  });
  appLog.info('human_ticket_deleted', {
    correlationId: correlationId ?? card.correlation_id, cardId: card.id,
    race: race.number, ticketId: ticket.id, remainingTickets: out.n,
  });

  const cardCostCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets WHERE card_id = ?').get(card.id).n;
  return {
    cardId: card.id, race: race.number, remainingTickets: out.n,
    raceCostCents: out.cost, cardCostCents, raceRetired: out.n === 0,
  };
}

function loadDay(db, id) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  return day ?? null;
}

humanCardsRouter.post('/race-days/:id/human-cards/preview', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const race = Number(req.body?.race);
  if (!Number.isInteger(race) || race <= 0) return res.status(400).json({ error: 'race is required.' });
  try {
    const preview = previewHumanRace(db, day, race, String(req.body?.text ?? ''), req.body?.cardId);
    res.json({ correlationId, ...preview });
  } catch (err) {
    if (err instanceof HumanCardError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

humanCardsRouter.post('/race-days/:id/human-cards', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted. Restore it before recording human picks.' });

  const race = Number(req.body?.race);
  if (!Number.isInteger(race) || race <= 0) return res.status(400).json({ error: 'race is required.' });
  const pass = req.body?.pass === true;
  if (!pass && typeof req.body?.text !== 'string') {
    return res.status(400).json({ error: 'text is required unless pass is true.' });
  }

  try {
    const result = persistHumanRace(db, day, {
      race, text: req.body?.text ?? '', pass,
      bankrollCents: req.body?.bankrollCents != null ? Number(req.body.bankrollCents) : undefined,
      cardId: req.body?.cardId, correlationId,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof HumanCardError) {
      return res.status(err.status).json({ error: err.message, warnings: err.warnings ?? undefined });
    }
    throw err;
  }
});

// D103: the day builder's only remedy for a ticket it locked on close.
humanCardsRouter.delete('/cards/:cardId/human-tickets/:ticketId', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  try {
    const out = deleteHumanTicket(getDb(), {
      cardId: req.params.cardId, ticketId: req.params.ticketId, correlationId,
    });
    res.json({ correlationId, ...out });
  } catch (err) {
    if (err instanceof HumanCardError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
