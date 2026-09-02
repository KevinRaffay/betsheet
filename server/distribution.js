// Distribution API (D20): GET /api/distribution?engineVersion=<v>|all&meet=<m>|all
// The same selection rules as /api/pl (D16 / D34 / D43): one engine version
// at a time unless 'all' is asked for, an optional meet, deleted days
// excluded, and NOTHING pooled across completeness buckets (invariant 13).
// One card per day per bucket: the latest card_number in the selection.
// The figures themselves come from shared/distribution.js (pure).

import express from 'express';
import { distributionFor } from '../shared/distribution.js';
import { getDb } from './db.js';

export const distributionRouter = express.Router();

distributionRouter.get('/distribution', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id AS cardId, c.card_number AS cardNumber, c.race_day_id AS raceDayId, rd.track, rd.date, rd.meet,
           c.consensus_completeness AS completeness, c.engine_version AS engineVersion,
           t.id AS ticketId, t.sequence, t.bet_type AS betType, t.selections, t.cost_cents AS costCents,
           gt.returned_cents AS returnedCents, gt.pl_cents AS plCents, gt.outcome
    FROM graded_tickets_latest gt
    JOIN tickets t ON t.id = gt.ticket_id
    JOIN cards c ON c.id = t.card_id
    JOIN race_days rd ON rd.id = c.race_day_id
    WHERE rd.deleted_at IS NULL
    ORDER BY rd.date, c.race_day_id, c.card_number, t.sequence
  `).all();

  const engineVersions = [];
  for (const r of [...rows].sort((a, b) => b.cardId - a.cardId)) if (!engineVersions.includes(r.engineVersion)) engineVersions.push(r.engineVersion);
  const requested = String(req.query.engineVersion ?? '').trim();
  const selectedVersion = requested === 'all' ? 'all' : requested && engineVersions.includes(requested) ? requested : (engineVersions[0] ?? null);
  const meets = [...new Set(rows.map((r) => r.meet).filter(Boolean))].sort();
  const requestedMeet = String(req.query.meet ?? '').trim();
  const selectedMeet = requestedMeet && meets.includes(requestedMeet) ? requestedMeet : 'all';
  const selected = rows.filter((r) => (selectedVersion === 'all' || r.engineVersion === selectedVersion) && (selectedMeet === 'all' || r.meet === selectedMeet));

  // Latest card per (day, bucket): a regenerated or variant card replaces the
  // earlier one in this report rather than counting the day twice.
  const latestCard = new Map();
  for (const r of selected) {
    const k = `${r.raceDayId}|${r.completeness}`;
    if (!latestCard.has(k) || r.cardNumber > latestCard.get(k).cardNumber) latestCard.set(k, { cardId: r.cardId, cardNumber: r.cardNumber });
  }
  const byDay = new Map();
  for (const r of selected) {
    const k = `${r.raceDayId}|${r.completeness}`;
    if (latestCard.get(k).cardId !== r.cardId) continue;
    if (!byDay.has(k)) byDay.set(k, { raceDayId: r.raceDayId, date: r.date, track: r.track, meet: r.meet, cardId: r.cardId, completeness: r.completeness, engineVersion: r.engineVersion, tickets: [] });
    const sel = JSON.parse(r.selections);
    byDay.get(k).tickets.push({ sequence: r.sequence, betType: r.betType, races: sel.races, costCents: r.costCents, returnedCents: r.returnedCents, plCents: r.plCents, outcome: r.outcome });
  }
  const report = distributionFor([...byDay.values()]);
  res.json({ ...report, engineVersions, selectedVersion, meets, selectedMeet });
});
