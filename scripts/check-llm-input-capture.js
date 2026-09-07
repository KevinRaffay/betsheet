// Verification for D149 (LLM input capture) - exits non-zero on any failure.
// Run: npm run check-llm-input-capture
//
// The real API is never called: the server boots with
// BETSHEET_LLM_TEST_MODE=1, exactly like scripts/check-llm-cards.js, so a
// request body's __stubResponse carries a canned model response through the
// exact preview/save path a real call would take. This script does not
// re-check anything scripts/check-llm-cards.js already covers (parsing,
// bankroll math, bucket isolation, etc.) - only the new D149 surface: what a
// generation call CONSUMED gets captured on llm_card_requests, exported at
// schemaVersion 3 as llmInputs, redacted by --omit-llm-inputs, and that a
// regeneration writes a NEW row plus a race_regenerated trace event while
// leaving the original row untouched.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-llminputcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const sha256 = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

const PORT = 8918;
const BASE = `http://127.0.0.1:${PORT}`;
const dbPath = path.join(tmp, 'check.sqlite');
const logDir = path.join(tmp, 'server-logs');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: dbPath,
    BETSHEET_LOG_DIR: logDir,
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
    BETSHEET_LLM_TEST_MODE: '1',
    ANTHROPIC_API_KEY: '', // the stub path must never need it
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body = {}, method = 'POST', headers = {}) =>
  fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
// The real client (LlmCardModal.jsx) keeps ONE correlationId in state for a
// whole Generate/Regenerate-All session and sends it as x-correlation-id on
// every call, preview and save alike (invariant 8) - a save that omits it
// gets a brand-new correlationId from the server and would never join back
// up with the preview that produced its requestId. This helper reproduces
// that real behavior rather than each call minting its own id.
const withCorrelation = (id) => (id ? { 'x-correlation-id': id } : {});
const jget = (url) => fetch(BASE + url).then((r) => r.json());

const entry = (pgm, name, ml, mld) => ({ programNumber: pgm, horseName: name, morningLine: ml, morningLineDecimal: mld, programRank: null, bestBet: false, scratched: false });
const wellFormedResponse = (pgm, dollars, note) =>
  `Reasoning: ${note}\n\n<<<TICKETS>>>\nWin | #${pgm} | $${dollars} | ${note}\n<<<END TICKETS>>>\n`;

// decision-trace events are newline-delimited JSON in the active log file
// (this run is far too short to rotate). Read directly rather than via the
// server's own readRecent - this script has no import access to a private
// module boundary reason to avoid, but reading the file is simpler and
// proves the bytes actually landed on disk.
function readTraceEvents() {
  const file = path.join(logDir, 'decision-trace.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots with BETSHEET_LLM_TEST_MODE=1 and no API key set', up, serverOut.slice(-300));

  console.log('-- fixture: a two-race day with results --');
  const day = {
    track: 'Input Capture Downs', date: '2026-09-08', bankrollCents: 20000, perRaceMinCents: 500,
    races: [
      { number: 1, wagerMenu: '$1 Exacta', entries: [entry('1', 'One Runner', '5/2', 2.5), entry('2', 'Two Runner', '4/1', 4)] },
      { number: 2, wagerMenu: '$1 Exacta', entries: [entry('1', 'Race Two One', '3/1', 3), entry('2', 'Race Two Two', '5/1', 5)] },
    ],
  };
  const created = await (await jpost('/api/race-days', day)).json();
  const dayId = created.id;
  await jpost(`/api/race-days/${dayId}/results`, {
    track: 'INPUT CAPTURE DOWNS', date: '2026-09-08', sourceKind: 'paste',
    races: [
      { number: 1, results: [{ programNumber: '1', horseName: 'One Runner', finishPosition: 1, winCents: 700, placeCents: 340, showCents: 260 }], exotics: [], scratches: [] },
      { number: 2, results: [{ programNumber: '2', horseName: 'Race Two Two', finishPosition: 1, winCents: 1200, placeCents: 600, showCents: 440 }], exotics: [], scratches: [] },
    ],
  });

  console.log('-- generate + save race 1 with an analyst note, so notes capture is exercised --');
  await jpost(`/api/race-days/${dayId}/llm-notes`, { race: 1, text: 'Pace looks soft; the speed is alone.', sourceLabel: 'public-handicapper' }, 'PUT');
  const p1 = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, __stubResponse: wellFormedResponse(1, 25, 'Strong on the ML.') })).json();
  check('preview returns a correlationId', typeof p1.correlationId === 'string' && p1.correlationId.length > 0, JSON.stringify(p1.correlationId));
  const s1 = await (await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 1, requestId: p1.requestId, bankrollCents: day.bankrollCents }, 'POST', withCorrelation(p1.correlationId))).json();
  const cardId = s1.cardId;
  check('save creates a card', Number.isInteger(cardId));

  console.log('-- the llm_card_requests row carries everything a reproduction check would need --');
  const dbCheck = new Database(dbPath, { readonly: true });
  const row1 = dbCheck.prepare('SELECT * FROM llm_card_requests WHERE id = ?').get(p1.requestId);
  check('correlation_id recorded and matches the preview response', row1.correlation_id === p1.correlationId, JSON.stringify(row1.correlation_id));
  check('system_prompt_text stored and its hash matches an independent recomputation', row1.system_prompt_text && row1.system_prompt_hash === sha256(row1.system_prompt_text), row1.system_prompt_hash);
  check('user_prompt_hash matches an independent hash of the stored prompt_text', row1.user_prompt_hash === sha256(row1.prompt_text), row1.user_prompt_hash);
  check('prompt_template_id/version are populated', typeof row1.prompt_template_id === 'string' && typeof row1.prompt_template_version === 'string', JSON.stringify({ id: row1.prompt_template_id, v: row1.prompt_template_version }));
  const requestParams1 = JSON.parse(row1.request_params);
  check('request_params carries the resolved sampling params (defaults, since no override was passed)', requestParams1.maxTokens === 4000 && requestParams1.temperature === 1, JSON.stringify(requestParams1));
  check('notes_rendered_text is the composed payload the model saw, hashing to notes_hash', row1.notes_rendered_text && sha256(row1.notes_rendered_text) === row1.notes_hash, JSON.stringify({ rendered: row1.notes_rendered_text, hash: row1.notes_hash }));
  check('notes_rendered_text is embedded verbatim in the stored prompt', row1.prompt_text.includes(row1.notes_rendered_text));

  console.log('-- trace: llm_request_sent and llm_response_received bracket the call --');
  {
    // This is race 1 of a brand-new card, so both events fire from the
    // PREVIEW call before the card exists - cardId is null on them, same
    // nullability llm_card_requests.card_id already has for this exact call
    // (see server/llm-cards.js's architecture comment).
    const events = readTraceEvents().filter((e) => e.correlationId === p1.correlationId);
    const sent = events.find((e) => e.event === 'llm_request_sent' && e.races?.includes(1));
    const received = events.find((e) => e.event === 'llm_response_received');
    check('llm_request_sent logged with cardId null (card does not exist yet) and the prompt template/hashes', sent && sent.cardId === null && sent.promptTemplate?.id === row1.prompt_template_id && sent.promptHashes?.user === `sha256:${row1.user_prompt_hash}`, JSON.stringify(sent));
    check('llm_response_received logged with a parsed ticket count and no parse errors', received && received.parsedTicketCount === 1 && received.parseErrors.length === 0, JSON.stringify(received));
  }

  console.log('-- export at schemaVersion 3 carries llmInputs --');
  const exp1 = await jget(`/api/cards/${cardId}/export`);
  check('export.schemaVersion is 3', exp1.export.schemaVersion === 3, exp1.export.schemaVersion);
  check('llmInputs is an array with one entry for this correlation id', Array.isArray(exp1.llmInputs) && exp1.llmInputs.length === 1 && exp1.llmInputs[0].correlationId === p1.correlationId, JSON.stringify(exp1.llmInputs));
  const entry1 = exp1.llmInputs[0];
  check('the entry lists race 1 and carries the model/template/hashes', entry1.races.includes(1) && entry1.model === 'stub' && entry1.promptTemplate.id === row1.prompt_template_id, JSON.stringify(entry1));
  const req1 = entry1.requests.find((r) => r.race === 1);
  check('the per-race request carries the FULL rendered prompt/response and raw+rendered notes', req1.promptRendered === row1.prompt_text && req1.responseRaw === row1.response_text && req1.notes?.raw?.race === 'Pace looks soft; the speed is alone.' && req1.notes.rendered === row1.notes_rendered_text, JSON.stringify(req1));

  console.log('-- --omit-llm-inputs strips verbatim text but keeps hashes/chars --');
  const exp1Redacted = await jget(`/api/cards/${cardId}/export?omitLlmInputs=1`);
  const req1Redacted = exp1Redacted.llmInputs[0].requests.find((r) => r.race === 1);
  check('promptRendered/responseRaw/systemPromptRendered are gone', req1Redacted.promptRendered === undefined && req1Redacted.responseRaw === undefined && req1Redacted.systemPromptRendered === undefined, JSON.stringify(req1Redacted));
  check('notes.raw/notes.rendered are gone but notes.hash/notes.chars survive', req1Redacted.notes.raw === undefined && req1Redacted.notes.rendered === undefined && req1Redacted.notes.hash === req1.notes.hash && req1Redacted.notes.chars === req1.notes.chars, JSON.stringify(req1Redacted.notes));
  check('promptHashes/promptTemplate/race/model are unaffected by redaction', req1Redacted.promptHashes.user === req1.promptHashes.user && exp1Redacted.llmInputs[0].promptTemplate.id === entry1.promptTemplate.id);

  console.log('-- a non-LLM card exports llmInputs: null, never [] --');
  {
    const humanCard = await (await jpost(`/api/race-days/${dayId}/human-cards`, { race: 2, text: '$5 W 2', bankrollCents: 20000 })).json();
    const humanExport = await jget(`/api/cards/${humanCard.cardId}/export`);
    check('a HUMAN card carries llmInputs: null (not applicable, not "unknown")', humanExport.llmInputs === null, JSON.stringify(humanExport.llmInputs));
  }

  console.log('-- an LLM card whose requests predate this capture (no correlation_id) also exports null, not [] --');
  {
    // Simulate a pre-migration-026 row: same shape check-llm-cards.js's own
    // stub path would have produced before this deliverable, achieved by
    // clearing the new columns directly rather than fabricating a second
    // server binary that predates them.
    const otherDay = await (await jpost('/api/race-days', {
      track: 'Legacy Row Downs', date: '2026-09-08', bankrollCents: 20000, perRaceMinCents: 500,
      races: [{ number: 1, wagerMenu: '$1 Exacta', entries: [entry('1', 'Legacy One', '5/2', 2.5), entry('2', 'Legacy Two', '4/1', 4)] }],
    })).json();
    const legacyPreview = await (await jpost(`/api/race-days/${otherDay.id}/llm-cards/preview`, { race: 1, __stubResponse: wellFormedResponse(1, 20, 'legacy') })).json();
    const legacySave = await (await jpost(`/api/race-days/${otherDay.id}/llm-cards`, { race: 1, requestId: legacyPreview.requestId })).json();
    const dbWrite = new Database(dbPath);
    dbWrite.prepare(`UPDATE llm_card_requests SET correlation_id = NULL, system_prompt_text = NULL, system_prompt_hash = NULL,
      user_prompt_hash = NULL, notes_rendered_text = NULL, prompt_template_id = NULL, prompt_template_version = NULL, request_params = NULL
      WHERE id = ?`).run(legacyPreview.requestId);
    dbWrite.close();
    const legacyExport = await jget(`/api/cards/${legacySave.cardId}/export`);
    check('an LLM card with no D149-captured rows exports llmInputs: null, not []', legacyExport.llmInputs === null, JSON.stringify(legacyExport.llmInputs));
  }

  console.log('-- regenerating race 1: a NEW request row, the original untouched, and a race_regenerated event --');
  {
    // A fresh session (no x-correlation-id header) - the realistic shape of
    // reopening the modal later and regenerating a race, exactly the cards
    // 180/181 scenario the deliverable names.
    const p1b = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, cardId, __stubResponse: wellFormedResponse(1, 30, 'Revised.') })).json();
    check('the regeneration got its own correlationId', p1b.correlationId !== p1.correlationId, JSON.stringify({ a: p1.correlationId, b: p1b.correlationId }));
    await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 1, requestId: p1b.requestId, cardId }, 'POST', withCorrelation(p1b.correlationId));

    const row1After = dbCheck.prepare('SELECT * FROM llm_card_requests WHERE id = ?').get(p1.requestId);
    check('the ORIGINAL request row is byte-for-byte untouched (append-only)', row1After.prompt_text === row1.prompt_text && row1After.response_text === row1.response_text && row1After.correlation_id === row1.correlation_id, 'original row mutated');

    const row1b = dbCheck.prepare('SELECT * FROM llm_card_requests WHERE id = ?').get(p1b.requestId);
    check('the regeneration wrote its OWN new row, not an update to the old one', row1b.id !== row1.id && row1b.correlation_id === p1b.correlationId);

    const events = readTraceEvents();
    const regen = events.find((e) => e.event === 'race_regenerated' && e.cardId === cardId && e.race === 1);
    check('race_regenerated logged with the old/new correlation ids and the ticket count removed', regen && regen.previousCorrelationId === p1.correlationId && regen.newCorrelationId === p1b.correlationId && regen.ticketsRemoved === 1, JSON.stringify(regen));

    const exp2 = await jget(`/api/cards/${cardId}/export`);
    check('llmInputs now carries BOTH correlation ids for race 1 - the superseded attempt is not erased from the record', exp2.llmInputs.length === 2 && exp2.llmInputs.some((e) => e.correlationId === p1.correlationId) && exp2.llmInputs.some((e) => e.correlationId === p1b.correlationId), JSON.stringify(exp2.llmInputs.map((e) => e.correlationId)));
  }

  dbCheck.close();
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-llm-input-capture: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-llm-input-capture: all checks passed');
