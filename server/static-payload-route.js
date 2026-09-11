// Publish the static snapshot from the running app, not just the CLI (D336).
//
// `npm run build-static-payload` (D150/D329) always worked; this route wires
// the SAME build logic (server/static-payload-builder.js) to one button on
// the race day list ("Publish snapshot"), so choosing which days to bundle
// no longer requires knowing the CLI's date-range flags or opening a
// terminal at all.
//
// What this route does NOT do is the load-bearing part: it writes
// static/public/payload.json on THIS machine and nothing else. It never
// touches git, never pushes, never deploys, and requires no network access
// beyond the local request/response - a person still has to commit and push
// that file (and have Pages enabled) before anything becomes public. That
// framing is repeated in the response body so the UI can say it plainly
// rather than let a click be mistaken for a deploy.
//
// Still a READ against the database in every way that matters: the build
// itself never inserts, updates or deletes a single row. The one write is
// the payload FILE, exactly as the CLI already does.
//
// Still manual and deliberate, per invariant 6/D197 - no scheduling of any
// kind was added here. A click is a person choosing to publish a chosen set
// of days right now, the same shape the CLI's own header comment already
// describes; there is no path from here to a standing job.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDb } from './db.js';
import { getLogger, newCorrelationId } from './logging.js';
import { buildStaticPayload, DEFAULT_OUT, summarizePayload } from './static-payload-builder.js';

const log = getLogger('app');

export const staticPayloadRouter = express.Router();

staticPayloadRouter.post('/static-payload/publish', (req, res) => {
  const { dayIds, from, to, track } = req.body ?? {};
  const hasIds = Array.isArray(dayIds) && dayIds.length > 0;
  const hasRange = Boolean(from && to);
  if (!hasIds && !hasRange) {
    return res.status(400).json({
      error: 'Provide either a non-empty "dayIds" array or both "from" and "to" (YYYY-MM-DD).',
    });
  }
  if (hasIds && (from || to || track)) {
    return res.status(400).json({ error: 'Pass either "dayIds" or "from"/"to"/"track", not both.' });
  }

  const db = getDb();
  const { payload, error } = buildStaticPayload(db, { dayIds, from, to, track });
  if (error) {
    return res.status(422).json({ error });
  }

  const outPath = DEFAULT_OUT;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const days = summarizePayload(payload);
  // App-level audit event (mirrors app_reset's shape) - a publish is a
  // deliberate action worth a visible trace, even though it is not a card
  // event and carries no card correlation id (invariant 8 is about a card
  // SESSION's own trace; this spans however many days were just bundled).
  const correlationId = newCorrelationId();
  log.info('static_payload_published', {
    correlationId,
    path: path.relative(process.cwd(), outPath) || outPath,
    generatedAt: payload.generatedAt,
    raceDayIds: days.map((d) => d.raceDayId),
  });

  res.json({
    ok: true,
    correlationId,
    path: path.relative(process.cwd(), outPath) || outPath,
    generatedAt: payload.generatedAt,
    days,
  });
});
