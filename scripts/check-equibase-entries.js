// Verification for the Equibase entries HTML parser (D104).
//
// PURE - no server, no database, so a parser break reports as a parser break.
//
// Follows scripts/check-parsers.js's rule: a golden-file diff PLUS independent
// hand-counted assertions on the real fixture. The golden alone is not enough,
// because regenerating it would bless whatever the parser currently does; the
// hand counts come from reading the page, so they catch a regression the
// golden would happily absorb.
//
// Regenerate the golden deliberately:
//   node scripts/check-equibase-entries.js --write-golden
//
// Run: npm run check-equibase-entries

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseEquibaseEntriesHtml, unwrapViewSource } from '../shared/parsers/equibase-entries.js';
import { parseWagerMenu } from '../shared/betmath.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(ROOT, 'tests', 'fixtures', 'equibase-entries');
const FIXTURE = path.join(DIR, 'DMR090626USA-EQB.view-source.html');
const GOLDEN = path.join(DIR, 'DMR090626USA-EQB.expected.json');
const writeGolden = process.argv.slice(2).includes('--write-golden');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// Equibase serves windows-1252; reading as latin1 keeps every byte addressable
// and the parser's entity handling does the rest.
const html = fs.readFileSync(FIXTURE, 'latin1');

console.log('-- the saved view-source wrapper --');
const unwrapped = unwrapViewSource(html);
check('a view-source save unwraps to the original markup',
  unwrapped.includes('<!DOCTYPE html>') && unwrapped.length > 900000, `${unwrapped.length} chars`);
check('unwrapping is a no-op on markup that was never wrapped',
  unwrapVerbatim('<html><body>hi</body></html>') === '<html><body>hi</body></html>');
function unwrapVerbatim(s) { return unwrapViewSource(s); }

console.log('\n-- the page --');
const out = parseEquibaseEntriesHtml(html);
check('track reads Del Mar', out.track === 'Del Mar', out.track);
check('date is normalised to ISO', out.date === '2026-09-06', out.date);
check('the printed date is kept alongside it', out.printedDate === 'September 6, 2026', out.printedDate);
check('11 races', out.races.length === 11, String(out.races.length));
check('no warnings at all on a clean page', out.warnings.length === 0,
  JSON.stringify(out.warnings.map((w) => w.type)));

console.log('\n-- post times (hand-read off the page) --');
const POSTS = ['1:30 PM', '2:05 PM', '2:38 PM', '3:11 PM', '3:44 PM', '4:14 PM',
  '4:44 PM', '5:14 PM', '5:44 PM', '6:14 PM', '6:44 PM'];
check('all 11 post times, in race order',
  JSON.stringify(out.races.map((r) => r.postTime)) === JSON.stringify(POSTS),
  JSON.stringify(out.races.map((r) => r.postTime)));

console.log('\n-- entry counts --');
// 116 table rows minus the three "Also Eligibles:" separators = 113 entries.
const total = out.races.reduce((a, r) => a + r.entries.length, 0);
check('113 entries across the card', total === 113, String(total));
check('per-race counts match the page',
  JSON.stringify(out.races.map((r) => r.entries.length)) === JSON.stringify([10, 8, 14, 5, 12, 9, 11, 8, 9, 14, 13]),
  JSON.stringify(out.races.map((r) => r.entries.length)));

console.log('\n-- race 1, field by field --');
const r1e1 = out.races[0].entries[0];
check('program number, post position and horse', r1e1.programNumber === '1' && r1e1.postPosition === '1'
  && r1e1.horseName === 'Broheim (KY)', JSON.stringify(r1e1));
check('the state suffix stays attached to the name', r1e1.horseName.endsWith('(KY)'));
check('age/sex, medication, jockey, weight, trainer',
  r1e1.ageSex === '5/G' && r1e1.medication === 'L' && r1e1.jockey === 'J J Hernandez'
  && r1e1.weight === '124' && r1e1.trainer === 'M W McCarthy', JSON.stringify(r1e1));
check('morning line, as text and as a decimal',
  r1e1.morningLine === '6/1' && r1e1.morningLineDecimal === 6);
check('an 11-column race carries no claim price', r1e1.claimPrice === null);

console.log('\n-- THE REGRESSION THAT MATTERS: 12-column claiming races --');
// A claiming race inserts `Claim $`. Reading a fixed index would put the claim
// price in `jockey` and slide M/L into `liveOdds` - which is exactly the error
// made while first analysing this file. Columns come from each race's header.
check('races 3, 6 and 7 are 12-column; the rest are 11',
  JSON.stringify(out.races.map((r) => r.columnCount)) === JSON.stringify([11, 11, 12, 11, 11, 12, 12, 11, 11, 11, 11]),
  JSON.stringify(out.races.map((r) => r.columnCount)));
const r3e1 = out.races[2].entries[0];
check('the claim price lands in claimPrice, not jockey', r3e1.claimPrice === '$22,500', JSON.stringify(r3e1));
check('the jockey is still the jockey', r3e1.jockey === 'T J Pereira', r3e1.jockey);
check('M/L is M/L and did NOT slide into liveOdds',
  r3e1.morningLine === '30/1' && r3e1.liveOdds === null, JSON.stringify({ ml: r3e1.morningLine, live: r3e1.liveOdds }));
check('every 12-column race keeps a claim price on its live entries',
  [2, 5, 6].every((i) => out.races[i].entries.filter((e) => !e.scratched).every((e) => e.claimPrice)));

console.log('\n-- scratches (by row shape, not column index) --');
const scratched = out.races.flatMap((r) => r.entries.filter((e) => e.scratched).map((e) => `${r.number}:${e.horseName}`));
check('exactly 3, in races 3, 5 and 7',
  JSON.stringify(scratched) === JSON.stringify(['3:King of Clubs (KY)', '5:Cuban Flame (FR)', '7:Miso Phansy (CA)']),
  JSON.stringify(scratched));
check('a scratched horse is retained, not dropped',
  out.races[2].entries.some((e) => e.horseName === 'King of Clubs (KY)'));
check('scratches are excluded from the active count',
  out.races[2].activeEntries === out.races[2].entries.length - 1
  && out.races[4].activeEntries === out.races[4].entries.length - 1);
check('a scratch carries no effective odds', out.races.flatMap((r) => r.entries)
  .filter((e) => e.scratched).every((e) => e.effectiveOdds === null));
check('the dashed Scratched bar never becomes a horse name',
  !out.races.flatMap((r) => r.entries).some((e) => /Scratched/i.test(e.horseName)));

console.log('\n-- also-eligibles are a separator, never an entry --');
check('no entry is named "Also Eligibles:"',
  !out.races.flatMap((r) => r.entries).some((e) => /also eligible/i.test(e.horseName)));
check('races 3, 10 and 11 flag their AEs',
  JSON.stringify(out.races.filter((r) => r.entries.some((e) => e.alsoEligible)).map((r) => r.number))
  === JSON.stringify([3, 10, 11]));

console.log('\n-- odds fallback (this capture has no live odds at all) --');
const all = out.races.flatMap((r) => r.entries);
check('live odds are empty in all 113 entries - the capture predates wagering',
  all.every((e) => e.liveOdds === null));
check('effective odds therefore fall back to the morning line',
  all.filter((e) => !e.scratched).every((e) => e.effectiveOdds === e.morningLine));
check('effective odds are also exposed as a decimal',
  r1e1.effectiveOddsDecimal === 6 && r3e1.effectiveOddsDecimal === 30);

console.log('\n-- UI cruft never reaches a field --');
const blob = JSON.stringify(out);
check('"See More See Less" appears nowhere in the output', !/See More See Less/.test(blob));
check('"Jump to Race" appears nowhere in the output', !/Jump to Race/.test(blob));
check('no HTML entity survives into a value', !/&(?:nbsp|amp|ndash|quot|#\d+);/.test(blob),
  (blob.match(/&(?:nbsp|amp|ndash|quot|#\d+);/g) || []).slice(0, 3).join(' '));

console.log('\n-- race metadata --');
check('purse, distance and surface come off the header block',
  out.races[0].purseCents === 4100000 && /Five Furlongs/.test(out.races[0].distance ?? '')
  && out.races[0].surface === 'Turf',
  JSON.stringify({ p: out.races[0].purseCents, d: out.races[0].distance, s: out.races[0].surface }));

// D116 added race type, wager menu and a real conditions paragraph. Before it,
// `conditions` was a fixed 1400-character slice off the end of the header
// block, which on race 1 was the page's own navigation strip and a block of
// inline JavaScript - text that would have gone into races.conditions and from
// there into every LLM prompt built for the day. These are the assertions that
// would have caught that, so they are hand-written rather than golden-diffed.
check('every race carries a race type, and none of them swallowed "Purse"',
  out.races.every((r) => r.raceType && !/\bP$/.test(r.raceType)),
  JSON.stringify(out.races.map((r) => r.raceType)));
check('the race types are the ones printed on the page',
  out.races[0].raceType === 'STARTER OPTIONAL CLAIMING $50,000'
  && out.races[1].raceType === 'MAIDEN SPECIAL WEIGHT'
  && out.races[2].raceType === 'CLAIMING $25,000 - $22,500'
  && out.races[3].raceType === 'STAKES',
  JSON.stringify(out.races.slice(0, 4).map((r) => r.raceType)));
check('every race carries a wager menu - it is load-bearing, not decoration',
  out.races.every((r) => r.wagerMenu && /Exacta/i.test(r.wagerMenu)),
  JSON.stringify(out.races.map((r) => (r.wagerMenu ?? '').slice(0, 24))));
// The menu is what TicketBuilder and human-picks.js read for minimums, so a
// menu that parses to nothing is the same bug as no menu at all.
check('the wager menu parses to REAL minimums, not BET.minimums fallbacks', (() => {
  const m = parseWagerMenu(out.races[0].wagerMenu);
  return m.exacta === 100 && m.trifecta === 50 && m.superfecta === 10;
})(), JSON.stringify(parseWagerMenu(out.races[0].wagerMenu)));
check('the wager menu never bleeds the race type into itself',
  out.races.every((r) => !/CLAIMING|MAIDEN|STAKES|ALLOWANCE/i.test(r.wagerMenu ?? '')),
  JSON.stringify(out.races.map((r) => r.wagerMenu).filter((w) => /CLAIMING|MAIDEN/i.test(w ?? ''))));
check('conditions read as conditions - every race starts on real prose',
  out.races.every((r) => r.conditions && /^[(A-Z]/.test(r.conditions)),
  JSON.stringify(out.races.map((r) => (r.conditions ?? '').slice(0, 30))));
check('no race\'s conditions carry the page navigation or inline script',
  out.races.every((r) => !/Jump to Race|var httpHost|purchaseLinkURL|function\s*\(/.test(r.conditions ?? '')),
  JSON.stringify(out.races.map((r) => (r.conditions ?? '').slice(0, 40)).filter((c) => /Jump|var /.test(c))));
check('conditions never swallow the post time or the wager menu of their own race',
  out.races.every((r) => !/POST Time|Free Tools/i.test(r.conditions ?? '')));

console.log('\n-- never throws --');
for (const junk of ['', '<html></html>', 'not html at all', '<table class="fullwidth"></table>']) {
  const r = parseEquibaseEntriesHtml(junk);
  check(`survives ${JSON.stringify(junk.slice(0, 24))} with warnings, not an exception`,
    Array.isArray(r.races) && r.warnings.some((w) => w.blocking));
}

console.log('\n-- every surface the page actually prints (D124) --');
{
  // Woodbine 2026-09-07: three of the four printed forms on one card. Before
  // D124 the regex knew only `(Turf)`, so `All Weather Track`, `Inner turf`
  // and `Outer turf` all came back null - 70 of 803 races across the corpus
  // with no surface while the page said so plainly.
  const doc = fs.readFileSync(path.join(DIR, 'WO090726CAN-EQB.surfaces.html'), 'utf8');
  const r = parseEquibaseEntriesHtml(doc);
  const seen = new Set(r.races.map((x) => x.surface).filter(Boolean));
  check('reads Turf, All Weather Track and Inner turf off one card',
    ['Turf', 'All Weather Track', 'Inner turf'].every((v) => seen.has(v)), [...seen].join(' | '));
  check('...stored VERBATIM, not folded into a Turf/Dirt vocabulary - inner and outer '
    + 'turf are different courses and the distinction cannot be recovered later',
    seen.has('Inner turf') && !seen.has('Inner Turf'));
  check('the surface never leaks into the conditions text',
    r.races.every((x) => !x.surface || !(x.conditions ?? '').startsWith(x.surface)));

  // The fourth form, from a card too large to commit for one assertion.
  const outer = parseEquibaseEntriesHtml(
    '<html>Colonial Downs / September 6, 2026 / All Races'
    + '<div>Free Tools: $1 Exacta Colonial Downs ALLOWANCE Purse $50,000. One Mile. (Outer turf) For three year olds.</div>'
    + '<table class="fullwidth"><tr><th>P#</th><th>Horse</th></tr><tr><td>1</td><td>A Horse</td></tr></table></html>',
  );
  check('reads Outer turf too', outer.races[0]?.surface === 'Outer turf', JSON.stringify(outer.races[0]?.surface));
}

console.log('\n-- dirt is UNMARKED, and is not guessed (D124) --');
{
  // The page prints no parenthetical at all for a dirt race. Absence was Dirt
  // in 567 of 567 races when joined against the race-card index page, which
  // does print a surface column - so inferring it would very likely be right.
  // It is still not inferred: "the page did not say" and "the page said dirt"
  // are different facts, and this parser reports the first.
  const doc = fs.readFileSync(path.join(DIR, 'TDN091026USA-EQB.reduced-table.html'), 'utf8');
  const r = parseEquibaseEntriesHtml(doc);
  check('an all-dirt card reports null surface throughout, never a guessed "Dirt"',
    r.races.every((x) => x.surface === null), JSON.stringify([...new Set(r.races.map((x) => x.surface))]));
  check('...while still reading the distance and conditions it DOES print',
    r.races.every((x) => x.distance && x.conditions));
}

console.log('\n-- the REDUCED table: no program number, no morning line (D122) --');
{
  // Thistledown 2026-09-10, saved 4 days out. Equibase serves a narrower
  // entries table for a card that far ahead - `PP, Horse, VS, A/S, Med,
  // [Claim $,] Jockey, Wgt, Trainer`, 8 or 9 columns against the familiar
  // 11/12 - because the program numbers and morning lines DO NOT EXIST YET.
  // Measured across 91 real pages: 0-2 days out is always the full table,
  // 3+ days out is often this one. 18 of the 91, at tracks as ordinary as
  // Churchill Downs, Gulfstream, Woodbine and Parx - it is a function of lead
  // time, not of track.
  const doc = fs.readFileSync(path.join(DIR, 'TDN091026USA-EQB.reduced-table.html'), 'utf8');
  const r = parseEquibaseEntriesHtml(doc);
  check('a reduced-table card still parses every race', r.races.length === 8, String(r.races.length));
  check('...at 8 or 9 columns, not 11/12',
    r.races.every((x) => x.columnCount === 8 || x.columnCount === 9),
    JSON.stringify([...new Set(r.races.map((x) => x.columnCount))]));
  check('...and every active entry gets a program number from its post position',
    r.races.every((x) => x.entries.filter((e) => !e.scratched).every((e) => e.programNumber != null
      && e.programNumber === e.postPosition)));
  check('...announced as an assumption, never silent, and non-blocking',
    r.warnings.some((w) => w.type === 'program_number_from_post_position' && !w.blocking));
  check('...with the message saying the numbers are provisional',
    /provisional|MAY CHANGE/i.test(r.warnings.find((w) => w.type === 'program_number_from_post_position')?.message ?? ''));
  check('...and the morning line stays genuinely EMPTY rather than invented',
    r.races.every((x) => x.entries.every((e) => e.morningLine === null && e.morningLineDecimal === null)));
  // This card is also one of the six whose page prints no wager menu at all.
  check('a page that prints no wager menu yields null, never a guessed split',
    r.races.every((x) => x.wagerMenu === null));
}

console.log('\n-- a track spelled two ways on its own page (D122) --');
{
  // Lethbridge: the header says "Lethbridge Rmtc", every race block says
  // "Lethbridge - Rmtc". The wager-menu split searches for the track name
  // between "Free Tools:" and "Purse", so an exact match missed and BOTH the
  // menu and the race type came back null on all six races - and a null menu
  // is a silent fallback to Del Mar's minimums, not a visible failure.
  const doc = fs.readFileSync(path.join(DIR, 'LBG090626CAN-EQB.hyphenated-track.html'), 'utf8');
  const r = parseEquibaseEntriesHtml(doc);
  check('the header track is the un-hyphenated spelling', r.track === 'Lethbridge Rmtc', String(r.track));
  check('every race splits its wager menu despite the hyphenated spelling',
    r.races.every((x) => x.wagerMenu), JSON.stringify(r.races.map((x) => x.wagerMenu)));
  check('...and the race type comes back with it',
    r.races.every((x) => x.raceType), JSON.stringify(r.races.map((x) => x.raceType)));
  check('...so no race falls back to the no_wager_menu warning',
    !r.warnings.some((w) => w.type === 'no_wager_menu'));
  check('the menu does not swallow the track name or the race type',
    r.races.every((x) => !/lethbridge/i.test(x.wagerMenu) && !/purse/i.test(x.wagerMenu)),
    JSON.stringify(r.races[0].wagerMenu));
}

console.log('\n-- the wrong page, diagnosed rather than shrugged at (D121) --');
{
  // The mistake a real person makes, with the real artifact they make it with:
  // Equibase's race-card INDEX page. It looks near-identical to the entries
  // page in a browser tab and carries one row per race - purse, type, distance,
  // surface, starters, post time - and NOT ONE HORSE. Found live 2026-09-06
  // across 93 saved pages spanning ~40 tracks, every one of them the index.
  // Before this the parser said "No race tables found": true, unhelpful, and
  // reading like a parser bug rather than a save-the-other-page instruction.
  const indexPage = fs.readFileSync(path.join(DIR, 'KD090626-index-page.html'), 'utf8');
  const r = parseEquibaseEntriesHtml(indexPage);
  const w = r.warnings.find((x) => x.type === 'index_page_not_entries');
  check('an index page is identified as an index page, blocking', Boolean(w) && w.blocking);
  check('...and the message names the page to save instead',
    /static\/entry\/.*EQB/.test(w?.message ?? ''), w?.message);
  check('...and it does NOT fall through to the generic no_races warning',
    !r.warnings.some((x) => x.type === 'no_races'));
  check('...and no race or entry is invented from it', r.races.length === 0);
  // The generic warning must survive for genuinely unrecognizable input, or
  // the specific one has quietly replaced rather than refined it.
  check('a non-Equibase page still gets the generic no_races warning',
    parseEquibaseEntriesHtml('<html><table class="whatever"></table></html>')
      .warnings.some((x) => x.type === 'no_races'));
}

console.log('\n-- golden --');
if (writeGolden) {
  fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`  wrote ${path.relative(ROOT, GOLDEN)} - audit the diff before committing it`);
} else if (!fs.existsSync(GOLDEN)) {
  check('golden exists', false, 'run with --write-golden and audit it');
} else {
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  check('parse matches the audited golden exactly',
    JSON.stringify(out) === JSON.stringify(expected),
    'run --write-golden and read the diff before accepting it');
}

if (failures) {
  console.error(`\ncheck-equibase-entries: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-equibase-entries: all checks passed');
