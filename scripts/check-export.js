// Verification for the decision-trace export - exits non-zero on failure.
// Run: npm run check-export
//
// The server runs with a tiny BETSHEET_LOG_MAX_BYTES so the one card's
// trace provably spans MULTIPLE rotated log files - an export that only
// read the active file would fail the seq-contiguity check. One rotated
// file is then gzipped in place (exactly what the retention sweep does)
// and the export must still come back whole. The engine's gap-free `seq`
// counter is the tamper-evidence: any lost line breaks contiguity.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-exportcheck-'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/programs/delmar-2026-08-30.expected.json'), 'utf8'));
const sftb = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sources/sftb-delmar-2026-08-30.expected.json'), 'utf8'));
const chart = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts/dmr-2026-08-30.expected.json'), 'utf8'));

const PORT = 8906;
const BASE = `http://127.0.0.1:${PORT}`;
const logDir = path.join(tmp, 'server-logs');
const dbPath = path.join(tmp, 'check.sqlite');
const serverEnv = {
  ...process.env,
  BETSHEET_PORT: String(PORT),
  BETSHEET_DB: dbPath,
  BETSHEET_LOG_DIR: logDir,
  BETSHEET_LOG_MAX_BYTES: '4096', // force many rotations
  BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
};
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jget = (url) => fetch(BASE + url).then((r) => r.json());

// Engine events carry seq; assert the full generation run survived intact.
const engineSeqs = (trace) => trace.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
const contiguous = (seqs) => {
  const s = [...seqs].sort((a, b) => a - b);
  return s.length > 0 && s[0] === 0 && s.every((v, i) => v === i);
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((rr) => setTimeout(rr, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  const day = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500,
    races: prog.races,
  })).json();
  for (const name of ['Digest One', 'Digest Two']) {
    const text = sftb.races.map((x) => `Race ${x.race}: ${x.picks.map((p) => p.programNumber).join(', ')}`).join('\n');
    const preview = await (await jpost(`/api/race-days/${day.id}/consensus/manual-preview`, { sourceName: name, text })).json();
    await jpost(`/api/race-days/${day.id}/consensus/manual`, { sourceName: name, races: preview.races });
  }
  const card = await (await jpost(`/api/race-days/${day.id}/cards`, { variant: 'default' })).json();
  await new Promise((rr) => setTimeout(rr, 300));

  console.log('-- export before results --');
  const early = await jget(`/api/cards/${card.id}/export`);
  check('schema envelope present and versioned',
    early.export?.schema === 'betsheet.card-trace-export' &&
    Number.isInteger(early.export.schemaVersion) && early.export.docs === 'docs/trace-schema.md');
  check('ungraded card: every ticket grade null, gradeSummary null, results empty',
    early.tickets.length === card.tickets.length &&
    early.tickets.every((t) => t.grade === null) && early.gradeSummary === null &&
    early.results.finishers.length === 0);
  check('generation trace complete across rotated files (seq 0..N gap-free)',
    contiguous(engineSeqs(early.trace)) && early.traceStatus === 'complete',
    `seqs=${engineSeqs(early.trace).length} status=${early.traceStatus}`);
  const rotatedCount = fs.readdirSync(logDir).filter((f) => /^decision-trace\.\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/.test(f)).length;
  check('the trace really does span multiple files (the rotation forcing worked)',
    rotatedCount >= 2, `rotated files: ${rotatedCount}`);
  check('trace is chronological and starts at the inputs snapshot',
    early.trace[0]?.event === 'inputs_snapshot' &&
    early.trace.some((e) => e.event === 'card_finalized'));
  check('every trace event belongs to this card (correlation id or cardId)',
    early.trace.every((e) => e.correlationId === early.card.correlationId || e.cardId === early.card.id));
  check('races carry entries + classification for self-containment',
    early.races.length === 10 &&
    early.races.every((r) => r.entries.length > 0 && r.classification) &&
    early.consensus.length > 0);

  console.log('-- export after results --');
  await jpost(`/api/race-days/${day.id}/results`, {
    track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races,
  });
  await new Promise((rr) => setTimeout(rr, 300));
  const full = await jget(`/api/cards/${card.id}/export`);
  check('every ticket now carries its grade; summary consistent', (() => {
    if (!full.tickets.every((t) => t.grade && ['win', 'loss', 'refund', 'partial'].includes(t.grade.outcome))) return false;
    const s = full.gradeSummary;
    return s && s.plCents === s.returnedCents - s.costCents &&
      s.costCents === full.tickets.reduce((a, t) => a + t.costCents, 0);
  })());
  const gradesRead = await jget(`/api/cards/${card.id}/grades`);
  check('grade summary agrees with the grading endpoint',
    gradesRead.summary.plCents === full.gradeSummary.plCents);
  check('trace joined: one ticket_graded per ticket + card_graded, after generation',
    full.trace.filter((e) => e.event === 'ticket_graded').length === full.tickets.length &&
    full.trace.filter((e) => e.event === 'card_graded').length === 1 &&
    full.trace.findIndex((e) => e.event === 'card_graded') > full.trace.findIndex((e) => e.event === 'card_finalized'));
  check('results section carries the chart (finishers, exotics, resolved scratches)',
    full.results.finishers.length === 90 && full.results.exotics.length === 67 &&
    full.results.scratches.some((s) => s.programNumber != null));

  console.log('-- durability --');
  // Gzip one rotated trace file in place, exactly like the retention sweep.
  const rotated = fs.readdirSync(logDir).filter((f) => /^decision-trace\..*\.jsonl$/.test(f));
  const victim = path.join(logDir, rotated[0]);
  fs.writeFileSync(`${victim}.gz`, zlib.gzipSync(fs.readFileSync(victim)));
  fs.unlinkSync(victim);
  const afterGz = await jget(`/api/cards/${card.id}/export`);
  check('export reads through gzipped rotations: trace identical',
    afterGz.trace.length === full.trace.length && contiguous(engineSeqs(afterGz.trace)),
    `${afterGz.trace.length} vs ${full.trace.length}`);

  await jpost(`/api/cards/${card.id}/grade`, {});
  await new Promise((rr) => setTimeout(rr, 300));
  const regraded = await jget(`/api/cards/${card.id}/export`);
  check('a regrade replaces DB rows but APPENDS to the trace (both passes kept)',
    regraded.trace.filter((e) => e.event === 'card_graded').length === 2 &&
    regraded.tickets.length === full.tickets.length);

  console.log('-- doc honesty + guards --');
  const doc = fs.readFileSync(path.join(ROOT, 'docs/trace-schema.md'), 'utf8');
  const eventNames = [...new Set(regraded.trace.map((e) => e.event))];
  check('every event type in a real export is documented in docs/trace-schema.md',
    eventNames.every((n) => doc.includes(`\`${n}\``)), `events: ${eventNames.join(', ')}`);

  const headerRes = await fetch(`${BASE}/api/cards/${card.id}/export`);
  check('endpoint serves a named download',
    /attachment; filename="betsheet-del-mar-2026-08-30-card1\.json"/.test(headerRes.headers.get('content-disposition') ?? ''));

  const missing = await fetch(`${BASE}/api/cards/99999/export`);
  check('unknown card -> 404', missing.status === 404);
  await fetch(`${BASE}/api/race-days/${day.id}`, { method: 'DELETE' });
  const deleted = await fetch(`${BASE}/api/cards/${card.id}/export`);
  check('card on a deleted day -> 410 (invariant 12)', deleted.status === 410);
  await jpost(`/api/race-days/${day.id}/restore`, {});

  console.log('-- CLI --');
  const outFile = path.join(tmp, 'cli-export.json');
  const cli = spawn(process.execPath, [path.join(ROOT, 'scripts', 'export-trace.js'),
    '--card', String(card.id), '--out', outFile], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let cliErr = '';
  cli.stderr.on('data', (d) => { cliErr += d; });
  const cliCode = await new Promise((resolve) => cli.on('close', resolve));
  const cliDoc = cliCode === 0 ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  check('CLI export matches the endpoint (same DB, same log files)',
    cliCode === 0 && cliDoc &&
    cliDoc.tickets.length === regraded.tickets.length &&
    cliDoc.trace.length === regraded.trace.length &&
    cliDoc.gradeSummary.plCents === regraded.gradeSummary.plCents,
    `exit=${cliCode} ${cliErr.slice(0, 200)}`);
  const cliBad = spawn(process.execPath, [path.join(ROOT, 'scripts', 'export-trace.js'), '--card', '99999'],
    { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const badCode = await new Promise((resolve) => cliBad.on('close', resolve));
  check('CLI refuses an unknown card with exit 1', badCode === 1);

  console.log('-- trace-loss honesty --');
  // Lose one generation file: the export must flag partial, not pretend.
  const traceFiles = () => fs.readdirSync(logDir).filter((f) => f.startsWith('decision-trace.'));
  const first = traceFiles().find((f) => f !== 'decision-trace.jsonl') ?? 'decision-trace.jsonl';
  fs.unlinkSync(path.join(logDir, first));
  const partial = await jget(`/api/cards/${card.id}/export`);
  check('a lost rotation is flagged: traceStatus partial', partial.traceStatus === 'partial',
    partial.traceStatus);
  for (const f of traceFiles()) fs.unlinkSync(path.join(logDir, f));
  const gone = await jget(`/api/cards/${card.id}/export`);
  check('logs wiped entirely: traceStatus missing, DB sections still whole',
    gone.traceStatus === 'missing' && gone.trace.length === 0 &&
    gone.tickets.length === regraded.tickets.length && gone.gradeSummary !== null,
    gone.traceStatus);
} finally {
  server.kill();
  await new Promise((rr) => setTimeout(rr, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

if (failures) {
  console.error(`\ncheck-export: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-export: all checks passed');
