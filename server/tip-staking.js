// TIPSHEET staking API (D171): turn stored tip picks into graded cards.
//
// Writes THREE cards per run, one per variant, in ONE transaction - the D71
// shape. Append-only: a second run mints three NEW cards rather than editing
// the old ones, so a card's grade is never rewritten under it (invariant 14's
// spirit, even though a TIPSHEET card has no version axis of its own).
//
// Bucket TIPSHEET, engine_version 'tipsheet' - never pooling with EQB_OTR,
// HUMAN, LLM_GENERATED or any lean-* version (invariant 13).

import express from 'express';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';
import { parseWagerMenu, estimateTicketPayouts } from '../shared/betmath.js';
import { stakeTipRace, TIP_VARIANTS, TIP_VARIANT_LABEL } from '../shared/tip-staking.js';
import { perRaceBankrollCents } from './llm-cards.js';

const traceLog = getLogger('decision-trace');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export const tipStakingRouter = express.Router();

class TipStakingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The day's races that actually carry tip picks, with everything staking needs. */
function stakeableRaces(db, dayId, sourceLabel) {
  const rows = db.prepare(`
    SELECT t.race_no, t.picks, t.source_label, r.id race_id, r.wager_menu
      FROM tip_picks t
      JOIN races r ON r.race_day_id = t.race_day_id AND r.number = t.race_no
     WHERE t.race_day_id = ? AND t.source_label = ?
     ORDER BY t.race_no
  `).all(dayId, sourceLabel);

  return rows.map((r) => {
    const entries = db.prepare(
      'SELECT program_number, morning_line, scratched FROM entries WHERE race_id = ?',
    ).all(r.race_id);
    const ml = new Map(entries.map((e) => [String(e.program_number).toUpperCase(), e.morning_line]));
    return {
      raceNo: r.race_no,
      raceId: r.race_id,
      picks: JSON.parse(r.picks),
      menu: parseWagerMenu(r.wager_menu),
      mlOf: (pgm) => ml.get(String(pgm).toUpperCase()) ?? null,
      scratched: entries.filter((e) => e.scratched).map((e) => String(e.program_number)),
    };
  });
}

/** Build every variant's tickets for a day, without writing anything. */
export function planTipCards(db, dayId, sourceLabel, bankrollCents) {
  const races = stakeableRaces(db, dayId, sourceLabel);
  if (races.length === 0) throw new TipStakingError(404, `No ${sourceLabel} tip picks on this race day.`);
  // D163's whole-dollar floor, reused rather than reimplemented: an even
  // division lands on figures like $14.33 that no legal wager can spend.
  const perRace = perRaceBankrollCents(bankrollCents, races.length);

  return TIP_VARIANTS.map((variant) => {
    const perRaceOut = [];
    let cost = 0;
    for (const race of races) {
      const { tickets, warnings } = stakeTipRace({
        picks: race.picks, variant, perRaceCents: perRace,
        mlOf: race.mlOf, menu: race.menu, scratched: race.scratched,
      });
      const priced = estimateTicketPayouts(tickets, race.mlOf);
      cost += priced.reduce((a, x) => a + x.costCents, 0);
      perRaceOut.push({ ...race, tickets: priced, warnings });
    }
    return { variant, label: TIP_VARIANT_LABEL[variant], perRace: perRaceOut, perRaceCents: perRace, costCents: cost };
  });
}

/** Write the three cards. Append-only, one transaction. */
export function persistTipCards(db, day, sourceLabel, bankrollCents, correlationId) {
  const plans = planTipCards(db, day.id, sourceLabel, bankrollCents);
  const templateId = db.prepare("SELECT id FROM strategy_templates WHERE name = 'tipsheet'").get()?.id ?? null;
  const ts = now();

  const write = db.transaction(() => {
    let cardNumber = db.prepare(
      'SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?',
    ).get(day.id).n;
    const made = [];

    for (const plan of plans) {
      const cardId = db.prepare(`INSERT INTO cards
          (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
           per_race_min_cents, status, correlation_id, consensus_completeness,
           created_at, engine_version, name)
          VALUES (?, ?, ?, ?, ?, NULL, 'final', ?, 'TIPSHEET', ?, 'tipsheet', ?)`)
        .run(day.id, cardNumber, plan.variant, templateId, bankrollCents,
          correlationId, ts, `${sourceLabel} — ${plan.label}`).lastInsertRowid;

      traceLog.info('card_generated', {
        correlationId, cardId, raceDayId: day.id, variant: plan.variant,
        bucket: 'TIPSHEET', engineVersion: 'tipsheet', sourceLabel,
        bankrollCents, perRaceCents: plan.perRaceCents,
      });

      let seq = 0;
      for (const race of plan.perRace) {
        if (!race.tickets.length) continue;
        let raceCost = 0;
        for (const t of race.tickets) {
          seq += 1;
          raceCost += t.costCents;
          // selections is {races, legs} - the shape server/grading.js reads
          // back (`sel.races`, `sel.legs`) and every stored ticket already has.
          db.prepare(`INSERT INTO tickets
              (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
               est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call,
               rationale, rule_tags, rationale_text)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(cardId, race.raceId, seq, t.betType,
              JSON.stringify({ races: [race.raceNo], legs: t.legs }),
              t.stakeCents, t.costCents, t.estMinCents ?? null,
              t.estMaxCents ?? null, t.estIsRange ? 1 : 0, t.tellerCall,
              t.rationale, JSON.stringify(['tipsheet', plan.variant]), t.rationale);
          traceLog.info('ticket_added', {
            correlationId, cardId, raceNumber: race.raceNo, betType: t.betType,
            stakeCents: t.stakeCents, costCents: t.costCents, tellerCall: t.tellerCall,
          });
        }
        db.prepare(`INSERT INTO allocations (card_id, race_id, amount_cents, confidence, rule, thesis)
                    VALUES (?, ?, ?, 'TIPSHEET', 'tipsheet_staking', NULL)`)
          .run(cardId, race.raceId, raceCost);
      }
      made.push({ cardId, variant: plan.variant, label: plan.label, costCents: plan.costCents });
      cardNumber += 1;
    }
    return made;
  });
  return { cards: write(), plans };
}

function loadDay(db, id) {
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(id);
  if (!day) throw new TipStakingError(404, 'Race day not found.');
  if (day.deleted_at) throw new TipStakingError(410, 'This race day is deleted.');
  return day;
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (err) {
    if (err instanceof TipStakingError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
};

/** PREVIEW the three variants. Writes nothing (invariant 9). */
tipStakingRouter.post('/race-days/:id/tip-cards/preview', wrap((req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  const source = String(req.body?.sourceLabel ?? '');
  if (!source) throw new TipStakingError(400, 'sourceLabel is required.');
  const bankroll = Number(req.body?.bankrollCents ?? day.bankroll_cents);
  if (!Number.isFinite(bankroll) || bankroll <= 0) throw new TipStakingError(400, 'bankrollCents must be positive.');

  const plans = planTipCards(db, day.id, source, bankroll);
  res.json({
    sourceLabel: source,
    bankrollCents: bankroll,
    variants: plans.map((p) => ({
      variant: p.variant, label: p.label, costCents: p.costCents, perRaceCents: p.perRaceCents,
      races: p.perRace.map((r) => ({
        raceNo: r.raceNo,
        tickets: r.tickets.map((t) => ({ betType: t.betType, tellerCall: t.tellerCall, costCents: t.costCents, estMinCents: t.estMinCents ?? null, estMaxCents: t.estMaxCents ?? null, rationale: t.rationale })),
        warnings: r.warnings,
      })),
    })),
  });
}));

/** SAVE the three cards. Append-only. */
tipStakingRouter.post('/race-days/:id/tip-cards', wrap((req, res) => {
  const db = getDb();
  const day = loadDay(db, req.params.id);
  const source = String(req.body?.sourceLabel ?? '');
  if (!source) throw new TipStakingError(400, 'sourceLabel is required.');
  const bankroll = Number(req.body?.bankrollCents ?? day.bankroll_cents);
  if (!Number.isFinite(bankroll) || bankroll <= 0) throw new TipStakingError(400, 'bankrollCents must be positive.');

  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const { cards } = persistTipCards(db, day, source, bankroll, correlationId);
  res.status(201).json({ cards, correlationId });
}));
