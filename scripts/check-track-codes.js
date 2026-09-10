// Verification for shared/track-codes.js (D35, registry filled out in D122).
// Run: npm run check-track-codes
//
// PURE: no server, no DB, no fixtures. The registry is a table of constants and
// what matters about it is the set of properties no entry may break.
//
// Why this exists at all. `race_days` is keyed on the canonical track, the
// one-day-per-track+date rule compares codes, and the results-chart mismatch
// refusal compares codes - so two entries sharing a code would silently MERGE
// two real tracks' race days into one identity, and one spelling resolving to
// two tracks would make which row you get depend on registry order. Neither
// failure would raise anything at the time; both would show up much later as a
// day that already exists, or a chart refused for the wrong track. They are
// cheap to assert and expensive to discover.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { canonicalizeTrack, meetFor, meetForDay } from '../shared/track-codes.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

// The registry is module-private by design - a call site must go through
// `canonicalizeTrack` - so it is read back out of the source here rather than
// exported just to be tested. Reading the source is also what lets this assert
// the SHAPE of every entry, which an exported array would not.
const src = fs.readFileSync(path.join(ROOT, 'shared', 'track-codes.js'), 'utf8');
// D209 added `tz` (the track's IANA timezone) as a fourth property on every
// entry, right after `aliases`, so the shape this regex locks down widened
// to match - it must stay the source of truth for what "every entry" means.
const entries = [...src.matchAll(/\{ code: '([^']+)', display: '([^']+)', aliases: \[([^\]]*)\], tz: '([^']+)' \}/g)]
  .map((m) => ({
    code: m[1],
    display: m[2],
    aliases: m[3].split(',').map((a) => a.trim().replace(/'/g, '')).filter(Boolean),
    tz: m[4],
  }));

const keyOf = (s) => String(s).toUpperCase().replace(/[^A-Z]/g, '');

console.log('-- the registry parses and is populated --');
check('every registry entry was read', entries.length >= 39, String(entries.length));
check('Del Mar and Kentucky Downs are still there (D35, D115)',
  entries.some((e) => e.code === 'DMR') && entries.some((e) => e.code === 'KD'));

console.log('\n-- codes are identities: no two tracks may share one --');
{
  const seen = new Map();
  const dupes = [];
  for (const e of entries) {
    if (seen.has(e.code)) dupes.push(`${e.code}: ${seen.get(e.code)} vs ${e.display}`);
    seen.set(e.code, e.display);
  }
  check('no duplicate code', dupes.length === 0, dupes.join('; '));
  check('every code is non-empty letters/digits', entries.every((e) => /^[A-Z0-9]+$/.test(e.code)),
    entries.filter((e) => !/^[A-Z0-9]+$/.test(e.code)).map((e) => e.code).join(', '));
}

console.log('\n-- every entry carries a real, valid IANA timezone (D209) --');
{
  const missing = entries.filter((e) => !e.tz).map((e) => e.code);
  check('every entry has a non-empty tz', missing.length === 0, missing.join(', '));
  // The exact string must be a timezone the runtime actually recognizes, not
  // merely a plausible-looking one - Intl throws RangeError on a typo'd zone
  // name, which is the cheapest oracle available with no dependency.
  const invalid = [];
  for (const e of entries) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: e.tz }); }
    catch { invalid.push(`${e.code}: ${e.tz}`); }
  }
  check('every tz is a real IANA zone Intl accepts', invalid.length === 0, invalid.join('; '));
}

console.log('\n-- spellings are unambiguous: one spelling, one track --');
{
  const owner = new Map();
  const clashes = [];
  for (const e of entries) {
    for (const k of new Set([keyOf(e.display), ...e.aliases])) {
      if (owner.has(k) && owner.get(k) !== e.code) clashes.push(`${k}: ${owner.get(k)} vs ${e.code}`);
      owner.set(k, e.code);
    }
  }
  check('no spelling resolves to two different tracks', clashes.length === 0, clashes.join('; '));
}

console.log('\n-- aliases are in the form the lookup actually compares --');
{
  // `canonicalizeTrack` strips everything but A-Z before comparing, so a
  // lowercase alias, or one carrying a space, hyphen or ampersand, can never
  // match anything. It would fail silently: the track just reads unrecognized.
  const malformed = entries.flatMap((e) => e.aliases.filter((a) => a !== keyOf(a)).map((a) => `${e.code}:${a}`));
  check('no alias contains anything the lookup strips before comparing',
    malformed.length === 0, malformed.join(', '));
  const redundant = entries.flatMap((e) => e.aliases.filter((a) => a === keyOf(e.display)).map((a) => `${e.code}:${a}`));
  check('no alias merely repeats its own display name', redundant.length === 0, redundant.join(', '));
}

console.log('\n-- every entry resolves to itself, by display and by every alias --');
{
  let bad = 0;
  for (const e of entries) {
    const byDisplay = canonicalizeTrack(e.display);
    if (byDisplay.code !== e.code || byDisplay.display !== e.display || !byDisplay.recognized || byDisplay.timezone !== e.tz) {
      bad += 1;
      console.log(`        ${e.display} -> ${JSON.stringify(byDisplay)}`);
    }
    for (const a of e.aliases) {
      const byAlias = canonicalizeTrack(a);
      if (byAlias.code !== e.code || byAlias.display !== e.display || byAlias.timezone !== e.tz) {
        bad += 1;
        console.log(`        alias ${a} (${e.code}) -> ${JSON.stringify(byAlias)}`);
      }
    }
  }
  check(`all ${entries.length} displays and every alias round-trip to their own entry, timezone included`, bad === 0, `${bad} bad`);
}

console.log('\n-- every entry\'s own CODE resolves to that entry (D212) --');
{
  // The general form of a real bug: `canonicalizeTrack` compares the input
  // against `display` and `aliases` and NOTHING ELSE, so an entry whose own
  // code is not among its aliases sends that code down the DERIVED path -
  // `recognized: false`, `timezone: null` - even though the code names a
  // registered track. Del Mar was exactly that entry for as long as the
  // registry has existed; `server/race-calendar.js` routes any race whose
  // track has no timezone into `unplaceable`, so a caller passing the bare
  // code would have made every Del Mar race vanish from the calendar.
  //
  // That caller is not hypothetical: `shared/parsers/equibase-apify-parseforge.js`
  // falls back to `trackName || trackCode`, so a capture printing a code and
  // no name hands the save layer a bare code today. It is correct for 38 of
  // the 39 entries precisely BECAUSE each of those lists its own code.
  //
  // Asserted on BEHAVIOUR rather than on the shape of `aliases`, so it stays
  // the right check if the lookup is ever taught to match codes implicitly.
  const bad = [];
  for (const e of entries) {
    const got = canonicalizeTrack(e.code);
    if (got.code !== e.code || got.display !== e.display || !got.recognized || got.timezone !== e.tz) {
      bad.push(`${e.code} -> ${JSON.stringify(got)}`);
    }
  }
  check(`all ${entries.length} codes round-trip to their own entry, timezone included`,
    bad.length === 0, bad.join('; '));
  // The case that was actually broken, pinned by name so a regression reads
  // as itself rather than as one line in a list of 39.
  const dmr = canonicalizeTrack('DMR');
  check('the bare code "DMR" is a recognized Del Mar, with its Pacific zone',
    dmr.code === 'DMR' && dmr.display === 'Del Mar' && dmr.recognized
    && dmr.timezone === 'America/Los_Angeles', JSON.stringify(dmr));
}

console.log('\n-- the spellings this registry was built from (D122, real captures) --');
for (const [raw, code, display] of [
  // The page header's own wording, including the two that are not the track's
  // name and the one the entries parser used to truncate at its `&`.
  ['Hollywood Casino At Charles Town Races', 'CT', 'Charles Town'],
  ['Mountaineer Casino Racetrack & Resort', 'MNR', 'Mountaineer'],
  ['Resort', 'MNR', 'Mountaineer'],
  ['Lethbridge Rmtc', 'LBG', 'Lethbridge'],
  ['Lethbridge - Rmtc', 'LBG', 'Lethbridge'],
  // Codes as a saved filename carries them.
  ['CBY', 'CBY', 'Canterbury Park'],
  ['WO', 'WO', 'Woodbine'],
  ['GP', 'GP', 'Gulfstream Park'],
  // Case and punctuation must not matter.
  ['del mar', 'DMR', 'Del Mar'],
  ['DEL MAR', 'DMR', 'Del Mar'],
  ['DelMarRacing.com', 'DMR', 'Del Mar'],
]) {
  const got = canonicalizeTrack(raw);
  check(`"${raw}" -> ${code} / ${display}`,
    got.code === code && got.display === display && got.recognized, JSON.stringify(got));
}

console.log('\n-- the codes these tracks used to get, which is why they are registered --');
{
  // Before D122 the fallback took the first three letters of whatever the page
  // printed. Those codes collided with other tracks' real ones and moved
  // whenever a page changed its wording. Pinned here so a regression is loud.
  for (const [display, wouldHaveBeen, now] of [
    ['Canterbury Park', 'CAN', 'CBY'],
    ['Hollywood Casino At Charles Town Races', 'HOL', 'CT'],
    ['Horseshoe Indianapolis', 'HOR', 'IND'],
    ['Ajax Downs', 'AJA', 'AJX'],
  ]) {
    const got = canonicalizeTrack(display);
    check(`${display}: ${wouldHaveBeen} (derived) -> ${now} (registered)`, got.code === now, got.code);
  }
}

console.log('\n-- an unrecognized track is still never blocked --');
{
  const got = canonicalizeTrack('Some Brand New Track');
  check('gets a derived code rather than nothing', Boolean(got.code));
  check('is flagged unrecognized, so a caller can warn', got.recognized === false);
  check('keeps the spelling it was given as its display', got.display === 'Some Brand New Track');
  check('carries no guessed timezone - a derived code has no real location', got.timezone === null);
  const empty = canonicalizeTrack('');
  check('an empty track yields a null code rather than throwing', empty.code === null && !empty.recognized);
  check('an empty track carries no timezone either', empty.timezone === null);
  for (const junk of [null, undefined, 123, {}]) {
    let threw = false;
    try { canonicalizeTrack(junk); } catch { threw = true; }
    check(`survives ${JSON.stringify(junk) ?? String(junk)}`, !threw);
  }
}

console.log('\n-- meets stay a Del Mar-only fact (D43/D113) --');
check('a Del Mar summer date is in the summer meet', meetForDay('Del Mar', '2026-08-15') === 'DMR-2026-summer');
check('a Del Mar fall date is in the fall meet', meetForDay('Del Mar', '2025-11-08') === 'DMR-2025-fall');
check('a newly registered track has NO meet, never a guessed label',
  meetForDay('Saratoga', '2026-09-06') === null && meetForDay('Woodbine', '2026-09-10') === null);
// meetFor takes a DATE alone - the track question is meetForDay's - so a Del
// Mar day by any spelling must land on exactly what the bare date gives.
check('meetForDay is meetFor once the track is known to be Del Mar, whatever the spelling',
  meetFor('2026-08-15') === meetForDay('DELMAR', '2026-08-15')
  && meetFor('2026-08-15') === meetForDay('DelMarRacing.com', '2026-08-15'));
check('a date outside both meets has none', meetFor('2026-03-01') === null);

if (failures) {
  console.error(`\ncheck-track-codes: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-track-codes: all checks passed');
