// SQLite access for BetSheet, via better-sqlite3 (synchronous, which is the
// right shape for a local single-process app - same reasoning as the
// synchronous log appends in logging.js).
//
// openDb(path) opens/creates a database and brings it to the current schema
// by applying server/migrations/*.sql in numeric order, each in its own
// transaction, recorded in schema_migrations. Re-opening an up-to-date
// database applies nothing. getDb() is the server's lazy singleton at the
// configured path (BETSHEET_DB, default data/betsheet.sqlite).
//
// Migrations are append-only: a shipped migration file is never edited -
// schema changes are new numbered files. The check script asserts the
// applied-migration digests still match the files on disk.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { getLogger } from './logging.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, 'server', 'migrations');
const DEFAULT_PATH = process.env.BETSHEET_DB
  ? path.resolve(ROOT, process.env.BETSHEET_DB)
  : path.join(ROOT, 'data', 'betsheet.sqlite');

const log = getLogger('app');

// Hashes are computed over CANONICAL text (CRLF folded to LF). Raw-byte
// hashing shipped first and produced false tamper alarms on Windows: git's
// autocrlf rewrites a migration's line endings whenever a branch switch
// re-materializes the file, so the same content hashed two ways depending
// on checkout history. Line endings are presentation, not content.
const canonical = (text) => text.replace(/\r\n/g, '\n');
const digest = (text) => crypto.createHash('sha256').update(canonical(text)).digest('hex');
const rawDigest = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A record written by the raw-byte era matches one of the same content's
// line-ending variants; anything else is a real edit.
function isLegacyEndingVariant(prior, sql) {
  const lf = canonical(sql);
  return prior === rawDigest(sql) ||
    prior === rawDigest(lf) ||
    prior === rawDigest(lf.replace(/\n/g, '\r\n'));
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

export function openDb(dbPath = DEFAULT_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);

  const applied = new Map(
    db.prepare('SELECT name, sha256 FROM schema_migrations').all()
      .map((r) => [r.name, r.sha256]),
  );

  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const hash = digest(sql);
    const prior = applied.get(file);
    if (prior) {
      if (prior !== hash) {
        if (isLegacyEndingVariant(prior, sql)) {
          // Same content, different line endings (or a raw-era record):
          // self-heal the record to the canonical hash and move on.
          db.prepare('UPDATE schema_migrations SET sha256 = ? WHERE name = ?').run(hash, file);
          log.info('migration_hash_migrated', { migration: file, db: path.basename(dbPath) });
        } else {
          // Close before throwing: an open handle on the refused database
          // keeps the file locked on Windows.
          db.close();
          throw new Error(
            `migration ${file} changed after being applied (recorded ${prior.slice(0, 12)}, ` +
            `on disk ${hash.slice(0, 12)}). Shipped migrations are append-only - add a new file.`,
          );
        }
      }
      continue;
    }
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, sha256) VALUES (?, ?)').run(file, hash);
    });
    run();
    log.info('migration_applied', { migration: file, db: path.basename(dbPath) });
  }

  return db;
}

let singleton = null;

/** The server's database. Opens (and migrates) on first use. */
export function getDb() {
  if (!singleton) singleton = openDb();
  return singleton;
}
