// Refuse to start `npm run dev` when a dev port is already taken, and say
// exactly which process to stop.
//
// This runs BEFORE concurrently, and that placement is the whole point.
// Checking inside the two halves does not work: vite binds in ~50ms while an
// API-side check needs a process lookup, so vite loses/wins the race and
// `concurrently -k` SIGTERMs the other half before it can print anything.
// Observed while building this - vite's "Port 5175 is already in use" killed
// the api slot mid-diagnosis, leaving the least useful message on screen.
//
// One check, up front, both ports, one message, nothing started.
// scripts/dev-watch.js keeps its own check as a backstop for being run
// directly.

// The dev ports come from this clone's own .env when it has them, so a second
// checkout (the betsheet-alt scratch clone, README) just runs `npm run dev`
// with no env prefix to remember. server/index.js already reads .env this way;
// without it here, the server would move but the preflight, the watcher and
// vite's /api proxy would all still be looking at the default ports.
import 'dotenv/config';
import { probePort, holderTree, describe } from './dev-ports.js';

const API_PORT = Number(process.env.BETSHEET_PORT) || 8788;
const VITE_PORT = Number(process.env.BETSHEET_VITE_PORT) || 5175;

const say = (msg) => process.stdout.write(`[dev-preflight] ${msg}\n`);

const busy = [];
for (const [label, port] of [['api', API_PORT], ['vite', VITE_PORT]]) {
  if (!(await probePort(port))) busy.push({ label, port, held: holderTree(port) });
}

if (busy.length === 0) process.exit(0);

say(`not starting - ${busy.map((b) => `${b.label} port ${b.port}`).join(' and ')} already in use.`);

// Several ports usually belong to ONE stale stack (its vite and its API under
// one concurrently), so report each tree once with the ports it owns.
const roots = new Map();
for (const b of busy) {
  if (!b.held) {
    say(`  ${b.label} ${b.port}: holder could not be identified (not Windows, or access denied)`);
    continue;
  }
  const entry = roots.get(b.held.root.pid) ?? { held: b.held, ports: [] };
  entry.ports.push(b.port);
  roots.set(b.held.root.pid, entry);
}

for (const { held, ports } of roots.values()) {
  say('');
  say(`  holding ${ports.join(' and ')}:`);
  say(`    process ${describe(held.leaf)}`);
  if (!held.sameProcess) {
    say(`    root    ${describe(held.root)}`);
    say('    supervised - killing the process alone respawns it; the root has to go.');
  }
}

say('');
// The one-command remedy comes first: the two-step (clean, then re-run)
// is the whole reason a stale stack stayed in the way long enough to be
// reported twice. `dev:restart` is dev:clean --yes followed by this.
say('  stop them and start:  npm run dev:restart');
say('  or just look first:   npm run dev:clean');
say('  or move this instance to its own ports (POSIX shell syntax):');
say('    BETSHEET_PORT=8790 BETSHEET_VITE_PORT=5177 npm run dev');
// An agent's browser-verification stack is NOT supposed to show up here
// any more - .claude/launch.json runs `npm run dev:preview`, which sits on
// 8795/5185. A `dev:preview` process named above means that isolation was
// bypassed (an explicit BETSHEET_PORT, or a launch config pointed back at
// plain `dev`), not that the ports are shared again by design.
process.exit(1);
