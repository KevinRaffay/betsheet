// Verification for TIPSHEET picks (D166 shape, D176 manual entry).
// Run: npm run check-tip-picks
//
// Runs against a throwaway temp database with the logger redirected there too
// (CLAUDE.md, Gotchas: pointing only BETSHEET_DB somewhere safe is NOT
// isolation - resetLogs() reads the LOGGER's own directory). Nothing in this
// script can reach data/betsheet.sqlite.
//
// D177 removed the screenshot path, and with it this file's two vision phases:
// a stubbed extract -> persist round trip, and a phase that ran real images
// through a paid model. Everything they were really guarding survives here,
// because it was never about the model: the tip_picks SHAPE, the odds
// conversion, the blocking/non-blocking split, the correction path, and the
// factory reset naming the table. Manual entry now exercises the same writer
// and the same validator those phases did.

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
const { insertTipPicks, tipPicksForDay } = await import('../server/tip-picks.js');

const db = openDb(process.env.BETSHEET_DB);
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'days', 'delmar-2026-08-30.entries.json'), 'utf8'));
const dayId = Number(db.transaction(() => insertRaceDay(db, {
  track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
}, 'check-tip-picks'))());

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
  // D166 promised EXTRACTION touched no card schema, and it did not: tip picks
  // lived entirely in their own table. D171 then staked them into real
  // tickets, which needs a bucket, so TIPSHEET is now a card value on purpose.
  // The assertion is kept and INVERTED rather than deleted, because the thing
  // worth guarding never changed - that the other buckets are undisturbed.
  check('cards.consensus_completeness carries TIPSHEET (added by D171 staking)', /TIPSHEET/.test(completeness));
  check('cards still carries HUMAN, LLM_GENERATED and EQB_OTR', ['HUMAN', 'LLM_GENERATED', 'EQB_OTR'].every((b) => completeness.includes(b)));
  // D166 promised extraction added no card column, and it did not. D171 staked
  // tip picks into real cards and D174 gave those cards an identity so a
  // re-stake finds them again, so exactly ONE tip_* column exists now, on
  // purpose. Pinned to that one rather than deleted, so a THIRD column would
  // still have to be a deliberate act.
  const tipCols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name).filter((c) => /tip/i.test(c));
  check('cards carries exactly one tip_* column, tip_source_label (D174)',
    tipCols.length === 1 && tipCols[0] === 'tip_source_label', tipCols.join(','));
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

console.log('-- a factory reset names tip_picks rather than cascading it silently --');
{
  const { resetApp } = await import('../server/reset.js');
  const { rowsRemoved } = resetApp(db);
  check('tip_picks is named in the reset audit', Object.keys(rowsRemoved || {}).includes('tip_picks'),
    Object.keys(rowsRemoved || {}).join(','));
  check('  and the rows are gone', db.prepare('SELECT COUNT(*) c FROM tip_picks').get().c === 0);
}

// ------------------------------------- the HTTP surface (D169, D176, D177)
// A real server on its own database, and no API key at all - nothing in this
// path calls a model any more. The route contract under test: manual entry
// writes the same rows extraction used to, correcting is a separate recorded
// act on a stored row, and an empty sheet clears a source.

console.log('-- routes: enter -> correct -> delete --');
{
  const { spawn } = await import('node:child_process');
  const PORT = 8910;
  const BASE = `http://127.0.0.1:${PORT}`;
  const srvDb = path.join(tmp, 'srv.sqlite');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      BETSHEET_PORT: String(PORT),
      BETSHEET_DB: srvDb,
      BETSHEET_LOG_DIR: path.join(tmp, 'srv-logs'),
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

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    check('server boots with no API key at all - nothing here calls a model', up, out.slice(-300));

    const dayRes = await jpost('/api/race-days', {
      track: 'Del Mar', date: fixture.date, bankrollCents: 20000, perRaceMinCents: 500, races: fixture.races,
    });
    const srvDayId = (await dayRes.json()).id;
    // A row to correct, typed rather than extracted (D177 removed the
    // screenshot path). The correction behaviour below is unchanged by that -
    // it always acted on a STORED row, never on a preview.
    await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 1,
      sheets: [{ sourceLabel: 'trackmaster', picks: [
        { horse_no: '4', rank: 1 }, { horse_no: '6', rank: 2 }, { horse_no: '2', rank: 3 },
      ] }],
    });
    const saved = { saved: (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.find((r) => r.raceNo === 1) };
    check('a typed row starts UNEDITED', saved.saved.edited === false && saved.saved.picksExtracted === null);
    check('PICKS WERE STORED, and nothing else writes them', saved.saved.picks.length === 3);

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
    check('  and the picks as FIRST ENTERED are preserved',
      corrected.saved.picksExtracted?.[2]?.horse_no === '2');

    // Editing twice must not overwrite the original with the previous edit.
    const again = await (await jpost(`/api/tip-picks/${saved.saved.id}`, {
      picks: [{ horse_no: '1', horse_name: 'Changed Again', rank: 1 }],
    }, 'PATCH')).json();
    check('a SECOND edit still keeps the FIRST entry, not the last edit',
      again.saved.picksExtracted?.length === 3 && again.saved.picksExtracted[2].horse_no === '2');

    const badEdit = await jpost(`/api/tip-picks/${saved.saved.id}`, {
      picks: [{ horse_no: '1', horse_name: 'A', rank: 1 }, { horse_no: '2', horse_name: 'B', rank: 1 }],
    }, 'PATCH');
    check('a BROKEN ranking is refused 422 by the same validator',
      badEdit.status === 422);

    const del = await jpost(`/api/tip-picks/${saved.saved.id}`, {}, 'DELETE');
    check('a row can be deleted', del.status === 200
      && (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.length === 0);

    // ---------------------------------------------- manual entry (D176)
    // Typed picks must produce the IDENTICAL payload extraction does - same
    // validator, same writer, same rows - so scoring and staking cannot tell
    // them apart. Only the audit columns differ, and honestly so.
    const manual = await (await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 2,
      sheets: [
        { sourceLabel: 'TrackMaster', picks: [{ horse_no: '1', rank: 1 }, { horse_no: '2', rank: 2 }] },
        // The SAME horse in a second sheet at a different rank - the case a
        // one-tipsheet-per-row grid could not express, and the reason the
        // entry dialog is horse-rows x tipsheet-columns.
        { sourceLabel: 'numberfire', picks: [{ horse_no: '2', rank: 1 }, { horse_no: '1', rank: 2 }] },
      ],
    })).json();
    check('manual entry saves one row per sheet', manual.sheets?.length === 2);
    {
      const rows = (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.filter((r) => r.raceNo === 2);
      check('  and normalizes the source the same way extraction does',
        rows.map((r) => r.sourceLabel).sort().join() === 'numberfire,trackmaster');
      const tm = rows.find((r) => r.sourceLabel === 'trackmaster');
      const nf = rows.find((r) => r.sourceLabel === 'numberfire');
      check('  the SAME horse can rank differently in two sheets',
        tm.picks.find((p) => p.horse_no === '1').rank === 1
        && nf.picks.find((p) => p.horse_no === '1').rank === 2);
      check('  horse names come from the DAY, not the client', tm.picks.every((p) => p.horse_name));
      check('  no odds are invented for a typed pick',
        tm.picks.every((p) => !('ml_odds' in p) && !('live_odds' in p)));
      check('  and the audit columns are honestly empty - no model, no image',
        tm.model === null && tm.imageSha256 === null);
      check('  a typed row carries the full tip_picks shape',
        ['id', 'raceNo', 'bucket', 'sourceLabel', 'picks', 'edited'].every((k) => k in tm)
        && tm.bucket === 'TIPSHEET');
    }

    // The same validator a model's output faces.
    const dupRank = await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 2, sheets: [{ sourceLabel: 'trackmaster', picks: [{ horse_no: '1', rank: 1 }, { horse_no: '2', rank: 1 }] }],
    });
    check('a duplicated rank is refused 422 by the shared validator', dupRank.status === 422);
    const ghost = await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 2, sheets: [{ sourceLabel: 'trackmaster', picks: [{ horse_no: '99', rank: 1 }] }],
    });
    check('a horse not in the race is refused 422', ghost.status === 422);

    // An empty sheet CLEARS that source - there is no second verb for it.
    await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 2, sheets: [{ sourceLabel: 'numberfire', picks: [] }],
    });
    {
      const rows = (await jget(`/api/race-days/${srvDayId}/tip-picks`)).rows.filter((r) => r.raceNo === 2);
      check('an empty sheet clears that source, leaving the others', rows.length === 1
        && rows[0].sourceLabel === 'trackmaster');
    }

    const missing = await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, {
      race: 99, sheets: [{ sourceLabel: 'trackmaster', picks: [{ horse_no: '1', rank: 1 }] }],
    });
    check('a race the day does not have is refused 404', missing.status === 404);
    const noSheets = await jpost(`/api/race-days/${srvDayId}/tip-picks/manual`, { race: 1 });
    check('a body with no sheets is refused 400', noSheets.status === 400);
  } finally {
    server.kill();
  }
}

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All tip-picks checks passed.');
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win file locks */ }
process.exit(failures ? 1 : 0);
