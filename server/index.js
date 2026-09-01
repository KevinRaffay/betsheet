// BetSheet API server. Serves the built client from dist/ and the /api/*
// endpoints. Binds 127.0.0.1 only - BetSheet is a local-only app; sharing a
// card with the outside world is the job of the here.now publish feature
// (Phase 4), never of this server's binding.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Namespaced on purpose: dev harnesses inject a generic PORT for the process
// they launch (vite's), and reading it here made the API bind vite's port.
const PORT = Number(process.env.BETSHEET_PORT) || 8788;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'betsheet', version: '0.1.0' });
});

app.use(express.static(path.join(ROOT, 'dist')));

const server = app.listen(PORT, HOST, () => {
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
