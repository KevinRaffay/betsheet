#!/usr/bin/env node
// Dev supervisor for the API: restarts `node server/index.js` when a source
// file's CONTENT changes, and only then.
//
// Why this exists rather than `node --watch server/index.js`:
//
// Node's watch mode restarts on any filesystem notification for a loaded
// module file. On Windows libuv's ReadDirectoryChangesW filter includes
// FILE_NOTIFY_CHANGE_ATTRIBUTES / _SECURITY / _LAST_WRITE, so a metadata-only
// touch - a virus scan, the search indexer, a `git fetch`/`git status`, an
// editor stat sweep, a repo-wide `find` - fires 'change' for a file whose
// bytes and mtime are identical, and the API restarts for no reason. Proven
// locally 2026-09-04: `fs.utimesSync(f, st.atime, st.mtime)` on server/pl.js
// (same mtime, same bytes) makes `node --watch` print "Restarting" and
// respawn. That is what killed an in-flight /api/fetch/ml-sheet mid-ingest
// and surfaced as `[vite] http proxy error: read ECONNRESET`.
//
// It cannot be fixed inside the server: on Windows the watcher force-kills
// the child (TerminateProcess - SIGTERM is not deliverable), so no graceful
// shutdown handler ever runs and in-flight sockets are always reset. The only
// place to fix it is here, by not restarting in the first place.
//
// So: hash every watched file, and restart only when a hash actually moves.
// Node's `--watch-path` is not an option - it restarts on ANY change under
// the path, and server/logs/ (the D02 log streams) lives inside server/.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = path.join(ROOT, 'server', 'index.js');

// The trees the API actually loads from. `client/` is vite's job.
const WATCH_DIRS = ['server', 'shared'].map((d) => path.join(ROOT, d));
// Source only: the log streams and the raw/archive trees live under these
// directories too and change constantly while the server runs.
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.sql']);
const IGNORED_DIR = /(^|[\\/])(logs[^\\/]*|node_modules|\.git)([\\/]|$)/;
const DEBOUNCE_MS = 200;

const rel = (f) => path.relative(ROOT, f).replaceAll('\\', '/');
const say = (msg) => process.stdout.write(`[dev-watch] ${msg}\n`);

const watched = (file) => SOURCE_EXT.has(path.extname(file)) && !IGNORED_DIR.test(file);

/** Content hash, or null when the file is gone / unreadable mid-write. */
function hash(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Every watched file under `dir`, hashed. */
function scan(dir, into = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIR.test(`${full}${path.sep}`)) scan(full, into);
    } else if (watched(full)) {
      const h = hash(full);
      if (h) into.set(full, h);
    }
  }
  return into;
}

const hashes = new Map();
for (const dir of WATCH_DIRS) scan(dir, hashes);

// ---------- the child ----------

let child = null;
let restarting = false;

function start() {
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    if (restarting || shuttingDown) return;
    // Not our doing: the server exited on its own. Say so and wait for an
    // edit rather than respawn-looping on a startup error.
    say(`server exited (${signal ?? `code ${code}`}); waiting for a change`);
  });
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  say(`restarting - ${reason}`);
  if (child) {
    const dead = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await dead;
  }
  restarting = false;
  if (!shuttingDown) start();
}

// ---------- change detection ----------

let timer = null;
const pending = new Set();

/** True when `file`'s content differs from what we last saw. */
function contentMoved(file) {
  const before = hashes.get(file);
  const after = hash(file);
  if (after === null) {
    if (before === undefined) return false; // never existed; nothing to do
    hashes.delete(file);
    return true; // deleted
  }
  if (before === after) return false; // the phantom event this script exists for
  hashes.set(file, after);
  return true;
}

function onChange(file) {
  if (!watched(file)) return;
  pending.add(file);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const moved = [...pending].filter(contentMoved);
    pending.clear();
    if (moved.length === 0) return;
    const names = moved.slice(0, 3).map(rel).join(', ');
    restart(`${names}${moved.length > 3 ? ` (+${moved.length - 3} more)` : ''}`);
  }, DEBOUNCE_MS);
}

for (const dir of WATCH_DIRS) {
  try {
    fs.watch(dir, { recursive: true }, (_event, name) => {
      if (name) onChange(path.resolve(dir, name));
    });
  } catch (err) {
    say(`could not watch ${rel(dir)}: ${err.message}`);
  }
}

// ---------- shutdown ----------

let shuttingDown = false;
const stop = () => {
  shuttingDown = true;
  if (child) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

say(`watching ${WATCH_DIRS.map(rel).join(', ')} (${hashes.size} source files) - content changes only`);
start();
