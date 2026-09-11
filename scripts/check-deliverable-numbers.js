// Verification for scripts/lib/deliverable-numbers.js + allocate-deliverable.js
// (D203). Everything here runs against a THROWAWAY database via
// BETSHEET_DELIVERABLE_DB - never the real shared one in .git/, which every
// worktree on this machine reads from.
//
// The load-bearing assertion is the concurrency one: it spawns many real
// child processes (not in-process calls) claiming against the SAME database
// at once, the way independent worktree agents actually would, and asserts
// every number they get back is unique and the whole run is contiguous from
// the seed. That is the actual bug this tool exists to fix - D200 was
// claimed by two concurrent sessions before this existed.
//
// D226: every existing case below now pins BETSHEET_DELIVERABLE_LEDGER to a
// path that CANNOT exist, so the seed falls back to DEFAULT_NEXT_NUMBER and
// the assertions stay exactly as deterministic as they were when the seed
// was a constant. Without that pin they would drift every time a row is
// added to the real DELIVERABLES.md - a check that changes answer because an
// unrelated deliverable shipped is a check nobody trusts. The seeding
// behaviour itself is tested separately, against written fixtures.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  DEFAULT_NEXT_NUMBER,
  ledgerHighWaterMark,
  resolveLedgerPath,
  resolveSeedNumber,
  openAllocatorDb,
  closeAllocatorDb,
  claimDeliverableNumber,
  releaseDeliverableNumber,
  getDeliverableClaim,
  listDeliverableClaims,
  nextNumberPreview,
  setNextNumber,
  resolveDbPath,
} from './lib/deliverable-numbers.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOCATE_CLI = path.join(ROOT, 'scripts', 'allocate-deliverable.js');

// A ledger path that cannot exist, so resolveSeedNumber() falls back to the
// built-in floor. Set process-wide here and passed to every spawned child,
// so that both the in-process cases and the CLI cases below see a constant
// seed regardless of what the real ledger currently says.
const NO_LEDGER = path.join(os.tmpdir(), 'betsheet-no-such-ledger', 'DELIVERABLES.md');
process.env.BETSHEET_DELIVERABLE_LEDGER = NO_LEDGER;

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failures++;
}
function assertTrue(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures++;
}

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-deliverable-numbers-'));
  return path.join(dir, 'deliverable-numbers.sqlite');
}

// ---------- path resolution (no writes - just checks the string) ----------
{
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', cwd: ROOT }).trim();
  const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(ROOT, commonDir);
  const expected = path.join(abs, 'deliverable-numbers.sqlite');
  assertEqual(resolveDbPath(), expected, 'resolveDbPath() (no override) points at the shared .git common dir');
}
{
  const override = tempDbPath();
  process.env.BETSHEET_DELIVERABLE_DB = override;
  assertEqual(resolveDbPath(), path.resolve(override), 'BETSHEET_DELIVERABLE_DB overrides the resolved path');
  delete process.env.BETSHEET_DELIVERABLE_DB;
}

// ---------- basic claim/seed behaviour, on a throwaway db ----------
{
  const dbPath = tempDbPath();
  const db = openAllocatorDb(dbPath);

  assertEqual(nextNumberPreview(db), DEFAULT_NEXT_NUMBER, 'a fresh database seeds next_number to DEFAULT_NEXT_NUMBER');

  const first = claimDeliverableNumber(db, { title: 'first claim', branch: 'b1', claimedBy: 'agent-a' });
  assertEqual(first.number, DEFAULT_NEXT_NUMBER, 'first claim gets the seeded number');

  const second = claimDeliverableNumber(db, { title: 'second claim', branch: 'b2', claimedBy: 'agent-b' });
  assertEqual(second.number, DEFAULT_NEXT_NUMBER + 1, 'second claim is one higher, never a repeat');

  closeAllocatorDb(db);
  const reopened = openAllocatorDb(dbPath);
  assertEqual(nextNumberPreview(reopened), DEFAULT_NEXT_NUMBER + 2, 're-seeding is a no-op once a counter exists');

  const third = claimDeliverableNumber(reopened, { title: 'third claim' });
  assertEqual(third.number, DEFAULT_NEXT_NUMBER + 2, 'the counter persists across process/db-handle boundaries');

  let threw = false;
  try { claimDeliverableNumber(reopened, { title: '' }); } catch { threw = true; }
  assertTrue(threw, 'an empty title is refused rather than silently claiming a number');

  closeAllocatorDb(reopened);
}

// ---------- release semantics: annotated, never recycled ----------
{
  const dbPath = tempDbPath();
  const db = openAllocatorDb(dbPath);
  const { number } = claimDeliverableNumber(db, { title: 'will be abandoned' });

  const released = releaseDeliverableNumber(db, number, { reason: 'redirected', releasedBy: 'agent-a' });
  assertEqual(released.status, 'released', 'release marks the claim released');
  assertEqual(released.release_reason, 'redirected', 'release records the reason');

  const again = releaseDeliverableNumber(db, number, { reason: 'second call' });
  assertEqual(again.release_reason, 'redirected', 'releasing an already-released claim is idempotent, not overwritten');

  const next = claimDeliverableNumber(db, { title: 'claimed after a release' });
  assertTrue(next.number > number, 'a released number is never reissued - the next claim moves forward');

  let threw = false;
  try { releaseDeliverableNumber(db, 999999); } catch { threw = true; }
  assertTrue(threw, 'releasing a number with no claim on record is refused');

  const claims = listDeliverableClaims(db, { status: 'released' });
  assertEqual(claims.map((c) => c.number), [number], 'listDeliverableClaims filters by status');

  assertEqual(getDeliverableClaim(db, number).status, 'released', 'getDeliverableClaim reads back the current status');
  assertEqual(getDeliverableClaim(db, 424242), null, 'getDeliverableClaim on an unknown number returns null, not a throw');

  closeAllocatorDb(db);
}

// ---------- setNextNumber: the disaster-recovery escape hatch ----------
{
  const dbPath = tempDbPath();
  const db = openAllocatorDb(dbPath);
  const { number: claimed } = claimDeliverableNumber(db, { title: 'occupies a number' });

  let threw = false;
  try { setNextNumber(db, claimed); } catch { threw = true; }
  assertTrue(threw, 'setNextNumber refuses to move the counter into an already-claimed number without force');

  setNextNumber(db, claimed, { force: true });
  assertEqual(nextNumberPreview(db), claimed, 'setNextNumber with force overrides the counter');

  setNextNumber(db, claimed + 50);
  assertEqual(nextNumberPreview(db), claimed + 50, 'setNextNumber moving forward needs no force');

  closeAllocatorDb(db);
}

// ---------- the actual bug: many concurrent real processes, one database ----------
async function runAllocateCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ALLOCATE_CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

{
  const dbPath = tempDbPath();
  // Seed the db once up front so every child process claims against the
  // same, already-created file rather than racing on its creation too -
  // this test is about the CLAIM race, not database creation.
  closeAllocatorDb(openAllocatorDb(dbPath));

  const CONCURRENCY = 25;
  const env = { ...process.env, BETSHEET_DELIVERABLE_DB: dbPath };
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runAllocateCli(
      ['--title', `concurrent claim ${i}`, '--branch', `worker-${i}`, '--who', 'check-script'],
      env,
    )),
  );

  const failed = results.filter((r) => r.code !== 0);
  assertEqual(failed.length, 0, `all ${CONCURRENCY} concurrent CLI invocations exit 0 (${failed.map((r) => r.stderr).join(' | ')})`);

  const numbers = results.map((r) => Number(r.stdout.replace(/^D/, '')));
  const unique = new Set(numbers);
  assertEqual(unique.size, CONCURRENCY, `${CONCURRENCY} concurrent real processes claim ${CONCURRENCY} DISTINCT numbers - no two agents ever get the same D number`);

  const sorted = [...unique].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  assertTrue(contiguous, 'the claimed numbers form one contiguous run from the seed, with no gap and no repeat');
  assertEqual(sorted[0], DEFAULT_NEXT_NUMBER, 'the run starts exactly at the seeded next number');

  const db = openAllocatorDb(dbPath);
  const claims = listDeliverableClaims(db);
  assertEqual(claims.length, CONCURRENCY, 'every concurrent claim left exactly one row in the ledger table');
  assertEqual(nextNumberPreview(db), DEFAULT_NEXT_NUMBER + CONCURRENCY, 'the persisted counter advanced by exactly one per claim, no more and no less');
  closeAllocatorDb(db);
}

// ---------- CLI argument handling ----------
{
  const dbPath = tempDbPath();
  const env = { ...process.env, BETSHEET_DELIVERABLE_DB: dbPath };

  const noArgs = await runAllocateCli([], env);
  assertEqual(noArgs.code, 2, 'the CLI with no recognized flags exits 2 and prints usage');

  const claim = await runAllocateCli(['--title', 'cli smoke test', '--branch', 'b'], env);
  assertEqual(claim.code, 0, 'a real --title claim via the CLI exits 0');
  assertEqual(claim.stdout, `D${DEFAULT_NEXT_NUMBER}`, 'stdout is EXACTLY `D<number>` and nothing else - safe to capture in a shell variable');

  const list = await runAllocateCli(['--list'], env);
  assertTrue(list.stdout.includes(`D${DEFAULT_NEXT_NUMBER}`) && list.stdout.includes('cli smoke test'), '--list shows the claim just made');

  const status = await runAllocateCli(['--status', String(DEFAULT_NEXT_NUMBER)], env);
  const parsed = JSON.parse(status.stdout);
  assertEqual(parsed.status, 'claimed', '--status <n> prints the claim as JSON');

  const release = await runAllocateCli(['--release', String(DEFAULT_NEXT_NUMBER), '--reason', 'cli smoke test done'], env);
  assertEqual(release.code, 0, '--release exits 0');

  const unknownRelease = await runAllocateCli(['--release', '9999999'], env);
  assertEqual(unknownRelease.code, 1, 'releasing an unknown number exits 1 rather than silently succeeding');
}


// ---------- D226: seeding a brand-new database from the ledger ----------
function writeLedger(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-ledger-'));
  const file = path.join(dir, 'DELIVERABLES.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const LEDGER_HEAD = '| ID | Deliverable | Phase | PR # / branch | Status | Notes |\n| --- | --- | --- | --- | --- | --- |\n';

{
  // -- parsing the ID column --
  const ordinary = writeLedger(LEDGER_HEAD
    + '| D225 | most recent | - | branch x | merged | notes |\n'
    + '| D224 | older | - | branch y | merged | notes |\n'
    + '| D9 | ancient | 1 | - | merged | notes |\n');
  assertEqual(ledgerHighWaterMark(ordinary), 225, 'ledgerHighWaterMark reads the highest ID, not the first or last row');

  // THE load-bearing parsing assertions: a Notes cell routinely cites a dozen
  // other D numbers (D224's real cell cites D223 and D216 among others), and
  // DELIVERABLES.md also carries prose OUTSIDE the table. A loose scan would
  // read any of them - and one citing a FUTURE number ("superseded by D999")
  // would poison the counter for every later claim.
  //
  // Two fixtures, because the two plausible loose implementations fail
  // differently and one fixture does not catch both. A per-line regex
  // returning the FIRST match still gets the ID right on a table row (the ID
  // column comes first), so only a NON-ROW line discriminates against it; a
  // global match taking the max within a line is caught by the in-row case.
  // The first version of this check had only the in-row fixture and passed
  // under a deliberately loosened regex - it was verifying nothing.
  const proseyOutsideTable = writeLedger(LEDGER_HEAD
    + '| D210 | a deliverable | - | branch z | merged | ordinary notes |\n'
    + '\nThis file once mentioned D999 in a paragraph below the table.\n'
    + '- and a bullet citing D888.\n');
  assertEqual(ledgerHighWaterMark(proseyOutsideTable), 210,
    'ONLY table rows count - a D number in prose or a bullet outside the table is ignored');

  const proseyInsideCell = writeLedger(LEDGER_HEAD
    + '| D210 | a deliverable | - | branch z | merged | supersedes D999, see also D888 and D44-QA |\n');
  assertEqual(ledgerHighWaterMark(proseyInsideCell), 210,
    'ONLY the ID column counts - a higher number cited later in the same row\'s Notes cell is ignored');

  const suffixed = writeLedger(LEDGER_HEAD
    + '| D44-QA | a QA-branch deliverable | - | - | merged | notes |\n'
    + '| D77-A | a split deliverable | - | - | merged | notes |\n');
  assertEqual(ledgerHighWaterMark(suffixed), 77, 'a suffixed ID (D44-QA, D77-A) parses to its base number');

  const crlf = writeLedger(LEDGER_HEAD.replace(/\n/g, '\r\n')
    + '| D207 | windows line endings | - | - | merged | notes |\r\n');
  assertEqual(ledgerHighWaterMark(crlf), 207, 'CRLF line endings parse the same as LF');

  const noRows = writeLedger('# DELIVERABLES\n\nNothing here yet.\n');
  assertEqual(ledgerHighWaterMark(noRows), null, 'a ledger with no ID rows reads as null, not 0');

  assertEqual(
    ledgerHighWaterMark(path.join(os.tmpdir(), 'betsheet-absent', 'nope.md')),
    null,
    'a missing ledger returns null rather than throwing - seeding must never take down every command',
  );
}

{
  // -- turning a high-water mark into a seed --
  const ahead = writeLedger(LEDGER_HEAD + '| D225 | current | - | - | merged | notes |\n');
  assertEqual(
    resolveSeedNumber({ ledgerPath: ahead }),
    { seed: 226, highWater: 225, source: 'ledger' },
    'a ledger ahead of the floor seeds to high-water + 1 - the whole point of D226',
  );

  // The safety property. A stale, truncated or partially-written ledger must
  // never drag the counter DOWN into numbers that are already spent; the
  // floor encodes D202, which no committed row mentions at all.
  const behind = writeLedger(LEDGER_HEAD + '| D50 | ancient checkout | - | - | merged | notes |\n');
  assertEqual(
    resolveSeedNumber({ ledgerPath: behind }),
    { seed: DEFAULT_NEXT_NUMBER, highWater: 50, source: 'floor' },
    'a ledger BEHIND the floor never lowers the seed - DEFAULT_NEXT_NUMBER wins',
  );

  const missing = path.join(os.tmpdir(), 'betsheet-absent', 'nope.md');
  assertEqual(
    resolveSeedNumber({ ledgerPath: missing }),
    { seed: DEFAULT_NEXT_NUMBER, highWater: null, source: 'floor' },
    'an unreadable ledger falls back to the floor, never to 0 or NaN',
  );

  const exact = writeLedger(LEDGER_HEAD + `| D${DEFAULT_NEXT_NUMBER - 1} | boundary | - | - | merged | notes |\n`);
  assertEqual(
    resolveSeedNumber({ ledgerPath: exact }).seed,
    DEFAULT_NEXT_NUMBER,
    'the boundary case (high-water + 1 === the floor) resolves to the floor, with no off-by-one',
  );
}

{
  // -- the REAL ledger, which is the case that actually matters --
  // This is a live assertion, not a fixture: if DELIVERABLES.md's row format
  // ever changes, the parse silently returns null and every fresh clone goes
  // back to reissuing D203. That regression is invisible - the allocator
  // still "works" - so it has to be asserted against the real file.
  const realLedger = path.join(ROOT, 'DELIVERABLES.md');
  const realHigh = ledgerHighWaterMark(realLedger);
  assertTrue(
    Number.isInteger(realHigh) && realHigh >= 225,
    `the REAL DELIVERABLES.md still parses - high-water is D${realHigh} (a format change that broke this would silently reinstate the D203 bug)`,
  );
  assertEqual(
    resolveSeedNumber({ ledgerPath: realLedger }).source,
    'ledger',
    'the real ledger is ahead of the floor, so a fresh clone seeds from it rather than from the constant',
  );

  process.env.BETSHEET_DELIVERABLE_LEDGER = realLedger;
  assertEqual(resolveLedgerPath(), realLedger, 'BETSHEET_DELIVERABLE_LEDGER overrides the resolved ledger path');
  process.env.BETSHEET_DELIVERABLE_LEDGER = NO_LEDGER;
  assertEqual(
    path.basename(resolveLedgerPath()),
    'DELIVERABLES.md',
    'the resolved ledger path is always a DELIVERABLES.md',
  );
}

{
  // -- end to end: the seed reaches a real claim, and fires onSeed once --
  const ledger = writeLedger(LEDGER_HEAD + '| D300 | far ahead | - | - | merged | notes |\n');
  const dbPath = tempDbPath();

  const seeds = [];
  const db = openAllocatorDb(dbPath, { ledgerPath: ledger, onSeed: (info) => seeds.push(info) });
  assertEqual(nextNumberPreview(db), 301, 'a brand-new database seeds from the ledger, not from DEFAULT_NEXT_NUMBER');
  assertEqual(seeds, [{ seed: 301, highWater: 300, source: 'ledger' }], 'onSeed fires exactly once, with where the seed came from');

  const claimed = claimDeliverableNumber(db, { title: 'first claim on a fresh clone' });
  assertEqual(claimed.number, 301, 'the first real claim gets the ledger-derived number');
  closeAllocatorDb(db);

  // Reopening must NOT re-read the ledger: once seeded, the persisted
  // counter governs. Pointed at a ledger claiming a much higher number to
  // prove the reopen ignores it entirely.
  const laterLedger = writeLedger(LEDGER_HEAD + '| D900 | much later | - | - | merged | notes |\n');
  const reopened = openAllocatorDb(dbPath, { ledgerPath: laterLedger, onSeed: (info) => seeds.push(info) });
  assertEqual(nextNumberPreview(reopened), 302, 'reopening does NOT re-seed - the persisted counter wins over a changed ledger');
  assertEqual(seeds.length, 1, 'onSeed does not fire on a reopen, only on genuine creation');
  closeAllocatorDb(reopened);
}

{
  // -- concurrent creation: many processes racing to seed ONE new database --
  // The existing concurrency case deliberately pre-creates the file to isolate
  // the claim race. This one does the opposite: every child opens a database
  // that does not exist yet, so they race on the seed itself. All must agree.
  const ledger = writeLedger(LEDGER_HEAD + '| D400 | fresh clone | - | - | merged | notes |\n');
  const dbPath = tempDbPath();
  const CONCURRENCY = 8;
  const env = { ...process.env, BETSHEET_DELIVERABLE_DB: dbPath, BETSHEET_DELIVERABLE_LEDGER: ledger };
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runAllocateCli(['--title', `seed race ${i}`], env)),
  );

  assertEqual(results.filter((r) => r.code !== 0).length, 0, `all ${CONCURRENCY} processes racing to CREATE the database exit 0`);
  const numbers = results.map((r) => Number(r.stdout.replace(/^D/, ''))).sort((a, b) => a - b);
  assertEqual(new Set(numbers).size, CONCURRENCY, 'a seed race still yields distinct numbers - no two get the same one');
  assertEqual(numbers[0], 401, 'the run starts at the ledger-derived seed, not at DEFAULT_NEXT_NUMBER');
  assertEqual(
    numbers[numbers.length - 1], 400 + CONCURRENCY,
    'exactly one seed won: the run is contiguous from it, so no process seeded a second, competing value',
  );

  const seedNotices = results.filter((r) => /seeded at D401, from the ledger high-water mark D400/.test(r.stderr));
  assertEqual(seedNotices.length, 1, 'exactly ONE process reports having seeded the database, and it names the ledger it used');
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
