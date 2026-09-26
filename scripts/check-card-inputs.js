// Verification for the card sheet footer's "Sources used" (D439):
// server/card-inputs.js, shared/card-sources.js and loadDaySignals' `asOf`.
// Run: npm run check-card-inputs
//
// Seeds a THROWAWAY temp database (logger redirected too - CLAUDE.md Gotchas:
// BETSHEET_DB alone is not isolation) with one day carrying every post-pivot
// producer, then asserts each card names exactly what it had. The assertions
// that matter most are the NEGATIVE ones: a source that arrived after a
// COMBINED card was saved is not claimed, a market-legs card claims no tip
// sheet, and no post-pivot card ever falls back to the engine-era sentence
// "program analysis and morning lines only" - the false claim D439 removes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-card-inputs-'));
process.env.BETSHEET_DB = path.join(tmp, 'check.sqlite');
process.env.BETSHEET_LOG_DIR = path.join(tmp, 'logs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

const { describeCardSources } = await import('../shared/card-sources.js');
const { validateStaticPayload } = await import('../shared/static-payload.js');
const ENGINE_SENTENCE = 'program analysis and morning lines only';

console.log('-- the pure footer line --');
{
  const noLegacy = { used: [], unavailable: [] };
  check('an engine-era card with no fetch rows keeps the engine sentence',
    describeCardSources({ consensus_completeness: 'PROGRAM_ONLY', sources: noLegacy }).used === ENGINE_SENTENCE);
  const legacy = { used: [{ name: 'dmtc', ts: '2026-08-01T10:00:00Z' }], unavailable: [{ name: 'brisnet' }] };
  const eng = describeCardSources({ consensus_completeness: 'FULL', sources: legacy });
  check('an engine-era card keeps its legacy fetch rows', eng.used === 'dmtc (2026-08-01)' && eng.unavailable[0] === 'brisnet');
  check('a post-pivot card with no inputs (pre-D439 snapshot) does not borrow the engine sentence',
    describeCardSources({ consensus_completeness: 'LLM_GENERATED', sources: noLegacy }).used === 'not recorded for this card');
  const post = describeCardSources({ consensus_completeness: 'COMBINED', sources: noLegacy, inputs: { used: ['morning lines', 'Equibase OTR'], note: 'n' } });
  check('a post-pivot card states its own inputs', post.used === 'morning lines, Equibase OTR' && post.note === 'n');
}

console.log('-- every producer on one day --');
{
  const { openDb } = await import('../server/db.js');
  const { getCardCore } = await import('../server/cards.js');
  const { getCardInputs } = await import('../server/card-inputs.js');
  const { loadDaySignals } = await import('../server/race-consensus.js');
  const db = openDb(process.env.BETSHEET_DB);
  const dayId = db.prepare("INSERT INTO race_days (track, date, correlation_id) VALUES ('Remington Park', '2026-09-10', 'corr-day')").run().lastInsertRowid;
  const raceIds = [1, 2, 3].map((n) => db.prepare('INSERT INTO races (race_day_id, number) VALUES (?, ?)').run(dayId, n).lastInsertRowid);
  for (const rid of raceIds) {
    for (const p of ['1', '2', '3', '4']) {
      db.prepare('INSERT INTO entries (race_id, program_number, horse_name, morning_line_decimal) VALUES (?, ?, ?, ?)')
        .run(rid, p, `Horse ${p}`, Number(p) + 1);
    }
  }
  let cardNo = 0;
  const card = (bucket, version, { model = null, createdAt = '2026-09-10T15:00:00Z', variant = 'default', tipSource = null, flags = [0, 0, 0] } = {}) => {
    cardNo += 1;
    return db.prepare(`INSERT INTO cards (race_day_id, card_number, variant, bankroll_cents, status, correlation_id,
        consensus_completeness, engine_version, llm_model, created_at, tip_source_label,
        notes_present, live_odds_present, tip_sheets_present)
      VALUES (?, ?, ?, 20000, 'final', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(dayId, cardNo, variant, `corr-${cardNo}`, bucket, version, model, createdAt, tipSource, ...flags).lastInsertRowid;
  };
  let seq = 0;
  const ticket = (cardId, raceNo, legs, races = [raceNo]) => {
    seq += 1;
    db.prepare(`INSERT INTO tickets (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents, teller_call)
      VALUES (?, ?, ?, 'win', ?, 200, 200, 'x')`)
      .run(cardId, raceNo ? raceIds[raceNo - 1] : null, seq, JSON.stringify({ races, legs }));
  };
  const tip = (raceNo, source, createdAt) => db.prepare(`INSERT INTO tip_picks (race_day_id, race_no, source_label, picks, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(dayId, raceNo, source, JSON.stringify([{ horse_no: '2', horse_name: 'x', rank: 1 }]), createdAt);
  const inputsOf = (id) => getCardInputs(db, getCardCore(db, id));

  // Two tip sheets before everything; a third arrives AFTER the parlay.
  tip(1, 'trackmaster', '2026-09-10T12:00:00Z');
  tip(2, 'numberfire', '2026-09-10T12:00:00Z');
  tip(1, 'equibase-tipsheet', '2026-09-10T18:00:00Z');

  // LLM card: notes + tip sheets on race 1, nothing on race 2.
  const llm = card('LLM_GENERATED', 'llm', { model: 'claude-sonnet-5', createdAt: '2026-09-10T13:00:00Z', flags: [1, 0, 1] });
  ticket(llm, 1, [['2']]);
  db.prepare(`INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, requested_at,
      notes_present, notes_source_label, tip_sheets_present) VALUES (?, ?, 1, 'p', '2026-09-10T13:00:00Z', 1, 'public-handicapper', 1)`)
    .run(dayId, llm);
  // A race generated onto the same card AFTER the parlay was saved.
  ticket(llm, 3, [['1']]);
  db.prepare(`INSERT INTO llm_card_requests (race_day_id, card_id, race_number, prompt_text, requested_at)
    VALUES (?, ?, 3, 'p', '2026-09-10T19:00:00Z')`).run(dayId, llm);

  const otr = card('EQB_OTR', 'equibase-otr', { createdAt: '2026-09-10T11:00:00Z' });
  ticket(otr, 2, [['3']]);
  const tipCard = card('TIPSHEET', 'tipsheet', { tipSource: 'trackmaster' });
  ticket(tipCard, 1, [['2']]);
  const human = card('HUMAN', 'human');
  ticket(human, 1, [['4']]);

  // A typed board on races 1-2, before the parlay.
  const cap = db.prepare("INSERT INTO odds_captures (race_day_id, source, ingested_at) VALUES (?, 'manual', '2026-09-10T14:00:00Z')").run(dayId).lastInsertRowid;
  for (const [r, p] of [[1, '1'], [1, '2'], [2, '1'], [2, '2']]) {
    db.prepare("INSERT INTO odds_capture_entries (capture_id, race_number, program_number, live_odds) VALUES (?, ?, ?, '3/1')").run(cap, r, p);
  }

  // The parlay: races 1-2, saved at 16:00; a market-legs twin; and a
  // combined parlay on race 3 alone, where nothing had voted at save time.
  const combined = card('COMBINED', 'combined-1', { createdAt: '2026-09-10T16:00:00Z', variant: 'combined-legs' });
  ticket(combined, null, [['2'], ['3']], [1, 2]);
  const market = card('COMBINED', 'combined-1', { createdAt: '2026-09-10T16:00:00Z', variant: 'market-legs' });
  ticket(market, null, [['2'], ['3']], [1, 2]);
  const lonely = card('COMBINED', 'combined-1', { createdAt: '2026-09-10T16:00:00Z', variant: 'combined-legs' });
  ticket(lonely, null, [['1'], ['1']], [3, 3]);

  const li = inputsOf(llm).used;
  check('LLM: names the model by its label', li[0] === 'LLM (Sonnet 5)', li[0]);
  check('LLM: carries entries and morning lines', li.includes('entries and morning lines'));
  check('LLM: notes named by their recorded source', li.includes('analyst notes (public-handicapper)'), li.join(' | '));
  check('LLM: tip sheets on file when its prompt was built, not later ones', li.includes('tip sheets (trackmaster)'), li.join(' | '));
  check('LLM: no live board claimed without the flag', !li.includes('live board'));

  check('OTR states the printed sheet', inputsOf(otr).used[0].includes('Off to the Races'));
  check('TIPSHEET names its one sheet', inputsOf(tipCard).used[0] === 'tip sheet (trackmaster)');
  check('HUMAN claims only the hand-entered picks', inputsOf(human).used.join() === 'hand-entered picks');

  const ci = inputsOf(combined);
  check('COMBINED: morning lines and the live board on its races', ci.used[0] === 'morning lines' && ci.used.includes('live board'), ci.used.join(' | '));
  check('COMBINED: both tip sheets it read, not the one added after', ci.used.includes('tip sheets (numberfire + trackmaster)'), ci.used.join(' | '));
  check('COMBINED: the LLM card and OTR it read', ci.used.includes('LLM cards (Sonnet 5)') && ci.used.includes('Equibase OTR'), ci.used.join(' | '));
  check('COMBINED: says the list is as of the save', /when the card was saved/.test(ci.note ?? ''));

  const mi = inputsOf(market);
  check('market-legs: no tip sheet, LLM or OTR claimed', !mi.used.some((u) => /tip|LLM|OTR/.test(u)), mi.used.join(' | '));
  check('market-legs: says why', /market-only/.test(mi.note ?? ''));

  const lo = inputsOf(lonely).used;
  check('COMBINED on race 3: an LLM race generated after the save is not claimed', !lo.some((u) => /LLM/.test(u)), lo.join(' | '));
  check('COMBINED on race 3: no board on that race, none claimed', !lo.includes('live board'));

  check('asOf: absent, every signal counts', loadDaySignals(db, dayId).races.get(1).tipSources.length === 2);
  check('asOf: set, the later tip sheet drops out',
    loadDaySignals(db, dayId, { asOf: '2026-09-10T16:00:00Z' }).races.get(1).tipSources.join() === 'trackmaster');

  for (const id of [llm, otr, tipCard, human, combined, market, lonely]) {
    const c = getCardCore(db, id);
    const line = describeCardSources({ ...c, sources: { used: [], unavailable: [] }, inputs: getCardInputs(db, c) });
    check(`card ${id} (${c.consensus_completeness}) never claims the engine sentence`, line.used !== ENGINE_SENTENCE);
  }

  const { buildStaticDay } = await import('../server/static-payload-builder.js');
  const built = buildStaticDay(db, dayId);
  check('the static day carries inputs on every card', built.day?.cards?.every((c) => c.inputs && Array.isArray(c.inputs.used)));
  const bad = { version: 1, raceDays: [{ ...built.day, cards: [{ ...built.day.cards[0], inputs: { used: 'x' } }] }] };
  check('the payload validator refuses a malformed inputs shape',
    validateStaticPayload(bad).some((p) => /inputs\.used/.test(p)));
  db.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exitCode = 1; } else console.log('\nall card-inputs checks passed');
