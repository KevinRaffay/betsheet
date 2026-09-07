// Verification for the static payload builder (D150).
// Run: npm run check-static-payload
//
// Two phases, in this order deliberately:
//
//  1. PURE - canonicalization and validation, no database. These are the
//     properties the whole round trip rests on: if canonicalJson is not
//     order-independent, `payloadHash` is a coin flip and D153's import check
//     is worse than useless (it would refuse honest files at random).
//
//  2. REAL - a real fixture day written through the REAL insertRaceDay into a
//     throwaway temp database, then built into a payload. Nothing here touches
//     data/betsheet.sqlite, and BETSHEET_LOG_DIR is redirected BEFORE the
//     first import of anything that initializes the logger (CLAUDE.md,
//     Gotchas: the log half of a reset reads the logger's own directory, so a
//     check that points only the DB somewhere safe is not actually isolated).
//
// The determinism check is the one worth reading. It builds the same day
// twice and requires an identical hash, and then builds it a third time WITH
// reference cards and requires the SAME hash again - the payload differs, the
// hash does not, because reference cards are an optional embed the importer
// cannot know about (shared/static-payload.js).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-staticpayload-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

const {
  canonicalJson, hashedRegion, validateStaticPayload,
  STATIC_PAYLOAD_SCHEMA, STATIC_PAYLOAD_SCHEMA_VERSION,
} = await import('../shared/static-payload.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

// ---------------------------------------------------------------- phase 1

console.log('-- canonicalJson is deterministic, which is what makes payloadHash checkable --');
{
  const a = { b: 1, a: 2, c: { z: 3, y: [1, 2, { q: 1, p: 2 }] } };
  const b = { c: { y: [1, 2, { p: 2, q: 1 }], z: 3 }, a: 2, b: 1 };
  check('key insertion order does not change the text', canonicalJson(a) === canonicalJson(b),
    `${canonicalJson(a)} vs ${canonicalJson(b)}`);
  check('array ORDER does change it (order is content, not presentation)',
    canonicalJson([1, 2]) !== canonicalJson([2, 1]));
  check('null survives as a value', canonicalJson({ m: null }) === '{"m":null}', canonicalJson({ m: null }));
  check('undefined is dropped, exactly as JSON.stringify drops it',
    canonicalJson({ m: undefined, n: 1 }) === '{"n":1}', canonicalJson({ m: undefined, n: 1 }));
  check('an undefined array element becomes null, as in JSON.stringify',
    canonicalJson([undefined]) === '[null]', canonicalJson([undefined]));
  check('strings are JSON-escaped, not concatenated raw',
    canonicalJson({ s: 'a"b\n' }) === '{"s":"a\\"b\\n"}', canonicalJson({ s: 'a"b\n' }));
}

console.log('\n-- hashedRegion covers the race day and nothing else --');
{
  const base = {
    schema: STATIC_PAYLOAD_SCHEMA, schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    raceDay: { raceDayId: 1 }, races: [{ number: 1 }],
    referenceCards: null, generatedAt: 'A', payloadHash: 'sha256:x',
  };
  const moved = { ...base, referenceCards: [{ cardId: 9 }], generatedAt: 'B', payloadHash: 'sha256:y' };
  check('generatedAt, referenceCards and payloadHash are all outside it',
    canonicalJson(hashedRegion(base)) === canonicalJson(hashedRegion(moved)));
  check('a changed entry IS inside it',
    canonicalJson(hashedRegion(base)) !== canonicalJson(hashedRegion({ ...base, races: [{ number: 2 }] })));
  check('the region carries exactly four keys',
    canonicalJson(Object.keys(hashedRegion(base)).sort()) === canonicalJson(['raceDay', 'races', 'schema', 'schemaVersion']),
    Object.keys(hashedRegion(base)).join(','));
}

console.log('\n-- validateStaticPayload names each problem rather than throwing --');
{
  const good = () => ({
    schema: STATIC_PAYLOAD_SCHEMA,
    schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    payloadHash: `sha256:${'a'.repeat(64)}`,
    raceDay: { raceDayId: 3, track: 'Del Mar', date: '2026-08-30', meet: 'DMR-2026-summer' },
    races: [{ number: 1, entries: [{ program_number: '1', horse_name: 'Tahini', scratched: false }] }],
    referenceCards: null,
  });
  check('a well-formed payload has no problems', validateStaticPayload(good()).length === 0,
    validateStaticPayload(good()).join('; '));

  const cases = [
    ['wrong schema', (p) => { p.schema = 'something-else'; }],
    ['wrong schemaVersion', (p) => { p.schemaVersion = 2; }],
    ['malformed payloadHash', (p) => { p.payloadHash = 'deadbeef'; }],
    ['no raceDayId', (p) => { delete p.raceDay.raceDayId; }],
    ['non-ISO date', (p) => { p.raceDay.date = '30/08/2026'; }],
    ['no races', (p) => { p.races = []; }],
    ['duplicate race number', (p) => { p.races.push({ ...p.races[0] }); }],
    ['a race with no entries', (p) => { p.races[0].entries = []; }],
    ['an entry with no program number', (p) => { delete p.races[0].entries[0].program_number; }],
    ['duplicate program number', (p) => { p.races[0].entries.push({ ...p.races[0].entries[0] }); }],
    ['scratched not a boolean', (p) => { p.races[0].entries[0].scratched = 0; }],
    ['referenceCards neither array nor null', (p) => { p.referenceCards = 'yes'; }],
    ['markup in a field', (p) => { p.races[0].conditions = 'Claiming <div class="nav">menu</div>'; }],
  ];
  for (const [name, breakIt] of cases) {
    const p = good();
    breakIt(p);
    check(`refuses: ${name}`, validateStaticPayload(p).length > 0);
  }

  for (const junk of [null, undefined, 'text', 42, []]) {
    let threw = false;
    try { validateStaticPayload(junk); } catch { threw = true; }
    check(`survives ${JSON.stringify(junk) ?? String(junk)} without throwing`, !threw);
  }
}

// ---------------------------------------------------------------- phase 2

console.log('\n-- a real fixture day, through the real writer, into a throwaway db --');

const { openDb } = await import('../server/db.js');
const { insertRaceDay } = await import('../server/ingest.js');
const { buildStaticPayload, payloadHashOf } = await import('./build-static-payload.js');

const db = openDb(process.env.BETSHEET_DB);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));

const dayId = db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar',
  date: fixture.date,
  bankrollCents: 20000,
  perRaceMinCents: 500,
  races: fixture.races,
}, 'check-static-payload'))();

const built = buildStaticPayload(db, Number(dayId));
check('the day built without error', !built.error, built.error);
const payload = built.payload;

if (payload) {
  check('10 races, 98 entries - the fixture day, unchanged',
    payload.races.length === 10 && payload.races.reduce((a, r) => a + r.entries.length, 0) === 98,
    `${payload.races.length} races, ${payload.races.reduce((a, r) => a + r.entries.length, 0)} entries`);
  check('it validates against its own schema', validateStaticPayload(payload).length === 0,
    validateStaticPayload(payload).join('; '));
  check('payloadHash is the hash of the canonical text', payload.payloadHash === payloadHashOf(payload));
  check('race day identity is carried', payload.raceDay.track === 'Del Mar'
    && payload.raceDay.date === fixture.date && payload.raceDay.raceDayId === Number(dayId));
  check('the Del Mar meet came through shared/track-codes.js', payload.raceDay.meet === 'DMR-2026-summer',
    String(payload.raceDay.meet));
  check('every entry carries what the builder needs to price a ticket',
    payload.races.every((r) => r.entries.every((e) => 'morning_line' in e && 'morning_line_decimal' in e
      && typeof e.horse_name === 'string' && typeof e.scratched === 'boolean')));
  check('the wager menu rides along (a null one silently falls back to Del Mar minimums)',
    payload.races.every((r) => 'wagerMenu' in r));
  check('reference cards are OFF by default', payload.referenceCards === null);

  // The hard constraint, asserted rather than assumed.
  const text = JSON.stringify(payload);
  check('no Equibase HTML anywhere in the file',
    !/<\s*\/?\s*(?:html|head|body|table|tr|td|div|span|script)\b/i.test(text));
  check('no parser input smuggled in under another name',
    !/rawHtml|sourceHtml|pasteText|chartText/i.test(text));
}

console.log('\n-- the same day built twice is byte-identical where it matters --');
{
  const a = buildStaticPayload(db, Number(dayId)).payload;
  const b = buildStaticPayload(db, Number(dayId)).payload;
  check('two builds produce the same payloadHash', a.payloadHash === b.payloadHash,
    `${a.payloadHash} vs ${b.payloadHash}`);
  check('generatedAt is the only thing free to differ',
    canonicalJson({ ...a, generatedAt: null }) === canonicalJson({ ...b, generatedAt: null }));

  const withRefs = buildStaticPayload(db, Number(dayId), { referenceCards: true }).payload;
  check('--reference-cards does NOT move the hash (the importer cannot know the flag was used)',
    withRefs.payloadHash === a.payloadHash, `${withRefs.payloadHash} vs ${a.payloadHash}`);
  check('with no LLM or OTR card on the day, the embed is an empty list, not null',
    Array.isArray(withRefs.referenceCards) && withRefs.referenceCards.length === 0);

  // Negative control: the check above is only worth anything if a REAL change
  // to the race day does move the hash.
  db.prepare('UPDATE entries SET horse_name = ? WHERE id = (SELECT MIN(id) FROM entries)').run('Renamed Horse');
  const after = buildStaticPayload(db, Number(dayId)).payload;
  check('NEGATIVE CONTROL: renaming one horse moves the hash', after.payloadHash !== a.payloadHash);
  db.prepare('UPDATE entries SET horse_name = ? WHERE id = (SELECT MIN(id) FROM entries)')
    .run(fixture.races[0].entries[0].horseName ?? fixture.races[0].entries[0].horse_name);
  check('and restoring it brings the hash back', buildStaticPayload(db, Number(dayId)).payload.payloadHash === a.payloadHash);
}

console.log('\n-- days a payload must refuse --');
{
  check('an unknown race day is an error, not a crash', Boolean(buildStaticPayload(db, 99999).error));
  db.prepare('UPDATE race_days SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), dayId);
  const deleted = buildStaticPayload(db, Number(dayId));
  check('a soft-deleted day is refused (invariant 12)', Boolean(deleted.error)
    && /deleted/i.test(deleted.error), deleted.error);
  db.prepare('UPDATE race_days SET deleted_at = NULL WHERE id = ?').run(dayId);
  check('restoring it makes the day buildable again', !buildStaticPayload(db, Number(dayId)).error);
}

console.log('\n-- the CLI, run as a real subprocess --');
{
  const out = path.join(tmp, 'payload.json');
  const run = (args) => execFileSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-static-payload.js'), ...args],
    { env: process.env, encoding: 'utf8' });

  const stdout = run([String(dayId), '--out', out]);
  check('it wrote the file it said it wrote', fs.existsSync(out));
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('the written file validates', validateStaticPayload(onDisk).length === 0);
  check('stdout names the hash it wrote', stdout.includes(onDisk.payloadHash));
  check('the CLI and the module agree on the hash',
    onDisk.payloadHash === buildStaticPayload(db, Number(dayId)).payload.payloadHash);

  const refOut = path.join(tmp, 'payload-refs.json');
  run([String(dayId), '--out', refOut, '--reference-cards']);
  const refs = JSON.parse(fs.readFileSync(refOut, 'utf8'));
  check('--reference-cards embeds an array rather than null', Array.isArray(refs.referenceCards));
  check('and still hashes the same as the plain build', refs.payloadHash === onDisk.payloadHash);

  let failedLoudly = false;
  try { run(['--out', out]); } catch { failedLoudly = true; }
  check('a missing race day id exits non-zero', failedLoudly);
  failedLoudly = false;
  try { run([String(dayId), '--nonsense']); } catch { failedLoudly = true; }
  check('an unrecognized argument exits non-zero', failedLoudly);
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-static-payload: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-static-payload: all checks passed');
