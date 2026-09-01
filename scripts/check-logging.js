// Verification for server/logging.js - exits non-zero on any failure.
// Run: npm run check-logging
//
// Exercises the behaviors that matter, not the lines: day rotation, size
// rotation, the gzip/retention sweep (against pre-seeded files with old
// rotation epochs, so no waiting), read-across-rotations, torn-line
// tolerance, and level gating. House rule from life-swipe: a check that has
// never failed has not been tested. This suite earned that on day one - its
// first run caught two real bugs (async appends racing the rotation rename,
// and same-millisecond rotations renaming onto each other), and the sweep
// checks were confirmed to fail against a deliberately disabled sweep.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-logcheck-'));
process.env.BETSHEET_LOG_DIR = dir;
process.env.BETSHEET_LOG_LEVEL = 'info';
process.env.BETSHEET_LOG_MAX_BYTES = '400';
process.env.BETSHEET_LOG_HOT_DAYS = '1';
process.env.BETSHEET_LOG_COMPRESSED_DAYS = '2';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// --- pre-seed, before the module ever sees the directory ---

// 1. An active app.jsonl "from yesterday": first append today must rotate it.
const yesterdayLine = JSON.stringify({ ts: 'seeded', event: 'from_yesterday' }) + '\n';
fs.writeFileSync(path.join(dir, 'app.jsonl'), yesterdayLine);
const yesterday = new Date(Date.now() - DAY_MS);
fs.utimesSync(path.join(dir, 'app.jsonl'), yesterday, yesterday);

// 2. A rotated file 2 days old: past hotDays (1), inside retention -> gzipped.
const twoDaysAgo = Date.now() - 2 * DAY_MS;
const hotName = `app.${dayOf(twoDaysAgo)}.${twoDaysAgo}.jsonl`;
const hotContent = JSON.stringify({ ts: 'old', event: 'should_be_gzipped' }) + '\n';
fs.writeFileSync(path.join(dir, hotName), hotContent);

// 3. A compressed file 5 days old: past hotDays+compressedDays (3) -> deleted.
const fiveDaysAgo = Date.now() - 5 * DAY_MS;
const staleName = `app.${dayOf(fiveDaysAgo)}.${fiveDaysAgo}.jsonl.gz`;
fs.writeFileSync(path.join(dir, staleName), zlib.gzipSync('{"event":"stale"}\n'));

// --- exercise ---

const { getLogger, newCorrelationId, readRecent } = await import('../server/logging.js');
const log = getLogger('app');
const cid = newCorrelationId();

log.info('first_of_today', { correlationId: cid });
log.debug('below_threshold', { correlationId: cid });
await sleep(250);

const files = () => fs.readdirSync(dir);

check('day rotation: yesterday\'s content moved to a rotated file',
  files().some((f) => /^app\.\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(f) &&
    fs.readFileSync(path.join(dir, f), 'utf8').includes('from_yesterday')),
  `files: ${files().join(', ')}`);

check('day rotation: active file holds only today\'s event',
  (() => {
    const text = fs.readFileSync(path.join(dir, 'app.jsonl'), 'utf8');
    return text.includes('first_of_today') && !text.includes('from_yesterday');
  })());

check('level gating: debug event dropped at info level',
  !fs.readFileSync(path.join(dir, 'app.jsonl'), 'utf8').includes('below_threshold'));

check('sweep: 2-day-old rotated file gzipped, content intact',
  fs.existsSync(path.join(dir, `${hotName}.gz`)) &&
  !fs.existsSync(path.join(dir, hotName)) &&
  zlib.gunzipSync(fs.readFileSync(path.join(dir, `${hotName}.gz`))).toString() === hotContent);

check('sweep: 5-day-old compressed file pruned',
  !fs.existsSync(path.join(dir, staleName)));

// Size rotation: each event ~120 bytes against a 400-byte cap.
const before = files().filter((f) => f.startsWith('app.') && f !== 'app.jsonl').length;
for (let i = 0; i < 10; i++) log.info('bulk_event', { i, pad: 'x'.repeat(60), correlationId: cid });
await sleep(300);
const after = files().filter((f) => f.startsWith('app.') && f !== 'app.jsonl').length;
check('size rotation: bulk writes past the byte cap produced rotations',
  after > before, `rotated files before=${before} after=${after}`);

check('active file stays under ~2x the byte cap',
  fs.statSync(path.join(dir, 'app.jsonl')).size < 800);

// Streams are separate files.
getLogger('fetch-audit').info('fetch_attempt', { source: 'test', outcome: 'ok' });
getLogger('decision-trace').info('rule_fired', { rule: 'place_money_rule', correlationId: cid });
await sleep(250);
check('streams write to separate files',
  fs.existsSync(path.join(dir, 'fetch-audit.jsonl')) &&
  fs.existsSync(path.join(dir, 'decision-trace.jsonl')));

// Torn line (crash mid-append) must not break reads.
fs.appendFileSync(path.join(dir, 'app.jsonl'), '{"ts":"torn","eve');
const recent = readRecent('app', { limit: 100 });
check('readRecent: skips a torn line, parses the rest',
  recent.length > 0 && recent.every((r) => r.event));

check('readRecent: newest first',
  recent[0].event === 'bulk_event' && recent[0].i === 9);

check('readRecent: reaches back through rotated and gzipped files',
  recent.some((r) => r.event === 'from_yesterday') &&
  recent.some((r) => r.event === 'should_be_gzipped'));

check('readRecent: filter narrows to one correlation id',
  readRecent('app', { limit: 100, filter: (r) => r.correlationId === cid })
    .every((r) => r.correlationId === cid));

check('correlation ids are unique',
  newCorrelationId() !== newCorrelationId());

fs.rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-logging: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-logging: all checks passed');
