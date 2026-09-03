// Verification for D63 (LLM cards) - exits non-zero on any failure.
// Run: npm run check-llm-cards
//
// The real API is never called: the server boots with
// BETSHEET_LLM_TEST_MODE=1, which lets a request body carry
// `__stubResponse` (a canned model response) straight through the exact
// same parsing/persistence path a real call would take. Phase 1: the
// pure prompt builder and ticket-block extractor. Phase 2: the real
// server on a temp DB - preview/save round trip, per-race bankroll math
// as it depletes, append-only across races, a malformed response (no
// hard error is silently swallowed, no card persists), blocking-warning
// refusal on save, reasoning/response retrievable per race, bucket
// isolation in P/L, and the no-version-bump identity.

import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-llmcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

// ---------- phase 1: pure ----------

const { buildLlmRaceUserPrompt, extractTicketBlock, SYSTEM_PROMPT } = await import('../server/llm-prompt.js');

console.log('-- pure: buildLlmRaceUserPrompt --');
{
  const prompt = buildLlmRaceUserPrompt({
    raceNumber: 1, totalRaces: 2, track: 'Prompt Fixture Downs', date: '2026-08-30',
    race: { surface: 'Dirt', distance: '6 Furlongs', raceType: 'ALLOWANCE', postTime: '1:00 PM', wagerMenu: '$1 Exacta' },
    entries: [
      { programNumber: '1', horseName: 'One Runner', morningLine: '5/2', programRank: 1, bestBet: true, scratched: false },
      { programNumber: '2', horseName: 'Two Runner', morningLine: '4/1', programRank: null, bestBet: false, scratched: true },
    ],
    bottomLineText: 'One Runner drops in class and adds blinkers.',
    consensusTable: [{ name: 'Sports from the Basement', top: { programNumber: '1', horseName: 'One Runner' }, second: null, third: null, flagged: [] }],
    bankroll: { perRaceCents: 2500, remainingCents: 5000, racesRemaining: 2 },
  });
  check('carries race header, wager menu and bankroll', prompt.includes('RACE 1 of 2') && prompt.includes('$1 Exacta') && prompt.includes('$25.00'));
  check('carries every entry with scratch/best-bet/rank annotations', prompt.includes('#1 One Runner') && prompt.includes('BEST BET') && prompt.includes('#2 Two Runner (SCRATCHED)'));
  check('carries the Bottom Line text', prompt.includes('One Runner drops in class'));
  check('carries the consensus table', prompt.includes('Sports from the Basement: top #1 One Runner'));

  const empty = buildLlmRaceUserPrompt({
    raceNumber: 1, totalRaces: 1, track: 'X', date: '2026-01-01',
    race: {}, entries: [], bottomLineText: null, consensusTable: [], bankroll: { perRaceCents: 100, remainingCents: 100, racesRemaining: 1 },
  });
  check('no consensus on file -> the honest fallback line, not an empty section', empty.includes('No external consensus on file'));

  check('system prompt names the ticket-block markers', SYSTEM_PROMPT.includes('<<<TICKETS>>>') && SYSTEM_PROMPT.includes('<<<END TICKETS>>>'));
}

console.log('-- pure: extractTicketBlock --');
{
  const wellFormed = 'Reasoning goes here about #1.\n\n<<<TICKETS>>>\nWin | #1 | $25 | Favorite on the morning line.\n<<<END TICKETS>>>\n';
  const out = extractTicketBlock(wellFormed);
  check('splits reasoning from the ticket block', out.reasoningText === 'Reasoning goes here about #1.' && out.ticketBlockText.includes('Win | #1 | $25'));
  check('missing markers -> null (hard failure upstream)', extractTicketBlock('just prose, no markers') === null);
  check('markers present but empty block -> parses to an empty (not null) block', extractTicketBlock('reasoning\n<<<TICKETS>>>\n<<<END TICKETS>>>').ticketBlockText === '');
}

// ---------- phase 2: server round-trip ----------

const PORT = 8909;
const BASE = `http://127.0.0.1:${PORT}`;
const dbPath = path.join(tmp, 'check.sqlite');
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: dbPath,
    BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'),
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
    BETSHEET_LLM_TEST_MODE: '1',
    ANTHROPIC_API_KEY: '', // deliberately unset - the stub path must never need it
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body = {}) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jget = (url) => fetch(BASE + url).then((r) => r.json());

const entry = (pgm, name, ml, mld, opts = {}) => ({ programNumber: pgm, horseName: name, morningLine: ml, morningLineDecimal: mld, programRank: opts.rank ?? null, bestBet: false, scratched: Boolean(opts.scratched) });

const wellFormedResponse = (pgm, dollars, note) =>
  `Reasoning: ${note}\n\n<<<TICKETS>>>\nWin | #${pgm} | $${dollars} | ${note}\n<<<END TICKETS>>>\n`;
const noMarkersResponse = 'I like the favorite here but forgot the ticket format entirely.';
const unknownProgramResponse = 'Reasoning about a horse not on this card.\n\n<<<TICKETS>>>\nWin | #9 | $25 | Ghost horse.\n<<<END TICKETS>>>\n';

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots with BETSHEET_LLM_TEST_MODE=1 and no API key set', up, serverOut.slice(-300));

  console.log('-- fixture: a two-race day with results --');
  const day = {
    track: 'LLM Fixture Downs', date: '2026-08-31', bankrollCents: 20000, perRaceMinCents: 500,
    races: [
      { number: 1, wagerMenu: '$1 Exacta', entries: [entry('1', 'One Runner', '5/2', 2.5, { rank: 1 }), entry('2', 'Two Runner', '4/1', 4)] },
      { number: 2, wagerMenu: '$1 Exacta', entries: [entry('1', 'Race Two One', '3/1', 3, { rank: 1 }), entry('2', 'Race Two Two', '5/1', 5)] },
    ],
  };
  const created = await (await jpost('/api/race-days', day)).json();
  const dayId = created.id;
  await jpost(`/api/race-days/${dayId}/results`, {
    track: 'LLM FIXTURE DOWNS', date: '2026-08-31', sourceKind: 'paste',
    races: [
      { number: 1, results: [{ programNumber: '1', horseName: 'One Runner', finishPosition: 1, winCents: 700, placeCents: 340, showCents: 260 }], exotics: [], scratches: [] },
      { number: 2, results: [{ programNumber: '2', horseName: 'Race Two Two', finishPosition: 1, winCents: 1200, placeCents: 600, showCents: 440 }], exotics: [], scratches: [] },
    ],
  });

  console.log('-- preview race 1: well-formed stub response --');
  const p1 = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, __stubResponse: wellFormedResponse(1, 25, 'Strong on the morning line.') })).json();
  check('preview parses one ticket, no blocking warnings, ruleTags carry llm', p1.tickets.length === 1 && p1.warnings.every((w) => !w.blocking) && p1.tickets[0].ruleTags?.[0] === 'llm', JSON.stringify(p1));
  check('reasoning text extracted separately from the ticket block', p1.reasoningText === 'Reasoning: Strong on the morning line.', p1.reasoningText);
  check('per-race bankroll on the first (cardless) preview = bankroll / totalRaces', p1.perRaceBankrollCents === 10000, JSON.stringify(p1));
  check('requestId present (the audit log row)', Number.isInteger(p1.requestId));

  console.log('-- save race 1: creates a new card in its own bucket --');
  const s1 = await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 1, requestId: p1.requestId, bankrollCents: day.bankrollCents });
  const s1Body = await s1.json();
  check('save creates a card (201) with one ticket', s1.status === 201 && s1Body.tickets.length === 1, JSON.stringify(s1Body));
  const cardId = s1Body.cardId;
  const cardRow = await jget(`/api/cards/${cardId}`);
  check('card is template llm, bucket LLM_GENERATED, engine_version llm', cardRow.template === 'llm' && cardRow.consensus_completeness === 'LLM_GENERATED' && cardRow.engine_version === 'llm', JSON.stringify({ t: cardRow.template, c: cardRow.consensus_completeness, e: cardRow.engine_version }));
  check('the day already had results - the card graded immediately', s1Body.graded != null);

  console.log('-- preview race 2 on the SAME card: bankroll recomputed from what race 1 actually spent --');
  const p2 = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 2, cardId, __stubResponse: wellFormedResponse(2, 40, 'Value price given the consensus.') })).json();
  check('race 2 bankroll = (20000 - 2500 spent on race 1) / 1 remaining race', p2.perRaceBankrollCents === 17500, JSON.stringify(p2));

  console.log('-- save race 2: appends to the SAME card (D28 append-only), never a second card --');
  const s2 = await (await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 2, requestId: p2.requestId, cardId })).json();
  check('appended to the same cardId', s2.cardId === cardId, JSON.stringify(s2));
  const cardAfter2 = await jget(`/api/cards/${cardId}`);
  check('card now carries two tickets, one per race', cardAfter2.tickets.length === 2);

  console.log('-- regenerate race 1: replaces its ticket, still one ticket for race 1 --');
  const p1b = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, cardId, __stubResponse: wellFormedResponse(1, 30, 'Revised after seeing race 2 spend.') })).json();
  // Race 1's own prior $25 is excluded from "spent so far" (it's about to
  // be replaced), but race 2's confirmed $40 counts: (20000 - 4000) / 1
  // remaining race (race 1 itself is the only one still undecided).
  check('regenerating race 1 excludes its OWN prior spend but still counts race 2\'s confirmed spend', p1b.perRaceBankrollCents === 16000, JSON.stringify(p1b));
  await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 1, requestId: p1b.requestId, cardId });
  const cardAfterRegen = await jget(`/api/cards/${cardId}`);
  check('still exactly two tickets total (race 1 replaced, not duplicated)', cardAfterRegen.tickets.length === 2, JSON.stringify(cardAfterRegen.tickets.map((t) => t.cost_cents)));

  console.log('-- malformed response: no ticket-block markers -> visible error, nothing persisted, still logged --');
  const badPreview = await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, cardId, __stubResponse: noMarkersResponse });
  const badBody = await badPreview.json();
  check('preview reports a hard error (502), no tickets', badPreview.status === 502 && badBody.error, JSON.stringify(badBody));
  const dbCheck = new Database(dbPath, { readonly: true });
  const loggedBad = dbCheck.prepare('SELECT * FROM llm_card_requests WHERE race_day_id = ? AND response_text = ? ORDER BY id DESC').get(dayId, noMarkersResponse);
  check('the failed attempt is still logged verbatim in llm_card_requests, error populated', loggedBad && loggedBad.error && loggedBad.card_id === cardId, JSON.stringify(loggedBad));
  const cardUnchanged = await jget(`/api/cards/${cardId}`);
  check('the malformed attempt did not touch the card', cardUnchanged.tickets.length === 2);

  console.log('-- unknown program number: preview succeeds (200) with a blocking warning; save refuses (422) --');
  const unknownPreview = await (await jpost(`/api/race-days/${dayId}/llm-cards/preview`, { race: 1, cardId, __stubResponse: unknownProgramResponse })).json();
  check('preview is not a hard error - it previews the bad pick with a blocking warning, like a human bad paste would', unknownPreview.tickets.length === 0 && unknownPreview.warnings.some((w) => w.blocking && w.type === 'unknown_program'), JSON.stringify(unknownPreview));
  const unknownSave = await jpost(`/api/race-days/${dayId}/llm-cards`, { race: 1, requestId: unknownPreview.requestId, cardId });
  check('save refuses blocking warnings (422), nothing changed', unknownSave.status === 422);
  const cardStillUnchanged = await jget(`/api/cards/${cardId}`);
  check('card still exactly two tickets after the refused save', cardStillUnchanged.tickets.length === 2);

  console.log('-- reasoning + raw response retrievable per race --');
  const requests = await jget(`/api/cards/${cardId}/llm-requests`);
  check('every logged call for this card is retrievable, race 1 and race 2 both present', requests.some((r) => r.raceNumber === 1) && requests.some((r) => r.raceNumber === 2));
  const race2Row = requests.find((r) => r.raceNumber === 2 && !r.error);
  check('raw response text (reasoning included) stored verbatim', race2Row?.responseText === wellFormedResponse(2, 40, 'Value price given the consensus.'), race2Row?.responseText);

  console.log('-- bucket isolation in P/L --');
  const pl = await jget('/api/pl?engineVersion=all');
  const llmBucket = pl.buckets.find((b) => b.completeness === 'LLM_GENERATED');
  const humanBucket = pl.buckets.find((b) => b.completeness === 'HUMAN');
  check('LLM_GENERATED is its own bucket, isolated from every other bucket', llmBucket && llmBucket.cards === 1 && !humanBucket, JSON.stringify(pl.buckets.map((b) => b.completeness)));
  check('every LLM_GENERATED card row belongs to this day, none pooled from elsewhere', pl.cards.filter((c) => c.completeness === 'LLM_GENERATED').every((c) => c.raceDayId === dayId));

  console.log('-- no engine-version bump / lean fixture identity unchanged --');
  const leanCard = await (await jpost(`/api/race-days/${dayId}/cards`, {})).json();
  const { ENGINE_VERSION } = await import('../shared/card-engine.js');
  check('ENGINE_VERSION unchanged, a live lean card still generates under it', ENGINE_VERSION === 'lean-1.1' && leanCard.engineVersion === 'lean-1.1');

  dbCheck.close();
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-llm-cards: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-llm-cards: all checks passed');
