// Loader for the combined per-race model (D434): every pre-race signal stored
// for one race day, reduced to the inputs shared/race-consensus.js takes.
//
// READ-ONLY: writes nothing, grades nothing, traces nothing. The dedupe rules
// are server/pick-scoring.js's (D221), for the same reasons, restated here
// because this loader must agree with them:
//   * tip sheets - the `tip_picks` row, one roles set per sheet.
//   * LLM        - the NEWEST card per (race, model): a regeneration appends a
//                  card (D28) and must never vote twice. The board/no-board
//                  split pick-scoring keeps is deliberately NOT kept here -
//                  that split is about measuring a source, and this model wants
//                  one opinion per model, the latest one it gave.
//   * EQB_OTR    - the UNION of tickets across the day's OTR cards (the three
//                  variants are subsets of one printed sheet).
//
// THE LEAKAGE RULE. A signal formed after the race's result was known must
// not count, or the backtest scores the future. The one stored input that can
// be is an LLM generation whose analyst notes were entered after the day's
// results (`llm_card_requests.notes_post_result`, D149) - that card's picks for
// that race are excluded and counted in `excluded.llmPostResult` so the report
// can say how many. Race results and the chart's post-time odds are never read
// here at all: they are the answer, and the backtest reads them separately.
//
// INVARIANT 12: every query joins race_days and filters `deleted_at IS NULL`.

import { rolesFromTickets, rolesFromTipPicks } from '../shared/pick-scoring.js';

const parseLegs = (json) => {
  try { return JSON.parse(json)?.legs ?? []; } catch { return []; }
};

/**
 * Signals for one day. Returns null for a missing or soft-deleted day,
 * otherwise `{ day, races: Map raceNumber -> { entries, tipRoles, llmRoles,
 * otrRoles, llmModels, tipSources }, excluded: { llmPostResult } }`.
 */
export function loadDaySignals(db, dayId) {
  const day = db.prepare('SELECT id, date, track, track_code, meet FROM race_days WHERE id = ? AND deleted_at IS NULL').get(dayId);
  if (!day) return null;

  const races = new Map();
  const raceAt = (n) => {
    if (!races.has(n)) races.set(n, { entries: [], tipRoles: [], llmRoles: [], otrRoles: null, llmModels: [], tipSources: [] });
    return races.get(n);
  };

  for (const e of db.prepare(`
    SELECT ra.number AS race_number, e.program_number, e.morning_line, e.morning_line_decimal,
           e.live_odds, e.live_odds_decimal, e.scratched
      FROM entries e JOIN races ra ON ra.id = e.race_id
     WHERE ra.race_day_id = ? AND e.program_number IS NOT NULL
     ORDER BY ra.number, e.id`).all(dayId)) {
    raceAt(e.race_number).entries.push({
      programNumber: e.program_number,
      morningLine: e.morning_line, morningLineDecimal: e.morning_line_decimal,
      liveOdds: e.live_odds, liveOddsDecimal: e.live_odds_decimal,
      scratched: Boolean(e.scratched),
    });
  }

  for (const t of db.prepare('SELECT race_no, source_label, picks FROM tip_picks WHERE race_day_id = ? ORDER BY id').all(dayId)) {
    let picks = [];
    try { picks = JSON.parse(t.picks); } catch { picks = []; }
    const r = raceAt(t.race_no);
    r.tipRoles.push(rolesFromTipPicks(picks));
    r.tipSources.push(t.source_label);
  }

  const ticketRows = db.prepare(`
    SELECT c.id AS card_id, c.consensus_completeness AS bucket, c.llm_model,
           ra.number AS race_number, t.bet_type, t.selections, t.stake_cents, t.sequence,
           (SELECT q.notes_post_result FROM llm_card_requests q
             WHERE q.card_id = c.id AND q.race_number = ra.number
             ORDER BY q.id DESC LIMIT 1) AS post_result
      FROM tickets t
      JOIN cards c ON c.id = t.card_id
      JOIN races ra ON ra.id = t.race_id
     WHERE c.race_day_id = ? AND c.consensus_completeness IN ('LLM_GENERATED', 'EQB_OTR')
     ORDER BY c.id, t.sequence`).all(dayId);

  const otr = new Map();       // race -> tickets[]
  const llm = new Map();       // `${race}|${model}` -> Map(cardId -> { postResult, tickets[] })
  for (const r of ticketRows) {
    const ticket = { betType: r.bet_type, legs: parseLegs(r.selections), stakeCents: r.stake_cents, sequence: r.sequence };
    if (r.bucket === 'EQB_OTR') {
      if (!otr.has(r.race_number)) otr.set(r.race_number, []);
      otr.get(r.race_number).push(ticket);
      continue;
    }
    const k = `${r.race_number}|${r.llm_model ?? 'llm:unknown-model'}`;
    if (!llm.has(k)) llm.set(k, new Map());
    const cards = llm.get(k);
    if (!cards.has(r.card_id)) cards.set(r.card_id, { postResult: Boolean(r.post_result), tickets: [] });
    cards.get(r.card_id).tickets.push(ticket);
  }

  for (const [raceNo, tickets] of otr) raceAt(raceNo).otrRoles = rolesFromTickets(tickets);

  let llmPostResult = 0;
  for (const [k, cards] of llm) {
    const [raceNo, model] = [Number(k.split('|')[0]), k.slice(k.indexOf('|') + 1)];
    // Newest card that is NOT post-result; a newer post-result card is
    // excluded rather than letting an older clean one silently stand in for
    // it without being counted.
    const ids = [...cards.keys()].sort((a, b) => b - a);
    const clean = ids.find((id) => !cards.get(id).postResult);
    llmPostResult += ids.filter((id) => cards.get(id).postResult).length;
    if (clean === undefined) continue;
    const r = raceAt(raceNo);
    r.llmRoles.push(rolesFromTickets(cards.get(clean).tickets));
    r.llmModels.push(model);
  }

  return { day, races, excluded: { llmPostResult } };
}

/** Non-deleted day ids that carry race results - the backtest's corpus. */
export function gradedDayIds(db) {
  return db.prepare(`
    SELECT d.id FROM race_days d
     WHERE d.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM race_results r WHERE r.race_day_id = d.id)
     ORDER BY d.date, d.id`).all().map((r) => r.id);
}
