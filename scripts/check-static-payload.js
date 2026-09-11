// Verification for the static payload builder (D150, redesigned v4 by D329).
// Run: npm run check-static-payload
//
// Two phases, in this order deliberately:
//
//  1. PURE - canonicalization and validation, no database. These are the
//     properties the whole round trip rests on: if canonicalJson is not
//     order-independent, a day's `payloadHash` is a coin flip.
//
//  2. REAL - two real fixture days written through the REAL insertRaceDay
//     into a throwaway temp database, bundled together, with one graded
//     HUMAN card. Nothing here touches data/betsheet.sqlite, and
//     BETSHEET_LOG_DIR is redirected BEFORE the first import of anything
//     that initializes the logger (CLAUDE.md, Gotchas).
//
// The determinism section is the one worth reading. It builds the same
// bundle twice and requires identical per-day hashes, regrades the card and
// requires the hash to STAY THE SAME (a regrade is not a change to the
// field), then renames a horse and requires the hash to MOVE (the negative
// control the positive check is worthless without).

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

console.log('-- canonicalJson is deterministic, which is what makes a day\'s payloadHash checkable --');
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

console.log('\n-- hashedRegion covers ONE day\'s race day and races, nothing else --');
{
  const base = {
    raceDay: { raceDayId: 1 }, races: [{ number: 1 }],
    cards: [{ id: 9 }], generatedAt: 'A', payloadHash: 'sha256:x',
  };
  const moved = { ...base, cards: [{ id: 9, grades: { rows: [1] } }], generatedAt: 'B', payloadHash: 'sha256:y' };
  check('generatedAt, cards and payloadHash are all outside it',
    canonicalJson(hashedRegion(base)) === canonicalJson(hashedRegion(moved)));
  check('a changed race IS inside it',
    canonicalJson(hashedRegion(base)) !== canonicalJson(hashedRegion({ ...base, races: [{ number: 2 }] })));
  check('the region carries exactly four keys',
    canonicalJson(Object.keys(hashedRegion(base)).sort()) === canonicalJson(['raceDay', 'races', 'schema', 'schemaVersion']),
    Object.keys(hashedRegion(base)).join(','));
}

console.log('\n-- validateStaticPayload names each problem rather than throwing --');
{
  const goodDay = () => ({
    payloadHash: `sha256:${'a'.repeat(64)}`,
    raceDay: { raceDayId: 3, track: 'Del Mar', date: '2026-08-30', meet: 'DMR-2026-summer', timezone: 'America/Los_Angeles' },
    races: [{ number: 1, entries: [{ program_number: '1', horse_name: 'Tahini', scratched: false }] }],
    cards: [{
      id: 5, tickets: [{ sequence: 1, bet_type: 'win', selections: { races: [1], legs: [['1']] }, cost_cents: 2000, teller_call: '$20 W 1' }],
      allocations: [{ race_number: 1 }], grades: null,
    }],
  });
  const good = () => ({
    schema: STATIC_PAYLOAD_SCHEMA, schemaVersion: STATIC_PAYLOAD_SCHEMA_VERSION,
    generatedAt: 'A', raceDays: [goodDay()],
  });
  check('a well-formed payload has no problems', validateStaticPayload(good()).length === 0,
    validateStaticPayload(good()).join('; '));

  const cases = [
    ['wrong schema', (p) => { p.schema = 'something-else'; }],
    ['wrong schemaVersion', (p) => { p.schemaVersion = 2; }],
    ['no raceDays', (p) => { p.raceDays = []; }],
    ['duplicate raceDayId', (p) => { p.raceDays.push(goodDay()); }],
    ['malformed payloadHash', (p) => { p.raceDays[0].payloadHash = 'deadbeef'; }],
    ['no raceDayId', (p) => { delete p.raceDays[0].raceDay.raceDayId; }],
    ['non-ISO date', (p) => { p.raceDays[0].raceDay.date = '30/08/2026'; }],
    ['timezone not string or null', (p) => { p.raceDays[0].raceDay.timezone = 42; }],
    ['no races', (p) => { p.raceDays[0].races = []; }],
    ['duplicate race number', (p) => { p.raceDays[0].races.push({ ...p.raceDays[0].races[0] }); }],
    ['a race with no entries', (p) => { p.raceDays[0].races[0].entries = []; }],
    ['an entry with no program number', (p) => { delete p.raceDays[0].races[0].entries[0].program_number; }],
    ['duplicate program number', (p) => { p.raceDays[0].races[0].entries.push({ ...p.raceDays[0].races[0].entries[0] }); }],
    ['scratched not a boolean', (p) => { p.raceDays[0].races[0].entries[0].scratched = 0; }],
    ['a card with no id', (p) => { delete p.raceDays[0].cards[0].id; }],
    ['a ticket missing sequence', (p) => { delete p.raceDays[0].cards[0].tickets[0].sequence; }],
    ['a ticket missing bet_type', (p) => { delete p.raceDays[0].cards[0].tickets[0].bet_type; }],
    ['a ticket missing teller_call', (p) => { delete p.raceDays[0].cards[0].tickets[0].teller_call; }],
    ['an allocation referencing an absent race', (p) => { p.raceDays[0].cards[0].allocations[0].race_number = 99; }],
    ['grades neither null nor {rows, summary}', (p) => { p.raceDays[0].cards[0].grades = 'yes'; }],
    ['markup in a field', (p) => { p.raceDays[0].races[0].conditions = 'Claiming <div class="nav">menu</div>'; }],
    ['markup in a card thesis', (p) => { p.raceDays[0].cards[0].allocations = [{ race_number: 1, thesis: '<script>x</script>' }]; }],
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

console.log('\n-- two real fixture days, through the real writer, into a throwaway db --');

const { openDb } = await import('../server/db.js');
const { insertRaceDay } = await import('../server/ingest.js');
const { seedTemplates } = await import('../server/templates.js');
const { persistHumanRace } = await import('../server/human-cards.js');
const { gradeAndPersist } = await import('../server/grading.js');
const { buildStaticPayload, buildStaticDay, payloadHashOf } = await import('./build-static-payload.js');

const db = openDb(process.env.BETSHEET_DB);
seedTemplates(db);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));

const dayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
}, 'check-static-payload'))());
// A SECOND day - same fixture races, a different date - so multi-day
// bundling is exercised for real, not just claimed to work.
const secondDayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: '2026-08-31', bankrollCents: 15000, perRaceMinCents: 500, races: fixture.races,
}, 'check-static-payload'))());

// One graded HUMAN card on the first day, so the payload's cards/grades path
// is exercised against a real grade, not just an empty array.
const race1 = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number LIMIT 1').get(dayId);
const pgm = db.prepare('SELECT program_number FROM entries WHERE race_id = ? AND scratched = 0 LIMIT 1').get(race1.id).program_number;
const { cardId } = persistHumanRace(db, { id: dayId }, {
  race: race1.number, text: `$20 W ${pgm}`, bankrollCents: 20000, correlationId: 'check-static-payload',
});
db.prepare(`INSERT INTO race_results (race_day_id, race_number, program_number, horse_name, finish_position, win_cents)
  VALUES (?, ?, ?, ?, 1, 900)`).run(dayId, race1.number, pgm, 'Test Winner');
gradeAndPersist(db, cardId, 'check-static-payload');

const built = buildStaticPayload(db, { dayIds: [dayId, secondDayId] });
check('the bundle built without error', !built.error, built.error);
const payload = built.payload;

if (payload) {
  check('raceDays.length matches the request', payload.raceDays.length === 2);
  const day1 = payload.raceDays.find((d) => d.raceDay.raceDayId === dayId);
  check('10 races, 98 entries - the fixture day, unchanged',
    day1.races.length === 10 && day1.races.reduce((a, r) => a + r.entries.length, 0) === 98,
    `${day1.races.length} races, ${day1.races.reduce((a, r) => a + r.entries.length, 0)} entries`);
  check('it validates against its own schema', validateStaticPayload(payload).length === 0,
    validateStaticPayload(payload).join('; '));
  check('day 1 payloadHash is the hash of its own canonical text', day1.payloadHash === payloadHashOf(day1));
  check('race day identity is carried', day1.raceDay.track === 'Del Mar'
    && day1.raceDay.date === fixture.date && day1.raceDay.raceDayId === dayId);
  check('the Del Mar meet came through shared/track-codes.js', day1.raceDay.meet === 'DMR-2026-summer',
    String(day1.raceDay.meet));
  check('the timezone came through shared/track-codes.js too', day1.raceDay.timezone === 'America/Los_Angeles',
    String(day1.raceDay.timezone));
  check('every entry carries what a card needs to price a ticket',
    day1.races.every((r) => r.entries.every((e) => 'morning_line' in e && 'morning_line_decimal' in e
      && typeof e.horse_name === 'string' && typeof e.scratched === 'boolean')));
  check('the wager menu rides along (a null one silently falls back to Del Mar minimums)',
    day1.races.every((r) => 'wagerMenu' in r));
  check('every card is included unconditionally - no reference-cards flag any more',
    day1.cards.length === 1);
  check('the one card is graded, with a real WIN outcome',
    day1.cards[0].grades.summary != null && day1.cards[0].grades.rows[0].outcome === 'win',
    JSON.stringify(day1.cards[0].grades));
  const secondDay = payload.raceDays.find((d) => d.raceDay.raceDayId === secondDayId);
  check('the second, cardless day has an empty cards array, not a missing one',
    Array.isArray(secondDay.cards) && secondDay.cards.length === 0);

  // The hard constraint, asserted rather than assumed.
  const text = JSON.stringify(payload);
  check('no Equibase HTML anywhere in the file',
    !/<\s*\/?\s*(?:html|head|body|table|tr|td|div|span|script)\b/i.test(text));
  check('no parser input smuggled in under another name',
    !/rawHtml|sourceHtml|pasteText|chartText/i.test(text));
}

console.log('\n-- hash stability: per-day, unaffected by regrading, moved by a real entry change --');
{
  const before = buildStaticDay(db, dayId).day.payloadHash;

  // Adding a SECOND day to the bundle must not move the FIRST day's hash -
  // the whole reason the hash is per-day rather than bundle-wide.
  const soloDay = buildStaticDay(db, dayId).day;
  const bundledDay = buildStaticPayload(db, { dayIds: [dayId, secondDayId] }).payload.raceDays
    .find((d) => d.raceDay.raceDayId === dayId);
  check('a day\'s hash is the same whether built alone or bundled with another day',
    soloDay.payloadHash === bundledDay.payloadHash);

  // Regrading is not a change to the FIELD - the hash must not move.
  gradeAndPersist(db, cardId, 'check-static-payload-regrade');
  const afterRegrade = buildStaticDay(db, dayId).day.payloadHash;
  check('regrading the card does NOT move the day\'s hash', before === afterRegrade,
    `${before} vs ${afterRegrade}`);

  // Negative control: the two checks above are only worth anything if a REAL
  // change to the race day DOES move the hash.
  const entryId = db.prepare('SELECT id FROM entries WHERE race_id = ?').get(race1.id).id;
  db.prepare('UPDATE entries SET horse_name = ? WHERE id = ?').run('Renamed Horse', entryId);
  const afterRename = buildStaticDay(db, dayId).day.payloadHash;
  check('NEGATIVE CONTROL: renaming one horse moves the hash', afterRename !== before,
    `${afterRename} vs ${before}`);
  db.prepare('UPDATE entries SET horse_name = ? WHERE id = ?')
    .run(fixture.races[0].entries[0].horseName ?? fixture.races[0].entries[0].horse_name, entryId);
  check('and restoring it brings the hash back', buildStaticDay(db, dayId).day.payloadHash === before);
}

console.log('\n-- days a payload must refuse, without poisoning the others requested --');
{
  check('an unknown race day is an error, not a crash', Boolean(buildStaticPayload(db, { dayIds: [99999] }).error));
  db.prepare('UPDATE race_days SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), dayId);
  const deleted = buildStaticPayload(db, { dayIds: [dayId] });
  check('a soft-deleted day is refused (invariant 12)', Boolean(deleted.error)
    && /deleted/i.test(deleted.error), deleted.error);
  const mixedRequest = buildStaticPayload(db, { dayIds: [dayId, secondDayId] });
  check('a soft-deleted day refuses the WHOLE bundle rather than silently dropping it',
    Boolean(mixedRequest.error));
  db.prepare('UPDATE race_days SET deleted_at = NULL WHERE id = ?').run(dayId);
  check('restoring it makes the day buildable again', !buildStaticPayload(db, { dayIds: [dayId] }).error);
}

console.log('\n-- --from/--to resolves the same days the explicit-id form does --');
{
  const byIds = buildStaticPayload(db, { dayIds: [dayId, secondDayId] }).payload;
  const byRange = buildStaticPayload(db, { from: fixture.date, to: '2026-08-31' }).payload;
  const idsOf = (p) => p.raceDays.map((d) => d.raceDay.raceDayId).sort();
  check('the resolved day ids agree', JSON.stringify(idsOf(byIds)) === JSON.stringify(idsOf(byRange)),
    `${idsOf(byIds)} vs ${idsOf(byRange)}`);
  const byTrack = buildStaticPayload(db, { from: fixture.date, to: '2026-08-31', track: 'Del Mar' }).payload;
  check('an explicit --track narrows the same way', JSON.stringify(idsOf(byTrack)) === JSON.stringify(idsOf(byIds)));
  const noMatch = buildStaticPayload(db, { from: '2020-01-01', to: '2020-01-02' });
  check('a range matching nothing is an error, not an empty success', Boolean(noMatch.error));
}

console.log('\n-- the CLI, run as a real subprocess --');
{
  const out = path.join(tmp, 'payload.json');
  const run = (args) => execFileSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-static-payload.js'), ...args],
    { env: process.env, encoding: 'utf8' });

  const stdout = run([String(dayId), String(secondDayId), '--out', out]);
  check('it wrote the file it said it wrote', fs.existsSync(out));
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('the written file validates', validateStaticPayload(onDisk).length === 0,
    validateStaticPayload(onDisk).join('; '));
  const day1Hash = onDisk.raceDays.find((d) => d.raceDay.raceDayId === dayId).payloadHash;
  check('stdout names a day\'s hash it wrote', stdout.includes(day1Hash));
  check('the CLI and the module agree on the hash',
    day1Hash === buildStaticDay(db, dayId).day.payloadHash);

  const rangeOut = path.join(tmp, 'payload-range.json');
  run(['--from', fixture.date, '--to', '2026-08-31', '--out', rangeOut]);
  const rangeOnDisk = JSON.parse(fs.readFileSync(rangeOut, 'utf8'));
  check('the --from/--to CLI form resolves the same two days',
    rangeOnDisk.raceDays.length === 2);

  let failedLoudly = false;
  try { run(['--out', out]); } catch { failedLoudly = true; }
  check('no ids and no range exits non-zero', failedLoudly);
  failedLoudly = false;
  try { run([String(dayId), '--from', fixture.date, '--to', '2026-08-31']); } catch { failedLoudly = true; }
  check('mixing explicit ids with --from/--to exits non-zero', failedLoudly);
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
