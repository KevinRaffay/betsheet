// Verification for the static-card import (D153).
// Run: npm run check-static-import
//
// Runs against a throwaway temp database with the logger redirected there too
// (CLAUDE.md, Gotchas: pointing only BETSHEET_DB somewhere safe is not
// isolation - the log half of the app reads the LOGGER's own directory).
//
// The check that matters most is the third one. `the same file imported three
// times produces one set of cards` is D153's own done-when and the property
// every other piece of this feature leans on: the rolling backup in D152 is
// only free because re-importing is free, and manual file transfer between a
// phone and a laptop is only safe because sloppy transfer is safe. It is
// asserted by actually running the real CLI three times as a subprocess and
// counting rows, not by reasoning about the code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-staticimport-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

const { openDb } = await import('../server/db.js');
const { insertRaceDay } = await import('../server/ingest.js');
const { buildStaticPayload } = await import('./build-static-payload.js');
const { buildStaticExport, validateStaticExport, exportFileName } = await import('../shared/static-export.js');
const { readRecent } = await import('../server/logging.js');
const { parseHumanPicksText } = await import('../shared/parsers/human-picks.js');

const db = openDb(process.env.BETSHEET_DB);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
const dayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
}, 'check-static-import'))());
const payload = buildStaticPayload(db, dayId).payload;

console.log('-- migration 027 landed --');
{
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  for (const c of ['external_id', 'built_on', 'saw_reference_cards']) {
    check(`cards.${c} exists`, cols.includes(c));
  }
  const idx = db.prepare("SELECT name, \"unique\" FROM pragma_index_list('cards')").all();
  check('external_id is uniquely indexed', idx.some((i) => i.name === 'idx_cards_external_id' && i.unique === 1));
  // Many NULLs must coexist: every card that predates this has no external id.
  db.prepare("INSERT INTO cards (race_day_id, card_number, bankroll_cents, correlation_id, consensus_completeness, engine_version) VALUES (?, 900, 1, 'x', 'HUMAN', 'human')").run(dayId);
  db.prepare("INSERT INTO cards (race_day_id, card_number, bankroll_cents, correlation_id, consensus_completeness, engine_version) VALUES (?, 901, 1, 'x', 'HUMAN', 'human')").run(dayId);
  check('two cards with a NULL external_id coexist', true);
  db.prepare('DELETE FROM cards WHERE card_number IN (900, 901)').run();
}

// ------------------------------------------------------------------ fixtures

const pgmsFor = (n) => payload.races.find((r) => r.number === n).entries
  .filter((e) => !e.scratched).map((e) => e.program_number);

/**
 * What the phone's own parse of a race produces - the static app runs this
 * exact call, so a fixture that skipped it would not exercise the
 * device-vs-server ticket comparison the import reports on.
 */
const deviceTicketsFor = (number, text) => {
  const race = payload.races.find((r) => r.number === number);
  return parseHumanPicksText({
    text, race: number, entries: race.entries, wagerMenu: race.wagerMenu,
    scratchedProgramNumbers: race.entries.filter((e) => e.scratched).map((e) => e.program_number),
  }).tickets;
};

const deviceCard = (cardId, races, extra = {}) => ({
  cardId,
  deviceId: 'aa11bb22',
  name: 'at the track',
  bankrollCents: 20000,
  createdAt: '2026-08-30T18:00:00.000Z',
  updatedAt: '2026-08-30T19:00:00.000Z',
  sawReferenceCards: false,
  races: Object.fromEntries(races.map((r) => [r.number, {
    text: r.text,
    tickets: r.tickets ?? (r.passed ? [] : deviceTicketsFor(r.number, r.text)),
    lockedAt: r.lockedAt,
    passed: Boolean(r.passed),
  }])),
  ...extra,
});

const writeDoc = (name, cards) => {
  const doc = buildStaticExport({ cards, payload, deviceId: 'aa11bb22' });
  const p = path.join(tmp, name);
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return { path: p, doc };
};

const goodCard = deviceCard('aa11bb22-good1', [
  { number: 1, text: `$10 W ${pgmsFor(1)[0]}`, lockedAt: '2026-08-30T18:20:00.000Z' },
  { number: 2, text: `$2 EX BOX ${pgmsFor(2).slice(0, 3).join('-')}`, lockedAt: '2026-08-30T18:55:00.000Z' },
  { number: 3, text: '', lockedAt: '2026-08-30T19:00:00.000Z', passed: true },
]);
const good = writeDoc('good.json', [goodCard]);

console.log('\n-- the export the browser writes validates here --');
check('the fixture export is valid', validateStaticExport(good.doc).length === 0,
  validateStaticExport(good.doc).join('; '));
check('its filename follows betsheet-{raceDayId}-{device}-{timestamp}.json',
  /^betsheet-\d+-aa11bb22-\d{4}-\d{2}-\d{2}T[\d-]+\.json$/.test(exportFileName(good.doc)),
  exportFileName(good.doc));

const run = (args, expectFail = false) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'import-static-cards.js'), ...args],
      { env: process.env, encoding: 'utf8' });
    return { out, code: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status };
  }
};

console.log('\n-- dry run writes nothing --');
{
  const before = db.prepare('SELECT COUNT(*) n FROM cards').get().n;
  const { out } = run([good.path]);
  check('it says it would import', /would import/.test(out), out.slice(-300));
  check('it says it is a dry run', /Dry run - nothing written/.test(out));
  check('no card was written', db.prepare('SELECT COUNT(*) n FROM cards').get().n === before);
  check('--dry-run is accepted as an explicit alias', run([good.path, '--dry-run']).code === 0);
}

console.log('\n-- the same file imported three times produces ONE set of cards --');
{
  const first = run([good.path, '--yes']);
  check('the first run imports', /imported\s+aa11bb22-good1/.test(first.out), first.out.slice(-400));
  const cards = db.prepare("SELECT * FROM cards WHERE external_id = 'aa11bb22-good1'").all();
  check('exactly one card row', cards.length === 1, String(cards.length));

  const ticketsAfterFirst = db.prepare('SELECT COUNT(*) n FROM tickets WHERE card_id = ?').get(cards[0].id).n;
  check('its tickets landed', ticketsAfterFirst === 2, String(ticketsAfterFirst));

  const second = run([good.path, '--yes']);
  const third = run([good.path, '--yes']);
  check('the second run reports it already present', /already present/.test(second.out));
  check('the third run reports it already present', /already present/.test(third.out));
  check('still exactly one card row after three runs',
    db.prepare("SELECT COUNT(*) n FROM cards WHERE external_id = 'aa11bb22-good1'").get().n === 1);
  check('and the tickets did not multiply',
    db.prepare('SELECT COUNT(*) n FROM tickets WHERE card_id = ?').get(cards[0].id).n === ticketsAfterFirst,
    String(db.prepare('SELECT COUNT(*) n FROM tickets WHERE card_id = ?').get(cards[0].id).n));
  check('the summary line counts them as already present', /1 already present/.test(third.out), third.out.slice(-200));
}

console.log('\n-- what the imported card actually looks like --');
{
  const card = db.prepare("SELECT * FROM cards WHERE external_id = 'aa11bb22-good1'").get();
  check('it merges into the HUMAN bucket, not a bucket of its own',
    card.consensus_completeness === 'HUMAN' && card.engine_version === 'human',
    `${card.consensus_completeness} / ${card.engine_version}`);
  check('builtOn is recorded as fact', card.built_on === 'static-web', String(card.built_on));
  check('the card name came across', card.name === 'at the track', String(card.name));
  check('sawReferenceCards defaulted to 0', card.saw_reference_cards === 0);

  // Invariant 15: the derivation must read the DEVICE's lock times.
  const states = db.prepare('SELECT * FROM human_race_state WHERE card_id = ? ORDER BY race_number').all(card.id);
  check('every locked race kept the time it was locked at the track',
    states.length === 3
    && states[0].picks_locked_at === '2026-08-30T18:20:00.000Z'
    && states[1].picks_locked_at === '2026-08-30T18:55:00.000Z',
    states.map((s) => `${s.race_number}:${s.picks_locked_at}`).join(' '));
  check('the PASSED race is recorded as a pass', states[2].passed === 1 && states[2].race_number === 3);
  check('race_days.replayed_at is the EARLIEST real lock, not the import clock',
    db.prepare('SELECT replayed_at FROM race_days WHERE id = ?').get(dayId).replayed_at === '2026-08-30T18:20:00.000Z',
    String(db.prepare('SELECT replayed_at FROM race_days WHERE id = ?').get(dayId).replayed_at));

  const trace = readRecent('decision-trace', { limit: 5000, filter: (r) => r.cardId === card.id });
  check('the import wrote a static_card_imported trace event',
    trace.some((e) => e.event === 'static_card_imported' && e.externalId === 'aa11bb22-good1'));
  check('and the ordinary human-card events too (invariant 7\'s export half)',
    trace.some((e) => e.event === 'card_generated') && trace.filter((e) => e.event === 'ticket_added').length === 2);
  const ids = new Set(trace.map((e) => e.correlationId));
  check('all under ONE correlation id (invariant 8)', ids.size === 1, [...ids].join(', '));
}

console.log('\n-- refusals, each naming the check that failed --');
{
  const cases = [
    ['schema', 'bad-schema.json', (d) => { d.schemaVersion = 2; }, /REFUSED \[schema\]/],
    ['not HUMAN', 'not-human.json', (d) => { d.cards[0].engineVersion = 'llm'; }, /REFUSED \[schema\].*engineVersion/s],
    ['unknown race day', 'no-day.json', (d) => { d.raceDayId = 99999; }, /REFUSED \[race day exists\]/],
    ['tampered payloadHash', 'bad-hash.json', (d) => { d.payloadHash = `sha256:${'b'.repeat(64)}`; }, /REFUSED \[payloadHash matches\]/],
  ];
  for (const [name, file, breakIt, expect] of cases) {
    const doc = JSON.parse(JSON.stringify(good.doc));
    doc.cards[0].cardId = `aa11bb22-${file}`;
    breakIt(doc);
    const p = path.join(tmp, file);
    fs.writeFileSync(p, JSON.stringify(doc, null, 2));
    const { out, code } = run([p, '--yes'], true);
    check(`refuses ${name}, and says which check`, expect.test(out), out.slice(-300));
    check(`refuses ${name} with a non-zero exit`, code !== 0, String(code));
  }

  // A race whose text cannot survive the server's own parse. Invariant 9 is
  // enforced here, not delegated to the file.
  const badText = writeDoc('bad-text.json', [deviceCard('aa11bb22-badtext', [
    { number: 1, text: '$1 W 99', lockedAt: '2026-08-30T18:20:00.000Z' },
  ])]);
  const { out, code } = run([badText.path, '--yes'], true);
  check('refuses a race whose ticket text will not re-parse',
    /REFUSED \[ticket text re-parses\]/.test(out), out.slice(-400));
  check('and writes no card for it',
    db.prepare("SELECT COUNT(*) n FROM cards WHERE external_id = 'aa11bb22-badtext'").get().n === 0);
  check('exiting non-zero', code !== 0);
}

console.log('\n-- a soft-deleted day is refused (invariant 12) --');
{
  db.prepare('UPDATE race_days SET deleted_at = ? WHERE id = ?').run('2026-09-01T00:00:00Z', dayId);
  const doc = JSON.parse(JSON.stringify(good.doc));
  doc.cards[0].cardId = 'aa11bb22-deleted';
  const p = path.join(tmp, 'deleted.json');
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  const { out } = run([p, '--yes'], true);
  check('named as a race-day refusal, not a hash one', /REFUSED \[race day exists\].*deleted/s.test(out), out.slice(-300));
  db.prepare('UPDATE race_days SET deleted_at = NULL WHERE id = ?').run(dayId);
}

console.log('\n-- two devices, one race day, no id collision --');
{
  const a = deviceCard('aa11bb22-phoneA', [{ number: 4, text: `$10 W ${pgmsFor(4)[0]}`, lockedAt: '2026-08-30T20:00:00.000Z' }]);
  const b = { ...deviceCard('cc33dd44-phoneB', [{ number: 4, text: `$10 W ${pgmsFor(4)[1]}`, lockedAt: '2026-08-30T20:01:00.000Z' }]), deviceId: 'cc33dd44' };
  const fa = writeDoc('phoneA.json', [a]);
  const fb = writeDoc('phoneB.json', [b]);
  run([fa.path, '--yes']);
  run([fb.path, '--yes']);
  const rows = db.prepare("SELECT external_id, card_number FROM cards WHERE external_id LIKE '%phone%' ORDER BY card_number").all();
  check('both devices\' cards exist side by side', rows.length === 2, JSON.stringify(rows));
  check('with distinct card numbers on the same day', rows[0].card_number !== rows[1].card_number);
}

console.log('\n-- a directory of rolling backups is one safe import --');
{
  const dir = path.join(tmp, 'downloads');
  fs.mkdirSync(dir);
  // The D152 rolling backup's real output: three files, each a superset of the
  // last, all naming the same card.
  const races = [
    { number: 5, text: `$10 W ${pgmsFor(5)[0]}`, lockedAt: '2026-08-30T21:00:00.000Z' },
    { number: 6, text: `$10 W ${pgmsFor(6)[0]}`, lockedAt: '2026-08-30T21:30:00.000Z' },
    { number: 7, text: `$10 W ${pgmsFor(7)[0]}`, lockedAt: '2026-08-30T22:00:00.000Z' },
  ];
  for (let i = 1; i <= 3; i++) {
    const doc = buildStaticExport({
      cards: [deviceCard('aa11bb22-rolling', races.slice(0, i))], payload, deviceId: 'aa11bb22',
    });
    doc.exportedAt = `2026-08-30T2${i}:59:00.000Z`;
    fs.writeFileSync(path.join(dir, `backup-${i}.json`), JSON.stringify(doc, null, 2));
  }
  const { out } = run([dir, '--yes']);
  check('three files, one card imported', /1 card\(s\) imported, 2 already present/.test(out), out.slice(-300));
  const card = db.prepare("SELECT * FROM cards WHERE external_id = 'aa11bb22-rolling'").get();
  check('exactly one card row for the three files', Boolean(card));
  // Oldest-first ordering means the LAST file read is the fullest, but the
  // FIRST one imported - so this asserts what actually got stored, which is
  // the earliest file's single race. That is the honest outcome of "skip
  // anything already present" and is why the counter says 2 already present.
  const races_ = db.prepare('SELECT COUNT(*) n FROM human_race_state WHERE card_id = ?').get(card.id).n;
  check('the card holds the races the first-read file carried', races_ === 1, String(races_));
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-static-import: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-static-import: all checks passed');
