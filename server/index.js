// BetSheet API server. Serves the built client from dist/ and the /api/*
// endpoints. Binds 127.0.0.1 only - BetSheet is a local-only app; sharing a
// card with the outside world is the job of the here.now publish feature
// (Phase 4), never of this server's binding.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { getLogger } from './logging.js';
import { ingestRouter } from './ingest.js';
import { equibaseApifyEntriesRouter } from './equibase-apify-entries.js';
import { getascraperEntriesRouter } from './getascraper-entries.js';
import { entriesZipRouter } from './entries-zip.js';
import { cardsRouter } from './cards.js';
import { humanCardsRouter } from './human-cards.js';
import { llmCardsRouter } from './llm-cards.js';
import { equibaseOtrRouter } from './equibase-otr.js';
import { tipPicksRouter } from './tip-picks.js';
import { tipScoringRouter } from './tip-scoring.js';
import { tipStakingRouter } from './tip-staking.js';
import { replayRouter } from './replay.js';
import { resetRouter } from './reset.js';
import { resultsRouter } from './results.js';
import { equibaseApifyResultsRouter } from './equibase-apify-results.js';
import { gradingRouter } from './grading.js';
import { plRouter } from './pl.js';
import { exportRouter } from './trace-export.js';
import { seedTemplates, templatesRouter } from './templates.js';
import { distributionRouter } from './distribution.js';
import { calendarRouter } from './race-calendar.js';
import { getDb } from './db.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const log = getLogger('app');
// Namespaced on purpose: dev harnesses inject a generic PORT for the process
// they launch (vite's), and reading it here made the API bind vite's port.
const PORT = Number(process.env.BETSHEET_PORT) || 8788;
const HOST = '127.0.0.1';

// pdfjs-dist (chart/program/ML PDF parsing) occasionally fires an internal
// 'error' event or a rejection off its own scheduling rather than through
// the awaited promise chain a route's try/catch wraps - on Node that's an
// uncaught exception that silently kills the WHOLE process (every in-flight
// request sees ECONNRESET, node --watch then restarts, and nothing lands in
// the app log to explain why). Log and stay up instead: no request handler
// here holds an open DB transaction or other state a bad PDF could corrupt.
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { error: String(err?.stack ?? err) });
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled_rejection', { error: String(err?.stack ?? err) });
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// The code-defined strategy templates land in their table at boot so
// cards can reference them by FK (the three surviving producers, D111).
seedTemplates(getDb());

// Request log for /api only (static assets would be noise). A request that
// belongs to a card session carries its correlation id in this header.
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    log.info('http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - started,
      correlationId: req.get('x-correlation-id') || undefined,
    });
  });
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'betsheet', version: '0.1.0' });
});

app.use('/api', ingestRouter);
app.use('/api', equibaseApifyEntriesRouter);
app.use('/api', getascraperEntriesRouter);
app.use('/api', entriesZipRouter);
app.use('/api', cardsRouter);
app.use('/api', humanCardsRouter);
app.use('/api', llmCardsRouter);
app.use('/api', equibaseOtrRouter);
app.use('/api', tipPicksRouter);
app.use('/api', tipScoringRouter);
app.use('/api', tipStakingRouter);
app.use('/api', replayRouter);
app.use('/api', resetRouter);
app.use('/api', resultsRouter);
app.use('/api', equibaseApifyResultsRouter);
app.use('/api', gradingRouter);
app.use('/api', plRouter);
app.use('/api', exportRouter);
app.use('/api', templatesRouter);
app.use('/api', distributionRouter);
app.use('/api', calendarRouter);

// JSON errors for the API, never Express's HTML error page. Registered
// after the routers; `async` handlers above catch their own.
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, _req, res, _next) => {
  log.error('api_error', { error: String(err?.message ?? err) });
  res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) });
});

app.use(express.static(path.join(ROOT, 'dist')));

// Client-side routes need the app shell on direct navigation and refresh.
// API misses remain JSON 404s and never fall through to this handler.
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));

const server = app.listen(PORT, HOST, () => {
  log.info('server_started', { host: HOST, port: PORT });
  console.log(`BetSheet listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use - another BetSheet instance ` +
      `(or a leftover dev/preview server) is running.\n` +
      `Stop it, or set BETSHEET_PORT to a different port.`,
    );
    process.exit(1);
  }
  throw err;
});
