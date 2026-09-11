// A single, atomic source of truth for "what is the next D number" (D203).
//
// Why this exists: this repo runs many Claude Code agents at once, each in
// its OWN git worktree under .claude/worktrees/. Every agent used to pick
// its deliverable's D number by reading DELIVERABLES.md/CLAUDE.md and
// eyeballing the highest row - which is exactly the kind of read-then-write
// race that produces duplicates. It already happened for real: D200 was
// claimed by two concurrent sessions, and the loser had to renumber to D201
// on rebase (see DELIVERABLES.md's own D201 row). This module replaces the
// eyeball with a real atomic claim.
//
// WHERE THE DATABASE LIVES, AND WHY: `git worktree list` shows every
// worktree of this checkout shares ONE git directory - `git rev-parse
// --git-common-dir` resolves to it from any of them. A file dropped there is
// visible to every worktree on this machine, is never tracked by git (so it
// can never itself cause a merge conflict - the thing it exists to prevent),
// and needs no path to be remembered or agreed on ahead of time. It is NOT
// visible across machines or separate clones (betsheet-alt is a separate
// clone by design, see CLAUDE.md's Gotchas) - this is a same-machine,
// same-checkout coordination tool, not a networked one.
//
// WHY NUMBERS ARE NEVER RECYCLED, EVEN ON release(): the same reasoning as
// invariant 12 (race-day ids are never reused) and the D77-A/D77-B
// split-ID rule (a colliding number gets suffixes, never a renumber) - by
// the time anyone notices a claim was abandoned, the number may already be
// cited in a branch name, a commit, or a half-open PR. Recycling it would
// recreate the exact collision this file exists to prevent. release() only
// annotates a claim as abandoned; it never frees the number for reuse.
//
// BETSHEET_DELIVERABLE_DB overrides the resolved path entirely - the same
// escape hatch this codebase already gives BETSHEET_DB/BETSHEET_LOG_DIR -
// used by check-deliverable-numbers.js to run every test against a throwaway
// file instead of the real shared one. BETSHEET_DELIVERABLE_LEDGER (D226)
// does the same for the file the SEED is read from, so the check script can
// point at a fixture rather than at this repo's own moving DELIVERABLES.md.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// The FLOOR, not the seed (D226 made the seed dynamic - see below).
//
// Derived 2026-09-09 by walking `git log --oneline --all` across every
// worktree on this machine (main was at D201/bf6ab4a; a not-yet-merged
// worktree had already minted D202 locally before this tool existed to stop
// it) - so the first number this tool ever handed out was D203, not D202.
// It is kept as a hard lower bound because it encodes one fact the ledger
// cannot: a number minted on a branch that was never merged, and so appears
// in NO committed row. Nothing may ever seed below it.
export const DEFAULT_NEXT_NUMBER = 203;

// D226: WHY THE SEED IS READ FROM THE LEDGER RATHER THAN HARDCODED.
//
// The counter lives in the shared `.git` common dir, which a SEPARATE CLONE
// does not have - a cloud session, a fresh `git clone`, betsheet-alt. Such a
// clone opens a brand-new database, seeds it from scratch, and confidently
// issues a number that was consumed long ago. That is not hypothetical: on
// 2026-09-11 a cloud session ran the allocator for D225's work and was handed
// D203, a number whose own ledger row is the one describing this very tool.
// The number had to be released and the eyeball-the-ledger fallback used
// instead - and that fallback is the exact read-then-write race this module
// was built to delete, so "just eyeball it over there" quietly reintroduces
// the bug in the one environment that cannot see the counter.
//
// DELIVERABLES.md is the right source because it is the ledger: CLAUDE.md's
// delivery workflow requires every deliverable to carry a row, and that file
// is committed, so any clone with a checkout has it. Only the ID COLUMN is
// read (`| D225 | ...`), never the prose - a cell may cite a dozen other D
// numbers, and a loose scan of the whole line would also read things like a
// date or an identifier that merely starts with D. Suffixed IDs (D44-QA,
// D77-A) parse to their base number, which is what the counter cares about.
//
// The ledger is a FLOOR-RAISER, never a floor-lowerer: the seed is
// max(ledger high-water + 1, DEFAULT_NEXT_NUMBER). A truncated, empty or
// unreadable ledger can therefore only fall back to the old constant, never
// hand out a number below it. Seeding HIGH is safe (a skipped number costs
// nothing - the never-recycle rule already accepts gaps); seeding LOW is the
// bug, so every ambiguity resolves upward.
//
// This is NOT a cross-machine coordinator and does not pretend to be. It
// cannot see a number minted on an unmerged branch in a different clone -
// the same limitation as before, now with a far better floor. A number
// already in a merged row is exactly what it does see.
const LEDGER_ROW_ID_RE = /^\|\s*D(\d{1,6})(?:-[A-Za-z0-9]+)?\s*\|/;

/** The ledger to seed from - override wins, else this checkout's DELIVERABLES.md. */
export function resolveLedgerPath() {
  if (process.env.BETSHEET_DELIVERABLE_LEDGER) {
    return path.resolve(process.env.BETSHEET_DELIVERABLE_LEDGER);
  }
  return fileURLToPath(new URL('../../DELIVERABLES.md', import.meta.url));
}

/**
 * The highest D number in the ledger's ID column, or null if the file is
 * missing/unreadable/has no rows. Never throws - a seed must not be able to
 * take down every command that opens the database.
 */
export function ledgerHighWaterMark(ledgerPath = resolveLedgerPath()) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return null;
  }
  let max = null;
  for (const line of text.split(/\r?\n/)) {
    const m = LEDGER_ROW_ID_RE.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * What a brand-new database should be seeded to.
 * Returns { seed, highWater, source } where source is 'ledger' when the
 * ledger actually raised the floor and 'floor' when DEFAULT_NEXT_NUMBER won.
 */
export function resolveSeedNumber({ ledgerPath } = {}) {
  const highWater = ledgerHighWaterMark(ledgerPath);
  const fromLedger = highWater === null ? null : highWater + 1;
  const seed = fromLedger !== null && fromLedger > DEFAULT_NEXT_NUMBER ? fromLedger : DEFAULT_NEXT_NUMBER;
  return { seed, highWater, source: seed === fromLedger ? 'ledger' : 'floor' };
}

function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function isBusyError(err) {
  return Boolean(err) && (err.code === 'SQLITE_BUSY' || /database is locked/i.test(err.message || ''));
}

// better-sqlite3's own busy_timeout already waits out most lock contention;
// this is a belt-and-braces retry for the rare case a BUSY still surfaces
// (seen most often as several processes opening a brand-new file for the
// first time at once, during the CREATE TABLE / seed step below).
function withRetry(fn, { retries = 30, baseDelayMs = 20 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= retries) throw err;
      sleepSync(baseDelayMs * (attempt + 1) + Math.floor(Math.random() * baseDelayMs));
    }
  }
}

/** The shared allocator database path - override wins, else the common .git dir. */
export function resolveDbPath() {
  if (process.env.BETSHEET_DELIVERABLE_DB) {
    return path.resolve(process.env.BETSHEET_DELIVERABLE_DB);
  }
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const abs = path.isAbsolute(commonDir) ? commonDir : path.resolve(process.cwd(), commonDir);
  return path.join(abs, 'deliverable-numbers.sqlite');
}

/**
 * Opens (creating and seeding if needed) the allocator database.
 *
 * `onSeed({ seed, highWater, source })` fires ONLY when this call actually
 * created the counter row - i.e. this process won the seed race on a
 * brand-new database. A caller can use it to say out loud where the seed
 * came from, which is the difference between a fresh clone silently
 * reissuing D203 and one announcing that it started at D226.
 */
export function openAllocatorDb(dbPath = resolveDbPath(), { onSeed = null, ledgerPath } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  withRetry(() => db.exec(`
    CREATE TABLE IF NOT EXISTS deliverable_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_number INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliverable_claims (
      number INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      branch TEXT,
      claimed_by TEXT,
      claimed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      released_at TEXT,
      release_reason TEXT
    );
  `));

  // The ledger is read ONLY when the counter row is genuinely absent, so the
  // overwhelmingly common case (an existing database) costs no file I/O and
  // cannot be affected by a later edit to DELIVERABLES.md. Once seeded, the
  // persisted counter governs every claim forever after - the ledger is a
  // starting point, never an ongoing authority.
  const existing = withRetry(() => db.prepare('SELECT next_number FROM deliverable_counter WHERE id = 1').get());
  if (!existing) {
    const info = resolveSeedNumber({ ledgerPath });
    // INSERT OR IGNORE against a PRIMARY KEY row is race-safe on its own -
    // SQLite serializes writers - so no explicit transaction is needed just
    // to seed once. If a concurrent process seeded first, changes === 0 and
    // ITS value stands; onSeed stays silent, because this process did not
    // choose the seed.
    const res = withRetry(() => db.prepare(
      'INSERT OR IGNORE INTO deliverable_counter (id, next_number) VALUES (1, ?)',
    ).run(info.seed));
    if (res.changes > 0 && onSeed) onSeed(info);
  }

  return db;
}

export function closeAllocatorDb(db) {
  db.close();
}

/** Atomically claims the next D number. Returns { number, claimedAt }. */
export function claimDeliverableNumber(db, { title, branch = null, claimedBy = null } = {}) {
  if (!title || !title.trim()) {
    throw new Error('claimDeliverableNumber requires a non-empty title');
  }
  const runClaim = db.transaction(() => {
    const row = db.prepare('SELECT next_number FROM deliverable_counter WHERE id = 1').get();
    const number = row.next_number;
    db.prepare('UPDATE deliverable_counter SET next_number = ? WHERE id = 1').run(number + 1);
    const claimedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO deliverable_claims (number, title, branch, claimed_by, claimed_at, status)
      VALUES (?, ?, ?, ?, ?, 'claimed')
    `).run(number, title.trim(), branch, claimedBy, claimedAt);
    return { number, claimedAt };
  });
  // BEGIN IMMEDIATE - the read-then-write inside must not start deferred,
  // or two processes can both read the same next_number before either
  // upgrades to a write lock.
  return withRetry(() => runClaim.immediate());
}

/** Marks a claim abandoned. Never frees the number - see header. Idempotent. */
export function releaseDeliverableNumber(db, number, { reason = null, releasedBy = null } = {}) {
  const runRelease = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM deliverable_claims WHERE number = ?').get(number);
    if (!existing) throw new Error(`No claim on record for D${number}`);
    if (existing.status !== 'released') {
      db.prepare(`
        UPDATE deliverable_claims SET status = 'released', released_at = ?, release_reason = ?
        WHERE number = ?
      `).run(new Date().toISOString(), reason, number);
    }
    return db.prepare('SELECT * FROM deliverable_claims WHERE number = ?').get(number);
  });
  return withRetry(() => runRelease.immediate());
}

export function getDeliverableClaim(db, number) {
  return db.prepare('SELECT * FROM deliverable_claims WHERE number = ?').get(number) || null;
}

export function listDeliverableClaims(db, { status = null } = {}) {
  if (status && status !== 'all') {
    return db.prepare('SELECT * FROM deliverable_claims WHERE status = ? ORDER BY number').all(status);
  }
  return db.prepare('SELECT * FROM deliverable_claims ORDER BY number').all();
}

export function nextNumberPreview(db) {
  return db.prepare('SELECT next_number FROM deliverable_counter WHERE id = 1').get().next_number;
}

// Admin escape hatch for disaster recovery only - e.g. the database was
// deleted and needs to be re-seeded past every number already in use.
// Refuses to move the counter DOWN into a range that could reissue an
// already-claimed number unless --force is explicit, because that would
// recreate the exact bug this file exists to fix.
export function setNextNumber(db, n, { force = false } = {}) {
  const highestClaimed = db.prepare('SELECT MAX(number) AS n FROM deliverable_claims').get().n || 0;
  if (!force && n <= highestClaimed) {
    throw new Error(
      `Refusing to set next_number to ${n}: D${highestClaimed} is already claimed. Pass force to override.`,
    );
  }
  withRetry(() => db.prepare('UPDATE deliverable_counter SET next_number = ? WHERE id = 1').run(n));
}
