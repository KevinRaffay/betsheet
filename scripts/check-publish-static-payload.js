// Verification for the "Publish snapshot" UI route (D336).
// Run: npm run check-publish-static-payload
//
// scripts/check-static-payload.js already proves the BUILD logic itself
// (payload shape, hash stability, refusals) at the pure/module level and via
// the CLI as a subprocess. This script proves the other half D336 added: a
// real HTTP route, POST /api/static-payload/publish, wired to the exact same
// build logic (server/static-payload-builder.js) - so it boots a real
// server, seeds a real race day and card over HTTP, and drives the route the
// way the new UI button actually will.
//
// THE ONE PROPERTY THIS SCRIPT MUST NEVER VIOLATE: it must never write to the
// real, committed static/public/payload.json. BETSHEET_STATIC_PAYLOAD_OUT
// redirects the route's write target to a throwaway file for exactly that
// reason, and the negative control at the end proves the redirect actually
// took effect rather than trusting it silently.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { makeHumanCard, winText } from './lib/test-cards.js';
import { validateStaticPayload } from '../shared/static-payload.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REAL_PAYLOAD = path.join(ROOT, 'static', 'public', 'payload.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betsheet-publish-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

// Read the real committed payload BEFORE anything below runs, so the final
// negative control has something to compare against.
const realPayloadBefore = fs.readFileSync(REAL_PAYLOAD, 'utf8');

const prog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/days/delmar-2026-08-30.entries.json'), 'utf8'));
const chart = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/charts/dmr-2026-08-30.expected.json'), 'utf8'));

const PORT = 8900;
const BASE = `http://127.0.0.1:${PORT}`;
const publishOut = path.join(tmp, 'published-payload.json');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    BETSHEET_PORT: String(PORT),
    BETSHEET_DB: path.join(tmp, 'check.sqlite'),
    BETSHEET_LOG_DIR: path.join(tmp, 'server-logs'),
    BETSHEET_STATIC_PAYLOAD_OUT: publishOut,
    BETSHEET_DISABLE_BUILTIN_FETCHERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const jpost = (url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const jdel = (url) => fetch(BASE + url, { method: 'DELETE' });

try {
  console.log('-- server boots, two real race days seeded over HTTP --');
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  check('server boots', up, serverOut.slice(-300));

  const day1 = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-30', bankrollCents: 20000, perRaceMinCents: 500, races: prog.races,
  })).json();
  const day2 = await (await jpost('/api/race-days', {
    track: 'Del Mar', date: '2026-08-31', bankrollCents: 20000, perRaceMinCents: 500, races: prog.races,
  })).json();
  check('two distinct race days were created', day1.id !== day2.id, JSON.stringify({ day1: day1.id, day2: day2.id }));

  // A graded HUMAN card on day1 only, so the publish result can distinguish
  // a day WITH cards/grades from one without.
  const storedDay1 = await (await fetch(`${BASE}/api/race-days/${day1.id}`)).json();
  const firstRaceWithEntries = storedDay1.races.find((r) => r.entries.length >= 1);
  const pgm = firstRaceWithEntries.entries[0].program_number;
  const cardId = await makeHumanCard(jpost, day1.id, [{ race: firstRaceWithEntries.number, text: winText(pgm) }]);
  await jpost(`/api/race-days/${day1.id}/results`, { track: chart.track, date: chart.date, sourceKind: 'paste', races: chart.races });
  const grades = await (await fetch(`${BASE}/api/cards/${cardId}/grades`)).json();
  check('the seeded card graded', Boolean(grades.summary), JSON.stringify(grades.summary));

  console.log('\n-- refusals before anything is written --');
  {
    const empty = await jpost('/api/static-payload/publish', {});
    check('neither dayIds nor from/to -> 400', empty.status === 400);

    const both = await jpost('/api/static-payload/publish', { dayIds: [day1.id], from: '2026-08-30', to: '2026-08-31' });
    check('dayIds AND from/to together -> 400', both.status === 400);

    const noSuchDay = await jpost('/api/static-payload/publish', { dayIds: [999999] });
    const noSuchBody = await noSuchDay.json();
    check('an unknown day -> 422, not a crash', noSuchDay.status === 422 && /No race day/.test(noSuchBody.error), JSON.stringify(noSuchBody));

    check('none of the refusals above wrote a file', !fs.existsSync(publishOut));
  }

  console.log('\n-- publishing by explicit dayIds --');
  let publishedByIds;
  {
    const res = await jpost('/api/static-payload/publish', { dayIds: [day1.id, day2.id] });
    check('publish by dayIds -> 200', res.ok, String(res.status));
    publishedByIds = await res.json();
    check('response names 2 days', publishedByIds.days.length === 2, JSON.stringify(publishedByIds.days.map((d) => d.raceDayId)));
    const d1 = publishedByIds.days.find((d) => d.raceDayId === day1.id);
    const d2 = publishedByIds.days.find((d) => d.raceDayId === day2.id);
    check('day1 reports 1 card, graded', d1?.cards === 1 && d1?.graded === 1, JSON.stringify(d1));
    check('day2 reports 0 cards, not a missing field', d2?.cards === 0 && d2?.graded === 0, JSON.stringify(d2));

    check('the file was actually written', fs.existsSync(publishOut));
    const onDisk = JSON.parse(fs.readFileSync(publishOut, 'utf8'));
    check('the written file validates against the schema', validateStaticPayload(onDisk).length === 0,
      JSON.stringify(validateStaticPayload(onDisk)));
    check('the written file names both race days', onDisk.raceDays.length === 2);
  }

  console.log('\n-- a soft-deleted day refuses the whole publish, and writes nothing over the last good file --');
  {
    const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(publishOut)).digest('hex');
    const del = await jdel(`/api/race-days/${day2.id}`);
    check('day2 soft-deleted', del.ok, String(del.status));

    const res = await jpost('/api/static-payload/publish', { dayIds: [day1.id, day2.id] });
    const body = await res.json();
    check('publishing a deleted day -> 422', res.status === 422 && /deleted/.test(body.error), JSON.stringify(body));

    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(publishOut)).digest('hex');
    check('the last successfully published file is untouched by the failed attempt', beforeHash === afterHash);

    await jpost(`/api/race-days/${day2.id}/restore`, {});
  }

  console.log('\n-- publishing by --from/--to resolves the same days as explicit ids --');
  {
    const res = await jpost('/api/static-payload/publish', { from: '2026-08-30', to: '2026-08-31', track: 'Del Mar' });
    check('publish by from/to/track -> 200', res.ok, String(res.status));
    const body = await res.json();
    const idsFromRange = body.days.map((d) => d.raceDayId).sort();
    const idsFromExplicit = publishedByIds.days.map((d) => d.raceDayId).sort();
    check('the resolved day ids agree with the explicit-id publish', JSON.stringify(idsFromRange) === JSON.stringify(idsFromExplicit),
      JSON.stringify({ idsFromRange, idsFromExplicit }));

    const rangeMatchingNothing = await jpost('/api/static-payload/publish', { from: '1999-01-01', to: '1999-01-02' });
    const rangeBody = await rangeMatchingNothing.json();
    check('a range matching nothing -> 422, not an empty success',
      rangeMatchingNothing.status === 422 && /No race days matched/.test(rangeBody.error), JSON.stringify(rangeBody));
  }

  console.log('\n-- an app-log audit event was written for a successful publish --');
  {
    const appLog = fs.readFileSync(path.join(tmp, 'server-logs', 'app.jsonl'), 'utf8');
    check('static_payload_published appears in the app log', appLog.includes('static_payload_published'));
  }
} finally {
  server.kill();
  // D369: the same guard every sibling check carries. On Windows the killed
  // child can still hold the SQLite file for a moment, and an unguarded
  // rmSync here threw EPERM AFTER all 21 assertions had passed - failing the
  // script on teardown alone, identically on main.
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* win locks */ }
}

console.log('\n-- NEGATIVE CONTROL: the real committed payload.json was never touched --');
{
  const realPayloadAfter = fs.readFileSync(REAL_PAYLOAD, 'utf8');
  check('static/public/payload.json is byte-identical to before this script ran', realPayloadAfter === realPayloadBefore);
}

if (failures) {
  console.error(`\ncheck-publish-static-payload: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\ncheck-publish-static-payload: all checks passed');
}
