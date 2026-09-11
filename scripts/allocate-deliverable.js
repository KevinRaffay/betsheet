// CLI onto scripts/lib/deliverable-numbers.js (D203) - see that file's
// header for WHY this exists (concurrent agents colliding on the same D
// number) and WHERE the database lives (the shared .git common dir, so
// every worktree on this machine sees the same counter).
//
// The one thing to remember: run this BEFORE picking a branch name or
// writing a ledger row, and use the number it prints. Reading
// DELIVERABLES.md and incrementing the highest row by hand is exactly the
// race this replaces - don't.
//
// D226: on a brand-new database (a fresh clone, a cloud session - anywhere
// the shared .git counter does not exist) the first number is SEEDED FROM
// DELIVERABLES.md's high-water mark rather than a hardcoded constant, and
// this CLI prints to stderr which seed it picked and where from. stdout is
// still exactly `D<number>` and nothing else.
//
// Usage:
//   npm run allocate-deliverable -- --title "Short deliverable title" [--branch name] [--who name]
//   npm run allocate-deliverable -- --list [--status claimed|released|all]
//   npm run allocate-deliverable -- --status <number>
//   npm run allocate-deliverable -- --release <number> --reason "..."
//
// On a successful claim, EXACTLY ONE LINE goes to stdout: `D<number>` - so
// `NUM=$(npm run --silent allocate-deliverable -- --title "..." )` is safe to
// script. Everything else (confirmation detail, list output, errors) goes to
// stderr or is clearly the whole point of --list/--status.

import {
  openAllocatorDb,
  closeAllocatorDb,
  claimDeliverableNumber,
  releaseDeliverableNumber,
  listDeliverableClaims,
  getDeliverableClaim,
  resolveLedgerPath,
} from './lib/deliverable-numbers.js';

const USAGE = `Usage:
  npm run allocate-deliverable -- --title "Short title" [--branch name] [--who name]
  npm run allocate-deliverable -- --list [--status claimed|released|all]
  npm run allocate-deliverable -- --status <number>
  npm run allocate-deliverable -- --release <number> --reason "..."`;

function parseArgs(argv) {
  const out = { title: null, branch: null, who: null, list: false, status: null, release: null, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') { out.title = argv[++i]; continue; }
    if (a === '--branch') { out.branch = argv[++i]; continue; }
    if (a === '--who') { out.who = argv[++i]; continue; }
    if (a === '--list') { out.list = true; continue; }
    if (a === '--status') { out.status = argv[++i]; continue; }
    if (a === '--release') { out.release = argv[++i]; continue; }
    if (a === '--reason') { out.reason = argv[++i]; continue; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// D226: say so, loudly, when this process creates the counter from nothing.
// A brand-new database means a clone that cannot see any other machine's
// counter, and the seed it picked is the single most important thing to be
// able to check afterwards - silence here is what let a cloud session take
// D203 and only notice because a human recognised the number.
const db = openAllocatorDb(undefined, {
  onSeed: ({ seed, highWater, source }) => {
    console.error(
      source === 'ledger'
        ? `New allocator database seeded at D${seed}, from the ledger high-water mark D${highWater} (${resolveLedgerPath()}).`
        : `New allocator database seeded at D${seed}, the built-in floor - the ledger `
          + `${highWater === null ? 'could not be read' : `stops at D${highWater}`} `
          + `(${resolveLedgerPath()}). If this checkout's DELIVERABLES.md is incomplete, `
          + `verify the number before using it.`,
    );
  },
});

try {
  if (args.list) {
    const rows = listDeliverableClaims(db, { status: args.status });
    if (rows.length === 0) {
      console.log('(no claims recorded)');
    } else {
      for (const r of rows) {
        const suffix = r.status === 'released' ? ` [released${r.release_reason ? `: ${r.release_reason}` : ''}]` : '';
        console.log(`D${r.number}  ${r.title}  (${r.branch || 'no branch'}, claimed by ${r.claimed_by || 'unknown'} at ${r.claimed_at})${suffix}`);
      }
    }
  } else if (args.status) {
    const n = Number(args.status);
    const row = getDeliverableClaim(db, n);
    if (!row) {
      console.error(`No claim on record for D${n}.`);
      process.exit(1);
    }
    console.log(JSON.stringify(row, null, 2));
  } else if (args.release) {
    const n = Number(args.release);
    const row = releaseDeliverableNumber(db, n, { reason: args.reason, releasedBy: args.who });
    console.error(`D${n} marked released${args.reason ? ` (${args.reason})` : ''}. The number will never be reissued.`);
    console.log(JSON.stringify(row));
  } else if (args.title) {
    const { number, claimedAt } = claimDeliverableNumber(db, {
      title: args.title,
      branch: args.branch,
      claimedBy: args.who,
    });
    console.error(`Claimed D${number} at ${claimedAt} for "${args.title}"${args.branch ? ` on branch ${args.branch}` : ''}.`);
    console.log(`D${number}`);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
} finally {
  closeAllocatorDb(db);
}
