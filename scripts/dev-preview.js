// The dev stack an AGENT starts, on ports that are never the human's.
//
// The recurring failure this exists for: `.claude/launch.json` runs
// `npm run dev`, so a browser-verification preview took 8788 and 5175 - the
// exact ports a person's own `npm run dev` wants. Every UI change verified in
// the browser and not torn down afterwards refused the next human `npm run
// dev`, with dev-preflight.js correctly naming a process the person had never
// started. D80's tooling can only report that collision; this removes it.
//
// The fix is the D83 one applied to ports instead of paths: make the isolation
// STRUCTURAL rather than something the agent has to remember. Precedence is
// explicit env > this clone's .env > these defaults, so an operator or a
// second checkout can still say otherwise.
//
// The ports dodge, deliberately: 8787/5173/5174 (life-swipe), 8788/5175 (the
// human's), 5176-5180 (the human's vite fallback range - dev-clean.js sweeps
// those when the tree is provably this checkout's, and this stack IS this
// checkout, so a person's dev:clean would otherwise kill an agent mid-verify,
// the same bug D83 fixed for betsheet-alt), 8798/5178 (betsheet-alt),
// 8790/5177 (the escape hatch dev-preflight.js prints), 8902 (start-qa) and
// 8899-8920 (the check-script band).
//
// Run: npm run dev:preview  (or let .claude/launch.json do it)

import 'dotenv/config';
import { spawn } from 'node:child_process';

process.env.BETSHEET_PORT ||= '8795';
process.env.BETSHEET_VITE_PORT ||= '5185';

process.stdout.write(
  `[dev-preview] agent instance - api ${process.env.BETSHEET_PORT}, vite ${process.env.BETSHEET_VITE_PORT}\n`
  + '[dev-preview] the human dev stack (8788/5175) is untouched and can run alongside this.\n',
);

// Spawn the ordinary `dev` script rather than re-implementing it, so the
// preflight, the watcher and vite all stay defined in exactly one place and
// simply read the env this process set.
// One command STRING, not (command, args) with shell:true - that form warns
// DEP0190 because the args would be concatenated into the shell line unescaped.
// There is nothing to escape here (the command is a fixed literal), but the
// string form is the documented way to say so.
const child = spawn('npm run dev', { stdio: 'inherit', shell: true });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
