// Verification for the static ticket builder (D151).
// Run: npm run check-static-app
//
// Two things are worth proving about an app that cannot be reached by the
// server-side check suites, and this script proves exactly those:
//
//  1. THE PAYLOAD IS PARSER-COMPATIBLE. The static app's whole claim is that
//     it validates a ticket with the SAME code the home server re-parses it
//     with. That claim is only true if a payload's entry rows are the shape
//     shared/parsers/human-picks.js reads. So the check builds a real payload
//     from a real day and runs the REAL parser over it, then runs the same
//     parser over the same day's DATABASE rows and requires identical tickets,
//     cent for cent. A payload that quietly renamed a field would show up here
//     as a name-mismatch warning or a missing program number, not months later
//     as an unimportable card.
//
//  2. THE BUNDLE EXCLUDES WHAT IT CLAIMS TO. "No LLM or OTR generation" is a
//     build-time constraint, so it is checked against the BUILT OUTPUT rather
//     than against an import graph read by eye. Every forbidden marker is a
//     string literal that survives minification, and a positive control
//     asserts a marker that MUST be present - without it, a scan of the wrong
//     file (or of nothing at all) would pass silently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-staticapp-'));
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
const { parseHumanPicksText } = await import('../shared/parsers/human-picks.js');
const { estimateTicketPayouts } = await import('../shared/betmath.js');

const db = openDb(process.env.BETSHEET_DB);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
const dayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
}, 'check-static-app'))());
const payload = buildStaticPayload(db, dayId).payload;

console.log('-- the payload feeds the REAL parser, not a lookalike --');
{
  const race = payload.races[0];
  const dbRace = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(dayId, race.number);
  const dbEntries = db.prepare('SELECT * FROM entries WHERE race_id = ?').all(dbRace.id);

  // A ticket of each shape the builder can compose, in the teller grammar the
  // builder emits (D84) - so this exercises the same path a phone would.
  const pgms = race.entries.filter((e) => !e.scratched).map((e) => e.program_number);
  const text = [
    `$10 W ${pgms[0]}`,
    `$2 EX BOX ${pgms[0]}-${pgms[1]}-${pgms[2]}`,
    `$1 TRI ${pgms[0]} WITH ${pgms[1]}-${pgms[2]} WITH ${pgms[1]}-${pgms[2]}`,
  ].join(' / ');

  const fromPayload = parseHumanPicksText({
    text, race: race.number, entries: race.entries, wagerMenu: race.wagerMenu,
    scratchedProgramNumbers: race.entries.filter((e) => e.scratched).map((e) => e.program_number),
  });
  const fromDb = parseHumanPicksText({
    text, race: dbRace.number, entries: dbEntries, wagerMenu: dbRace.wager_menu,
    scratchedProgramNumbers: dbEntries.filter((e) => e.scratched).map((e) => e.program_number),
  });

  check('the payload parses at all', fromPayload.tickets.length === 3,
    `${fromPayload.tickets.length} ticket(s): ${fromPayload.warnings.map((w) => w.message).join('; ')}`);
  check('no warnings from the payload shape', fromPayload.warnings.length === 0,
    fromPayload.warnings.map((w) => w.message).join('; '));
  check('payload and database rows produce IDENTICAL tickets',
    JSON.stringify(fromPayload.tickets) === JSON.stringify(fromDb.tickets));
  check('and identical race cost', fromPayload.raceCostCents === fromDb.raceCostCents,
    `${fromPayload.raceCostCents} vs ${fromDb.raceCostCents}`);

  // The estimator the static app runs after the parse, exactly as
  // server/human-cards.js runs it - it reads morning_line_decimal off the
  // same rows, so a payload that dropped that field would show up as every
  // estimate going null.
  const mlOf = (p) => race.entries.find((e) => e.program_number === p)?.morning_line_decimal ?? null;
  const priced = estimateTicketPayouts(fromPayload.tickets, mlOf);
  check('"If it hits" is fillable from the payload alone',
    priced.some((t) => t.estMinCents != null),
    'every estimate came back null - morning_line_decimal is probably missing from the payload');

  // Negative control: the comparison above only means something if a WRONG
  // payload shape actually fails.
  const renamed = race.entries.map(({ program_number, horse_name, ...rest }) => ({
    ...rest, programNumber: program_number, horseName: horse_name,
  }));
  const broken = parseHumanPicksText({
    text, race: race.number, entries: renamed, wagerMenu: race.wagerMenu, scratchedProgramNumbers: [],
  });
  check('NEGATIVE CONTROL: camelCase entries do NOT parse the same',
    JSON.stringify(broken.tickets) !== JSON.stringify(fromDb.tickets));
}

console.log('\n-- scratches in the payload reach the parser --');
{
  const race = payload.races[0];
  const victim = race.entries.find((e) => !e.scratched).program_number;
  db.prepare('UPDATE entries SET scratched = 1 WHERE program_number = ? AND race_id = (SELECT id FROM races WHERE race_day_id = ? AND number = ?)')
    .run(victim, dayId, race.number);
  const rebuilt = buildStaticPayload(db, dayId).payload.races[0];
  check('the payload marks it scratched', rebuilt.entries.find((e) => e.program_number === victim).scratched === true);
  const parsed = parseHumanPicksText({
    text: `$10 W ${victim}`, race: rebuilt.number, entries: rebuilt.entries, wagerMenu: rebuilt.wagerMenu,
    scratchedProgramNumbers: rebuilt.entries.filter((e) => e.scratched).map((e) => e.program_number),
  });
  check('and the parser warns about betting it', parsed.warnings.length > 0,
    'a scratched horse drew no warning at all');
  db.prepare('UPDATE entries SET scratched = 0 WHERE program_number = ? AND race_id = (SELECT id FROM races WHERE race_day_id = ? AND number = ?)')
    .run(victim, dayId, race.number);
}

db.close();

console.log('\n-- the built bundle ships no generator code --');
{
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build', '--config', path.join(ROOT, 'vite.static.config.js')], { cwd: ROOT, stdio: 'pipe' });

  const outDir = path.join(ROOT, 'dist-static');
  const files = fs.readdirSync(path.join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
  check('the build produced at least one JS bundle', files.length > 0);
  const js = files.map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');

  // POSITIVE CONTROL FIRST. Without this, a scan that read an empty string
  // would report every exclusion as satisfied.
  check('POSITIVE CONTROL: the real teller grammar IS in the bundle',
    js.includes('EXACTA BOX') && js.includes('SUPERFECTA'),
    'the scan is not reading the app bundle');
  check('POSITIVE CONTROL: the static store IS in the bundle', js.includes('betsheet-static'));

  const forbidden = [
    ['the Anthropic client', /anthropic|x-api-key|ANTHROPIC_API_KEY/i],
    ['the LLM prompt template', /<<<TICKETS>>>|ANALYST_NOTES|analyst notes clause/i],
    ['the OTR PDF parser', /parseEquibaseOtrTsv|pdftotext|Off to the Races/i],
    ['a SQLite/WASM engine', /sql\.js|better-sqlite3|\.wasm\b/i],
    ['an Equibase fetch', /equibase\.com/i],
    ['the server API client', /\/api\/race-days|\/api\/cards|\/api\/llm/i],
    ['grading', /gradeAndPersist|graded_tickets/i],
  ];
  for (const [name, re] of forbidden) {
    const hit = js.match(re);
    check(`no ${name}`, !hit, hit ? `found ${JSON.stringify(hit[0])}` : '');
  }

  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  check('index.html references its assets relatively (works at any base path)',
    /src="\.\/assets\//.test(html) && !/src="\/assets\//.test(html), html.match(/src="[^"]*"/)?.[0] ?? '');
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-static-app: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-static-app: all checks passed');
