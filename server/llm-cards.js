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

import crypto from 'node:crypto';
import express from 'express';
import { estimateTicketPayouts } from '../shared/betmath.js';
import { parseHumanPicksText } from '../shared/parsers/human-picks.js';
import { complete, DEFAULT_REQUEST_PARAMS, hasKey, MODEL, SELECTABLE_MODELS } from './anthropic-client.js';
import { getDb } from './db.js';
import { loadNotesForRace, readNotes, writeNote } from './llm-notes.js';
import { gradeAndPersist } from './grading.js';
import { loadRace, scratchedProgramNumbersFor } from './human-cards.js';
import { getLogger, newCorrelationId } from './logging.js';
import {
  buildLlmRaceUserPrompt, buildSystemPrompt, extractNotesReport, extractTicketBlock,
  PROMPT_TEMPLATE_ID, PROMPT_TEMPLATE_VERSION,
} from './llm-prompt.js';
import { templateIdFor } from './templates.js';

const sha256 = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

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

/**
 * The per-race share of what is left, floored to a WHOLE DOLLAR (D163).
 *
 * An even division lands on numbers no legal wager can add up to: $172.00
 * over 12 races is $14.3333, $57.50 over 4 is $14.375. Rounding those to the
 * cent - which this did until D163 - hands the model a target of "$14.33"
 * when the cheapest step in play is 50c and is usually $1, so the last cents
 * are unspendable by construction. Live evidence (day 263, requests 329/336/
 * 337/340, all on the post-D162 prompt): four races blocked, and in every one
 * the illegal stake was EXACTLY the leftover - $1.33 on a $1 exacta, $1.75 on
 * a 50c trifecta, $4.25 across 24 combos, and a race where nothing legal fit
 * at all. The model was not miscounting; it was trying to hit a figure that
 * cannot be hit, because nothing told it a remainder was allowed to survive.
 *
 * FLOOR, not round: the per-race shares must never sum to MORE than the
 * bankroll they are carved from, which rounding up can do.
 *
 * This trims at most 99c of headroom off a race, and a 50c trifecta is the
 * only wager fine-grained enough to notice. That is the deliberate trade -
 * a target that can actually be spent is worth more than the last 99 cents,
 * and the prompt now says plainly that leftover money is fine anyway.
 */
export function perRaceBankrollCents(remainingCents, racesRemaining) {
  const races = Math.max(1, racesRemaining);
  return Math.floor(Math.max(0, remainingCents) / races / 100) * 100;
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


function insertRequestRow(db, {
  raceDayId, cardId, raceNumber, promptText, responseText, model, error, notes,
  correlationId, systemPromptText, requestParams,
}) {
  // D92: the notes snapshot rides along on the same insert. It is what makes
  // the log self-describing - the draft in llm_notes is mutable, so a later
  // read must not have to trust it to know what this call actually sent.
  const n = notes?.snapshot ?? {
    notes_present: 0, notes_race_text: null, notes_card_text: null, notes_source_label: null,
    notes_hash: null, notes_char_count: null, notes_entered_at: null, notes_post_result: 0,
  };
  // D149: what the call CONSUMED, not just what it produced - see
  // migration 026's own comment for why these ride on this row rather than
  // a second table.
  return db.prepare(`
    INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, response_text, model, requested_at, error,
      notes_present, notes_race_text, notes_card_text, notes_source_label, notes_hash, notes_char_count, notes_entered_at, notes_post_result,
      correlation_id, system_prompt_text, system_prompt_hash, user_prompt_hash, notes_rendered_text,
      prompt_template_id, prompt_template_version, request_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(raceDayId, cardId ?? null, raceNumber, promptText, responseText ?? null, model ?? null, now(), error ?? null,
    n.notes_present, n.notes_race_text, n.notes_card_text, n.notes_source_label,
    n.notes_hash, n.notes_char_count, n.notes_entered_at, n.notes_post_result,
    correlationId ?? null, systemPromptText ?? null, systemPromptText ? sha256(systemPromptText) : null,
    sha256(promptText), notes?.composed ?? null,
    PROMPT_TEMPLATE_ID, PROMPT_TEMPLATE_VERSION, JSON.stringify(requestParams ?? null)).lastInsertRowid;
}

/**
 * Calls the LLM for one race, logs the attempt (success or failure) to
 * llm_card_requests, and parses a well-formed response through the SAME
 * human-picks validation. Never persists a ticket/card - preview-first,
 * invariant 9. `stubResponseText`: test-only escape hatch (see
 * scripts/check-llm-cards.js) so CI never calls the real API. `model`
 * (D75): overrides the server-configured default for this one call, so
 * the user can pick a model per generation in the LLM card modal.
 */
export async function previewLlmRace(db, day, raceNumber, cardId, {
  stubResponseText, model: requestedModel, interactive = false, correlationId,
} = {}) {
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
  const perRaceCents = perRaceBankrollCents(remainingCents, remaining);

  // Analyst notes (D92). A POSITIVE `interactive` gate, so a future batch
  // runner that forgets the flag gets a notes-free prompt by default rather
  // than silently attaching them - fail closed. When notes DO exist and the
  // caller is not interactive we refuse loudly: silently dropping them would
  // produce a corpus that differs from what the operator believed they ran,
  // which is the exact failure the guard exists to prevent.
  const notes = loadNotesForRace(db, day.id, raceNumber);
  if (notes.present && !interactive) {
    throw new LlmCardError(409,
      'Analyst notes are an interactive input; a batch run must not attach them. '
      + 'Clear the notes for this day, or run this race from the LLM card modal.');
  }

  const baseline = loadBaselineForRace(db, day.id, raceNumber);
  const totalRaces = raceNumbersFor(db, day.id).length;
  const userPrompt = buildLlmRaceUserPrompt({
    raceNumber, totalRaces, track: day.track, date: day.date,
    race: { surface: race.surface, distance: race.distance, raceType: race.race_type, postTime: race.post_time, wagerMenu: race.wager_menu },
    entries: entries.map((e) => ({
      programNumber: e.program_number, horseName: e.horse_name, morningLine: e.morning_line,
      scratched: Boolean(e.scratched),
    })),
    bankroll: { perRaceCents, remainingCents, racesRemaining: remaining },
    notes: notes.prompt,
    baseline,
  });

  const systemPromptText = buildSystemPrompt({
    hasNotes: notes.present,
    hasBaseline: baseline.tipsheets.length > 0 || baseline.otrTickets.length > 0,
  });

  let responseText = stubResponseText ?? null;
  let model = stubResponseText ? 'stub' : (requestedModel || MODEL);
  let requestParams = DEFAULT_REQUEST_PARAMS;
  let callError = null;

  // D149: the call is logged as SENT before we know whether it will
  // succeed - invariant 11's "every attempt visible" rule, one event
  // earlier than the request row itself (which is only written once we
  // also know the outcome, below).
  traceLog.info('llm_request_sent', {
    correlationId, cardId: card?.id ?? null, raceDayId: day.id, races: [raceNumber], model,
    promptTemplate: { id: PROMPT_TEMPLATE_ID, version: PROMPT_TEMPLATE_VERSION },
    promptHashes: { system: `sha256:${sha256(systemPromptText)}`, user: `sha256:${sha256(userPrompt)}` },
    notesHash: notes.snapshot?.notes_hash ?? null, notesChars: notes.snapshot?.notes_char_count ?? null,
  });

  if (stubResponseText == null) {
    if (!hasKey()) {
      callError = 'ANTHROPIC_API_KEY is not set.';
    } else {
      try {
        const result = await complete({ system: systemPromptText, user: userPrompt, model });
        responseText = result.text;
        model = result.model;
        requestParams = result.requestParams;
      } catch (err) {
        callError = err.message;
      }
    }
  }

  const requestId = insertRequestRow(db, {
    raceDayId: day.id, cardId: card?.id, raceNumber, promptText: userPrompt,
    responseText, model, error: callError, notes,
    correlationId, systemPromptText, requestParams,
  });

  if (callError) {
    traceLog.info('llm_response_received', {
      correlationId, cardId: card?.id ?? null, raceDayId: day.id, responseChars: 0, parsedTicketCount: 0,
      parsedRaceCount: 0, parseErrors: [callError],
    });
    throw new LlmCardError(502, `LLM call failed: ${callError}`);
  }

  const extracted = extractTicketBlock(responseText);
  if (!extracted) {
    const msg = 'Race %s: model response did not contain a parseable ticket block.'.replace('%s', raceNumber);
    db.prepare('UPDATE llm_card_requests SET error = ? WHERE id = ?').run(msg, requestId);
    traceLog.info('llm_response_received', {
      correlationId, cardId: card?.id ?? null, raceDayId: day.id, responseChars: responseText.length, parsedTicketCount: 0,
      parsedRaceCount: 0, parseErrors: ['no_ticket_block'],
    });
    throw new LlmCardError(502, msg);
  }

  const parsed = parseHumanPicksText({
    text: extracted.ticketBlockText, race: raceNumber, entries, wagerMenu: race.wager_menu,
    scratchedProgramNumbers: scratched, ruleTag: 'llm',
  });
  parsed.tickets = estimateTicketPayouts(parsed.tickets,
    (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null);

  // The notes report is telemetry, never a contract: absent or malformed is
  // null, never an error. Every response stored before D92 lacks one, and
  // persistLlmRace re-parses STORED responses - a hard failure here would
  // retroactively make historical requests unsaveable.
  const notesReport = notes.present ? extractNotesReport(extracted.trailingText) : null;
  if (notes.present) {
    // All NON-BLOCKING (D92): handicapper prose routinely names horses from
    // other races ("beat Chrome last out"), so blocking would refuse most real
    // notes. Pushed AFTER the parse, so they can never reach persistLlmRace's
    // blocking filter - notes structurally cannot refuse a save.
    for (const t of notes.truncated) {
      parsed.warnings.push({
        type: 'notes_truncated', blocking: false, race: raceNumber,
        message: `Race ${raceNumber}: the ${t.scope} note was truncated to ${t.cap} characters for the prompt (${t.omitted} omitted).`,
      });
    }
    if (!notesReport) {
      parsed.warnings.push({
        type: 'notes_report_missing', blocking: false, race: raceNumber,
        message: `Race ${raceNumber}: notes were sent but the model returned no notes report.`,
      });
    }
    for (const c of notesReport?.conflicts ?? []) {
      parsed.warnings.push({
        type: 'notes_conflict', blocking: false, race: raceNumber,
        message: `Race ${raceNumber}: the notes reference "${c.token}" (${c.kind ?? 'unresolved'}) - not matched to an entry in this race.`,
      });
    }
  }

  traceLog.info('llm_response_received', {
    correlationId, cardId: card?.id ?? null, raceDayId: day.id, responseChars: responseText.length,
    parsedTicketCount: parsed.tickets.length, parsedRaceCount: 1,
    parseErrors: parsed.warnings.filter((w) => w.blocking).map((w) => w.type),
  });

  const cardCostCents = spentCents + parsed.raceCostCents;
  return {
    requestId, model, reasoningText: extracted.reasoningText,
    notesPresent: notes.present, notesReport, notesSourceLabel: notes.sourceLabel,
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
  // D215: a refused LINE no longer refuses the RACE. A blocking warning here
  // never meant "drop a parsed ticket" - parseColumnRow / parseTellerTicketString
  // / buildTickets each return without pushing one, so the ticket does not
  // exist by the time this code runs. Refusing the whole race therefore threw
  // away the tickets that DID parse, which is how five real generations
  // (Horseshoe Indianapolis, 2026-09-10) cost ~22 good tickets over one bad
  // line each. This is deliberately NOT done for a human's pasted card
  // (server/human-cards.js): a human can fix the source text and re-parse,
  // which is what invariant 9 requires; a paid model response cannot be edited.
  const refused = parsed.warnings.filter((w) => w.blocking);
  // Nothing survived: still a refusal, and deliberately so. Saving an empty
  // race here would be indistinguishable from the model deciding this race is
  // not worth a bet - a real and legitimate outcome the prompt asks for - and
  // that difference is exactly what the LLM_GENERATED bucket is measuring.
  if (refused.length && !parsed.tickets.length) {
    const err = new LlmCardError(422, `Race ${raceNumber}: all ${refused.length} ticket line(s) were refused - nothing to save.`);
    err.warnings = parsed.warnings;
    throw err;
  }
  parsed.tickets = estimateTicketPayouts(parsed.tickets,
    (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null);

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
    // D76: a card's model is fixed at creation and never drifts - mixing
    // models on one card would make its P/L uncomparable to either model
    // on its own. The UI locks the picker once a card is resumed
    // (LlmCardModal.jsx), so this is a defense-in-depth 409, not the
    // primary guard.
    if (card.llm_model && requestRow.model && card.llm_model !== requestRow.model) {
      throw new LlmCardError(409,
        `This card was generated with ${card.llm_model}; this request used ${requestRow.model}. `
        + 'Start a new card to compare a different model.');
    }
  }

  // D149: capture what a regeneration is about to REPLACE, before it's gone.
  // Only meaningful when appending to an existing card - a brand-new card's
  // first race has nothing to replace. previousCorrelationId is the most
  // recent EARLIER successful request logged for this exact (card, race) -
  // an approximation (nothing links a ticket row back to the request that
  // produced it), but the append-only request log makes it a close one.
  const existingTickets = card
    ? db.prepare('SELECT id FROM tickets WHERE card_id = ? AND race_id = ?').all(card.id, race.id)
    : [];
  const previousCorrelationId = existingTickets.length
    ? db.prepare(`
        SELECT correlation_id FROM llm_card_requests
        WHERE race_number = ? AND error IS NULL AND id < ?
          AND (card_id = ? OR (card_id IS NULL AND race_day_id = ? AND correlation_id = ?))
        ORDER BY id DESC LIMIT 1
      `).get(raceNumber, Number(requestId), card.id, card.race_day_id, card.correlation_id)?.correlation_id ?? null
    : null;

  let isNewCard = false;
  const result = db.transaction(() => {
    if (!card) {
      isNewCard = true;
      const cardNumber = db.prepare('SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?').get(day.id).n;
      const newCardId = db.prepare(`INSERT INTO cards
          (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
           per_race_min_cents, status, correlation_id, consensus_completeness, engine_version, llm_model, notes_present)
          VALUES (?, ?, 'default', ?, ?, ?, 'final', ?, 'LLM_GENERATED', 'llm', ?, ?)`)
        .run(day.id, cardNumber, templateIdFor(db, 'llm'), bankrollCents ?? day.bankroll_cents,
          day.per_race_min_cents ?? null, correlationId, requestRow.model ?? null,
          requestRow.notes_present ? 1 : 0).lastInsertRowid;
      card = db.prepare('SELECT * FROM cards WHERE id = ?').get(newCardId);
    }

    // D92: notes LATCH, they never freeze. Unlike llm_model (fixed at creation,
    // a mismatch is a 409), a user will realistically have commentary for 3 of
    // 8 races - refusing the other 5 would make the feature unusable. So the
    // flag means "AT LEAST ONE race on this card used notes", never "every race
    // did"; per-race truth lives on llm_card_requests.notes_present.
    if (requestRow.notes_present) {
      db.prepare('UPDATE cards SET notes_present = 1 WHERE id = ? AND notes_present = 0').run(card.id);
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
    }

    db.prepare(`INSERT INTO allocations (card_id, race_id, amount_cents, confidence, rule, thesis)
        VALUES (?, ?, ?, 'LLM', 'llm_pick', ?)`)
      .run(card.id, race.id, parsed.raceCostCents, extracted.reasoningText || null);

    return card;
  })();

  if (isNewCard) {
    traceLog.info('card_generated', { correlationId, cardId: result.id, raceDayId: day.id, engineVersion: 'llm', template: 'llm', llmModel: result.llm_model });
  }
  if (existingTickets.length) {
    traceLog.info('race_regenerated', {
      cardId: result.id, raceDayId: day.id, race: raceNumber,
      previousCorrelationId, newCorrelationId: correlationId, ticketsRemoved: existingTickets.length,
    });
  }
  for (const t of parsed.tickets) {
    traceLog.info('ticket_added', {
      correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, betType: t.betType,
      selections: t.legs, stakeCents: t.stakeCents, costCents: t.costCents, rationaleText: t.rationale_text,
    });
  }
  // Invariant 7: the trace must explain why a card holds 4 tickets when the
  // model wrote 5. A refused line is a decision, so it is an event, not a gap.
  for (const w of refused) {
    traceLog.info('ticket_refused', {
      correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber,
      requestId, reason: w.type, message: w.message,
    });
  }
  appLog.info('llm_race_generated', {
    correlationId, cardId: result.id, raceDayId: day.id, race: raceNumber, requestId,
    tickets: parsed.tickets.length, refused: refused.length, costCents: parsed.raceCostCents,
  });

  let graded = null;
  const hasResults = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id);
  if (hasResults) graded = gradeAndPersist(db, result.id, correlationId, { engineVersion: 'llm' });

  const cardCostCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets WHERE card_id = ?').get(result.id).n;
  return { cardId: result.id, correlationId, llmModel: result.llm_model, tickets: parsed.tickets, raceCostCents: parsed.raceCostCents, cardCostCents, warnings: parsed.warnings, refused, graded };
}

function loadDay(db, id) {
  return db.prepare('SELECT * FROM race_days WHERE id = ?').get(id) ?? null;
}

// The selectable model list + the server-configured default (D75), so the
// modal's picker is never a second copy of anthropic-client.js's list.
// ---------- analyst notes (D92): the mutable draft store ----------
// Keyed by day + race, never by card - notes belong to a RACE, so the same
// commentary can feed a Sonnet card and an Opus card. race 0 is the day note.

llmCardsRouter.get('/race-days/:id/llm-notes', (req, res) => {
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted.' });
  res.json({
    ...readNotes(db, day.id),
    // So the modal can say up front that notes written now are not blind,
    // rather than only after the first save comes back.
    postResult: Boolean(db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id)),
  });
});

llmCardsRouter.put('/race-days/:id/llm-notes', (req, res) => {
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted.' });
  const race = Number(req.body?.race);
  // 0 is the day-level note; anything else must be a real race number.
  if (!Number.isInteger(race) || race < 0) return res.status(400).json({ error: 'race is required (0 for the card-level note).' });
  const row = writeNote(db, day.id, race, req.body?.text, req.body?.sourceLabel);
  res.json({
    race,
    note: row ? { text: row.notes_text, sourceLabel: row.source_label, updatedAt: row.updated_at, createdAt: row.created_at } : null,
    // Notes written after a result is known are not blind. Recorded, never
    // refused (D92 decision) - the corpus filter is notes_post_result.
    postResult: Boolean(db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id)),
  });
});

llmCardsRouter.get('/llm-models', (_req, res) => {
  res.json({ models: SELECTABLE_MODELS, default: MODEL });
});

llmCardsRouter.post('/race-days/:id/llm-cards/preview', async (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  // D112 found this guard missing here while every neighbouring route had it
  // (both notes routes and the save below). A preview on a deleted day
  // persists no card, but it DOES write an llm_card_requests row - invariant
  // 11 logs every attempt - and it spends a real, paid model call on a day
  // invariant 12 says is excluded everywhere. Pre-existing, surfaced by a
  // check-ingest assertion that had to find a second mutating route once the
  // consensus manual-paste route it used was removed.
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted. Restore it before generating an LLM card.' });
  const race = Number(req.body?.race);
  if (!Number.isInteger(race) || race <= 0) return res.status(400).json({ error: 'race is required.' });
  const requestedModel = req.body?.model;
  if (requestedModel && !SELECTABLE_MODELS.some((m) => m.id === requestedModel)) {
    return res.status(400).json({ error: `Unknown model "${requestedModel}". Choose one of: ${SELECTABLE_MODELS.map((m) => m.id).join(', ')}.` });
  }
  try {
    const preview = await previewLlmRace(db, day, race, req.body?.cardId, {
      stubResponseText: process.env.BETSHEET_LLM_TEST_MODE === '1' ? req.body?.__stubResponse : undefined,
      model: requestedModel || undefined,
      // The ONE interactive caller. Nothing else passes this, so a batch path
      // that grows an LLM call later gets a notes-free prompt by default.
      interactive: true,
      correlationId,
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
    // D93: what the badge needs to say whether the draft has MOVED since
    // this generation - the snapshot's own entered-at, not the call time.
    notesPresent: Boolean(r.notes_present), notesEnteredAt: r.notes_entered_at,
  })));
});

/**
 * What the day's OTHER sources already think about this race (D179).
 *
 * Two shapes, deliberately not merged: tip sheets are a ranked pick list,
 * Equibase's Off to the Races is a set of printed TICKETS. D74's reason still
 * holds - OTR prints a show pick, a win pick and unranked box mentions, never
 * a ranked 3rd pick, so flattening it into ranks would invent one.
 *
 * OTR is read from the `both` VARIANT, verified as the only one carrying all
 * four printed tickets (`some-reward` and `higher-reward` each hold half).
 *
 * Returns empty arrays rather than null when there is nothing: an absent
 * baseline must render no block at all, so the prompt for a race without one
 * stays byte-identical to what it always was.
 */
export function loadBaselineForRace(db, raceDayId, raceNumber) {
  const tipsheets = db.prepare(
    'SELECT source_label, picks FROM tip_picks WHERE race_day_id = ? AND race_no = ? ORDER BY source_label',
  ).all(raceDayId, raceNumber)
    .map((r) => ({ sourceLabel: r.source_label, picks: JSON.parse(r.picks) }));

  // ONE card, not every matching one. OTR ingest is APPEND-ONLY (D71), so a
  // re-uploaded sheet leaves several `both` cards on the day and joining them
  // all would render the same sheet two or three times over. The newest is the
  // current sheet.
  const otrCard = db.prepare(`
    SELECT id FROM cards
     WHERE race_day_id = ? AND consensus_completeness = 'EQB_OTR' AND variant = 'both'
     ORDER BY card_number DESC LIMIT 1
  `).get(raceDayId);
  const otrTickets = otrCard ? db.prepare(`
    SELECT t.teller_call AS tellerCall
      FROM tickets t
      JOIN races r ON r.id = t.race_id
     WHERE t.card_id = ? AND r.number = ?
     ORDER BY t.sequence
  `).all(otrCard.id, raceNumber) : [];

  return { tipsheets, otrTickets };
}
