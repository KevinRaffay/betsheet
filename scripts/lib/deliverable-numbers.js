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
// file instead of the real shared one.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Derived 2026-09-09 by walking `git log --oneline --all` across every
// worktree on this machine (main is at D201/bf6ab4a; a not-yet-merged
// worktree had already minted D202 locally before this tool existed to stop
// it) - so the first number this tool hands out is D203, not D202. Only
// matters for a brand-new database; once seeded, the persisted counter is
// what governs every later claim.
export const DEFAULT_NEXT_NUMBER = 203;

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

/** Opens (creating and seeding if needed) the allocator database. */
export function openAllocatorDb(dbPath = resolveDbPath()) {
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

  // INSERT OR IGNORE against a PRIMARY KEY row is race-safe on its own -
  // SQLite serializes writers - so no explicit transaction is needed just
  // to seed once.
  withRetry(() => db.prepare(
    'INSERT OR IGNORE INTO deliverable_counter (id, next_number) VALUES (1, ?)',
  ).run(DEFAULT_NEXT_NUMBER));

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
