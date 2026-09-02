// Card API: generate, persist and read betting cards. The engine itself is
// pure (shared/card-engine.js); this module feeds it the stored day, writes
// the result (cards / allocations / tickets), and streams every trace event
// to the decision-trace log under the card's correlation id - which is what
// Phase 3 joins with graded results.

import express from 'express';
import { classifyDay } from '../shared/classification.js';
import { generateCard } from '../shared/card-engine.js';
import { TEMPLATES, resolveTemplate } from '../shared/templates.js';
import { getDb } from './db.js';
import { gradeAndPersist } from './grading.js';
import { templateIdFor } from './templates.js';
import { getLogger, newCorrelationId } from './logging.js';

const traceLog = getLogger('decision-trace');
const appLog = getLogger('app');

export const cardsRouter = express.Router();

export function loadDayFull(db, id) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  if (!day) return null;
  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(day.id);
  const entriesFor = db.prepare('SELECT * FROM entries WHERE race_id = ?');
  for (const r of races) r.entries = entriesFor.all(r.id);
  return { ...day, races };
}

function picksByRaceNumber(db, dayId) {
  const rows = db.prepare(`
    SELECT cp.*, s.name AS source_name, s.kind AS source_kind, r.number AS race_number
    FROM consensus_picks cp
    JOIN sources s ON s.id = cp.source_id
    JOIN races r ON r.id = cp.race_id
    WHERE r.race_day_id = ?
  `).all(dayId);
  const byRace = {};
  for (const row of rows) (byRace[row.race_number] ??= []).push(row);
  return byRace;
}

function sourceOutcomes(db, dayId) {
  // Latest outcome per source for the day: used vs. unavailable labels.
  const rows = db.prepare(`
    SELECT s.name, fa.outcome
    FROM fetch_attempts fa
    JOIN sources s ON s.id = fa.source_id
    WHERE fa.race_day_id = ?
    ORDER BY fa.id
  `).all(dayId);
  const latest = new Map();
  for (const r of rows) latest.set(r.name, r.outcome);
  const used = [];
  const unavailable = [];
  for (const [name, outcome] of latest) {
    (['ok', 'manual_paste', 'manual_upload'].includes(outcome) ? used : unavailable).push(name);
  }
  return { used, unavailable };
}

/**
 * Everything the engine needs from a stored day besides the rule set: the
 * races with a FRESH classification from the picks on file, and the
 * sources-used / unavailable labels. Shared by live generation and the
 * simulator so a simulated day is the exact computation a live card gets.
 */
export function assembleEngineInput(db, day) {
  const entriesByRace = Object.fromEntries(day.races.map((r) => [r.number, r.entries]));
  const classifications = classifyDay(
    day.races.map((r) => r.number), entriesByRace, picksByRaceNumber(db, day.id));
  const byNumber = Object.fromEntries(classifications.map((c) => [c.number, c]));
  const { used, unavailable } = sourceOutcomes(db, day.id);
  return {
    races: day.races.map((r) => ({ ...r, classification: byNumber[r.number] })),
    sourcesUsed: used,
    sourcesUnavailable: unavailable,
  };
}

cardsRouter.post('/race-days/:id/cards', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDayFull(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) {
    return res.status(410).json({ error: 'This race day is deleted. Restore it before generating cards.' });
  }

  const variant = String(req.body?.variant ?? 'default').trim() || 'default';

  // Strategy template (D18): a named rule bundle; explicit `rules` override
  // on top of it. The persisting endpoint enforces invariant 1 - a LIVE
  // card can never disable the place-money rule, so simulation-only
  // templates (and raw overrides to the same effect) are refused here;
  // the simulator runs the engine directly.
  const templateName = String(req.body?.template ?? 'lean');
  const templateRules = resolveTemplate(templateName);
  if (!templateRules) {
    return res.status(400).json({
      error: `Unknown template "${templateName}". Templates: ${Object.keys(TEMPLATES).join(', ')}.`,
    });
  }
  if (TEMPLATES[templateName].simulationOnly) {
    return res.status(422).json({
      error: `Template "${templateName}" is simulation-only; a live card cannot use it (invariant 1).`,
    });
  }
  const rules = { ...templateRules, ...(req.body?.rules ?? {}) };
  if (rules.placeMoneyRule === false) {
    return res.status(422).json({
      error: 'Invariant 1: a live card cannot disable the place-money rule. The simulator runs the engine directly for that measurement.',
    });
  }

  const bankrollCents = Number(req.body?.bankrollCents ?? day.bankroll_cents);
  const perRaceMinCents = Number(req.body?.perRaceMinCents ?? day.per_race_min_cents);
  if (!Number.isInteger(bankrollCents) || bankrollCents <= 0) {
    return res.status(400).json({ error: 'bankrollCents (or a bankroll on the race day) is required.' });
  }
  if (!Number.isInteger(perRaceMinCents) || perRaceMinCents <= 0) {
    return res.status(400).json({ error: 'perRaceMinCents (or a per-race minimum on the race day) is required.' });
  }

  // Signal layer: classify fresh from stored picks so the card always
  // reflects the picks on file at generation time.
  const result = generateCard({
    bankrollCents,
    perRaceMinCents,
    ...assembleEngineInput(db, day),
    rules,
    template: templateName,
  });

  // Persist: APPEND-ONLY. Every generation is a new card row carrying its
  // full recipe (bankroll, per-race min, variant, completeness) and the
  // next card_number for its day - regenerating never overwrites, so
  // variants and re-runs sit side by side and stay comparable.
  const raceIdByNumber = Object.fromEntries(day.races.map((r) => [r.number, r.id]));
  const save = db.transaction(() => {
    const cardNumber = db.prepare(
      'SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?',
    ).get(day.id).n;
    const cardId = db.prepare(`INSERT INTO cards
        (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
         per_race_min_cents, status, correlation_id, consensus_completeness)
        VALUES (?, ?, ?, ?, ?, ?, 'final', ?, ?)`)
      .run(day.id, cardNumber, variant, templateIdFor(db, templateName), bankrollCents,
        perRaceMinCents, correlationId, result.completeness).lastInsertRowid;

    const insAlloc = db.prepare(`INSERT INTO allocations
        (card_id, race_id, amount_cents, confidence, rule, thesis)
        VALUES (?, ?, ?, ?, ?, ?)`);
    for (const a of result.allocations) {
      const thesis = [a.thesis, ...a.triggers.map((t) => `TRIGGER: ${t}`)].filter(Boolean).join('\n');
      insAlloc.run(cardId, raceIdByNumber[a.race], a.amountCents, a.confidence, a.rule, thesis || null);
    }

    const insTicket = db.prepare(`INSERT INTO tickets
        (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
         est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rationale, rule_tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of result.tickets) {
      insTicket.run(
        cardId,
        t.raceNumbers.length === 1 ? raceIdByNumber[t.raceNumbers[0]] : null,
        t.sequence, t.betType,
        JSON.stringify({ races: t.raceNumbers, legs: t.legs }),
        t.stakeCents, t.costCents, t.estMinCents, t.estMaxCents,
        t.estIsRange ? 1 : 0, t.tellerCall, t.rationale,
        JSON.stringify(t.ruleTags),
      );
    }
    return cardId;
  });
  const cardId = save();

  // The full decision trace, one JSONL event each, joined to the card by
  // correlation id + card id (invariants 7 and 8).
  for (const ev of result.trace) {
    traceLog.info(ev.event, { correlationId, cardId, raceDayId: day.id, ...ev });
  }
  appLog.info('card_generated', {
    correlationId, cardId, raceDayId: day.id, variant, template: templateName,
    completeness: result.completeness,
    tickets: result.tickets.length,
    totalCents: result.tickets.reduce((a, t) => a + t.costCents, 0),
    bankrollCents,
  });

  // A card generated after the chart already landed grades immediately -
  // the backtesting loop needs no extra click.
  const graded = gradeAndPersist(db, cardId, correlationId);

  res.status(201).json({
    id: cardId, correlationId, ...result,
    gradeSummary: graded.error ? null : graded.summary,
  });
});

cardsRouter.get('/race-days/:id/cards', (req, res) => {
  const db = getDb();
  const cards = db.prepare(`
    SELECT c.id, c.card_number, c.variant, st.name AS template,
           c.bankroll_cents, c.per_race_min_cents,
           c.status, c.consensus_completeness, c.created_at,
           COUNT(t.id) AS tickets, COALESCE(SUM(t.cost_cents), 0) AS total_cents
    FROM cards c
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    LEFT JOIN tickets t ON t.card_id = c.id
    WHERE c.race_day_id = ?
    GROUP BY c.id
    ORDER BY c.card_number DESC
  `).all(Number(req.params.id));
  res.json(cards);
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

  res.json({ ...card, allocations, tickets, sources, scratches });
});
