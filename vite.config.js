// The dev ports come from this clone's own .env when it has them, so a second
// checkout (the betsheet-alt scratch clone, README) just runs `npm run dev`
// with no env prefix to remember. server/index.js already reads .env this way;
// without it here, the server would move but the preflight, the watcher and
// vite's /api proxy would all still be looking at the default ports.
import 'dotenv/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
    },
  },
  server: {
    port: Number(process.env.BETSHEET_VITE_PORT) || 5175,
    // Fail instead of walking to the next free port. Vite's default fallback
    // is silent, and the API has no equivalent - so a stale dev stack used to
    // produce a NEW front end on 5176 proxying /api to the OLD stack's server
    // on 8788, with no error anywhere and edits appearing not to take effect.
    // Found live 2026-09-04. Loud beats convenient: scripts/dev-watch.js's
    // preflight fails the same way on the API side, so both halves of
    // `npm run dev` refuse a port they do not own.
    strictPort: true,
    fs: { allow: ['..'] },
    // Tracks the API port so a second dev instance (or a verification run
    // beside an already-running npm start) can move both ports together.
    // 127.0.0.1, not localhost: the server binds IPv4 loopback only
    // (invariant 10), while "localhost" on Windows resolves ::1 first.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.BETSHEET_PORT) || 8788}`,
        // The API can go away mid-request in dev - a restart after a real
        // edit, or the process not up yet. Without a handler the dropped
        // socket surfaces as an unhandled "http proxy error: read
        // ECONNRESET" stack in the terminal and an opaque network failure
        // in the browser. Answer with the JSON shape client/src/api.js's
        // `asJson` already reads, so the UI shows a sentence instead.
        // Vite attaches its own 'error' listener AFTER this hook runs, so its
        // red "http proxy error" stack still prints; ours goes above it and
        // says what actually happened. Answering here first is what matters:
        // vite's fallback only writes its own 500 when nothing else has.
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            const detail = err?.code || err?.message || 'connection failed';
            console.log(`[api proxy] ${req?.method ?? '?'} ${req?.url ?? '?'} - ${detail} (API restarting or down)`);
            // `res` is a raw socket for a websocket upgrade, which has no
            // writeHead - only an HTTP response can be answered.
            if (!res || typeof res.writeHead !== 'function') return;
            if (res.headersSent || res.writableEnded) return;
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: `The API server did not answer (${detail}). It is restarting or not running - try again in a moment.`,
            }));
          });
        },
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
