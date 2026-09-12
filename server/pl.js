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
import { TIP_VARIANTS, TIP_HEADLINE_VARIANT } from '../shared/tip-staking.js';

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
           c.live_odds_present AS liveOddsPresent, c.tip_sheets_present AS tipSheetsPresent,
           c.tip_source_label AS tipSource,
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
  // Track and date filtering: ?track=<track> and ?date=<date> narrow to specific values;
  // default 'all' for both (no filtering applied).
  const tracks = [...new Set(cardRows.map((r) => r.track).filter(Boolean))].sort();
  const dates = [...new Set(cardRows.map((r) => r.date).filter(Boolean))].sort().reverse();
  const requestedTrack = String(req.query.track ?? '').trim();
  const requestedDate = String(req.query.date ?? '').trim();
  const selectedTrack = requestedTrack && tracks.includes(requestedTrack) ? requestedTrack : 'all';
  const selectedDate = requestedDate && dates.includes(requestedDate) ? requestedDate : 'all';
  const inSelection = (row) => (selectedVersion === 'all' || row.engineVersion === selectedVersion) && (selectedTrack === 'all' || row.track === selectedTrack) && (selectedDate === 'all' || row.date === selectedDate);

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
  const byLiveOdds = new Map();
  const byTipSheets = new Map();
  // D175: TIPSHEET variants are MUTUALLY EXCLUSIVE - three ways to bet one
  // source's picks, only one of which is ever real money. Summing them made a
  // $500 bankroll report ~$1,498 spent. So exactly ONE variant per (day,
  // source) counts toward the bucket TOTAL, and it is a FIXED one: choosing
  // the best performer per day would be cherry-picking. The other two are
  // reported as `byVariant`, a breakdown of the same rows, never added in.
  // This is the rule Distributions has always had ("one card per day per
  // bucket") arriving in P/L, where it was missing.
  const tipHeadline = new Map();
  for (const row of cardRows) {
    if (!inSelection(row) || row.completeness !== 'TIPSHEET') continue;
    const key = `${row.raceDayId}::${row.tipSource ?? 'unknown'}`;
    const rank = (v) => { const i = TIP_VARIANTS.indexOf(v); return i === -1 ? TIP_VARIANTS.length : i; };
    const held = tipHeadline.get(key);
    // The headline variant when it exists; otherwise the earliest variant
    // present, so a day staked with only one structure is still counted once
    // rather than dropped.
    if (!held || rank(row.variant) < rank(held.variant)) tipHeadline.set(key, row);
  }
  const countsToward = (row) => row.completeness !== 'TIPSHEET'
    || tipHeadline.get(`${row.raceDayId}::${row.tipSource ?? 'unknown'}`)?.cardId === row.cardId;

  const byVariant = new Map();
  for (const row of cardRows) {
    if (!inSelection(row)) continue;
    if (!byBucket.has(row.completeness)) {
      byBucket.set(row.completeness, {
        completeness: row.completeness, cards: 0, tickets: 0,
        costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
      });
    }
    // Every TIPSHEET row is still reported, just not all of them ADDED UP.
    if (row.completeness === 'TIPSHEET') {
      const key = row.variant;
      if (!byVariant.has(key)) {
        byVariant.set(key, {
          variant: key, headline: key === TIP_HEADLINE_VARIANT, cards: 0, tickets: 0,
          costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
        });
      }
      const v = byVariant.get(key);
      v.cards++;
      v.tickets += row.tickets;
      v.costCents += row.costCents;
      v.returnedCents += row.returnedCents;
      v.plCents += row.plCents;
      v.bankrollCents += row.bankrollCents ?? 0;
    }
    if (!countsToward(row)) continue;

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
      // D234: the same split on the board. Two LLM cards on one race - one
      // generated from the morning line, one with the tote board in the
      // prompt - are two different experiments, and pooling them reports one
      // number for both. The key is "saw a board", not "was generated late":
      // a card made at 4pm with nobody having typed the board has a prompt
      // byte-identical to the morning one.
      const oddsKey = row.liveOddsPresent ? 'live_odds' : 'no_live_odds';
      if (!byLiveOdds.has(oddsKey)) {
        byLiveOdds.set(oddsKey, {
          liveOdds: Boolean(row.liveOddsPresent),
          label: row.liveOddsPresent ? 'Saw the live board' : 'Morning line only',
          cards: 0, tickets: 0, costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
        });
      }
      const lb = byLiveOdds.get(oddsKey);
      lb.cards++;
      lb.tickets += row.tickets;
      lb.costCents += row.costCents;
      lb.returnedCents += row.returnedCents;
      lb.plCents += row.plCents;
      lb.bankrollCents += row.bankrollCents ?? 0;

      // D369: the same split on tip sheets. A card whose prompt carried the
      // day's tip sheets and one whose prompt did not are two experiments;
      // the flag LATCHES like the other two ("at least one race saw one").
      const tipsKey = row.tipSheetsPresent ? 'tip_sheets' : 'no_tip_sheets';
      if (!byTipSheets.has(tipsKey)) {
        byTipSheets.set(tipsKey, {
          tipSheets: Boolean(row.tipSheetsPresent),
          label: row.tipSheetsPresent ? 'Saw tip sheets' : 'No tip sheets',
          cards: 0, tickets: 0, costCents: 0, returnedCents: 0, plCents: 0, bankrollCents: 0,
        });
      }
      const tb = byTipSheets.get(tipsKey);
      tb.cards++;
      tb.tickets += row.tickets;
      tb.costCents += row.costCents;
      tb.returnedCents += row.returnedCents;
      tb.plCents += row.plCents;
      tb.bankrollCents += row.bankrollCents ?? 0;

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
    if (k === 'TIPSHEET') {
      return {
        ...b,
        // The total above counts ONE variant per (day, source). This says which,
        // and what the alternatives would have done - side by side, never summed.
        headlineVariant: TIP_HEADLINE_VARIANT,
        byVariant: [...byVariant.values()]
          .sort((a, b2) => TIP_VARIANTS.indexOf(a.variant) - TIP_VARIANTS.indexOf(b2.variant)),
      };
    }
    if (k !== 'LLM_GENERATED') return b;
    return {
      ...b,
      byModel: [...byModel.values()].sort((a, b2) => b2.plCents - a.plCents),
      byNotes: [...byNotes.values()].sort((a, b2) => Number(b2.notes) - Number(a.notes)),
      byLiveOdds: [...byLiveOdds.values()].sort((a, b2) => Number(b2.liveOdds) - Number(a.liveOdds)),
      byTipSheets: [...byTipSheets.values()].sort((a, b2) => Number(b2.tipSheets) - Number(a.tipSheets)),
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
    .filter((r) => (selectedTrack === 'all' || r.track === selectedTrack) && (selectedDate === 'all' || r.date === selectedDate))
    .map((r) => ({ ...r, notesPresent: Boolean(r.notesPresent), liveOddsPresent: Boolean(r.liveOddsPresent), tipSheetsPresent: Boolean(r.tipSheetsPresent) }));
  res.json({ buckets, cards: cardsOut, ungraded: ungraded.filter((r) => (selectedTrack === 'all' || r.track === selectedTrack) && (selectedDate === 'all' || r.date === selectedDate)), engineVersions, selectedVersion, tracks, dates, selectedTrack, selectedDate });
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
           c.consensus_completeness, c.engine_version, c.llm_model, c.notes_present, c.live_odds_present,
           c.tip_sheets_present, c.created_at
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
      engineVersion: c.engine_version, llmModel: c.llm_model, notesPresent: Boolean(c.notes_present),
      liveOddsPresent: Boolean(c.live_odds_present), tipSheetsPresent: Boolean(c.tip_sheets_present),
      createdAt: c.created_at, graded: perRace.length > 0, perRace,
      costCents: sum('costCents'), returnedCents: sum('returnedCents'), plCents: sum('plCents'),
    };
  });

  res.json({ raceDayId: day.id, track: day.track, date: day.date, cards: out });
});
