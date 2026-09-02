// P/L reporting: graded tickets rolled up per card, per day and per race.
//
// Invariant 13 rules this file: every aggregate is bucketed by the card's
// consensus_completeness and NO endpoint emits a pooled all-bucket total -
// a program-only backfill card and a full-consensus card never share a
// number. Invariant 12 rules the joins: soft-deleted race days are
// excluded from every aggregate here.

import express from 'express';
import { getDb } from './db.js';

export const plRouter = express.Router();

const BUCKET_ORDER = ['FULL', 'PARTIAL', 'PROGRAM_ONLY'];

// The running view: per-bucket totals + every graded card as a row, plus
// the cards still waiting on results. Deliberately NO overall total.
// Engine versions (D34, invariant 14) never pool either: the buckets are
// built from ONE engine version - ?engineVersion=<v>, default the version
// of the most recently generated graded card - unless the caller asks for
// ?engineVersion=all. Every card row still carries its own version.
plRouter.get('/pl', (req, res) => {
  const db = getDb();

  const cardRows = db.prepare(`
    SELECT c.id AS cardId, c.race_day_id AS raceDayId, rd.track, rd.date,
           c.card_number AS cardNumber, c.variant, st.name AS template,
           c.consensus_completeness AS completeness, c.bankroll_cents AS bankrollCents,
           c.engine_version AS engineVersion,
           SUM(t.cost_cents) AS costCents,
           SUM(gt.returned_cents) AS returnedCents,
           SUM(gt.pl_cents) AS plCents,
           SUM(CASE WHEN gt.outcome = 'win' THEN 1 ELSE 0 END) AS wins,
           COUNT(gt.ticket_id) AS tickets
    FROM graded_tickets_latest gt
    JOIN tickets t ON t.id = gt.ticket_id
    JOIN cards c ON c.id = t.card_id
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    JOIN race_days rd ON rd.id = c.race_day_id
    WHERE rd.deleted_at IS NULL
    GROUP BY c.id
    ORDER BY rd.date DESC, rd.track, c.card_number DESC
  `).all();

  // Versions present among graded cards, newest card first.
  const engineVersions = [];
  for (const row of [...cardRows].sort((a, b) => b.cardId - a.cardId)) {
    if (!engineVersions.includes(row.engineVersion)) engineVersions.push(row.engineVersion);
  }
  const requested = String(req.query.engineVersion ?? '').trim();
  const selectedVersion = requested === 'all' ? 'all'
    : requested && engineVersions.includes(requested) ? requested
      : (engineVersions[0] ?? null);
  const inSelection = (row) => selectedVersion === 'all' || row.engineVersion === selectedVersion;

  const byBucket = new Map();
  for (const row of cardRows) {
    if (!inSelection(row)) continue;
    if (!byBucket.has(row.completeness)) {
      byBucket.set(row.completeness, {
        completeness: row.completeness, cards: 0, tickets: 0,
        costCents: 0, returnedCents: 0, plCents: 0,
      });
    }
    const b = byBucket.get(row.completeness);
    b.cards++;
    b.tickets += row.tickets;
    b.costCents += row.costCents;
    b.returnedCents += row.returnedCents;
    b.plCents += row.plCents;
  }
  const buckets = BUCKET_ORDER.filter((k) => byBucket.has(k)).map((k) => byBucket.get(k));

  const ungraded = db.prepare(`
    SELECT c.id AS cardId, c.race_day_id AS raceDayId, rd.track, rd.date,
           c.card_number AS cardNumber, c.variant, c.engine_version AS engineVersion,
           c.consensus_completeness AS completeness,
           COALESCE(SUM(t.cost_cents), 0) AS costCents
    FROM cards c
    JOIN race_days rd ON rd.id = c.race_day_id
    LEFT JOIN tickets t ON t.card_id = c.id
    WHERE rd.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM graded_tickets_latest gt
        JOIN tickets tt ON tt.id = gt.ticket_id
        WHERE tt.card_id = c.id
      )
    GROUP BY c.id
    ORDER BY rd.date DESC, rd.track, c.card_number DESC
  `).all();

  res.json({ buckets, cards: cardRows, ungraded, engineVersions, selectedVersion });
});

// One day's cards side by side, broken down per race - the variant-compare
// view. Multi-race tickets settle across races and report under 'multi'.
plRouter.get('/race-days/:id/pl', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) {
    return res.status(410).json({ error: 'This race day is deleted; deleted days are excluded from P/L.' });
  }

  const cards = db.prepare(`
    SELECT c.id, c.card_number, c.variant, st.name AS template, c.bankroll_cents,
           c.consensus_completeness, c.engine_version, c.created_at
    FROM cards c
    LEFT JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.race_day_id = ? ORDER BY c.card_number
  `).all(day.id);

  const rows = db.prepare(`
    SELECT t.card_id, r.number AS race_number,
           t.cost_cents, gt.returned_cents, gt.pl_cents, gt.outcome
    FROM graded_tickets_latest gt
    JOIN tickets t ON t.id = gt.ticket_id
    LEFT JOIN races r ON r.id = t.race_id
    WHERE t.card_id IN (SELECT id FROM cards WHERE race_day_id = ?)
  `).all(day.id);

  const perCard = new Map();
  for (const row of rows) {
    if (!perCard.has(row.card_id)) perCard.set(row.card_id, new Map());
    const races = perCard.get(row.card_id);
    const label = row.race_number ?? 'multi';
    if (!races.has(label)) {
      races.set(label, { race: label, costCents: 0, returnedCents: 0, plCents: 0, wins: 0, tickets: 0 });
    }
    const cell = races.get(label);
    cell.costCents += row.cost_cents;
    cell.returnedCents += row.returned_cents;
    cell.plCents += row.pl_cents;
    cell.tickets++;
    if (row.outcome === 'win') cell.wins++;
  }

  const raceLabel = (v) => (v === 'multi' ? Infinity : v);
  const out = cards.map((c) => {
    const races = perCard.get(c.id);
    const perRace = races
      ? [...races.values()].sort((a, b) => raceLabel(a.race) - raceLabel(b.race))
      : [];
    const sum = (k) => perRace.reduce((a, x) => a + x[k], 0);
    return {
      cardId: c.id, cardNumber: c.card_number, variant: c.variant, template: c.template,
      bankrollCents: c.bankroll_cents, completeness: c.consensus_completeness,
      engineVersion: c.engine_version, createdAt: c.created_at, graded: perRace.length > 0, perRace,
      costCents: sum('costCents'), returnedCents: sum('returnedCents'), plCents: sum('plCents'),
    };
  });

  res.json({ raceDayId: day.id, track: day.track, date: day.date, cards: out });
});
