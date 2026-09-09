// Preview for a live, on-demand Apify entries pull, triggered from the UI
// (`docs/requirements/apify-equibase-ingest.md`; reuses Phase 3/4's own
// building blocks). Unlike `server/equibase-apify-results.js`'s preview
// route, this one MAKES THE LIVE CALL itself - the browser holds no
// `APIFY_TOKEN` (the same reason `server/apifyClient.js` lives under
// `server/`, never `shared/`), so the server is the only place this call
// can happen. Same cost posture as the CLI scripts: COSTS REAL MONEY EVERY
// CALL, even though this is "just" a preview - invariant 9 (preview before
// write) still holds, there is just no cheaper way to preview a live
// source than to actually call it.
//
// ONE track, ONE date - the UI's own initial flow (user decision
// 2026-09-09): unlike the CLI's "omit --tracks for every track racing that
// day," the UI commits to exactly one track before the paid call is even
// possible, matching how a race day is already created one track at a time
// (`NewRaceDay.jsx`). Returns the SAME shape `/api/parse/equibase-entries`
// already returns, so the client's existing preview/save UI needs no new
// handling - `entriesSource: 'equibase_apify'` flows through the existing
// `POST /race-days` route unchanged (D195/D196).

import express from 'express';
import { fetchEntries } from './apifyEquibase.js';
import { parseApifyParseforgeDataset } from '../shared/parsers/equibase-apify-parseforge.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');

export const equibaseApifyEntriesRouter = express.Router();

// Exported (not just the route handler) so a check script can inject a
// fake Apify client - matching shared/apifyEquibase.js's own `runActor`
// seam - and verify this file's own logic (single-track resolution,
// response shape) without ever making a real, billed call. A real request
// never passes `client`.
export async function previewApifyEntries({ track, date }, client) {
  const { items, runId } = await fetchEntries({ raceDate: date, tracks: [track] }, client);
  const parsed = parseApifyParseforgeDataset(JSON.stringify(items));
  // apifyRunId rides on the return value so the route below can log it
  // (D204) - stripped before the HTTP response, since it is a diagnostic
  // detail of THIS call, not part of the entries-preview shape
  // /api/parse/equibase-entries already defines and NewRaceDay.jsx saves
  // straight through.
  return { ...parsed, entriesSource: 'equibase_apify', oddsCapturedAt: new Date().toISOString(), apifyRunId: runId };
}

equibaseApifyEntriesRouter.post('/parse/equibase-apify-entries', async (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const track = String(req.body?.track ?? '').trim();
  const date = String(req.body?.date ?? '').trim();
  if (!track || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'track and date (YYYY-MM-DD) are both required.' });
  }

  try {
    const { apifyRunId, ...parsed } = await previewApifyEntries({ track, date });
    log.info('parse_completed', {
      correlationId,
      kind: 'equibase_apify_entries',
      apifyRunId,
      track: parsed.track,
      date: parsed.date,
      races: parsed.races.length,
      entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
      warnings: parsed.warnings.length,
    });
    res.json({ correlationId, ...parsed });
  } catch (err) {
    log.warn('parse_failed', { correlationId, kind: 'equibase_apify_entries', error: String(err?.message ?? err) });
    res.status(422).json({ error: String(err?.message ?? err) });
  }
});
