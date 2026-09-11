// CLI onto scripts/lib/deliverable-issues.js (D237 investigation, shipped as
// the number this PR actually claimed - see that file's header for the full
// argument). D-numbers are now GitHub Issues: claiming one opens an issue
// labeled `deliverable` and the issue's number IS the D-number. This
// replaces the local SQLite counter (D203/D226/D230) - see
// deliverable-issues.js for why GitHub's own atomic issue numbering closes
// the residual cross-clone race that three iterations of local coordination
// never fully could.
//
// The one thing to remember: run this BEFORE picking a branch name or
// writing a ledger row, and use the number it prints. This still requires a
// GitHub credential (the same one `npm run gh` uses) and a network call -
// unlike the old allocator, there is no offline fallback, because there is
// no local counter left to fall back to. That is the trade this migration
// makes deliberately: a network dependency in exchange for a claim that is
// atomic everywhere and always, not atomic on one machine and merely
// "usually fine" everywhere else.
//
// Usage:
//   npm run allocate-deliverable -- --title "Short deliverable title" [--branch name] [--who name] [--body "..."]
//   npm run allocate-deliverable -- --list [--state open|closed|all]
//   npm run allocate-deliverable -- --status <number>
//   npm run allocate-deliverable -- --release <number> --reason "..."
//
// On a successful claim, EXACTLY ONE LINE goes to stdout: `D<number>` - the
// same contract the old script had, so `NUM=$(npm run --silent
// allocate-deliverable -- --title "..." )` still works unchanged. Everything
// else (confirmation detail, list output, errors) goes to stderr.
//
// D218: this file makes a real fetch to api.github.com, so - exactly like
// gh-api.js - it must NEVER call process.exit() after that point: doing so
// has been reproduced to abort the node process outright on this machine
// (Windows/node 24) and return exit code 127 instead of the one requested.
// Every path below sets process.exitCode and lets the event loop drain.

import {
  claimDeliverableNumber, releaseDeliverableNumber, getDeliverableIssue, listDeliverableIssues,
} from './lib/deliverable-issues.js';

const USAGE = `Usage:
  npm run allocate-deliverable -- --title "Short title" [--branch name] [--who name] [--body "..."]
  npm run allocate-deliverable -- --list [--state open|closed|all]
  npm run allocate-deliverable -- --status <number>
  npm run allocate-deliverable -- --release <number> --reason "..."`;

function parseArgs(argv) {
  const out = {
    title: null, branch: null, who: null, body: '', list: false, state: 'all', status: null, release: null, reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') { out.title = argv[++i]; continue; }
    if (a === '--branch') { out.branch = argv[++i]; continue; }
    if (a === '--who') { out.who = argv[++i]; continue; }
    if (a === '--body') { out.body = argv[++i]; continue; }
    if (a === '--list') { out.list = true; continue; }
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--status') { out.status = argv[++i]; continue; }
    if (a === '--release') { out.release = argv[++i]; continue; }
    if (a === '--reason') { out.reason = argv[++i]; continue; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    const issues = await listDeliverableIssues({ state: args.state });
    if (issues.length === 0) {
      console.log('(no deliverable issues recorded)');
    } else {
      for (const i of issues) {
        console.log(`D${i.number}  ${i.title}  [${i.state}]  ${i.html_url}`);
      }
    }
  } else if (args.status) {
    const n = Number(args.status);
    const issue = await getDeliverableIssue(n);
    console.log(JSON.stringify(issue, null, 2));
  } else if (args.release) {
    const n = Number(args.release);
    await releaseDeliverableNumber(n, { reason: args.reason });
    console.error(`D${n} released (issue closed)${args.reason ? ` - ${args.reason}` : ''}. The number will never be reissued.`);
  } else if (args.title) {
    const { number, url, createdAt } = await claimDeliverableNumber({
      title: args.title,
      body: args.body,
      branch: args.branch,
      claimedBy: args.who,
    });
    console.error(`Claimed D${number} at ${createdAt} for "${args.title}"${args.branch ? ` on branch ${args.branch}` : ''}.`);
    console.error(`  ${url}`);
    console.log(`D${number}`);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exitCode = 1;
});
