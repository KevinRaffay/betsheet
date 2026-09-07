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

console.log('\n-- the Pages build carries the deployed base (D154) --');
{
  // What .github/workflows/deploy-pages.yml actually runs. Asserted here so
  // the workflow and the config cannot drift apart silently - a deploy that
  // produced root-absolute asset URLs would 404 on every file at
  // user.github.io/betsheet/ and there is no way to notice that locally.
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build', '--config', path.join(ROOT, 'vite.static.config.js')],
  { cwd: ROOT, stdio: 'pipe', env: { ...process.env, BETSHEET_STATIC_BASE: '/betsheet/' } });
  const html = fs.readFileSync(path.join(ROOT, 'dist-static', 'index.html'), 'utf8');
  check('BETSHEET_STATIC_BASE puts the app under /betsheet/',
    /src="\/betsheet\/assets\//.test(html), html.match(/src="[^"]*"/)?.[0] ?? '');

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
  check('the workflow sets that exact base', /BETSHEET_STATIC_BASE:\s*\/betsheet\//.test(workflow));
  check('the workflow refuses to deploy without a payload', /payload\.json/.test(workflow));
  check('a payload IS committed for the deploy to publish',
    fs.existsSync(path.join(ROOT, 'static', 'public', 'payload.json')));
}

console.log('\n-- the offline shell ships and refuses to serve a stale race day (D155) --');
{
  const sw = fs.readFileSync(path.join(ROOT, 'dist-static', 'sw.js'), 'utf8');
  check('sw.js is in the build output', sw.length > 0);
  // The one strategy rule that must never be relaxed: a cached payload is not
  // a stale page, it is the WRONG RACES, and every ticket built against it
  // would be refused on import by D153's payloadHash check.
  check('payload.json is network-first', /if \(isPayload\(url\)\) return networkFirst/.test(sw));
  check('navigations are network-first', /request\.mode === 'navigate'[\s\S]{0,200}networkFirst/.test(sw));
  check('hashed assets are cache-first (their names are content hashes)',
    /if \(isHashedAsset\(url\)\) return cacheFirst/.test(sw));
  check('old cache versions are purged on activate', /caches\.delete/.test(sw));
  // Found live: Vite emits <script crossorigin>, so those requests carry an
  // Origin header while the install-time cache.add() does not - and a server
  // answering `Vary: Origin` then makes every lookup miss and the app fail to
  // load offline with a full cache.
  check('cache lookups ignore Vary', /ignoreVary:\s*true/.test(sw));
  check('the hashed bundles are pre-warmed, so ONE online visit is enough',
    /shellAssets/.test(sw) && /index\.html/.test(sw));

  const main = fs.readFileSync(path.join(ROOT, 'static', 'src', 'main.jsx'), 'utf8');
  check('it is registered in production builds only', /import\.meta\.env\.PROD/.test(main));
  check('and registered relative to the document, not to the module',
    /new URL\('sw\.js', document\.baseURI\)/.test(main),
    'a worker registered from ./assets/ would take a scope excluding index.html');
}

console.log('\n-- calls to action stay reachable on a phone (D157 house rule) --');
{
  // HOUSE RULE (user, 2026-09-07): a call to action must be reachable without
  // sideways scrolling on a phone. Asserted by reading the SOURCE rather than
  // by rendering, because these check scripts never mount React - but the
  // failure mode is mechanical and so is the guard: any static table that
  // ends in a button column must also mark descriptive columns `col-detail`,
  // which static.css hides below 720px. Without this, a new table added later
  // reintroduces exactly the D157 bug with nothing to catch it.
  const css = fs.readFileSync(path.join(ROOT, 'static', 'src', 'static.css'), 'utf8');
  const mobileBlock = css.slice(css.indexOf('@media (max-width: 720px)'));
  check('static.css hides .col-detail at mobile width',
    /\.col-detail\s*\{[^}]*display:\s*none/.test(mobileBlock), 'the rule is missing or outside the media query');

  const views = ['DayView.jsx', 'CardsView.jsx'];
  for (const v of views) {
    const src = fs.readFileSync(path.join(ROOT, 'static', 'src', v), 'utf8');
    const hasActionColumn = /<th \/>/.test(src);
    if (!hasActionColumn) { check(`${v} has no action column to protect`, true); continue; }
    const detailCount = (src.match(/className="col-detail"/g) ?? []).length;
    // Header + body cell for each hidden column, so an odd count means one
    // half was marked and the other was not - the column would still occupy
    // width on a phone.
    check(`${v} marks descriptive columns col-detail`, detailCount >= 4, `${detailCount} occurrence(s)`);
    check(`${v} marks them in matched header/body pairs`, detailCount % 2 === 0, `${detailCount} is odd`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ncheck-static-app: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-static-app: all checks passed');
