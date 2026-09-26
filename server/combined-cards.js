// COMBINED cards (D436): a WPS parlay whose legs the combined per-race model
// chose, saved as a first-class card - same tables, same grader as every
// other producer - in its own bucket, `consensus_completeness = 'COMBINED'`,
// `engine_version = COMBINED_VERSION` (invariants 13 and 14).
//
// PREVIEW-FIRST (invariant 9). `/combined-cards/preview` writes nothing and
// returns candidates under BOTH selections - legs chosen by the combined model
// and legs chosen by the market alone - because the D434 backtest found the
// market at least as good, and hiding it would show only the flattering half.
// The save endpoint does NOT trust a ticket from the client: it rebuilds the
// candidates from the stored day with the same options and saves only a
// candidate that is still among them. A day whose inputs changed in between
// (a tip sheet added, a board typed) answers 409 and asks for a re-preview,
// rather than saving a parlay the preview never showed.
//
// ONE CARD PER SAVED PARLAY, ONE TICKET PER CARD. `race_id` is NULL on the
// ticket (the schema's multi-race convention) and `selections` carries
// `{races, legs}`; no `allocations` row is written, because an allocation is a
// per-race amount and a parlay's one stake belongs to no single race. Saving a
// second parlay on the same day mints a second card (append-only, D28).
//
// THE TRACE IS THE REASONING (invariant 7). `ticket_added` carries every leg's
// combined and market probability, its estimate band and the source votes
// that moved it, so "the builder chose #4 in race 3 because two tip sheets and
// OTR backed it" replays from the log alone. `card_generated` carries the
// weights and every option the build ran with.

import express from 'express';
import { combineRace, DEFAULT_WEIGHTS, MARKET_ONLY_WEIGHTS } from '../shared/race-consensus.js';
import { buildWpsParlays, buildPoolTickets, POOL_TYPES, CALIBRATION_NOTE } from '../shared/parlay-builder.js';
import { morningLineToDecimal } from '../shared/betmath.js';
import { COMBINED_VERSION } from '../shared/version.js';
import { getDb } from './db.js';
import { gradeAndPersist } from './grading.js';
import { templateIdFor } from './templates.js';
import { loadDaySignals } from './race-consensus.js';
import { getLogger, newCorrelationId } from './logging.js';

const traceLog = getLogger('decision-trace');
const appLog = getLogger('app');

export const combinedCardsRouter = express.Router();

class CombinedCardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const up = (p) => String(p).trim().toUpperCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The build options, from a request body, with the builder's defaults.
 * D442: `mode` is 'wps' (the default - D436's WPS parlays) or 'pool'
 * (Daily Double / Pick 3-5), which reads `pools` and `budgetCents` instead of
 * `kinds` / legs / `stakeCents`. Only the fields of the chosen mode are
 * returned, so the options echoed in the preview and traced on save are
 * exactly the ones the build ran with.
 */
export function readOptions(body = {}) {
  const int = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  const floor = body.payoutFloor === undefined || body.payoutFloor === null || body.payoutFloor === '' ? null : Number(body.payoutFloor);
  const limit = Math.min(20, Math.max(1, int(body.limit, 5)));
  if (body.mode === 'pool') {
    return {
      mode: 'pool',
      pools: Array.isArray(body.pools) && body.pools.length ? body.pools.map(String) : [...POOL_TYPES],
      budgetCents: int(body.budgetCents, 1200),
      payoutFloor: floor,
      limit,
    };
  }
  const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds.map(String) : ['win', 'place', 'show'];
  return {
    mode: 'wps',
    kinds,
    legsMin: int(body.legsMin, 2),
    legsMax: int(body.legsMax, 3),
    payoutFloor: floor,
    stakeCents: int(body.stakeCents, 200),
    limit,
  };
}

/** Decimal odds a leg's payout estimate reads: the board on a live-basis race, else the morning line. */
function oddsReader(entries, basis) {
  const byPgm = new Map(entries.map((e) => [up(e.programNumber), e]));
  return (pgm) => {
    const e = byPgm.get(up(pgm));
    if (!e) return null;
    const ml = num(e.morningLineDecimal) ?? morningLineToDecimal(e.morningLine);
    const live = num(e.liveOddsDecimal) ?? morningLineToDecimal(e.liveOdds);
    return basis === 'live' ? (live ?? ml) : ml;
  };
}

/**
 * Everything a build needs for one day: per-race models under both weight
 * sets, the odds reader, and the stored program number for each upper-cased
 * one (the model upper-cases; a ticket must carry what the entries carry).
 */
function dayModels(db, dayId) {
  const sig = loadDaySignals(db, dayId);
  if (!sig) throw new CombinedCardError(404, 'No such race day.');
  const races = [];
  const storedPgm = new Map();
  const menus = new Map(db.prepare('SELECT number, wager_menu FROM races WHERE race_day_id = ?').all(dayId).map((r) => [r.number, r.wager_menu]));
  for (const [raceNumber, s] of [...sig.races].sort((a, b) => a[0] - b[0])) {
    if (!s.entries.length) continue;
    for (const e of s.entries) storedPgm.set(`${raceNumber}|${up(e.programNumber)}`, e.programNumber);
    const combined = combineRace({ entries: s.entries, tipRoles: s.tipRoles, llmRoles: s.llmRoles, otrRoles: s.otrRoles, weights: DEFAULT_WEIGHTS });
    const market = combineRace({ entries: s.entries, weights: MARKET_ONLY_WEIGHTS });
    races.push({
      raceNumber, combined, market, wagerMenu: menus.get(raceNumber) ?? null,
      oddsOf: oddsReader(s.entries, combined?.basis ?? 'ml'),
      summary: {
        race: raceNumber, basis: combined?.basis ?? null, modelled: Boolean(combined),
        tipSheets: s.tipSources, llmModels: s.llmModels, otr: s.otrRoles !== null,
      },
    });
  }
  return { sig, races, storedPgm };
}

function restorePgms(candidates, storedPgm) {
  return candidates.map((c) => {
    const legs = c.legs.map((leg, i) => leg.map((p) => storedPgm.get(`${c.raceNumbers[i]}|${up(p)}`) ?? p));
    // A WPS leg names one horse (`programNumber`); a pool leg several
    // (`programNumbers`, D442). Restore whichever the leg carries.
    return {
      ...c,
      legs,
      legDetail: c.legDetail.map((d, i) => (Array.isArray(d.programNumbers)
        ? { ...d, programNumbers: legs[i], horses: d.horses?.map((h, j) => ({ ...h, programNumber: legs[i][j] })) }
        : { ...d, programNumber: legs[i][0] })),
    };
  });
}

/** Both selections' candidates for a day. Throws CombinedCardError on bad options. */
export function previewCombinedParlays(db, dayId, options) {
  const { sig, races, storedPgm } = dayModels(db, dayId);
  const out = {};
  let skipped = [];
  for (const selection of ['combined', 'market']) {
    const built = options.mode === 'pool'
      ? buildPoolTickets({ races, ...options, selection })
      : buildWpsParlays({ races, ...options, selection });
    if (built.error) throw new CombinedCardError(400, built.error);
    out[selection] = restorePgms(built.candidates, storedPgm);
    if (selection === 'combined') skipped = built.skipped ?? built.skippedRaces ?? [];
  }
  return {
    raceDayId: sig.day.id,
    modelVersion: COMBINED_VERSION,
    weights: DEFAULT_WEIGHTS,
    calibration: CALIBRATION_NOTE,
    options,
    races: races.map((r) => r.summary),
    excluded: sig.excluded,
    skipped,
    resultsOnFile: Boolean(db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(dayId)),
    candidates: out,
  };
}

const candidateKey = (c) => `${c.betType}|${c.raceNumbers.join(',')}|${c.legs.map((l) => l.map(up).join('/')).join(',')}`;

/**
 * Save ONE candidate as a COMBINED card. `choice` = { selection, betType,
 * raceNumbers, legs } naming a candidate the preview showed; it is re-derived
 * here and refused (409) if it is no longer among the rebuilt candidates.
 */
export function persistCombinedParlay(db, day, { options, choice, name, correlationId }) {
  if (!choice || !Array.isArray(choice.raceNumbers) || !Array.isArray(choice.legs) || typeof choice.betType !== 'string') {
    throw new CombinedCardError(400, 'choice { selection, betType, raceNumbers, legs } is required.');
  }
  const selection = choice.selection === 'market' ? 'market' : 'combined';
  const preview = previewCombinedParlays(db, day.id, options);
  const wanted = candidateKey({ betType: choice.betType, raceNumbers: choice.raceNumbers.map(Number), legs: choice.legs });
  const ticket = preview.candidates[selection].find((c) => candidateKey(c) === wanted);
  if (!ticket) {
    throw new CombinedCardError(409, 'That parlay is no longer among the candidates for this day - its inputs changed since the preview. Preview again.');
  }

  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : null;
  const variant = `${selection}-legs`;
  const rationale = `P(hit) ${(ticket.pHit * 100).toFixed(1)}% by the ${selection} model`
    + ` (combined ${ticket.combinedPHit === null ? '-' : `${(ticket.combinedPHit * 100).toFixed(1)}%`},`
    + ` market ${ticket.marketPHit === null ? '-' : `${(ticket.marketPHit * 100).toFixed(1)}%`}) - ${CALIBRATION_NOTE}`;

  const card = db.transaction(() => {
    const cardNumber = db.prepare('SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?').get(day.id).n;
    const cardId = db.prepare(`INSERT INTO cards
        (race_day_id, card_number, variant, strategy_template_id, bankroll_cents, per_race_min_cents,
         status, correlation_id, consensus_completeness, engine_version, name)
        VALUES (?, ?, ?, ?, ?, ?, 'final', ?, 'COMBINED', ?, ?)`)
      .run(day.id, cardNumber, variant, templateIdFor(db, 'combined'), ticket.costCents,
        day.per_race_min_cents ?? null, correlationId, COMBINED_VERSION, trimmedName).lastInsertRowid;
    db.prepare(`INSERT INTO tickets
        (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
         est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rationale, rule_tags)
        VALUES (?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cardId, ticket.betType, JSON.stringify({ races: ticket.raceNumbers, legs: ticket.legs }),
        ticket.stakeCents, ticket.costCents, ticket.estMinCents, ticket.estMaxCents, ticket.estIsRange ? 1 : 0,
        ticket.tellerCall, rationale, JSON.stringify(['combined', ticket.kind, `${selection}-legs`]));
    return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  })();

  traceLog.info('card_generated', {
    correlationId, cardId: card.id, raceDayId: day.id, engineVersion: COMBINED_VERSION, template: 'combined',
    name: card.name ?? null, variant, weights: preview.weights, options, resultsOnFile: preview.resultsOnFile,
    excluded: preview.excluded,
  });
  traceLog.info('ticket_added', {
    correlationId, cardId: card.id, raceDayId: day.id, race: null, races: ticket.raceNumbers,
    betType: ticket.betType, selections: ticket.legs, stakeCents: ticket.stakeCents, costCents: ticket.costCents,
    selection, pHit: ticket.pHit, combinedPHit: ticket.combinedPHit, marketPHit: ticket.marketPHit,
    estMinCents: ticket.estMinCents, estMaxCents: ticket.estMaxCents, calibration: CALIBRATION_NOTE,
    legs: ticket.legDetail, rationaleText: rationale,
  });
  appLog.info('combined_card_saved', {
    correlationId, cardId: card.id, raceDayId: day.id, betType: ticket.betType, races: ticket.raceNumbers,
    costCents: ticket.costCents,
  });

  let graded = null;
  if (preview.resultsOnFile) graded = gradeAndPersist(db, card.id, correlationId, { engineVersion: COMBINED_VERSION });
  return { cardId: card.id, cardNumber: card.card_number, correlationId, ticket, graded };
}

function liveDay(db, id, res) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  if (!day) { res.status(404).json({ error: 'No such race day.' }); return null; }
  if (day.deleted_at) { res.status(410).json({ error: 'This race day is deleted. Restore it before building a parlay.' }); return null; }
  return day;
}

combinedCardsRouter.post('/race-days/:id/combined-cards/preview', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = liveDay(db, Number(req.params.id), res);
  if (!day) return undefined;
  try {
    return res.json({ correlationId, ...previewCombinedParlays(db, day.id, readOptions(req.body)) });
  } catch (err) {
    if (err instanceof CombinedCardError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

combinedCardsRouter.post('/race-days/:id/combined-cards', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = liveDay(db, Number(req.params.id), res);
  if (!day) return undefined;
  try {
    const result = persistCombinedParlay(db, day, {
      options: readOptions(req.body), choice: req.body?.choice, name: req.body?.name, correlationId,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof CombinedCardError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
