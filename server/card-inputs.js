// What one card actually had in front of it (D439) - the card sheet footer's
// "Sources used", which shared/card-sources.js renders.
//
// Before this the footer read only `fetch_attempts`, the pre-pivot consensus
// audit nothing writes any more, so every post-pivot card claimed "program
// analysis and morning lines only". Each producer records its inputs
// differently, so this reads each one from where it is actually recorded:
//
//   HUMAN          - the person's own picks. Nothing else is recorded, so
//                    nothing else is claimed.
//   LLM_GENERATED  - the model, the entries/morning lines every prompt carries,
//                    and the card's own recorded flags (`notes_present`,
//                    `live_odds_present`, `tip_sheets_present`). Note sources
//                    and tip-sheet names come from the per-race request rows
//                    that set those flags.
//   EQB_OTR        - the printed OTR sheet, verbatim.
//   TIPSHEET       - the one sheet it staked (`tip_source_label`).
//   COMBINED       - no column records its inputs, so they are re-derived
//                    with loadDaySignals AS OF the card's `created_at` over the
//                    parlay's own races. The save refuses a day whose inputs
//                    changed since the preview, so what was on file at the
//                    save is what the model read; `asOf` can only under-count.
//                    A `market-legs` card read the market alone and says so.
//
// Engine-era buckets return null: their legacy `fetch_attempts` rows are
// already the truth, and shared/card-sources.js keeps rendering those.

import { KNOWN_MODELS } from './anthropic-client.js';
import { loadDaySignals } from './race-consensus.js';
import { ENGINE_BUCKETS } from '../shared/card-sources.js';

const modelLabel = (id) => (id ? KNOWN_MODELS.find((m) => m.id === id)?.label ?? id : null);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const list = (xs) => xs.join(' + ');

function llmInputs(db, card) {
  const used = [`LLM (${modelLabel(card.llm_model) ?? 'model not recorded'})`, 'entries and morning lines'];
  if (card.notes_present) {
    const labels = uniq(db.prepare(`
      SELECT DISTINCT notes_source_label FROM llm_card_requests
       WHERE card_id = ? AND notes_present = 1 ORDER BY notes_source_label`).all(card.id)
      .map((r) => r.notes_source_label));
    used.push(labels.length ? `analyst notes (${list(labels)})` : 'analyst notes');
  }
  if (card.live_odds_present) used.push('live board');
  if (card.tip_sheets_present) {
    // The sheets on file for a race when that race's prompt was built - a
    // sheet re-extracted later carries a later created_at and drops out,
    // which under-names rather than over-names.
    const names = uniq(db.prepare(`
      SELECT DISTINCT tp.source_label FROM llm_card_requests q
        JOIN tip_picks tp ON tp.race_day_id = q.race_day_id AND tp.race_no = q.race_number
       WHERE q.card_id = ? AND q.tip_sheets_present = 1
         AND julianday(tp.created_at) <= julianday(q.requested_at)
       ORDER BY tp.source_label`).all(card.id).map((r) => r.source_label));
    used.push(names.length ? `tip sheets (${list(names)})` : 'tip sheets');
  }
  return { used, note: null };
}

function parlayRaces(card) {
  const races = new Set();
  for (const t of card.tickets ?? []) {
    for (const n of t.selections?.races ?? []) races.add(Number(n));
  }
  return races;
}

function combinedInputs(db, card) {
  const races = parlayRaces(card);
  const used = ['morning lines'];
  const liveRaces = db.prepare(`
    SELECT oce.race_number FROM odds_capture_entries oce
      JOIN odds_captures oc ON oc.id = oce.capture_id
     WHERE oc.race_day_id = ? AND julianday(oc.ingested_at) <= julianday(?)
     GROUP BY oce.race_number HAVING COUNT(DISTINCT oce.program_number) >= 2`)
    .all(card.race_day_id, card.created_at).map((r) => r.race_number);
  if (liveRaces.some((n) => races.has(n))) used.push('live board');
  if (card.variant === 'market-legs') {
    return { used, note: 'market-only selection: tip sheets, LLM cards and OTR were not read' };
  }
  const sig = loadDaySignals(db, card.race_day_id, { asOf: card.created_at });
  const tips = [];
  const models = [];
  let otr = false;
  for (const [n, s] of sig?.races ?? []) {
    if (!races.has(n)) continue;
    tips.push(...s.tipSources);
    models.push(...s.llmModels);
    otr = otr || s.otrRoles !== null;
  }
  const tipNames = uniq(tips).sort();
  const modelNames = uniq(models.map(modelLabel)).sort();
  if (tipNames.length) used.push(`tip sheets (${list(tipNames)})`);
  if (modelNames.length) used.push(`LLM cards (${list(modelNames)})`);
  if (otr) used.push('Equibase OTR');
  return { used, note: 'as on file when the card was saved' };
}

/** `{ used: string[], note }` for a card from getCardCore, or null for an engine-era card. */
export function getCardInputs(db, card) {
  const bucket = card.consensus_completeness;
  if (!bucket || ENGINE_BUCKETS.has(bucket)) return null;
  switch (bucket) {
    case 'HUMAN': return { used: ['hand-entered picks'], note: null };
    case 'LLM_GENERATED': return llmInputs(db, card);
    case 'EQB_OTR': return { used: ["Equibase 'Off to the Races' sheet"], note: null };
    case 'TIPSHEET': return { used: [`tip sheet (${card.tip_source_label ?? 'source not recorded'})`], note: null };
    case 'COMBINED': return combinedInputs(db, card);
    default: return { used: [], note: `no input record for the ${bucket} bucket` };
  }
}
