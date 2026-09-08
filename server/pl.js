// P/L reporting: graded tickets rolled up per card, per day and per race.
//
// Invariant 13 rules this file: every aggregate is bucketed by the card's
// consensus_completeness and NO endpoint emits a pooled all-bucket total -
// a program-only backfill card and a full-consensus card never share a
// number. Invariant 12 rules the joins: soft-deleted race days are
// excluded from every aggregate here.

import express from 'express';
import { getDb } from './db.js';
import { KNOWN_MODELS } from './anthropic-client.js';

export const plRouter = express.Router();

// KNOWN_MODELS, not SELECTABLE_MODELS: a retired model's existing cards are
// still graded and still shown, and must keep their label rather than
// degrading to a raw id the moment the picker stops offering them.
const MODEL_LABEL = Object.fromEntries(KNOWN_MODELS.map((m) => [m.id, m.label]));

// D171: imported, not redeclared - see shared/distribution.js for why.
import { BUCKET_ORDER } from '../shared/distribution.js';

// The running view: per-bucket totals + every graded card as a row, plus
// the cards still waiting on results. Deliberately NO overall total.
// Engine versions (D34, invariant 14) never pool either: the buckets are
// built from ONE engine version - ?engineVersion=<v>, default the version
// of the most recently generated graded card - unless the caller asks for
// ?engineVersion=all. Every card row still carries its own version.
plRouter.get('/pl', (req, res) => {
  const db = getDb();

  const cardRows = db.prepare(`
    SELECT c.id AS cardId, c.race_day_id AS raceDayId, rd.track, rd.date, rd.meet,
           c.card_number AS cardNumber, c.variant, st.name AS template,
           c.consensus_completeness AS completeness, c.bankroll_cents AS bankrollCents,
           c.engine_version AS engineVersion, c.llm_model AS llmModel, c.notes_present AS notesPresent,
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
  // Meets (D43): ?meet=<DMR-2026-summer> narrows every figure to one meet;
  // default 'all' (meets may pool - completeness buckets never do).
  const meets = [...new Set(cardRows.map((r) => r.meet).filter(Boolean))].sort();
  const requestedMeet = String(req.query.meet ?? '').trim();
  const selectedMeet = requestedMeet && meets.includes(requestedMeet) ? requestedMeet : 'all';
  const inSelection = (row) => (selectedVersion === 'all' || row.engineVersion === selectedVersion) && (selectedMeet === 'all' || row.meet === selectedMeet);

  const byBucket = new Map();
  // D76: within LLM_GENERATED, a further split by which Claude model
  // generated the card - the whole point of recording it (cards.llm_model,
  // frozen at creation, D76) is comparing models against each other, which
  // a single bucket total can't show. Never pools with the bucket total's
  // own math, just a breakdown of the same rows.
  const byModel = new Map();
  // D94: the same rows again, grouped by whether the card used analyst notes -
  // a breakdown, never a second pool, exactly like byModel above. NOTE the flag
  // LATCHES (D92): it means "at least one race on this card used notes", never
  // "every race did". Deliberately NOT cross-tabbed with model - with a handful
  // of cards each cell would be a pool of one.
  const byNotes = new Map();
  for (const row of cardRows) {
    if (!inSelection(row)) continue;
    if (!byBucket.has(row.completeness)) {
      byBucket.set(row.completeness, {
        completeness: row.completeness, cards: 0, tickets: 0,
        costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
      });
    }
    const b = byBucket.get(row.completeness);
    b.cards++;
    b.tickets += row.tickets;
    b.costCents += row.costCents;
    b.returnedCents += row.returnedCents;
    b.plCents += row.plCents;
    b.bankrollCents += row.bankrollCents ?? 0;

    if (row.completeness === 'LLM_GENERATED') {
      const key = row.llmModel ?? 'unknown';
      if (!byModel.has(key)) {
        byModel.set(key, {
          model: key, label: MODEL_LABEL[key] ?? key, cards: 0, tickets: 0,
          costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
        });
      }
      const m = byModel.get(key);
      m.cards++;
      m.tickets += row.tickets;
      m.costCents += row.costCents;
      m.returnedCents += row.returnedCents;
      m.plCents += row.plCents;
      m.bankrollCents += row.bankrollCents ?? 0;

      const notesKey = row.notesPresent ? 'notes' : 'no_notes';
      if (!byNotes.has(notesKey)) {
        byNotes.set(notesKey, {
          notes: Boolean(row.notesPresent),
          label: row.notesPresent ? 'With analyst notes' : 'No analyst notes',
          cards: 0, tickets: 0, costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
        });
      }
      const nb = byNotes.get(notesKey);
      nb.cards++;
      nb.tickets += row.tickets;
      nb.costCents += row.costCents;
      nb.returnedCents += row.returnedCents;
      nb.plCents += row.plCents;
      nb.bankrollCents += row.bankrollCents ?? 0;
    }
  }
  const buckets = BUCKET_ORDER.filter((k) => byBucket.has(k)).map((k) => {
    const b = byBucket.get(k);
    if (k !== 'LLM_GENERATED') return b;
    return {
      ...b,
      byModel: [...byModel.values()].sort((a, b2) => b2.plCents - a.plCents),
      byNotes: [...byNotes.values()].sort((a, b2) => Number(b2.notes) - Number(a.notes)),
    };
  });

  const ungraded = db.prepare(`
    SELECT c.id AS cardId, c.race_day_id AS raceDayId, rd.track, rd.date, rd.meet,
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

  // notesPresent is a SQLite 0/1; emit a real boolean so the client can test it
  // the same way it tests every other flag on the row.
  const cardsOut = cardRows
    .filter((r) => selectedMeet === 'all' || r.meet === selectedMeet)
    .map((r) => ({ ...r, notesPresent: Boolean(r.notesPresent) }));
  res.json({ buckets, cards: cardsOut, ungraded: ungraded.filter((r) => selectedMeet === 'all' || r.meet === selectedMeet), engineVersions, selectedVersion, meets, selectedMeet });
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
           c.consensus_completeness, c.engine_version, c.llm_model, c.notes_present, c.created_at
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
      engineVersion: c.engine_version, llmModel: c.llm_model, notesPresent: Boolean(c.notes_present), createdAt: c.created_at, graded: perRace.length > 0, perRace,
      costCents: sum('costCents'), returnedCents: sum('returnedCents'), plCents: sum('plCents'),
    };
  });

  res.json({ raceDayId: day.id, track: day.track, date: day.date, cards: out });
});
