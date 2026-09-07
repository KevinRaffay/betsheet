// Card API: read and delete stored betting cards.
//
// This module used to OWN card generation - it fed the stored day to the lean
// engine and was the one writer of cards / allocations / tickets. D111 deleted
// that engine, so no card is generated here any more. The three surviving card
// producers each write their own rows through their own module:
// server/equibase-otr.js, server/llm-cards.js and server/human-cards.js.
//
// What is left is the read side every card view depends on, plus the confirmed
// hard-delete.

import express from 'express';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';

const appLog = getLogger('app');

export const cardsRouter = express.Router();

cardsRouter.get('/race-days/:id/cards', (req, res) => {
  const db = getDb();
  // D140: `locked_races` / `revealed_races` say how far along a HUMAN card
  // is, which is what the day builder's card picker needs to tell a card
  // still being built from one that has been played out - a ticket count
  // alone cannot (a card with three PASSes has no tickets and is not
  // untouched). Correlated subqueries rather than a third JOIN on purpose:
  // joining human_race_state here would multiply the ticket rows the
  // COUNT/SUM above are grouped over. Zero for every non-human card, which
  // is the truth - nothing else writes that table.
  //
  // `graded` is the same predicate `deleteHumanTicket` refuses on
  // (server/human-cards.js): once a card carries any grade row, its P/L has
  // been reported. Locking ANOTHER race onto such a card is still allowed -
  // it has to be, since a live day's results land race by race while later
  // races are still being built - but it silently REGRADES the card, and
  // there is no in-app way back (the ticket delete is refused on exactly
  // this predicate). The picker therefore has to be able to say so before
  // the click, not after.
  const cards = db.prepare(`
    SELECT c.id, c.card_number, c.variant, c.name, st.name AS template,
           c.bankroll_cents, c.per_race_min_cents, c.engine_version, c.llm_model, c.notes_present,
           c.status, c.consensus_completeness, c.created_at,
           COUNT(t.id) AS tickets, COALESCE(SUM(t.cost_cents), 0) AS total_cents,
           (SELECT COUNT(*) FROM human_race_state h WHERE h.card_id = c.id) AS locked_races,
           (SELECT COUNT(*) FROM human_race_state h
             WHERE h.card_id = c.id AND h.results_revealed_at IS NOT NULL) AS revealed_races,
           EXISTS(SELECT 1 FROM graded_tickets gt JOIN tickets gtt ON gtt.id = gt.ticket_id
                   WHERE gtt.card_id = c.id) AS graded
    FROM cards c
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    LEFT JOIN tickets t ON t.card_id = c.id
    WHERE c.race_day_id = ?
    GROUP BY c.id
    ORDER BY c.card_number DESC
  `).all(Number(req.params.id));
  res.json(cards);
});

cardsRouter.delete('/cards/:id', (req, res) => {
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Card deletion requires confirm: "DELETE".' });
  }
  const db = getDb();
  const cardId = Number(req.params.id);
  const card = db.prepare('SELECT id, race_day_id, correlation_id FROM cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'No such card.' });

  db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
  appLog.info('card_deleted', {
    cardId,
    raceDayId: card.race_day_id,
    correlationId: card.correlation_id,
  });
  res.json({ ok: true, id: cardId, raceDayId: card.race_day_id });
});

cardsRouter.get('/cards/:id', (req, res) => {
  const db = getDb();
  const card = db.prepare(`
    SELECT c.*, rd.track, rd.date, st.name AS template,
           COALESCE(c.per_race_min_cents, rd.per_race_min_cents) AS per_race_min_cents
    FROM cards c JOIN race_days rd ON rd.id = c.race_day_id
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.id = ?
  `).get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const allocations = db.prepare(`
    SELECT a.*, r.number AS race_number, r.classification, r.post_time, r.distance,
           r.surface, r.race_type, r.wager_menu, r.contrarian_flags
    FROM allocations a JOIN races r ON r.id = a.race_id
    WHERE a.card_id = ?
    ORDER BY r.number
  `).all(card.id);
  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(card.race_day_id);
  const entriesFor = db.prepare('SELECT * FROM entries WHERE race_id = ?');
  for (const race of races) race.entries = entriesFor.all(race.id);
  const tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ? ORDER BY sequence').all(card.id)
    .map((t) => ({ ...t, selections: JSON.parse(t.selections), rule_tags: JSON.parse(t.rule_tags ?? '[]') }));

  // Footer material: which sources fed this day (latest attempt each, with
  // its timestamp) and the day's known scratches.
  const attemptRows = db.prepare(`
    SELECT s.name, fa.outcome, fa.ts, fa.fallback_reason
    FROM fetch_attempts fa JOIN sources s ON s.id = fa.source_id
    WHERE fa.race_day_id = ? ORDER BY fa.id
  `).all(card.race_day_id);
  const latest = new Map();
  for (const r of attemptRows) latest.set(r.name, r);
  const sources = { used: [], unavailable: [] };
  for (const r of latest.values()) {
    (['ok', 'manual_paste', 'manual_upload'].includes(r.outcome) ? sources.used : sources.unavailable)
      .push({ name: r.name, ts: r.ts, outcome: r.outcome, reason: r.fallback_reason });
  }
  const scratches = db.prepare(`
    SELECT r.number AS race_number, e.program_number, e.horse_name
    FROM entries e JOIN races r ON r.id = e.race_id
    WHERE r.race_day_id = ? AND e.scratched = 1
    ORDER BY r.number
  `).all(card.race_day_id);

  // The day's results, for the per-race results panel on the sheet. Nested
  // rather than flattened alongside the footer's `scratches` above: those are
  // PROGRAM-time scratches (entries.scratched), while these come off the
  // result chart, and silently merging two different scratch sets under one
  // name is how a card would start claiming a horse was scratched at a time
  // it wasn't. Empty arrays when the day has no results - the client renders
  // the panel per race, only where there is a finisher.
  const results = {
    finishers: db.prepare(
      'SELECT * FROM race_results WHERE race_day_id = ? ORDER BY race_number, finish_position',
    ).all(card.race_day_id),
    exotics: db.prepare(
      'SELECT * FROM exotic_payoffs WHERE race_day_id = ? ORDER BY race_number, id',
    ).all(card.race_day_id),
    scratches: db.prepare(
      'SELECT * FROM result_scratches WHERE race_day_id = ? ORDER BY race_number, id',
    ).all(card.race_day_id),
  };

  res.json({ ...card, races, allocations, tickets, sources, scratches, results });
});
