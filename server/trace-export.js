// Decision-trace export: one self-contained JSON document per card that
// joins WHY every dollar was placed (the decision trace) with WHAT it
// earned (the grades) - the Phase 3 feed for LLM analysis of the
// generation algorithm. Schema documented in docs/trace-schema.md; bump
// SCHEMA_VERSION whenever the shape changes.
//
// The trace is read back from the decision-trace log files (active +
// rotated + gzipped) by the card's correlation id - the files are the
// source of truth for history (invariant 12: they survive even race-day
// deletion), the DB rows are the source of truth for current state, and
// the export carries both.

import express from 'express';
import { getDb } from './db.js';
import { getLogger, readRecent } from './logging.js';

const log = getLogger('app');

export const SCHEMA_VERSION = 3;

export const exportRouter = express.Router();

/**
 * D149: what an LLM card's generation calls CONSUMED (prompts, notes,
 * responses), grouped by correlation id - one entry per Generate/
 * Regenerate-All session that actually landed a ticket on this card.
 *
 * llm_card_requests rows normally carry this card's own id, but the very
 * FIRST call for a brand-new card is logged before the card exists (see
 * server/llm-cards.js's architecture comment) and is never back-filled with
 * one - it stays findable by (race_day_id, correlation_id) instead, which is
 * why the match below is an OR rather than a plain card_id equality.
 *
 * Returns null (never []) for a non-LLM card, or an LLM card with no
 * matching rows at all - which is what every card exported at
 * schemaVersion 2 or earlier looks like, since this capture did not exist
 * yet. null means "unknown", not "no notes" / "no calls made".
 */
function buildLlmInputs(db, card) {
  if (card.template !== 'llm') return null;
  const rows = db.prepare(`
    SELECT * FROM llm_card_requests
    WHERE error IS NULL
      -- correlation_id IS NOT NULL is the marker that this row was written
      -- by the D149-aware insertRequestRow - a row from before migration 026
      -- (or from before D149's code landed) can never carry one, which is
      -- exactly the "unknown, not merely notes-free" case the null return
      -- below exists for.
      AND correlation_id IS NOT NULL
      AND (
        card_id = ?
        OR (card_id IS NULL AND race_day_id = ? AND correlation_id = ?)
      )
    ORDER BY correlation_id, race_number, id
  `).all(card.id, card.race_day_id, card.correlation_id);
  if (!rows.length) return null;

  const byCorrelation = new Map();
  for (const r of rows) {
    if (!byCorrelation.has(r.correlation_id)) byCorrelation.set(r.correlation_id, []);
    byCorrelation.get(r.correlation_id).push(r);
  }

  const sha = (h) => (h ? `sha256:${h}` : null);
  return [...byCorrelation.entries()].map(([correlationId, reqs]) => ({
    correlationId,
    races: reqs.map((r) => r.race_number),
    // Uniform across one session in practice (one model/template per card
    // session), taken from the first call rather than repeated per race.
    model: reqs[0].model,
    requestParams: reqs[0].request_params ? JSON.parse(reqs[0].request_params) : null,
    promptTemplate: { id: reqs[0].prompt_template_id, version: reqs[0].prompt_template_version },
    // Per-race detail, since each race is its OWN model call with its own
    // prompt and response - collapsing them into one shared string per
    // correlation id would misrepresent calls that never shared one.
    requests: reqs.map((r) => ({
      race: r.race_number,
      promptHashes: { system: sha(r.system_prompt_hash), user: sha(r.user_prompt_hash) },
      notes: r.notes_present ? {
        raw: { race: r.notes_race_text, card: r.notes_card_text },
        rendered: r.notes_rendered_text,
        hash: sha(r.notes_hash),
        chars: r.notes_char_count,
      } : null,
      systemPromptRendered: r.system_prompt_text,
      promptRendered: r.prompt_text,
      responseRaw: r.response_text,
    })),
  }));
}

/** Strips the heavy/verbatim text an --omit-llm-inputs export leaves out, keeping hashes/chars/template/race/model. */
function redactLlmInputs(llmInputs) {
  if (!llmInputs) return llmInputs;
  return llmInputs.map((entry) => ({
    ...entry,
    requests: entry.requests.map(({ systemPromptRendered, promptRendered, responseRaw, notes, ...rest }) => ({
      ...rest,
      notes: notes ? { hash: notes.hash, chars: notes.chars } : null,
    })),
  }));
}

/** Build the export document for one card, or {error, status} if it can't. `omitLlmInputs` (D149) drops verbatim prompt/response/notes text, keeping only hashes/chars - the shareable form. */
export function buildCardExport(db, cardId, { omitLlmInputs = false } = {}) {
  const card = db.prepare(`
    SELECT c.*, rd.track, rd.date, rd.deleted_at AS day_deleted_at, st.name AS template,
           COALESCE(c.per_race_min_cents, rd.per_race_min_cents) AS per_race_min_cents
    FROM cards c JOIN race_days rd ON rd.id = c.race_day_id
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.id = ?
  `).get(cardId);
  if (!card) return { error: 'No such card.', status: 404 };
  if (card.day_deleted_at) {
    return { error: 'This card belongs to a deleted race day; deleted days are excluded from exports.', status: 410 };
  }

  const races = db.prepare(
    'SELECT * FROM races WHERE race_day_id = ? ORDER BY number',
  ).all(card.race_day_id).map((r) => ({
    number: r.number,
    raceType: r.race_type,
    surface: r.surface,
    distance: r.distance,
    postTime: r.post_time,
    conditions: r.conditions,
    classification: r.classification,
    contrarianFlags: r.contrarian_flags ? JSON.parse(r.contrarian_flags) : [],
    wagerMenu: r.wager_menu,
    entries: db.prepare('SELECT * FROM entries WHERE race_id = ? ORDER BY id').all(r.id)
      .map((e) => ({
        programNumber: e.program_number,
        horseName: e.horse_name,
        morningLine: e.morning_line,
        morningLineDecimal: e.morning_line_decimal,
        programRank: e.program_rank,
        bestBet: Boolean(e.best_bet),
        scratched: Boolean(e.scratched),
      })),
  }));

  const consensus = db.prepare(`
    SELECT r.number AS race, s.name AS source, s.kind, cp.pick_type, cp.program_number, cp.horse_name, cp.note
    FROM consensus_picks cp
    JOIN sources s ON s.id = cp.source_id
    JOIN races r ON r.id = cp.race_id
    WHERE r.race_day_id = ?
    ORDER BY r.number, s.name, cp.id
  `).all(card.race_day_id);

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

  const allocations = db.prepare(`
    SELECT r.number AS race, a.amount_cents, a.confidence, a.rule, a.thesis
    FROM allocations a JOIN races r ON r.id = a.race_id
    WHERE a.card_id = ? ORDER BY r.number
  `).all(card.id).map((a) => ({
    race: a.race, amountCents: a.amount_cents, confidence: a.confidence,
    rule: a.rule, thesis: a.thesis,
  }));

  const tickets = db.prepare(`
    SELECT t.*, gt.outcome, gt.returned_cents, gt.pl_cents, gt.details
    FROM tickets t
    LEFT JOIN graded_tickets_latest gt ON gt.ticket_id = t.id
    WHERE t.card_id = ? ORDER BY t.sequence
  `).all(card.id).map((t) => {
    const sel = JSON.parse(t.selections);
    return {
      sequence: t.sequence,
      betType: t.bet_type,
      races: sel.races,
      legs: sel.legs,
      stakeCents: t.stake_cents,
      costCents: t.cost_cents,
      estPayoutMinCents: t.est_payout_min_cents,
      estPayoutMaxCents: t.est_payout_max_cents,
      estIsRange: Boolean(t.est_is_range),
      tellerCall: t.teller_call,
      rationale: t.rationale,
      ruleTags: JSON.parse(t.rule_tags ?? '[]'),
      grade: t.outcome == null ? null : {
        outcome: t.outcome,
        returnedCents: t.returned_cents,
        plCents: t.pl_cents,
        note: JSON.parse(t.details ?? '{}').note ?? null,
      },
    };
  });

  const graded = tickets.filter((t) => t.grade);
  const gradeSummary = graded.length === 0 ? null : {
    costCents: graded.reduce((a, t) => a + t.costCents, 0),
    returnedCents: graded.reduce((a, t) => a + t.grade.returnedCents, 0),
    plCents: graded.reduce((a, t) => a + t.grade.plCents, 0),
    outcomes: graded.reduce((a, t) => ((a[t.grade.outcome] = (a[t.grade.outcome] ?? 0) + 1), a), {}),
  };

  const results = db.prepare(
    'SELECT race_number, program_number, horse_name, finish_position, win_cents, place_cents, show_cents FROM race_results WHERE race_day_id = ? ORDER BY race_number, finish_position',
  ).all(card.race_day_id).map((r) => ({
    race: r.race_number, programNumber: r.program_number, horseName: r.horse_name,
    finishPosition: r.finish_position, winCents: r.win_cents,
    placeCents: r.place_cents, showCents: r.show_cents,
  }));
  const exotics = db.prepare(
    'SELECT race_number, bet_type, base_cents, combination, payout_cents FROM exotic_payoffs WHERE race_day_id = ? ORDER BY race_number, id',
  ).all(card.race_day_id).map((x) => ({
    race: x.race_number, betType: x.bet_type, baseCents: x.base_cents,
    combination: x.combination, payoutCents: x.payout_cents,
  }));
  const resultScratches = db.prepare(
    'SELECT race_number, program_number, horse_name FROM result_scratches WHERE race_day_id = ? ORDER BY race_number, id',
  ).all(card.race_day_id).map((s) => ({
    race: s.race_number, programNumber: s.program_number, horseName: s.horse_name,
  }));

  // The trace, from the log files: everything the card's correlation id
  // touched plus anything stamped with this cardId (grading runs triggered
  // by a results save carry the card's correlation id but a different
  // session started them). readRecent returns newest-first; reverse to
  // chronological. The limit is a guard, not a page size - one card's
  // session is hundreds of events, never near it.
  const traceEvents = readRecent('decision-trace', {
    limit: 50000,
    filter: (r) => r.correlationId === card.correlation_id || r.cardId === card.id,
  }).reverse();

  // Honesty marker: log files can be younger than the card (factory reset,
  // pruned retention, a different BETSHEET_LOG_DIR), so a thin trace must be
  // FLAGGED rather than silently exported as if it were the whole story.
  //
  // This used to be proven by the lean engine's gap-free `seq` counter, which
  // it stamped on every event of the one call that built a whole card. D111
  // deleted that engine, and none of the three producers that remain can
  // carry such a counter honestly: a human, LLM or OTR card is appended to
  // race by race across separate requests, so any per-call counter would
  // restart and read as a gap on a perfectly intact trace.
  //
  // Completeness is therefore checked against the DATABASE instead of against
  // a number the writer reported about itself - which is the stronger test,
  // and the one that actually answers the question the marker exists for:
  // is every ticket that is on file also in the log? `card_generated` is the
  // card's own opening event, so its absence means the trace is gone entirely.
  const added = traceEvents.filter((e) => e.event === 'ticket_added').length;
  const opened = traceEvents.some((e) => e.event === 'card_generated');
  const traceStatus = (!opened && added === 0) ? 'missing'
    : (opened && added >= tickets.length) ? 'complete'
      : 'partial';

  return {
    export: {
      schema: 'betsheet.card-trace-export',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      docs: 'docs/trace-schema.md',
    },
    card: {
      id: card.id,
      cardNumber: card.card_number,
      variant: card.variant,
      template: card.template,
      bankrollCents: card.bankroll_cents,
      perRaceMinCents: card.per_race_min_cents,
      consensusCompleteness: card.consensus_completeness,
      engineVersion: card.engine_version,
      llmModel: card.llm_model,
      correlationId: card.correlation_id,
      createdAt: card.created_at,
    },
    raceDay: { id: card.race_day_id, track: card.track, date: card.date },
    sources,
    races,
    consensus,
    allocations,
    tickets,
    gradeSummary,
    results: { finishers: results, exotics, scratches: resultScratches },
    llmInputs: omitLlmInputs ? redactLlmInputs(buildLlmInputs(db, card)) : buildLlmInputs(db, card),
    traceStatus,
    trace: traceEvents,
  };
}

exportRouter.get('/cards/:id/export', (req, res) => {
  const db = getDb();
  const omitLlmInputs = ['1', 'true'].includes(String(req.query.omitLlmInputs ?? '').toLowerCase());
  const out = buildCardExport(db, Number(req.params.id), { omitLlmInputs });
  if (out.error) return res.status(out.status).json({ error: out.error });
  const name = `betsheet-${out.raceDay.track.replace(/\W+/g, '-').toLowerCase()}-${out.raceDay.date}-card${out.card.cardNumber}.json`;
  log.info('card_exported', {
    correlationId: out.card.correlationId,
    cardId: out.card.id,
    traceEvents: out.trace.length,
    graded: out.gradeSummary != null,
  });
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.json(out);
});
