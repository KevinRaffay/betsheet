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
import { consensusRouter } from './consensus.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const log = getLogger('app');
// Namespaced on purpose: dev harnesses inject a generic PORT for the process
// they launch (vite's), and reading it here made the API bind vite's port.
const PORT = Number(process.env.BETSHEET_PORT) || 8788;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json({ limit: '10mb' }));

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
app.use('/api', consensusRouter);

// JSON errors for the API, never Express's HTML error page. Registered
// after the routers; `async` handlers above catch their own.
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, _req, res, _next) => {
  log.error('api_error', { error: String(err?.message ?? err) });
  res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) });
});

app.use(express.static(path.join(ROOT, 'dist')));

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
