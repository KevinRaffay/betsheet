// Grading persistence: the pure grader (shared/grading.js) applied to a
// stored card against the day's stored results, written to graded_tickets
// and traced under the card's correlation id - the joint Phase 3 feeds to
// an LLM ("this rule fired, this is what it earned").

import express from 'express';
import { buildDayResults, gradeCard } from '../shared/grading.js';
import { ENGINE_VERSION } from '../shared/card-engine.js';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');
const traceLog = getLogger('decision-trace');

export const gradingRouter = express.Router();

export function loadDayResultsFor(db, raceDayId) {
  const rows = db.prepare('SELECT * FROM race_results WHERE race_day_id = ?').all(raceDayId);
  if (rows.length === 0) return null;
  const exotics = db.prepare('SELECT * FROM exotic_payoffs WHERE race_day_id = ?').all(raceDayId);
  const scratches = db.prepare('SELECT * FROM result_scratches WHERE race_day_id = ?').all(raceDayId);
  const byRace = new Map();
  const raceFor = (n) => {
    if (!byRace.has(n)) byRace.set(n, { number: n, results: [], exotics: [], scratchedPgms: [] });
    return byRace.get(n);
  };
  for (const r of rows) {
    raceFor(r.race_number).results.push({
      programNumber: r.program_number, finishPosition: r.finish_position,
      winCents: r.win_cents, placeCents: r.place_cents, showCents: r.show_cents,
    });
  }
  for (const x of exotics) {
    raceFor(x.race_number).exotics.push({
      betType: x.bet_type, baseCents: x.base_cents,
      combination: x.combination, payoutCents: x.payout_cents,
    });
  }
  for (const s of scratches) {
    if (s.program_number != null) raceFor(s.race_number).scratchedPgms.push(s.program_number);
  }
  return buildDayResults([...byRace.values()]);
}

/**
 * Grade one card and persist. Shared by the route and the auto-grade hook.
 * Invariant 14: the grade set is keyed by engine version - a regrade under
 * the SAME version replaces it (idempotent), a regrade under a NEWER
 * version appends a new set and the older one stays readable. Readers use
 * the graded_tickets_latest view. `engineVersion` is overridable for the
 * check scripts only.
 */
export function gradeAndPersist(db, cardId, correlationId, { engineVersion = ENGINE_VERSION } = {}) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return { error: 'No such card.', status: 404 };
  const dayResults = loadDayResultsFor(db, card.race_day_id);
  if (!dayResults) return { error: 'No results ingested for this race day yet.', status: 409 };

  const ticketRows = db.prepare('SELECT * FROM tickets WHERE card_id = ? ORDER BY sequence').all(cardId);
  const tickets = ticketRows.map((t) => {
    const sel = JSON.parse(t.selections);
    return {
      id: t.id, betType: t.bet_type, races: sel.races, legs: sel.legs,
      stakeCents: t.stake_cents, costCents: t.cost_cents,
    };
  });

  const { grades, summary } = gradeCard(tickets, dayResults);

  const save = db.transaction(() => {
    db.prepare(`DELETE FROM graded_tickets WHERE engine_version = ? AND ticket_id IN
        (SELECT id FROM tickets WHERE card_id = ?)`).run(engineVersion, cardId);
    const ins = db.prepare(`INSERT INTO graded_tickets
        (ticket_id, engine_version, outcome, returned_cents, pl_cents, details, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const g of grades) {
      ins.run(g.ticket.id, engineVersion, g.outcome, g.returnedCents, g.plCents,
        JSON.stringify({ note: g.note }), card.correlation_id);
    }
  });
  save();

  // Trace under the CARD's correlation id: the same stream that recorded
  // why each ticket exists now records what it earned.
  for (const g of grades) {
    traceLog.info('ticket_graded', {
      correlationId: card.correlation_id,
      cardId,
      ticketId: g.ticket.id,
      engineVersion,
      betType: g.ticket.betType,
      races: g.ticket.races,
      legs: g.ticket.legs,
      outcome: g.outcome,
      costCents: g.ticket.costCents,
      returnedCents: g.returnedCents,
      plCents: g.plCents,
      note: g.note,
    });
  }
  traceLog.info('card_graded', {
    correlationId: card.correlation_id, cardId, gradedBy: correlationId, engineVersion, ...summary,
  });
  log.info('card_graded', { correlationId, cardId, raceDayId: card.race_day_id, ...summary });
  return { cardId, engineVersion, summary, grades };
}

/** Grade every card of a race day (the auto-hook after results save). */
export function gradeAllCards(db, raceDayId, correlationId) {
  const cards = db.prepare('SELECT id FROM cards WHERE race_day_id = ?').all(raceDayId);
  const out = [];
  for (const c of cards) {
    const res = gradeAndPersist(db, c.id, correlationId);
    if (!res.error) out.push({ cardId: c.id, plCents: res.summary.plCents });
  }
  return out;
}

gradingRouter.post('/cards/:id/grade', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const result = gradeAndPersist(getDb(), Number(req.params.id), correlationId);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ correlationId, engineVersion: result.engineVersion, summary: result.summary });
});

gradingRouter.get('/cards/:id/grades', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const rows = db.prepare(`
    SELECT gt.*, t.sequence, t.bet_type, t.selections, t.stake_cents, t.cost_cents, t.teller_call
    FROM graded_tickets_latest gt JOIN tickets t ON t.id = gt.ticket_id
    WHERE t.card_id = ?
    ORDER BY t.sequence
  `).all(card.id).map((r) => ({ ...r, selections: JSON.parse(r.selections), details: JSON.parse(r.details ?? '{}') }));
  const summary = rows.length === 0 ? null : {
    engineVersion: rows[0].engine_version,
    costCents: rows.reduce((a, r) => a + r.cost_cents, 0),
    returnedCents: rows.reduce((a, r) => a + r.returned_cents, 0),
    plCents: rows.reduce((a, r) => a + r.pl_cents, 0),
  };
  res.json({ grades: rows, summary });
});
