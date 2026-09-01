// Structured JSON-lines logging for BetSheet.
//
// Named streams, one active JSONL file each under the log dir:
//   app            - server lifecycle, HTTP requests, errors
//   fetch-audit    - every consensus-fetch attempt (invariant 11: a failing
//                    source must be visible, never silently thin the cards)
//   decision-trace - card-generation decision events (invariant 7: every
//                    dollar on a card replayable as "decided X because Y")
//
// Machine-first: one self-describing JSON object per line. Phase 3 feeds
// these files to LLMs to analyze the generation algorithm, so facts get
// their own fields; free text is only ever a supplementary `reason`/`msg`.
// Every event: { ts, level, stream, event, correlationId?, ...fields }.
//
// Rotation: by size and by calendar day, whichever comes first. Rotated
// files stay uncompressed ("hot") for HOT_DAYS, are gzipped past that, and
// are deleted past HOT_DAYS + COMPRESSED_DAYS - no unbounded growth. The
// sweep runs at startup and on the first append of each new day.
//
// Writes are synchronous appends that never throw to the caller: losing one
// log line is better than failing the operation being logged. Synchronous on
// purpose - async appends raced the rotation rename (a rotation could move
// the file out from under queued writes), and at this app's scale (local,
// single-process, ~100-byte lines) a sync append costs nothing. Modeled on
// life-swipe's server/log-store.js, generalized to multiple streams and
// day-based retention.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const CONFIG = {
  dir: process.env.BETSHEET_LOG_DIR
    ? path.resolve(ROOT, process.env.BETSHEET_LOG_DIR)
    : path.join(ROOT, 'server', 'logs'),
  level: process.env.BETSHEET_LOG_LEVEL || 'info',
  maxBytes: Number(process.env.BETSHEET_LOG_MAX_BYTES) || 10 * 1024 * 1024,
  hotDays: Number(process.env.BETSHEET_LOG_HOT_DAYS) || 7,
  compressedDays: Number(process.env.BETSHEET_LOG_COMPRESSED_DAYS) || 60,
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const STREAMS = ['app', 'fetch-audit', 'decision-trace'];

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const ensureDir = () => fs.mkdirSync(CONFIG.dir, { recursive: true });

const activePath = (stream) => path.join(CONFIG.dir, `${stream}.jsonl`);

// Rotated: <stream>.<day-the-file-covers>.<rotation-epoch>.jsonl[.gz]
const rotatedRe = (stream) =>
  new RegExp(`^${stream}\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d+)\\.jsonl(\\.gz)?$`);

// Per-stream in-memory counters so a rotation decision never re-reads the
// whole file. Seeded from disk once, on first use of each stream.
const state = new Map(); // stream -> { bytes, day }

function seedState(stream) {
  ensureDir();
  const p = activePath(stream);
  let bytes = 0;
  let day = dayOf(Date.now());
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    bytes = st.size;
    if (st.size > 0) day = dayOf(st.mtimeMs);
  }
  const s = { bytes, day };
  state.set(stream, s);
  return s;
}

function rotate(stream, s) {
  const p = activePath(stream);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
    s.bytes = 0;
    s.day = dayOf(Date.now());
    return;
  }
  // Bump the epoch past any existing rotation so two rotations in the same
  // millisecond cannot rename onto each other and silently drop a file.
  let epoch = Date.now();
  while (fs.existsSync(path.join(CONFIG.dir, `${stream}.${s.day}.${epoch}.jsonl`))) epoch++;
  fs.renameSync(p, path.join(CONFIG.dir, `${stream}.${s.day}.${epoch}.jsonl`));
  s.bytes = 0;
  s.day = dayOf(Date.now());
}

// Compress hot rotated files past hotDays; delete compressed ones past
// hotDays + compressedDays. Age is measured from the rotation epoch in the
// filename - no stat calls, no dependence on filesystem timestamps.
function sweep() {
  ensureDir();
  const now = Date.now();
  for (const stream of STREAMS) {
    const re = rotatedRe(stream);
    for (const f of fs.readdirSync(CONFIG.dir)) {
      const m = f.match(re);
      if (!m) continue;
      const ageDays = (now - Number(m[2])) / DAY_MS;
      const full = path.join(CONFIG.dir, f);
      try {
        if (m[3]) {
          if (ageDays > CONFIG.hotDays + CONFIG.compressedDays) fs.unlinkSync(full);
        } else if (ageDays > CONFIG.hotDays) {
          fs.writeFileSync(`${full}.gz`, zlib.gzipSync(fs.readFileSync(full)));
          fs.unlinkSync(full);
        }
      } catch {
        /* sweep is best-effort; a locked file is retried next sweep */
      }
    }
  }
}

let lastSweepDay = null;

function append(stream, level, event, fields) {
  try {
    if (LEVELS[level] < (LEVELS[CONFIG.level] ?? LEVELS.info)) return;
    const s = state.get(stream) || seedState(stream);
    const today = dayOf(Date.now());
    if (s.bytes >= CONFIG.maxBytes || (s.bytes > 0 && s.day !== today)) {
      rotate(stream, s);
    }
    if (lastSweepDay !== today) {
      lastSweepDay = today;
      sweep();
    }
    const record = { ts: new Date().toISOString(), level, stream, event, ...fields };
    const line = JSON.stringify(record) + '\n';
    s.bytes += Buffer.byteLength(line);
    s.day = today;
    fs.appendFileSync(activePath(stream), line);
  } catch {
    /* logging never throws to the caller */
  }
}

/**
 * Get a logger for one stream. Usage:
 *   const log = getLogger('app');
 *   log.info('server_started', { port: 8788 });
 * Pass a correlationId in the fields of every event that belongs to a card
 * session (invariant 8).
 */
export function getLogger(stream) {
  if (!STREAMS.includes(stream)) throw new Error(`unknown log stream: ${stream}`);
  return {
    debug: (event, fields = {}) => append(stream, 'debug', event, fields),
    info: (event, fields = {}) => append(stream, 'info', event, fields),
    warn: (event, fields = {}) => append(stream, 'warn', event, fields),
    error: (event, fields = {}) => append(stream, 'error', event, fields),
  };
}

/** One ID per card session, stamped on every event that belongs to it. */
export const newCorrelationId = () => crypto.randomUUID();

/**
 * Read the newest `limit` events of a stream, newest first, scanning the
 * active file and rotated files (decompressing .gz) as needed. Optional
 * `filter(record) -> boolean`. Modest-scale scan-on-read, same trade as
 * life-swipe's log store: fine for a single-process local app.
 */
export function readRecent(stream, { limit = 100, filter = null } = {}) {
  ensureDir();
  const files = [activePath(stream)];
  const re = rotatedRe(stream);
  const rotated = fs.readdirSync(CONFIG.dir)
    .map((f) => ({ f, m: f.match(re) }))
    .filter(({ m }) => m)
    .sort((a, b) => Number(b.m[2]) - Number(a.m[2]))
    .map(({ f }) => path.join(CONFIG.dir, f));
  files.push(...rotated);

  const out = [];
  for (const file of files) {
    if (out.length >= limit) break;
    if (!fs.existsSync(file)) continue;
    let text;
    try {
      const raw = fs.readFileSync(file);
      text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (!filter || filter(rec)) out.push(rec);
      } catch {
        /* a torn line (crash mid-append) is skipped, not fatal */
      }
    }
  }
  return out;
}

/**
 * Factory reset support: remove every stream's active and rotated files
 * and zero the in-memory counters. ONLY the explicit app reset calls this
 * (invariant 12's one exception) - nothing else ever deletes log files.
 * Returns the number of files removed.
 */
export function resetLogs() {
  ensureDir();
  let removed = 0;
  for (const stream of STREAMS) {
    const re = rotatedRe(stream);
    for (const f of fs.readdirSync(CONFIG.dir)) {
      if (f === `${stream}.jsonl` || re.test(f)) {
        try { fs.unlinkSync(path.join(CONFIG.dir, f)); removed++; } catch { /* locked; skipped */ }
      }
    }
    state.set(stream, { bytes: 0, day: dayOf(Date.now()) });
  }
  lastSweepDay = null;
  return removed;
}

/** Exposed for the verification script only. */
export const _config = CONFIG;
