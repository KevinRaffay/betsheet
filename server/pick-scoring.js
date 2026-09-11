// Pick-source scoring API (D221, PS-2 of docs/requirements/pick-source-scoring.md).
//
// READ-ONLY: writes nothing, grades no ticket, touches no card. Reads every
// source's picks - OTR, LLM (per model), HUMAN from `tickets`; tip sheets from
// `tip_picks` - against `race_results`/`result_scratches` through
// shared/pick-scoring.js, and reports per SOURCE how often the horses it
// backed actually won, placed, showed, beside the morning-line favorite's own
// record on the same races. No money, no grade set, no engine_version.
//
// THE UNIT IS (race day, race number, source), NEVER A CARD. OTR writes three
// variant cards per day carrying the same picks and a staked tip sheet writes
// three more; scoring per card would triple the denominator - the trap D175
// fixed in the TIPSHEET P/L total. The dedupe lives HERE, in the query layer,
// because it is about how this codebase stores cards, not about scoring:
//   * EQB_OTR  - the UNION of tickets across every OTR card on the day for
//                that race (the variants are subsets of one printed sheet, so
//                the union is the sheet; a repeated ticket changes no role).
//   * LLM      - the NEWEST card (highest id) per (day, model, race) - a
//                regeneration under D28 appends a new card, and the newest is
//                the one a later action reuses (D174's own rule for tip cards).
//   * HUMAN    - the newest card per (day, race), for the same reason.
//   * tip sheets - the `tip_picks` row itself, ALWAYS; a TIPSHEET card is never
//                read here (it flattens the ranks and exists only on staked
//                days).
//
// LLM ROWS CARRY AN INPUTS LABEL (otr / tipsheet / both / none), derived from
// the stored prompt text (D149 keeps it verbatim): D179 feeds the day's OTR
// tickets and tip-sheet ranks into the prompt, so an LLM's agreement with OTR
// on those races is partly by construction. The label is part of the GROUP
// KEY - there is no by-model total that pools labels (scope doc, decision 6).
//
// Two invariants ride on the queries below:
//   * INVARIANT 12 - every query joins race_days and filters
//     `deleted_at IS NULL`, the same as every P/L and distribution query.
//   * INVARIANT 13 - sources are never pooled. `bySource` is the only total
//     produced, and it groups by (source, inputs).

import express from 'express';
import { getDb } from './db.js';
import { rolesFromTickets, rolesFromTipPicks, scorePickRace, bySource } from '../shared/pick-scoring.js';

export const pickScoringRouter = express.Router();

const TICKET_BUCKETS = ['EQB_OTR', 'LLM_GENERATED', 'HUMAN'];
const OTR_PROMPT_LINE = 'Equibase Off to the Races (';
const BASELINE_HEADER = 'BASELINE PICKS';

/**
 * Which baseline inputs a stored LLM prompt carried: 'otr', 'tipsheet',
 * 'both' or 'none'. Reads the BASELINE PICKS block server/llm-prompt.js
 * emits (D179): the OTR line is the one sentence that names the sheet; every
 * other non-blank line in the block is a tip sheet's ranked picks. A prompt
 * from before D179 has no block and is 'none', which is correct - it saw
 * neither.
 */
export function llmInputsLabel(promptText) {
  if (typeof promptText !== 'string') return 'none';
  const at = promptText.indexOf(BASELINE_HEADER);
  if (at < 0) return 'none';
  const block = promptText.slice(at + BASELINE_HEADER.length).split(/\r?\n\r?\n/)[0];
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const otr = lines.some((l) => l.startsWith(OTR_PROMPT_LINE));
  const tip = lines.some((l) => !l.startsWith(OTR_PROMPT_LINE));
  if (otr && tip) return 'both';
  if (otr) return 'otr';
  if (tip) return 'tipsheet';
  return 'none';
}

const key = (dayId, raceNo) => `${dayId}|${raceNo}`;

/** finishers / scratched / entries per (day, race), one query each. */
function raceContext(db) {
  const finishers = new Map();
  for (const r of db.prepare(`
    SELECT r.race_day_id, r.race_number, r.program_number, r.finish_position,
           r.post_time_odds, r.favorite
      FROM race_results r JOIN race_days d ON d.id = r.race_day_id
     WHERE d.deleted_at IS NULL`).all()) {
    const k = key(r.race_day_id, r.race_number);
    if (!finishers.has(k)) finishers.set(k, []);
    // D229: the closing price rides along. NULL on every row of an
    // Apify-sourced day, which `impliedProbabilities` turns into a NULL market
    // block rather than a zero - a board that was never read is not a board
    // the source beat or lost to.
    finishers.get(k).push({
      programNumber: r.program_number, finishPosition: r.finish_position,
      postTimeOdds: r.post_time_odds, favorite: Boolean(r.favorite),
    });
  }
  const scratched = new Map();
  for (const r of db.prepare(`
    SELECT s.race_day_id, s.race_number, s.program_number
      FROM result_scratches s JOIN race_days d ON d.id = s.race_day_id
     WHERE d.deleted_at IS NULL AND s.program_number IS NOT NULL`).all()) {
    const k = key(r.race_day_id, r.race_number);
    if (!scratched.has(k)) scratched.set(k, []);
    scratched.get(k).push(r.program_number);
  }
  const entries = new Map();
  for (const r of db.prepare(`
    SELECT ra.race_day_id, ra.number AS race_number, e.program_number, e.morning_line_decimal, e.scratched
      FROM entries e JOIN races ra ON ra.id = e.race_id JOIN race_days d ON d.id = ra.race_day_id
     WHERE d.deleted_at IS NULL AND e.program_number IS NOT NULL`).all()) {
    const k = key(r.race_day_id, r.race_number);
    if (!entries.has(k)) entries.set(k, []);
    entries.get(k).push({
      programNumber: r.program_number,
      morningLineDecimal: typeof r.morning_line_decimal === 'number' ? r.morning_line_decimal : null,
      scratched: Boolean(r.scratched),
    });
  }
  return { finishers, scratched, entries };
}

/** Non-deleted days, keyed by id. */
function days(db) {
  return new Map(db.prepare(
    'SELECT id, date, track, track_code, meet FROM race_days WHERE deleted_at IS NULL',
  ).all().map((d) => [d.id, d]));
}

/**
 * Ticket-backed sources, deduped to one role set per (day, race, source).
 * Returns [{ raceDayId, raceNo, bucket, source, cardIds, roles }].
 */
function ticketRows(db) {
  const rows = db.prepare(`
    SELECT c.id AS card_id, c.race_day_id, c.consensus_completeness AS bucket, c.llm_model,
           ra.number AS race_number, t.bet_type, t.selections, t.stake_cents, t.sequence,
           -- D234: did THIS race's generation on THIS card carry the tote
           -- board. Per race, from the request row, because the card-level
           -- flag latches: a card with a board on race 3 and none on race 4
           -- is 1 at the card level and would mislabel race 4.
           (SELECT q.live_odds_present FROM llm_card_requests q
             WHERE q.card_id = c.id AND q.race_number = ra.number
             ORDER BY q.id DESC LIMIT 1) AS saw_board
      FROM tickets t
      JOIN cards c ON c.id = t.card_id
      JOIN races ra ON ra.id = t.race_id
      JOIN race_days d ON d.id = c.race_day_id
     WHERE d.deleted_at IS NULL
       AND c.consensus_completeness IN (${TICKET_BUCKETS.map(() => '?').join(',')})
     ORDER BY c.id, t.sequence`).all(...TICKET_BUCKETS);

  // group -> { cards: Map(cardId -> tickets[]) }
  const groups = new Map();
  for (const r of rows) {
    const source = r.bucket === 'LLM_GENERATED' ? (r.llm_model ?? 'llm:unknown-model') : r.bucket;
    // D234: THE BOARD IS PART OF THE DEDUPE KEY, not just the label.
    //
    // "Newest card per (day, model, race)" was right while a second card on a
    // race could only be a REGENERATION - the same experiment run again, where
    // the newest is the one that counts (D28's append-only rule). D233 changed
    // that: a second card may now be a DIFFERENT experiment, the same race
    // generated with the tote board in the prompt. Keeping the old key would
    // silently discard the morning card and report the post-time one as though
    // it were the only card there ever was - which is worse than pooling them,
    // because pooling at least shows both.
    const sawBoard = r.bucket === 'LLM_GENERATED' && Boolean(r.saw_board);
    const gk = `${r.race_day_id}|${r.race_number}|${source}|${sawBoard ? 'board' : 'ml'}`;
    if (!groups.has(gk)) groups.set(gk, { raceDayId: r.race_day_id, raceNo: r.race_number, bucket: r.bucket, source, sawBoard, cards: new Map() });
    const g = groups.get(gk);
    if (!g.cards.has(r.card_id)) g.cards.set(r.card_id, []);
    let legs = [];
    try { legs = JSON.parse(r.selections)?.legs ?? []; } catch { legs = []; }
    g.cards.get(r.card_id).push({ betType: r.bet_type, legs, stakeCents: r.stake_cents, sequence: r.sequence });
  }

  const out = [];
  for (const g of groups.values()) {
    let cardIds;
    let tickets;
    if (g.bucket === 'EQB_OTR') {
      cardIds = [...g.cards.keys()].sort((a, b) => a - b);
      tickets = cardIds.flatMap((id) => g.cards.get(id));
    } else {
      const newest = Math.max(...g.cards.keys());
      cardIds = [newest];
      tickets = g.cards.get(newest);
    }
    out.push({ raceDayId: g.raceDayId, raceNo: g.raceNo, bucket: g.bucket, source: g.source, sawBoard: g.sawBoard, cardIds, roles: rolesFromTickets(tickets) });
  }
  return out;
}

/** The newest stored prompt per (card, race) -> its inputs label. */
function llmInputs(db, cardIds) {
  const labels = new Map();
  if (cardIds.length === 0) return labels;
  const rows = db.prepare(`
    SELECT card_id, race_number, prompt_text FROM llm_card_requests
     WHERE card_id IN (${cardIds.map(() => '?').join(',')})
     ORDER BY id`).all(...cardIds);
  for (const r of rows) labels.set(`${r.card_id}|${r.race_number}`, llmInputsLabel(r.prompt_text));   // last wins = newest
  return labels;
}

/** Tip sheets, straight from tip_picks - never from a TIPSHEET card. */
function tipRows(db) {
  return db.prepare(`
    SELECT t.race_day_id, t.race_no, t.source_label, t.picks
      FROM tip_picks t JOIN race_days d ON d.id = t.race_day_id
     WHERE d.deleted_at IS NULL`).all().map((r) => {
    let picks = [];
    try { picks = JSON.parse(r.picks); } catch { picks = []; }
    return { raceDayId: r.race_day_id, raceNo: r.race_no, bucket: 'TIPSHEET', source: r.source_label, cardIds: [], roles: rolesFromTipPicks(picks) };
  });
}

/**
 * Every (day, race, source) row across the corpus, scored. Pure given a db.
 * Exported for the check script and for any future per-day surface.
 */
export function scoredPickRows(db, { track = null, meet = null } = {}) {
  const dayMap = days(db);
  const ctx = raceContext(db);
  const ticket = ticketRows(db);
  const llmCards = [...new Set(ticket.filter((r) => r.bucket === 'LLM_GENERATED').flatMap((r) => r.cardIds))];
  const inputs = llmInputs(db, llmCards);

  return [...ticket, ...tipRows(db)]
    .map((r) => {
      const day = dayMap.get(r.raceDayId);
      if (!day) return null;
      const k = key(r.raceDayId, r.raceNo);
      const isLlm = r.bucket === 'LLM_GENERATED';
      const label = isLlm ? (inputs.get(`${r.cardIds[0]}|${r.raceNo}`) ?? 'none') : null;
      // Carried up from ticketRows, where it is already part of the dedupe key.
      const sawBoard = Boolean(r.sawBoard);
      const score = scorePickRace({
        roles: r.roles,
        finishers: ctx.finishers.get(k) ?? [],
        scratched: ctx.scratched.get(k) ?? [],
        entries: ctx.entries.get(k) ?? null,
      });
      return {
        raceDayId: r.raceDayId, date: day.date, track: day.track, trackCode: day.track_code, meet: day.meet,
        raceNo: r.raceNo, bucket: r.bucket, source: r.source, inputs: label, sawBoard, cardIds: r.cardIds,
        // The group key: source alone for every bucket but LLM, where the
        // inputs label (decision 6) and the board (D234) are both part of the
        // identity - never pooled.
        groupKey: label ? `${r.source} [${label}${sawBoard ? ' +board' : ''}]` : r.source,
        roles: r.roles,
        score,
      };
    })
    .filter(Boolean)
    .filter((r) => (track ? r.trackCode === track : true))
    .filter((r) => (meet ? r.meet === meet : true))
    .sort((a, b) => a.date.localeCompare(b.date) || a.raceDayId - b.raceDayId || a.raceNo - b.raceNo || a.groupKey.localeCompare(b.groupKey));
}

/**
 * GET /api/pick-scoring[?track=CODE&meet=]
 *
 * Per-(source, inputs) records across the corpus, NO pooled total, plus the
 * per-race rows every rate is derivable from by hand.
 */
pickScoringRouter.get('/pick-scoring', (req, res) => {
  const db = getDb();
  const track = typeof req.query.track === 'string' && req.query.track ? req.query.track.toUpperCase() : null;
  const meet = typeof req.query.meet === 'string' && req.query.meet ? req.query.meet : null;
  const rows = scoredPickRows(db, { track, meet });

  const meta = new Map();
  for (const r of rows) if (!meta.has(r.groupKey)) meta.set(r.groupKey, { bucket: r.bucket, source: r.source, inputs: r.inputs, sawBoard: r.sawBoard });
  const grouped = bySource(rows.map((r) => ({ source: r.groupKey, score: r.score })))
    .map(({ source: groupKey, ...agg }) => ({ groupKey, ...meta.get(groupKey), ...agg }));

  // Days that hold picks but no results at all - the list that actually moves
  // the numbers, reported so a reader knows what is missing rather than
  // reading a thin n as the whole story.
  const unscoredDays = new Map();
  for (const r of rows) {
    if (r.score !== null) continue;
    if (!unscoredDays.has(r.raceDayId)) unscoredDays.set(r.raceDayId, { raceDayId: r.raceDayId, date: r.date, track: r.track, trackCode: r.trackCode, rows: 0 });
    unscoredDays.get(r.raceDayId).rows += 1;
  }

  res.json({
    bySource: grouped,
    unscoredDays: [...unscoredDays.values()].sort((a, b) => a.date.localeCompare(b.date) || a.raceDayId - b.raceDayId),
    races: rows.map(({ score, roles, ...rest }) => ({
      ...rest,
      roles,
      scored: score !== null,
      primary: score?.primary ?? null,
      primaryWin: score?.primaryWin ?? null,
      primaryPlace: score?.primaryPlace ?? null,
      primaryShow: score?.primaryShow ?? null,
      anyWin: score?.anyWin ?? null,
      placeHit: score?.placeHit ?? null,
      showHit: score?.showHit ?? null,
      winBackedCount: score?.winBackedCount ?? null,
      namedTop3: score?.namedTop3 ?? null,
      top3Possible: score?.top3Possible ?? null,
      unknownPicks: score?.unknownPicks ?? [],
      winnerProgramNumber: score?.winnerProgramNumber ?? null,
      fieldSize: score?.fieldSize ?? null,
      favorite: score?.favorite ?? null,
      // D229: the per-race market read, so every aggregate closeEdge above is
      // re-derivable by hand from these rows - the same reason the favorite
      // and the winner are already here.
      market: score?.market ?? null,
    })),
  });
});
