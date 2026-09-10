// Preview for a getascraper/equibase-us-horse-racing-scraper dataset export
// (D219), read from a file the user exported from Apify and chose to bring in -
// NOT a live call.
//
// WHY NOT A LIVE PULL, unlike server/equibase-apify-entries.js. That route can
// call its actor because D197 read parseforge's real input schema off the
// actor's own Store page (`resultType`/`tracks`/`date`) - and D197 also found
// that the scope doc this codebase inherited had confidently stated a DIFFERENT
// actor's parameter names for it. This actor's input schema has not been read
// from any primary source, so inventing one here would repeat exactly that
// mistake, with a billed call as the failure mode. The dataset export is
// verified real (three captures on file), so it is what this route accepts.
//
// This is also the codebase's ordinary posture rather than an exception:
// invariant 6's "every source of data is a file a person chose to upload or
// paste." The Equibase HTML route next door works the same way, and the file is
// read in the BROWSER and posted as text, so the server never sees a path and
// never opens a file.
//
// Adding the live-pull mode later is small - a `fetchGetascraperEntries` beside
// `fetchEntries` in server/apifyEquibase.js and a second button - and needs
// exactly one thing this environment could not obtain: the actor's real input
// schema, read from its own page.

import express from 'express';
import { parseGetascraperDataset } from '../shared/parsers/equibase-getascraper.js';
import { getLogger, newCorrelationId } from './logging.js';

const log = getLogger('app');

export const getascraperEntriesRouter = express.Router();

getascraperEntriesRouter.post('/parse/getascraper-entries', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const json = typeof req.body?.json === 'string' ? req.body.json : '';
  // Optional: only needed when one export spans several tracks, which this
  // source's own output does. Absent, the parser resolves a single track itself
  // and refuses (never guesses) when there is more than one.
  const trackCode = String(req.body?.trackCode ?? '').trim() || null;
  const oddsCapturedAt = String(req.body?.oddsCapturedAt ?? '').trim() || null;

  if (!json.trim()) {
    return res.status(400).json({ error: 'A getascraper dataset export (JSON) is required.' });
  }

  // The parser never throws by contract; a try/catch here would only mask a
  // genuine bug in it, so there is none - the same shape the HTML entries route
  // uses for its own pure parser.
  const parsed = parseGetascraperDataset(json, trackCode ? { trackCode } : {});
  log.info('parse_completed', {
    correlationId,
    kind: 'getascraper_entries',
    track: parsed.track,
    date: parsed.date,
    races: parsed.races.length,
    entries: parsed.races.reduce((a, r) => a + r.entries.length, 0),
    warnings: parsed.warnings.length,
    blocking: parsed.warnings.filter((w) => w.blocking).length,
  });

  res.json({
    correlationId,
    ...parsed,
    entriesSource: 'equibase_getascraper',
    oddsCapturedAt,
  });
});
