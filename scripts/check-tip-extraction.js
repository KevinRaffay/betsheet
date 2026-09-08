// Verification for TIPSHEET screenshot extraction (D166).
// Run: npm run check-tip-extraction
//
// Runs against a throwaway temp database with the logger redirected there too
// (CLAUDE.md, Gotchas: pointing only BETSHEET_DB somewhere safe is NOT
// isolation - resetLogs() reads the LOGGER's own directory, and a reset run
// against a scratch copy once wiped 14 live log files). Nothing in this script
// can reach data/betsheet.sqlite.
//
// Two phases, and the split is deliberate:
//
//   PHASE 1 is HERMETIC and always runs - the pure normalization and
//   validation, then the whole extract -> parse -> validate -> persist -> read
//   back path driven by a stubbed model response under BETSHEET_TIP_TEST_MODE.
//   It needs no API key, no network and no images, so it is the part that can
//   fail a build.
//
//   PHASE 2 needs REAL SCREENSHOTS and a real key, and is SKIPPED (loudly, and
//   without failing) when either is missing. Its output is meant to be READ,
//   not asserted: no golden can be written for "did the model read this image
//   correctly", so it prints each extraction beside its source file for the
//   human to compare against the picture. That is this deliverable's own
//   done-when - "extraction produces correct-looking structured data I can
//   eyeball" - and pretending it could be a machine assertion would be a lie
//   about what was verified.
//
// Drop sample screenshots in scratch/tip-samples/ (gitignored - they are
// screenshots of someone else's app, and not ours to commit).

// Phase 2 needs ANTHROPIC_API_KEY, and this repo's convention is a per-checkout
// .env (see CLAUDE.md's scratch-environment note) loaded the way server/index.js
// and vite.config.js load it. Phase 1 needs no key and is unaffected.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-tipextract-'));
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
const { morningLineToDecimal } = await import('../shared/betmath.js');
const {
  validateTipPicks, normalizeOdds, normalizeSourceLabel, hasBlocking, TIP_SOURCE_FALLBACK,
} = await import('../shared/tip-picks.js');
const {
  extractTipPicks, insertTipPicks, tipPicksForDay, parseExtractionJson, detectMediaType,
} = await import('../server/tip-extraction.js');

const db = openDb(process.env.BETSHEET_DB);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
const dayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
}, 'check-tip-extraction'))());

console.log('-- migration 028: the tip_picks table --');
{
  const cols = Object.fromEntries(db.prepare('PRAGMA table_info(tip_picks)').all().map((c) => [c.name, c]));
  for (const c of ['race_day_id', 'race_no', 'bucket', 'source_label', 'picks',
    'captured_at', 'raw_extraction', 'model', 'image_sha256', 'created_at']) {
    check(`tip_picks.${c} exists`, Boolean(cols[c]));
  }
  // The scope is explicit that this bucket has no completeness axis, and that
  // it carries no ticket - both are later deliverables, if ever.
  check('tip_picks has NO completeness column', !Object.keys(cols).some((c) => /complete/i.test(c)));
  check('tip_picks has NO ticket column', !Object.keys(cols).some((c) => /ticket|stake|bankroll/i.test(c)));

  const fk = db.prepare("SELECT * FROM pragma_foreign_key_list('tip_picks')").all();
  check('race_day_id cascades from race_days', fk.some((f) => f.table === 'race_days' && f.on_delete === 'CASCADE'));

  let refused = false;
  try { db.prepare("INSERT INTO tip_picks (race_day_id, race_no, bucket, source_label, picks, created_at) VALUES (?, 1, 'OTR', 'x', '[]', 'now')").run(dayId); }
  catch { refused = true; }
  check('a non-TIPSHEET bucket is refused (invariant 13)', refused);

  let refusedRace = false;
  try { db.prepare("INSERT INTO tip_picks (race_day_id, race_no, source_label, picks, created_at) VALUES (?, 0, 'x', '[]', 'now')").run(dayId); }
  catch { refusedRace = true; }
  check('race_no 0 is refused (no day-level tip row)', refusedRace);
}

console.log('-- no HUMAN / LLM / OTR schema was touched --');
{
  const completeness = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cards'").get().sql;
  check('cards.consensus_completeness gained no TIPSHEET value', !/TIPSHEET/.test(completeness));
  check('cards still carries HUMAN, LLM_GENERATED and EQB_OTR', ['HUMAN', 'LLM_GENERATED', 'EQB_OTR'].every((b) => completeness.includes(b)));
  const tipCols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name).filter((c) => /tip/i.test(c));
  check('cards gained no tip_* column', tipCols.length === 0, tipCols.join(','));
}

console.log('-- odds normalize into the format morningLineToDecimal reads --');
{
  // The hyphen is the case that matters: tote boards and tip apps print `9-2`,
  // morningLineToDecimal only admits `9/2`, so an unconverted price would be
  // stored looking captured and read back as null.
  const cases = [['4-5', '4/5', 0.8], ['9-2', '9/2', 4.5], ['8/1', '8/1', 8],
    ['EVEN', '1/1', 1], ['7 to 2', '7/2', 3.5], ['5', '5', 5]];
  for (const [raw, want, decimal] of cases) {
    const got = normalizeOdds(raw);
    check(`${raw} -> ${want}`, got === want, `got ${JSON.stringify(got)}`);
    check(`  and morningLineToDecimal reads it as ${decimal}`, morningLineToDecimal(got) === decimal,
      `got ${morningLineToDecimal(got)}`);
  }
  // The corpus stores the explicit denominator (4/5, 8/1, 12/1 are all real
  // values in the fixture day), so a tipsheet price must render the same way.
  check('8/1 is NOT reduced to 8 (the corpus keeps the denominator)', normalizeOdds('8-1') === '8/1');
  for (const raw of ['-', '--', 'N/A', '', null, undefined, 'abc', 'SCR']) {
    check(`${JSON.stringify(raw)} yields null, never a guess`, normalizeOdds(raw) === null);
  }
}

console.log('-- absent odds are omitted, never fabricated --');
{
  const { picks, warnings } = validateTipPicks([
    { horse_no: 4, horse_name: 'Karazest', rank: 1 },
    { horse_no: 6, horse_name: 'Union Roar', rank: 2 },
  ]);
  check('a no-odds sheet is not a failure', !hasBlocking(warnings), JSON.stringify(warnings));
  check('ml_odds is ABSENT, not null', picks.every((p) => !('ml_odds' in p) && !('live_odds' in p)));
  check('program numbers are TEXT', picks.every((p) => typeof p.horse_no === 'string'));

  const unreadable = validateTipPicks([{ horse_no: 1, horse_name: 'A', rank: 1, ml_odds: 'about even' }]);
  check('an unreadable price is dropped, not stored', !('ml_odds' in unreadable.picks[0]));
  check('  and it warns without blocking', !hasBlocking(unreadable.warnings)
    && unreadable.warnings.some((w) => w.code === 'unreadable_odds'));
}

console.log('-- a broken RANKING blocks; rank is the signal in this bucket --');
{
  const blocks = [
    ['no picks at all', []],
    ['a duplicated rank', [{ horse_no: 1, horse_name: 'A', rank: 1 }, { horse_no: 2, horse_name: 'B', rank: 1 }]],
    ['the same horse twice', [{ horse_no: 3, horse_name: 'A', rank: 1 }, { horse_no: 3, horse_name: 'A', rank: 2 }]],
    ['a missing rank', [{ horse_no: 1, horse_name: 'A' }]],
    ['a zero rank', [{ horse_no: 1, horse_name: 'A', rank: 0 }]],
  ];
  for (const [name, input] of blocks) {
    check(`${name} blocks`, hasBlocking(validateTipPicks(input).warnings));
  }
  check('a missing horse NAME does not block (the number is the identity)',
    !hasBlocking(validateTipPicks([{ horse_no: 5, rank: 1 }]).warnings));
  check('validateTipPicks never throws on junk',
    [null, undefined, 'x', 42, [null], [{}]].every((i) => { try { validateTipPicks(i); return true; } catch { return false; } }));
}

console.log('-- source label comes from the image, falling back to the hint --');
{
  check('TM badge -> trackmaster', normalizeSourceLabel('TM') === 'trackmaster');
  check('"Track Master" -> trackmaster', normalizeSourceLabel('Track Master') === 'trackmaster');
  check('an unknown app keeps its own slug', normalizeSourceLabel('Some New App') === 'some-new-app');
  check('nothing identifiable -> the fallback', normalizeSourceLabel('') === TIP_SOURCE_FALLBACK);
}

console.log('-- the whole path, stubbed: extract -> validate -> persist -> read back --');
process.env.BETSHEET_TIP_TEST_MODE = '1';
// A 1x1 PNG. Real enough for the format detection and the sha256 that a real
// image would exercise; the model's answer is stubbed, so the pixels are not
// the thing under test here.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
{
  check('the 1x1 PNG is detected by its magic bytes', detectMediaType(PNG_1x1) === 'image/png');
  check('a non-image is refused, not sent to the model', detectMediaType(Buffer.from('not an image')) === null);

  // A fenced response with prose around it: the prompt forbids both, and the
  // extractor still recovers rather than losing a 95%-right answer.
  const res = await extractTipPicks({
    imageBuffer: PNG_1x1, sourceHint: 'trackmaster',
    stubResponse: 'Here are the picks:\n```json\n' + JSON.stringify({
      source_label: 'TrackMaster',
      picks: [
        { horse_no: '4', horse_name: 'Karazest', rank: 1 },
        { horse_no: '6', horse_name: 'Union Roar', rank: 2 },
        { horse_no: '2', horse_name: 'Fancy Feet', rank: 3 },
      ],
    }) + '\n```\n',
  });
  check('extraction succeeded', res.ok, res.error || '');
  check('3 picks in rank order', res.picks.map((p) => p.rank).join(',') === '1,2,3');
  check('the source came back normalized', res.sourceLabel === 'trackmaster');
  check('no blocking warnings', !hasBlocking(res.warnings), JSON.stringify(res.warnings));
  check('the unedited response is kept for audit', typeof res.raw === 'string' && res.raw.includes('```'));
  check('the image is hashed', /^[0-9a-f]{64}$/.test(res.imageSha256));
  check('extraction wrote NOTHING (invariant 9 in spirit)',
    db.prepare('SELECT COUNT(*) c FROM tip_picks').get().c === 0);

  insertTipPicks(db, {
    raceDayId: dayId, raceNo: 1, sourceLabel: res.sourceLabel, picks: res.picks,
    capturedAt: '2026-09-08T18:00:00.000Z', rawExtraction: res.raw,
    model: res.model, imageSha256: res.imageSha256,
  });
  const [row] = tipPicksForDay(db, dayId);
  check('one row persisted, bucket TIPSHEET', row && row.bucket === 'TIPSHEET');
  check('picks survive the JSON round trip', JSON.stringify(row.picks) === JSON.stringify(res.picks));
  check('captured_at and created_at are distinct facts',
    row.captured_at === '2026-09-08T18:00:00.000Z' && row.created_at !== row.captured_at);

  // Re-extracting one app's picks for one race is a CORRECTION, not a second
  // opinion - so it replaces rather than accumulating.
  insertTipPicks(db, { raceDayId: dayId, raceNo: 1, sourceLabel: 'TrackMaster', picks: [{ horse_no: '9', horse_name: 'Late Fix', rank: 1 }] });
  const after = tipPicksForDay(db, dayId);
  check('re-extracting the same (day, race, source) replaces', after.length === 1 && after[0].picks[0].horse_no === '9');

  // A different app on the same race is a genuinely different opinion.
  insertTipPicks(db, { raceDayId: dayId, raceNo: 1, sourceLabel: 'numberfire', picks: [{ horse_no: '1', horse_name: 'Other', rank: 1 }] });
  check('a second SOURCE on the same race coexists', tipPicksForDay(db, dayId).length === 2);

  const bad = await extractTipPicks({ imageBuffer: PNG_1x1, stubResponse: 'I am unable to read this image.' });
  check('a non-JSON response fails honestly', !bad.ok && /not JSON/i.test(bad.error));
  check('  and keeps the raw text anyway', bad.raw === 'I am unable to read this image.');
  const noImage = await extractTipPicks({ stubResponse: '{}' });
  check('no image at all is refused', !noImage.ok);
}

console.log('-- a factory reset names tip_picks rather than cascading it silently --');
{
  const { resetApp } = await import('../server/reset.js');
  const { rowsRemoved } = resetApp(db);
  check('tip_picks is named in the reset audit', Object.keys(rowsRemoved || {}).includes('tip_picks'),
    Object.keys(rowsRemoved || {}).join(','));
  check('  and the rows are gone', db.prepare('SELECT COUNT(*) c FROM tip_picks').get().c === 0);
}

// ------------------------------------------------- the HTTP surface (D169)
// A real server on its own database. The vision call is stubbed via
// BETSHEET_TIP_TEST_MODE so the ROUTE contract - preview writes nothing, save
// re-parses the ARCHIVED response rather than the client's payload, and
// correcting is a separate recorded act - is verifiable without a paid call.

console.log('-- routes: preview -> save -> correct -> delete (D169) --');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8910;
  const BASE = `http://127.0.0.1:${PORT}`;
  const srvDb = path.join(tmp, 'srv.sqlite');
  const archive = path.join(tmp, 'tip-archive');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      BETSHEET_PORT: String(PORT),
      BETSHEET_DB: srvDb,
      BETSHEET_LOG_DIR: path.join(tmp, 'srv-logs'),
      BETSHEET_TIP_ARCHIVE_DIR: archive,
      BETSHEET_TIP_TEST_MODE: '1',
      ANTHROPIC_API_KEY: '',   // the stub path must never need a key
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const jpost = (u, b = {}, m = 'POST') => fetch(BASE + u, {
    method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });
  const jget = (u) => fetch(BASE + u).then((r) => r.json());

  const stub = (picks, source = 'TrackMaster') => JSON.stringify({ source_label: source, picks });
  const THREE = [
    { horse_no: '4', horse_name: 'Karazest', rank: 1 },
    { horse_no: '6', horse_name: 'Union Roar', rank: 2 },
    { horse_no: '2', horse_name: 'Fancy Feet', rank: 3 },
  ];

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots with BETSHEET_TIP_TEST_MODE=1 and no API key', up, out.slice(-300));

    const dayRes = await jpost('/api/race-days', {
      track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
    });
    const srvDayId = (await dayRes.json()).id;
    const png = PNG_1x1.toString('base64');

    const pv = await (await jpost(`/api/race-days/${srvDayId}/tip-picks/preview`, {
      race: 1, imageBase64: png, sourceHint: '', __stubResponse: stub(THREE),
    })).json();
    check('preview returns picks and a parseToken', pv.picks?.length === 3 && typeof pv.parseToken === 'string');
    check('preview normalized the source off the response', pv.sourceLabel === 'trackmaster');
    check('PREVIEW WROTE NOTHING (invariant 9)', (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.length === 0);
    check('the extraction was archived regardless', fs.existsSync(path.join(archive, `${pv.parseToken}.json`)));

    // The save must re-parse the ARCHIVED response, so a client that lies
    // about the picks changes nothing. Nothing in the save body carries picks.
    const saved = await (await jpost(`/api/race-days/${srvDayId}/tip-picks`, {
      race: 1, parseToken: pv.parseToken, picks: [{ horse_no: '99', horse_name: 'Injected', rank: 1 }],
    })).json();
    check('save re-parses the archive and IGNORES client-supplied picks',
      saved.saved?.picks?.length === 3 && !JSON.stringify(saved.saved.picks).includes('Injected'));
    check('a saved row starts UNEDITED - verbatim model output', saved.saved.edited === false && saved.saved.picksExtracted === null);

    const badToken = await jpost(`/api/race-days/${srvDayId}/tip-picks`, { race: 1, parseToken: 'deadbeef' });
    check('an unknown parseToken is refused 404', badToken.status === 404);

    // Correcting: a separate, recorded act on a stored row.
    const fixedPicks = [
      { horse_no: '4', horse_name: 'Karazest', rank: 1 },
      { horse_no: '6', horse_name: 'Union Roar', rank: 2 },
      { horse_no: '7', horse_name: 'Last Candy', rank: 3, ml_odds: '9-2' },
    ];
    const corrected = await (await jpost(`/api/tip-picks/${saved.saved.id}`, { picks: fixedPicks }, 'PATCH')).json();
    check('a correction is applied', corrected.saved?.picks?.[2]?.horse_no === '7');
    check('  and normalized on the way in (9-2 -> 9/2)', corrected.saved.picks[2].ml_odds === '9/2');
    check('  and MARKED as edited', corrected.saved.edited === true && typeof corrected.saved.editedAt === 'string');
    check('  and the model ORIGINAL is preserved',
      corrected.saved.picksExtracted?.[2]?.horse_no === '2');

    // Editing twice must not overwrite the original with the previous edit.
    const again = await (await jpost(`/api/tip-picks/${saved.saved.id}`, {
      picks: [{ horse_no: '1', horse_name: 'Changed Again', rank: 1 }],
    }, 'PATCH')).json();
    check('a SECOND edit still keeps the FIRST extraction, not the last edit',
      again.saved.picksExtracted?.length === 3 && again.saved.picksExtracted[2].horse_no === '2');

    const badEdit = await jpost(`/api/tip-picks/${saved.saved.id}`, {
      picks: [{ horse_no: '1', horse_name: 'A', rank: 1 }, { horse_no: '2', horse_name: 'B', rank: 1 }],
    }, 'PATCH');
    check('a hand-typed BROKEN ranking is refused 422, same validator as the model',
      badEdit.status === 422);

    const del = await jpost(`/api/tip-picks/${saved.saved.id}`, {}, 'DELETE');
    check('a row can be deleted', del.status === 200
      && (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.length === 0);
    check('the archived extraction SURVIVES the row deletion',
      fs.existsSync(path.join(archive, `${pv.parseToken}.json`)));

    const missing = await jpost(`/api/race-days/${srvDayId}/tip-picks/preview`, {
      race: 99, imageBase64: png, __stubResponse: stub(THREE),
    });
    check('a race the day does not have is refused 404', missing.status === 404);
    const notImage = await jpost(`/api/race-days/${srvDayId}/tip-picks/preview`, {
      race: 1, imageBase64: Buffer.from('not an image').toString('base64'), __stubResponse: stub(THREE),
    });
    check('a non-image body is refused 400 before any model call', notImage.status === 400);
  } finally {
    server.kill();
  }
}

// --------------------------------------------------------------- PHASE 2
// Real screenshots, real model. Skipped without failing when either is
// missing, because this half cannot be a build gate: there is no golden for
// "did the model read this picture correctly", and inventing one would assert
// something this script has not actually checked.

console.log('-- real screenshots --');
delete process.env.BETSHEET_TIP_TEST_MODE;
const samplesDir = process.env.BETSHEET_TIP_SAMPLES || path.join(ROOT, 'scratch', 'tip-samples');
const samples = fs.existsSync(samplesDir)
  ? fs.readdirSync(samplesDir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)).sort()
  : [];

if (!samples.length) {
  console.log(`  SKIP  no sample screenshots in ${path.relative(ROOT, samplesDir)}/`);
  console.log('        Drop 2-3 tip-sheet screenshots there and re-run to exercise the real');
  console.log('        vision call. The directory is gitignored on purpose - they are');
  console.log('        screenshots of someone else\'s app, not ours to commit.');
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`  SKIP  ${samples.length} sample(s) found but ANTHROPIC_API_KEY is not set.`);
} else {
  const dayId2 = Number(db.transaction(() => insertRaceDay(db, {
    track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
  }, 'check-tip-extraction-live'))());

  let withOdds = 0;
  let withoutOdds = 0;
  for (const [i, file] of samples.entries()) {
    const full = path.join(samplesDir, file);
    const res = await extractTipPicks({ imagePath: full, sourceHint: '' });
    console.log(`\n  === ${file} ===`);
    if (!res.ok) { check(`${file}: extraction succeeded`, false, res.error); continue; }

    check(`${file}: extraction succeeded`, true);
    check(`${file}: no blocking warnings`, !hasBlocking(res.warnings),
      res.warnings.filter((w) => w.blocking).map((w) => w.message).join('; '));
    console.log(`  source_label: ${res.sourceLabel}    model: ${res.model}`);
    // Printed for the HUMAN to compare against the picture - the point of
    // this phase. Nothing below is asserted about the horses themselves.
    for (const p of res.picks) {
      const odds = ['ml_odds', 'live_odds'].filter((k) => k in p).map((k) => `${k}=${p[k]}`).join(' ');
      console.log(`    ${String(p.rank).padStart(2)}.  #${(p.horse_no + '').padEnd(3)} ${(p.horse_name || '(no name)').padEnd(24)} ${odds}`);
    }
    for (const w of res.warnings) console.log(`    warn (${w.blocking ? 'BLOCKING' : 'advisory'}): ${w.message}`);

    // Whatever odds DID come back must be readable by the payout math - the
    // one thing about a real extraction that IS machine-checkable.
    const oddsValues = res.picks.flatMap((p) => ['ml_odds', 'live_odds'].filter((k) => k in p).map((k) => p[k]));
    if (oddsValues.length) {
      withOdds += 1;
      check(`${file}: every captured price parses via morningLineToDecimal`,
        oddsValues.every((o) => morningLineToDecimal(o) !== null),
        oddsValues.filter((o) => morningLineToDecimal(o) === null).join(','));
    } else {
      withoutOdds += 1;
      console.log('    (no odds shown - an ordinary tip sheet, not a failed extraction)');
    }
    check(`${file}: no price was fabricated as null`,
      res.picks.every((p) => !('ml_odds' in p && p.ml_odds === null) && !('live_odds' in p && p.live_odds === null)));

    insertTipPicks(db, {
      raceDayId: dayId2, raceNo: i + 1, sourceLabel: res.sourceLabel, picks: res.picks,
      capturedAt: fs.statSync(full).mtime.toISOString(), rawExtraction: res.raw,
      model: res.model, imageSha256: res.imageSha256,
    });
  }
  const stored = tipPicksForDay(db, dayId2);
  console.log('');
  check(`all ${samples.length} sample(s) persisted and read back`, stored.length === samples.length);
  check('at least 2 different screenshots extracted', stored.length >= 2, `only ${stored.length}`);
  check('at least one screenshot with NO odds visible', withoutOdds >= 1,
    'every sample showed odds - add one that does not, per the done-when');
  if (!withOdds) console.log('  note  no sample showed odds; the odds-format assertion had nothing to check.');
}

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All tip-extraction checks passed.');
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
process.exit(failures ? 1 : 0);
