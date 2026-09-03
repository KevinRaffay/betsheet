// LLM cards (D63): a manual, per-race LLM-generated card as a third
// comparison point alongside lean and human - investigating whether a
// non-static LLM picker beats the static rules engine, not replacing it
// (CLAUDE.md's "Benchmark first, bet later"). Same tables, same grader as
// every other card: template 'llm', consensus_completeness
// 'LLM_GENERATED' (never pools with an engine bucket or with HUMAN,
// invariant 13), engine_version 'llm' (invariant 14 - never pools with a
// lean-* version).
//
// The prompt is per-race (docs/prompts/llm-card-v1.md); the response's
// ticket block is parsed by the SAME shared/parsers/human-picks.js a
// human's pasted picks go through (server/human-cards.js's loadRace/
// scratchedProgramNumbersFor are reused directly, not duplicated). Every
// call - success, failure, or an unparseable response - is logged
// verbatim to llm_card_requests (invariant 11's "every attempt visible"
// rule); nothing is saved to a card/ticket until the user confirms the
// preview, exactly like D54's human flow.

import express from 'express';
import { exactaEstimate, placeEstimate, trifectaBoxEstimate, winPayout } from '../shared/betmath.js';
import { buildConsensusTable } from '../shared/classification.js';
import { parseHumanPicksText } from '../shared/parsers/human-picks.js';
import { complete, hasKey, MODEL } from './anthropic-client.js';
import { getDb } from './db.js';
import { gradeAndPersist } from './grading.js';
import { loadRace, scratchedProgramNumbersFor } from './human-cards.js';
import { getLogger, newCorrelationId } from './logging.js';
import { buildLlmRaceUserPrompt, extractTicketBlock, SYSTEM_PROMPT } from './llm-prompt.js';
import { templateIdFor } from './templates.js';

const traceLog = getLogger('decision-trace');
const appLog = getLogger('app');

export const llmCardsRouter = express.Router();

class LlmCardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function raceNumbersFor(db, dayId) {
  return db.prepare('SELECT number FROM races WHERE race_day_id = ? ORDER BY number').all(dayId).map((r) => r.number);
}

/** Card bankroll minus tickets already spent on OTHER races on this card. */
function spentSoFar(db, cardId, excludeRaceId) {
  return db.prepare(`
    SELECT COALESCE(SUM(t.cost_cents), 0) AS n FROM tickets t
    JOIN races r ON r.id = t.race_id
    WHERE t.card_id = ? AND t.race_id != ?
  `).get(cardId, excludeRaceId ?? -1).n;
}

/** Races on this day with no tickets on this card yet (includes the race about to be generated). */
function racesRemaining(db, cardId, dayId, excludeRaceId) {
  const total = raceNumbersFor(db, dayId).length;
  if (!cardId) return total;
  const withTickets = db.prepare(`
    SELECT COUNT(DISTINCT t.race_id) AS n FROM tickets t
    WHERE t.card_id = ? AND t.race_id != ?
  `).get(cardId, excludeRaceId ?? -1).n;
  return Math.max(1, total - withTickets);
}

/**
 * Fills estMinCents/estMaxCents/estIsRange on each parsed ticket, reusing
 * the SAME validated formulas shared/card-engine.js uses (shared/betmath.js)
 * - so an LLM ticket's "If it hits" column (CardView.jsx) isn't empty the
 * way a human's own pasted ticket's is by design (shared/parsers/
 * human-picks.js always sets these null; a human already knows what they
 * bet, an LLM's picks are meant to be reviewed the way lean's are). Needs
 * each selection's morning-line odds, from the day's entries.
 *
 * Bet types with no validated formula anywhere in this codebase - show,
 * straight trifecta, superfecta, superfecta box - are left without an
 * estimate rather than inventing unvalidated multipliers alongside the
 * ones betmath.js's constants were tuned against real payouts for; a
 * blank "If it hits" there is an honest gap, not a bug, same as it would
 * be for an engine card (the engine itself never produces those types).
 */
function estimatePayouts(tickets, entries) {
  const mlOf = (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null;
  return tickets.map((t) => {
    const legs = t.legs;
    if (t.betType === 'win') {
      const ml = mlOf(legs[0]?.[0]);
      if (ml == null) return t;
      const p = winPayout(t.stakeCents, ml);
      return { ...t, estMinCents: p, estMaxCents: p, estIsRange: false };
    }
    if (t.betType === 'place') {
      const ml = mlOf(legs[0]?.[0]);
      if (ml == null) return t;
      const [lo, hi] = placeEstimate(t.stakeCents, ml);
      return { ...t, estMinCents: lo, estMaxCents: hi, estIsRange: true };
    }
    if (t.betType === 'exacta') {
      const mlTop = mlOf(legs[0]?.[0]);
      const mlUnder = mlOf(legs[1]?.[0]);
      if (mlTop == null || mlUnder == null) return t;
      const [lo, hi] = exactaEstimate(t.stakeCents, mlTop, mlUnder);
      return { ...t, estMinCents: lo, estMaxCents: hi, estIsRange: true };
    }
    if (t.betType === 'exacta_box') {
      const mls = (legs[0] ?? []).map(mlOf).filter((m) => m != null).sort((a, b) => a - b);
      if (mls.length < 2) return t;
      const [lo, hi] = exactaEstimate(t.stakeCents, mls[0], mls[1]);
      return { ...t, estMinCents: lo, estMaxCents: hi, estIsRange: true };
    }
    if (t.betType === 'trifecta_box') {
      const mls = (legs[0] ?? []).map(mlOf).filter((m) => m != null);
      if (mls.length < 3) return t;
      const [lo, hi] = trifectaBoxEstimate(t.stakeCents, mls);
      return { ...t, estMinCents: lo, estMaxCents: hi, estIsRange: true };
    }
    return t;
  });
}

function insertRequestRow(db, { raceDayId, cardId, raceNumber, promptText, responseText, model, error }) {
  return db.prepare(`
    INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, response_text, model, requested_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(raceDayId, cardId ?? null, raceNumber, promptText, responseText ?? null, model ?? null, now(), error ?? null).lastInsertRowid;
}

/**
 * Calls the LLM for one race, logs the attempt (success or failure) to
 * llm_card_requests, and parses a well-formed response through the SAME
 * human-picks validation. Never persists a ticket/card - preview-first,
 * invariant 9. `stubResponseText`: test-only escape hatch (see
 * scripts/check-llm-cards.js) so CI never calls the real API.
 */
export async function previewLlmRace(db, day, raceNumber, cardId, { stubResponseText } = {}) {
  const { race, entries } = loadRace(db, day.id, raceNumber);
  const scratched = scratchedProgramNumbersFor(db, day.id, race, entries);

  const card = cardId ? db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(cardId)) : null;
  if (cardId && (!card || card.race_day_id !== day.id)) {
    throw new LlmCardError(404, 'No such LLM card on this race day.');
  }
  const bankrollCents = card ? card.bankroll_cents : day.bankroll_cents;
  const spentCents = card ? spentSoFar(db, card.id, race.id) : 0;
  const remainingCents = Math.max(0, bankrollCents - spentCents);
  const remaining = racesRemaining(db, card?.id, day.id, race.id);
  const perRaceCents = Math.round(remainingCents / remaining);

  const picks = db.prepare(`
    SELECT cp.*, s.name AS source_name, s.kind AS source_kind
    FROM consensus_picks cp JOIN sources s ON s.id = cp.source_id
    WHERE cp.race_id = ?
  `).all(race.id);
  const consensusTable = buildConsensusTable(entries, picks).table;

  const totalRaces = raceNumbersFor(db, day.id).length;
  const userPrompt = buildLlmRaceUserPrompt({
    raceNumber, totalRaces, track: day.track, date: day.date,
    race: { surface: race.surface, distance: race.distance, raceType: race.race_type, postTime: race.post_time, wagerMenu: race.wager_menu },
    entries: entries.map((e) => ({
      programNumber: e.program_number, horseName: e.horse_name, morningLine: e.morning_line,
      programRank: e.program_rank, bestBet: Boolean(e.best_bet), scratched: Boolean(e.scratched),
    })),
    bottomLineText: race.bottom_line ?? null,
    consensusTable,
    bankroll: { perRaceCents, remainingCents, racesRemaining: remaining },
  });

  let responseText = stubResponseText ?? null;
  let model = stubResponseText ? 'stub' : MODEL;
  let callError = null;
  if (stubResponseText == null) {
    if (!hasKey()) {
      callError = 'ANTHROPIC_API_KEY is not set.';
    } else {
      try {
        const result = await complete({ system: SYSTEM_PROMPT, user: userPrompt });
        responseText = result.text;
        model = result.model;
      } catch (err) {
        callError = err.message;
      }
    }
  }

  const requestId = insertRequestRow(db, {
    raceDayId: day.id, cardId: card?.id, raceNumber, promptText: userPrompt,
    responseText, model, error: callError,
  });

  if (callError) throw new LlmCardError(502, `LLM call failed: ${callError}`);

  const extracted = extractTicketBlock(responseText);
  if (!extracted) {
    const msg = 'Race %s: model response did not contain a parseable ticket block.'.replace('%s', raceNumber);
    db.prepare('UPDATE llm_card_requests SET error = ? WHERE id = ?').run(msg, requestId);
    throw new LlmCardError(502, msg);
  }

  const parsed = parseHumanPicksText({
    text: extracted.ticketBlockText, race: raceNumber, entries, wagerMenu: race.wager_menu,
    scratchedProgramNumbers: scratched, ruleTag: 'llm',
  });

  const cardCostCents = spentCents + parsed.raceCostCents;
  return {
    requestId, model, reasoningText: extracted.reasoningText,
    ...parsed, perRaceBankrollCents: perRaceCents, cardCostCents, bankrollCents,
    overBankroll: cardCostCents > bankrollCents,
  };
}

/**
 * The one writer: re-loads and re-parses the STORED response for
 * `requestId` server-side (never trusts a client-shaped ticket payload,
 * same rule D54's persistHumanRace follows) and refuses (422) on any
 * blocking warning. `cardId` omitted starts a new card (next
 * card_number); given, appends to it (404 if missing/wrong day/not
 * template 'llm'). Re-generating an already-ticketed race replaces its
 * tickets/allocation - there is no lock/reveal state machine here (LLM
 * cards aren't a Replay blind-play feature), so nothing blocks a redo.
 */
export function persistLlmRace(db, day, { race: raceNumber, requestId, bankrollCents, cardId, correlationId }) {
  const { race, entries } = loadRace(db, day.id, raceNumber);
  const scratched = scratchedProgramNumbersFor(db, day.id, race, entries);

  const requestRow = db.prepare('SELECT * FROM llm_card_requests WHERE id = ? AND race_day_id = ? AND race_number = ?')
    .get(Number(requestId), day.id, raceNumber);
  if (!requestRow) throw new LlmCardError(404, 'No such LLM request for this race.');
  if (requestRow.error) throw new LlmCardError(422, `Race ${raceNumber}: that request failed (${requestRow.error}) - nothing to save.`);

  const extracted = extractTicketBlock(requestRow.response_text);
  if (!extracted) throw new LlmCardError(422, `Race ${raceNumber}: the stored response has no parseable ticket block.`);

  const parsed = parseHumanPicksText({
    text: extracted.ticketBlockText, race: raceNumber, entries, wagerMenu: race.wager_menu,
    scratchedProgramNumbers: scratched, ruleTag: 'llm',
  });
  const blocking = parsed.warnings.filter((w) => w.blocking);
  if (blocking.length) {
    const err = new LlmCardError(422, `Race ${raceNumber}: ${blocking.length} blocking warning(s) - nothing saved.`);
    err.warnings = parsed.warnings;
    throw err;
  }
  parsed.tickets = estimatePayouts(parsed.tickets, entries);

  let card = null;
  if (cardId) {
    card = db.prepare(`
      SELECT c.*, st.name AS template FROM cards c
      LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
      WHERE c.id = ?
    `).get(Number(cardId));
    if (!card || card.race_day_id !== day.id || card.template !== 'llm') {
      throw new LlmCardError(404, 'No such LLM card on this race day.');
    }
  }

  let isNewCard = false;
  const result = db.transaction(() => {
    if (!card) {
      isNewCard = true;
      const cardNumber = db.prepare('SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?').get(day.id).n;
      const newCardId = db.prepare(`INSERT INTO cards
          (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
           per_race_min_cents, status, correlation_id, consensus_completeness, engine_version)
          VALUES (?, ?, 'default', ?, ?, ?, 'final', ?, 'LLM_GENERATED', 'llm')`)
        .run(day.id, cardNumber, templateIdFor(db, 'llm'), bankrollCents ?? day.bankroll_cents,
          day.per_race_min_cents ?? null, correlationId).lastInsertRowid;
      card = db.prepare('SELECT * FROM cards WHERE id = ?').get(newCardId);
    }

    db.prepare('DELETE FROM tickets WHERE card_id = ? AND race_id = ?').run(card.id, race.id);
    db.prepare('DELETE FROM allocations WHERE card_id = ? AND race_id = ?').run(card.id, race.id);

    if (parsed.tickets.length) {
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
          VALUES (?, ?, ?, 'LLM', 'llm_pick', ?)`)
        .run(card.id, race.id, parsed.raceCostCents, extracted.reasoningText || null);
    }

    return card;
  })();

  if (isNewCard) {
    traceLog.info('card_generated', { correlationId, cardId: result.id, raceDayId: day.id, engineVersion: 'llm', template: 'llm' });
  }
  for (const t of parsed.tickets) {
    traceLog.info('ticket_added', {
      correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, betType: t.betType,
      selections: t.legs, stakeCents: t.stakeCents, costCents: t.costCents, rationaleText: t.rationale_text,
    });
  }
  appLog.info('llm_race_generated', {
    correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, requestId,
    tickets: parsed.tickets.length, costCents: parsed.raceCostCents,
  });

  let graded = null;
  const hasResults = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id);
  if (hasResults) graded = gradeAndPersist(db, result.id, correlationId, { engineVersion: 'llm' });

  const cardCostCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets WHERE card_id = ?').get(result.id).n;
  return { cardId: result.id, correlationId, tickets: parsed.tickets, raceCostCents: parsed.raceCostCents, cardCostCents, warnings: parsed.warnings, graded };
}

function loadDay(db, id) {
  return db.prepare('SELECT * FROM race_days WHERE id = ?').get(id) ?? null;
}

llmCardsRouter.post('/race-days/:id/llm-cards/preview', async (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const race = Number(req.body?.race);
  if (!Number.isInteger(race) || race <= 0) return res.status(400).json({ error: 'race is required.' });
  try {
    const preview = await previewLlmRace(db, day, race, req.body?.cardId, {
      stubResponseText: process.env.BETSHEET_LLM_TEST_MODE === '1' ? req.body?.__stubResponse : undefined,
    });
    res.json({ correlationId, ...preview });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

llmCardsRouter.post('/race-days/:id/llm-cards', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted. Restore it before saving an LLM card.' });

  const race = Number(req.body?.race);
  if (!Number.isInteger(race) || race <= 0) return res.status(400).json({ error: 'race is required.' });
  if (!req.body?.requestId) return res.status(400).json({ error: 'requestId is required.' });

  try {
    const result = persistLlmRace(db, day, {
      race, requestId: req.body.requestId,
      bankrollCents: req.body?.bankrollCents != null ? Number(req.body.bankrollCents) : undefined,
      cardId: req.body?.cardId, correlationId,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, warnings: err.warnings ?? undefined });
    throw err;
  }
});

// Every logged call for one card - reasoning + raw response, retrievable
// per race, success or failure (invariant 11).
llmCardsRouter.get('/cards/:id/llm-requests', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const rows = db.prepare('SELECT * FROM llm_card_requests WHERE card_id = ? ORDER BY race_number, id').all(card.id);
  res.json(rows.map((r) => ({
    id: r.id, raceNumber: r.race_number, model: r.model, requestedAt: r.requested_at, error: r.error,
    promptText: r.prompt_text, responseText: r.response_text,
  })));
});
