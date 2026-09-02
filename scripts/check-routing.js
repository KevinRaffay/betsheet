// Verification for browser routes and the production SPA fallback.
// Run: npm run check-routing (build first).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseRoute, pathForView } from '../client/src/routes.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const port = 8898;
const base = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-routingcheck-'));
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(port),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const check = (name, value) => {
  assert.ok(value, name);
  console.log(`  ok    ${name}`);
};

try {
  check('root route parses as list', parseRoute('/').name === 'list');
  check('new route formats', pathForView({ name: 'new' }) === '/new');
  check('day route parses positive id', parseRoute('/day/17').id === 17);
  check('card route parses positive id', parseRoute('/card/23').id === 23);
  check('malformed route falls back to list', parseRoute('/day/nope').name === 'list');
  check('unknown route falls back to list', parseRoute('/not-a-route').name === 'list');

  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* keep polling */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('server boots on isolated port', ready);

  for (const route of ['/', '/new', '/pl', '/simulate', '/day/1', '/card/1']) {
    const response = await fetch(base + route);
    const text = await response.text();
    check(`${route} serves the client shell`, response.ok && text.includes('<div id="root">'));
  }

  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json();
  check('/api/health remains JSON', health.ok && healthBody.ok === true);

  const missingApi = await fetch(`${base}/api/does-not-exist`);
  const missingBody = await missingApi.json();
  check('unknown API route remains JSON 404', missingApi.status === 404 && missingBody.error);
} finally {
  server.kill();
}

console.log('check-routing: all checks passed');