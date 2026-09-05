// Find and stop stale BetSheet dev stacks.
//
// The recurring failure this exists for: an `npm run dev` outlives the shell
// that started it (concurrently's -k only kills siblings when concurrently
// itself exits, so a closed terminal or an ended session orphans the whole
// tree), keeps 8788 and 5175, and the next `npm run dev` half-starts against
// it. Found live 2026-09-04 with two stacks up at once.
//
// Targets are found BY PORT, not by scanning for node processes: the dev
// ports are the definition of "in the way", and a process-name scan would
// risk killing an unrelated node. From each listener it walks up to the tree
// root (see scripts/dev-ports.js - killing a supervised child just respawns
// it) and stops at the first ancestor that is a shell or is not part of a dev
// stack, so a terminal is never a kill target.
//
// Dry run by default, like every other destructive script in this repo
// (reset, backfill-bottom-line, strip-bottom-line-byline): --yes to kill.
// Run: npm run dev:clean [-- --yes]

// The dev ports come from this clone's own .env when it has them, so a second
// checkout (the betsheet-alt scratch clone, README) just runs `npm run dev`
// with no env prefix to remember. server/index.js already reads .env this way;
// without it here, the server would move but the preflight, the watcher and
// vite's /api proxy would all still be looking at the default ports.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { probePort, holderTree, describe } from './dev-ports.js';

const write = process.argv.slice(2).includes('--yes');

const API_PORT = Number(process.env.BETSHEET_PORT) || 8788;
const VITE_PORT = Number(process.env.BETSHEET_VITE_PORT) || 5175;
// Vite walks upward when its port is taken, so a stale stack's front end can
// be sitting a few ports along from the configured one.
const VITE_FALLBACKS = Array.from({ length: 5 }, (_, i) => VITE_PORT + 1 + i);
const PORTS = [API_PORT, VITE_PORT, ...VITE_FALLBACKS];
const CONFIGURED = new Set([API_PORT, VITE_PORT]);

// A fallback port is only swept when the stack holding it is provably THIS
// checkout's. Without that, the two clones overlap: betsheet-alt runs vite on
// 5178, which sits inside the main checkout's fallback range (5176-5180), so
// `dev:clean --yes` in main would stop the scratch instance - a stack that was
// never in main's way, since strictPort means main only ever wants 5175.
// Verified live 2026-09-04 with both stacks up.
//
// The evidence is the process tree's own command lines: every member of a dev
// stack names its checkout (server/index.js, node_modules/.bin/vite, the npm
// script). ROOT keeps its trailing separator on purpose - "C:\repos\betsheet"
// is a prefix of "C:\repos\betsheet-alt", and only the separator tells them
// apart.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const norm = (s) => (s ?? '').replace(/\//g, '\\').toLowerCase();
const ROOT_PREFIX = norm(ROOT);
const ownedHere = (tree) => tree.chain.some((p) => norm(p.cmd).includes(ROOT_PREFIX));

const busy = [];
const foreign = [];
for (const port of PORTS) {
  if (await probePort(port)) continue;
  const held = holderTree(port);
  // Our own two ports are swept whoever holds them: we cannot start without
  // them. A fallback needs positive proof, and an unidentifiable holder on one
  // is not proof.
  if (!CONFIGURED.has(port) && !(held && ownedHere(held))) {
    foreign.push({ port, held });
    continue;
  }
  busy.push({ port, held });
}

// Ports left to someone else must not count toward "did the clean work".
const CHECKED = PORTS.filter((p) => !foreign.some((f) => f.port === p));

for (const { port, held } of foreign) {
  const who = held ? describe(held.root) : 'holder could not be identified';
  console.log(`  port ${port}: in use by another checkout, left alone - ${who}`);
}
if (foreign.length > 0) console.log('');

if (busy.length === 0) {
  console.log(`No dev ports of this checkout in use (checked ${CHECKED.join(', ')}). Nothing to clean.`);
  process.exit(0);
}

// One tree can own several ports (api + vite under one concurrently), so kill
// each root once rather than once per port.
const roots = new Map();
for (const { port, held } of busy) {
  if (!held) {
    console.log(`  port ${port}: in use, but the holder could not be identified (not Windows, or access denied)`);
    continue;
  }
  const entry = roots.get(held.root.pid) ?? { root: held.root, ports: [], leaves: new Map() };
  entry.ports.push(port);
  entry.leaves.set(held.leaf.pid, held.leaf);
  roots.set(held.root.pid, entry);
}

console.log(`${roots.size} dev stack(s) holding ${busy.length} port(s):\n`);
for (const { root, ports, leaves } of roots.values()) {
  console.log(`  root  ${describe(root)}`);
  console.log(`  ports ${ports.join(', ')}`);
  for (const leaf of leaves.values()) {
    if (leaf.pid !== root.pid) console.log(`  child ${describe(leaf)}`);
  }
  console.log('');
}

if (!write) {
  console.log('Dry run - nothing killed. Re-run with --yes to stop these.');
  process.exit(0);
}

let killed = 0;
for (const { root, ports } of roots.values()) {
  try {
    // /T kills the whole tree; without it the supervisor survives and
    // immediately respawns the child that was holding the port.
    execFileSync('taskkill', ['/T', '/F', '/PID', String(root.pid)], {
      encoding: 'utf8', windowsHide: true,
    });
    console.log(`Stopped PID ${root.pid} and its tree (was holding ${ports.join(', ')}).`);
    killed++;
  } catch (err) {
    console.error(`Could not stop PID ${root.pid}: ${err?.message ?? err}`);
  }
}

// Re-probe rather than claim success: a tree can be gone and a port still be
// held by something this script never identified.
const stillBusy = [];
for (const port of CHECKED) if (!(await probePort(port))) stillBusy.push(port);

console.log(`\nStopped ${killed} stack(s). ${stillBusy.length === 0
  ? `All checked ports are free (${CHECKED.join(', ')}).`
  : `Still in use: ${stillBusy.join(', ')} - rerun, or investigate by hand.`}`);
process.exit(stillBusy.length === 0 ? 0 : 1);
