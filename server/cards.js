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
           c.live_odds_present, c.tip_sheets_present,
           c.status, c.consensus_completeness, c.created_at,
           COUNT(t.id) AS tickets, COALESCE(SUM(t.cost_cents), 0) AS total_cents,
           (SELECT COUNT(*) FROM human_race_state h WHERE h.card_id = c.id) AS locked_races,
           (SELECT COUNT(*) FROM human_race_state h
             WHERE h.card_id = c.id AND h.results_revealed_at IS NOT NULL) AS revealed_races,
           EXISTS(SELECT 1 FROM graded_tickets gt JOIN tickets gtt ON gtt.id = gt.ticket_id
                   WHERE gtt.card_id = c.id) AS graded,
           -- D175: the day view shows P/L once a card is graded, so a result
           -- is readable where the cards are without a trip to /pl. Correlated
           -- subqueries rather than another JOIN: joining grades alongside the
           -- LEFT JOIN on tickets would risk changing what COUNT(t.id) counts.
           -- graded_tickets_latest is the LATEST grade set per ticket, the same
           -- view /api/pl reports from, so the two screens cannot disagree.
           (SELECT SUM(g.pl_cents) FROM graded_tickets_latest g
              JOIN tickets gt2 ON gt2.id = g.ticket_id WHERE gt2.card_id = c.id) AS pl_cents,
           (SELECT SUM(g.returned_cents) FROM graded_tickets_latest g
              JOIN tickets gt2 ON gt2.id = g.ticket_id WHERE gt2.card_id = c.id) AS returned_cents
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

// Bulk delete from the day view's card table (checkbox selection), mirroring
// server/ingest.js's race-day bulk-delete: one request, many ids, each
// handled independently so one bad id can't block the rest. Unlike that
// route, there is **no grading guard here at all** (user decision
// 2026-09-09) - a card is a generated/built artifact, not a record of a
// day's history the way a graded race day is, so any card, graded or not,
// may be bulk-deleted. Hard delete, same as the single-card route above;
// cascades take tickets/allocations/grades with it.
cardsRouter.post('/cards/bulk-delete', (req, res) => {
  const db = getDb();
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id))) {
    return res.status(400).json({ error: 'ids must be a non-empty array of integers.' });
  }

  const deleted = [];
  const skipped = [];
  for (const id of ids) {
    const card = db.prepare('SELECT id, race_day_id, card_number, correlation_id FROM cards WHERE id = ?').get(id);
    if (!card) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    appLog.info('card_deleted', {
      cardId: id,
      raceDayId: card.race_day_id,
      correlationId: card.correlation_id,
    });
    deleted.push({ id, raceDayId: card.race_day_id, cardNumber: card.card_number });
  }
  res.json({ deleted, skipped });
});

/**
 * One card's own fields plus its allocations/tickets - everything that is
 * per-CARD rather than per-DAY. Extracted (D329) so `scripts/build-static-payload.js`
 * can call the same query the route does instead of hand-rolling a second,
 * inevitably-drifting version of this shape - the same "never a second
 * renderer" discipline D237 already applied to `CardSheet.jsx`. Returns
 * `null` for no such card, never throws.
 */
export function getCardCore(db, cardId) {
  const card = db.prepare(`
    SELECT c.*, rd.track, rd.date, st.name AS template,
           COALESCE(c.per_race_min_cents, rd.per_race_min_cents) AS per_race_min_cents
    FROM cards c JOIN race_days rd ON rd.id = c.race_day_id
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.id = ?
  `).get(cardId);
  if (!card) return null;
  const allocations = db.prepare(`
    SELECT a.*, r.number AS race_number, r.classification, r.post_time, r.distance,
           r.surface, r.race_type, r.wager_menu, r.contrarian_flags
    FROM allocations a JOIN races r ON r.id = a.race_id
    WHERE a.card_id = ?
    ORDER BY r.number
  `).all(card.id);
  const tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ? ORDER BY sequence').all(card.id)
    .map((t) => ({ ...t, selections: JSON.parse(t.selections), rule_tags: JSON.parse(t.rule_tags ?? '[]') }));
  return { ...card, allocations, tickets };
}

/** A day's races WITH entries attached - day-level, shared across every card on it. */
export function getDayRaces(db, dayId) {
  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(dayId);
  const entriesFor = db.prepare('SELECT * FROM entries WHERE race_id = ?');
  for (const race of races) race.entries = entriesFor.all(race.id);
  return races;
}

/**
 * The card sheet's day-level footer material: which sources fed the day
 * (latest attempt each, with its timestamp), the day's known program-time
 * scratches, and the day's results (finishers/exotics/result-time
 * scratches) for the per-race results panel. Nested rather than flattened:
 * `scratches` here is PROGRAM-time (`entries.scratched`), while
 * `results.scratches` comes off the result chart, and silently merging two
 * different scratch sets under one name is how a card would start claiming
 * a horse was scratched at a time it wasn't. `results` arrays are empty,
 * never omitted, when the day has no results yet - a caller renders a panel
 * only where there is a finisher.
 */
export function getDayFooter(db, dayId) {
  const attemptRows = db.prepare(`
    SELECT s.name, fa.outcome, fa.ts, fa.fallback_reason
    FROM fetch_attempts fa JOIN sources s ON s.id = fa.source_id
    WHERE fa.race_day_id = ? ORDER BY fa.id
  `).all(dayId);
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
  `).all(dayId);
  const results = {
    finishers: db.prepare(
      'SELECT * FROM race_results WHERE race_day_id = ? ORDER BY race_number, finish_position',
    ).all(dayId),
    exotics: db.prepare(
      'SELECT * FROM exotic_payoffs WHERE race_day_id = ? ORDER BY race_number, id',
    ).all(dayId),
    scratches: db.prepare(
      'SELECT * FROM result_scratches WHERE race_day_id = ? ORDER BY race_number, id',
    ).all(dayId),
  };
  return { sources, scratches, results };
}

cardsRouter.get('/cards/:id', (req, res) => {
  const db = getDb();
  const card = getCardCore(db, Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const races = getDayRaces(db, card.race_day_id);
  const { sources, scratches, results } = getDayFooter(db, card.race_day_id);
  res.json({ ...card, races, sources, scratches, results });
});
