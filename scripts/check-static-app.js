// Verification for the static app.
// Run: npm run check-static-app
//
// One thing is worth proving about an app that cannot be reached by the
// server-side check suites, and this script proves exactly that:
//
//  THE BUNDLE EXCLUDES WHAT IT CLAIMS TO. "Read-only, no server, no
//  construction" is a build-time constraint, so it is checked against the
//  BUILT OUTPUT rather than against an import graph read by eye. Every
//  forbidden marker is a string literal that survives minification, and a
//  positive control asserts a marker that MUST be present - without it, a
//  scan of the wrong file (or of nothing at all) would pass silently.
//
// D236 removed the payload/parser-compatibility checks this script used to
// run: they proved a ticket typed against the payload parsed identically to
// one typed against the database, which mattered only while a phone was
// building tickets here. Nothing in static/src/ parses a ticket any more, so
// that property is no longer one the app makes any claim about. Payload
// correctness itself is scripts/check-static-payload.js's job and is
// unaffected by this change.
//
// D329 added the multi-day calendar/list navigation and, via CardSheet.jsx
// (D237), the card sheet WITH grades - genuinely new code this script must
// now prove IS shipped, alongside everything it already proved is not.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

console.log('-- the built bundle ships no server, construction or generator code --');
{
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build', '--config', path.join(ROOT, 'vite.static.config.js')], { cwd: ROOT, stdio: 'pipe' });

  const outDir = path.join(ROOT, 'dist-static');
  const files = fs.readdirSync(path.join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
  check('the build produced at least one JS bundle', files.length > 0);
  const js = files.map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');

  // POSITIVE CONTROLS FIRST. Without these, a scan that read an empty string
  // would report every exclusion as satisfied.
  check('POSITIVE CONTROL: the app itself IS in the bundle',
    js.includes('pagehead--static'), 'the scan is not reading the app bundle');
  // `outcome outcome--` is a literal class-name prefix in CardSheet.jsx's
  // TicketRow, only ever emitted alongside a real grade. D329 makes grade
  // DISPLAY a required feature (every card, unconditionally) - this proves
  // it shipped, not just that the app compiled.
  check('POSITIVE CONTROL: the graded-card outcome display IS in the bundle',
    js.includes('outcome outcome--'), 'CardSheet.jsx\'s grading display did not make it into the build');
  // A heading literal from Calendar.jsx - proves the new multi-day
  // navigation shipped, not just the day/race screens that predate D329.
  check('POSITIVE CONTROL: the calendar navigation IS in the bundle',
    js.includes('Race day calendar'), 'Calendar.jsx did not make it into the build');

  const forbidden = [
    ['the Anthropic client', /anthropic|x-api-key|ANTHROPIC_API_KEY/i],
    ['the LLM prompt template', /<<<TICKETS>>>|ANALYST_NOTES|analyst notes clause/i],
    ['the OTR PDF parser', /parseEquibaseOtrTsv|pdftotext|Off to the Races/i],
    ['a SQLite/WASM engine', /sql\.js|better-sqlite3|\.wasm\b/i],
    ['an Equibase fetch', /equibase\.com/i],
    ['the server API client', /\/api\/race-days|\/api\/cards|\/api\/llm/i],
    // Grading COMPUTATION, not display: a read-only bundle must never ship
    // the engine that produces a grade, even though (as of D329) it ships
    // CardSheet.jsx's rendering of one - see the two POSITIVE controls
    // above. These two facts are not in tension: CardSheet.jsx only ever
    // destructures already-computed grade VALUES handed to it as props/JSON
    // data; it never imports server/grading.js or references
    // `graded_tickets` as an identifier.
    ['grading', /gradeAndPersist|graded_tickets/i],
    // The removed construction surface. If any of these reappear, something
    // reintroduced ticket-building or local card storage.
    ['the ticket builder', /wagerLimitsFor|comboCountFor/i],
    ['local card storage (the removed IndexedDB store name)', /betsheet-static['"]/],
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
  // a stale page, it is the WRONG RACES.
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
  // ends in a button/link column must also mark descriptive columns
  // `col-detail`, which static.css hides below 720px. Without this, a new
  // table added later reintroduces exactly the D157 bug with nothing to
  // catch it.
  const css = fs.readFileSync(path.join(ROOT, 'static', 'src', 'static.css'), 'utf8');
  const mobileBlock = css.slice(css.indexOf('@media (max-width: 720px)'));
  check('static.css hides .col-detail at mobile width',
    /\.col-detail\s*\{[^}]*display:\s*none/.test(mobileBlock), 'the rule is missing or outside the media query');

  const views = ['DayView.jsx', 'DayList.jsx'];
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

console.log('\n-- the race screen fits a phone (D158) --');
{
  const raceView = fs.readFileSync(path.join(ROOT, 'static', 'src', 'RaceView.jsx'), 'utf8');
  const entriesTable = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'EntriesTable.jsx'), 'utf8');
  const mobile = fs.readFileSync(path.join(ROOT, 'static', 'src', 'mobile.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'static', 'src', 'static.css'), 'utf8');

  check('the static race view collapses entries on a phone', /open=\{!isMobile\}/.test(raceView));
  check('and hides the rank column, which its payload never carries',
    /showRank=\{false\}/.test(raceView));
  check('the race CONDITIONS blurb is not rendered', !/\{race\.conditions/.test(raceView),
    'the eligibility boilerplate is back on the race screen');

  // The payload half of the same fact: if a rank ever DID ship, the column
  // being off would be hiding real data rather than a column of dashes.
  check('the payload builder still emits no program_rank',
    !/program_rank/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'build-static-payload.js'), 'utf8')));

  // The shared component must stay unchanged for its three desktop callers.
  check('EntriesTable defaults showRank TRUE so desktop is untouched',
    /showRank = true/.test(entriesTable));
  for (const caller of ['DayTicketBuilderModal.jsx', 'LlmCardModal.jsx', 'ReplayRaceView.jsx']) {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', caller), 'utf8');
    check(`${caller} does not pass showRank, so it keeps the column`, !/showRank/.test(src));
  }

  // One breakpoint, two files. They drift silently if nobody checks.
  const jsBreakpoint = (mobile.match(/MOBILE_MAX_WIDTH = (\d+)/) ?? [])[1];
  const cssBreakpoint = (css.match(/@media \(max-width: (\d+)px\)/) ?? [])[1];
  check('the JS and CSS mobile breakpoints agree', jsBreakpoint === cssBreakpoint,
    `mobile.js says ${jsBreakpoint}, static.css says ${cssBreakpoint}`);
}

if (failures) {
  console.error(`\ncheck-static-app: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-static-app: all checks passed');
