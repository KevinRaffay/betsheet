// Verification for scripts/lib/deliverable-issues.js + allocate-deliverable.js,
// the GitHub-Issues-backed replacement for the retired SQLite D-number
// allocator (scripts/lib/deliverable-numbers.js, D203/D226/D230).
//
// OFFLINE and CREDENTIAL-FREE, deliberately, for the same reason
// check-gh-api.js is: the thing under test opens REAL, PUBLIC GitHub issues
// when used for real, so a check script may never call it end to end.
// `createDeliverableIssuesClient({ fetchImpl, tokenImpl, repoSlugImpl })` is
// the seam that lets the real request-building logic run against a FAKE
// fetch - mirroring `runActor`'s own `client` parameter in
// server/apifyEquibase.js (D197), used there for the identical reason (a
// real Apify call costs money; a real issue call is public and irreversible
// by an automated check).
//
// Run: npm run check-deliverable-issues

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDeliverableIssuesClient } from './lib/deliverable-issues.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// ---------- a fake fetch that records every call and answers from a queue ----------
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no more queued responses');
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { impl, calls };
}

const REPO = { owner: 'KevinRaffay', repo: 'betsheet' };
const client = (fetchImpl) => createDeliverableIssuesClient({
  fetchImpl, tokenImpl: () => 'fake-token-never-sent-anywhere-real', repoSlugImpl: () => REPO,
});

console.log('\nclaimDeliverableNumber');
{
  const { impl, calls } = fakeFetch([
    { status: 201, body: {} }, // ensureDeliverableLabel
    { status: 201, body: { number: 321, html_url: 'https://github.com/KevinRaffay/betsheet/issues/321', created_at: '2026-09-11T00:00:00Z' } },
  ]);
  const result = await client(impl).claimDeliverableNumber({
    title: 'Some deliverable', body: 'Why it exists.', branch: 'my-branch', claimedBy: 'claude',
  });
  check('returns the issue number as the D-number', result.number === 321, String(result.number));
  check('returns the issue URL', result.url.endsWith('/issues/321'));
  check('two calls made: ensure-label, then create-issue', calls.length === 2, String(calls.length));
  check('label call POSTs to /repos/.../labels', calls[0].method === 'POST' && calls[0].url.endsWith('/repos/KevinRaffay/betsheet/labels'));
  check('label call names the `deliverable` label', calls[0].body.name === 'deliverable', JSON.stringify(calls[0].body));
  check('issue call POSTs to /repos/.../issues', calls[1].method === 'POST' && calls[1].url.endsWith('/repos/KevinRaffay/betsheet/issues'));
  check('issue carries the deliverable label', JSON.stringify(calls[1].body.labels) === '["deliverable"]');
  check('issue title is the trimmed title', calls[1].body.title === 'Some deliverable');
  check('issue body includes the branch and claimant', /Branch: `my-branch`/.test(calls[1].body.body) && /Claimed by: claude/.test(calls[1].body.body));
  check('the bearer token never appears in a recorded call (headers only, never argv/body)',
    !JSON.stringify(calls).includes('fake-token-never-sent-anywhere-real') || calls.every((c) => JSON.stringify(c.body || {}).indexOf('fake-token') === -1));
}

console.log('\nclaimDeliverableNumber refuses an empty title before any network call');
{
  const { impl, calls } = fakeFetch([]);
  let threw = null;
  try { await client(impl).claimDeliverableNumber({ title: '   ' }); } catch (err) { threw = err; }
  check('throws', threw instanceof Error, String(threw));
  check('no fetch was made', calls.length === 0, String(calls.length));
}

console.log('\nensureDeliverableLabel is idempotent against an existing label');
{
  const { impl, calls } = fakeFetch([
    { status: 422, body: { message: 'already_exists' } },
  ]);
  let threw = null;
  try { await client(impl).ensureDeliverableLabel(); } catch (err) { threw = err; }
  check('does not throw on already_exists', threw === null, String(threw));
  check('one call made', calls.length === 1, String(calls.length));
}

// GitHub's REAL shape for this exact case (verified live, D333-ish): the
// top-level `message` is the generic "Validation Failed" and the actionable
// code lives one level down, in `errors[].code`. The fixture above tests a
// message the API never actually sends - it passed while the real call to
// api.github.com 422'd every time after the label's first creation, because
// `already_exists` was never in `err.message` for a real response. This is
// the D201 lesson again: a check's fixture is only a valid test of a real
// call for as long as it matches what the real endpoint actually returns.
console.log('\nensureDeliverableLabel is idempotent against a REAL GitHub already_exists response shape');
{
  const { impl, calls } = fakeFetch([
    { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] } },
  ]);
  let threw = null;
  try { await client(impl).ensureDeliverableLabel(); } catch (err) { threw = err; }
  check('does not throw on the real already_exists shape', threw === null, String(threw));
  check('one call made', calls.length === 1, String(calls.length));
}

console.log('\nensureDeliverableLabel still throws on a real failure');
{
  const { impl } = fakeFetch([
    { status: 500, body: { message: 'server exploded' } },
  ]);
  let threw = null;
  try { await client(impl).ensureDeliverableLabel(); } catch (err) { threw = err; }
  check('throws', threw instanceof Error);
  check('names the real GitHub message', /server exploded/.test(threw.message), threw.message);
}

console.log('\nreleaseDeliverableNumber');
{
  const { impl, calls } = fakeFetch([
    { status: 201, body: {} }, // comment
    { status: 200, body: { number: 321, state: 'closed' } }, // patch
  ]);
  await client(impl).releaseDeliverableNumber(321, { reason: 'superseded' });
  check('two calls when a reason is given: comment then close', calls.length === 2, String(calls.length));
  check('comment posts to the issue comments endpoint', calls[0].url.endsWith('/issues/321/comments'));
  check('comment body names the reason', /superseded/.test(calls[0].body.body));
  check('close PATCHes the issue itself', calls[1].method === 'PATCH' && calls[1].url.endsWith('/issues/321'));
  check('the PATCH body is the literal { state: \'closed\' } and nothing else',
    JSON.stringify(calls[1].body) === '{"state":"closed"}', JSON.stringify(calls[1].body));
}
{
  const { impl, calls } = fakeFetch([
    { status: 200, body: { number: 322, state: 'closed' } },
  ]);
  await client(impl).releaseDeliverableNumber(322);
  check('one call when no reason is given: close only, no comment', calls.length === 1, String(calls.length));
}

console.log('\nlistDeliverableIssues');
{
  const { impl, calls } = fakeFetch([
    {
      status: 200,
      body: [
        { number: 321, title: 'A deliverable', state: 'open' },
        { number: 320, title: 'A PR that happens to carry the label', state: 'open', pull_request: { url: 'x' } },
      ],
    },
  ]);
  const issues = await client(impl).listDeliverableIssues({ state: 'all' });
  check('the request asks the server to filter by the deliverable label and state', /labels=deliverable/.test(calls[0].url) && /state=all/.test(calls[0].url), calls[0].url);
  check('a pull request in the response is filtered out client-side', issues.length === 1 && issues[0].number === 321, JSON.stringify(issues));
}

console.log('\ngetDeliverableIssue');
{
  const { impl, calls } = fakeFetch([{ status: 200, body: { number: 321, title: 'x', state: 'open' } }]);
  const issue = await client(impl).getDeliverableIssue(321);
  check('GETs the exact issue', calls[0].method === 'GET' && calls[0].url.endsWith('/issues/321'));
  check('returns the parsed issue', issue.number === 321);
}

console.log('\nallocate-deliverable.js (D218: must never process.exit() after a fetch)');
{
  const src = fs.readFileSync(path.join(HERE, 'allocate-deliverable.js'), 'utf8');
  const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('calls process.exit() NOWHERE (only exitCode)', !/process\.exit\(/.test(codeOnly), (codeOnly.match(/process\.exit\([^)]*\)/g) || []).join(', '));
  check('main() is wrapped so a rejection sets exitCode rather than crashing uncaught',
    /main\(\)\.catch\(/.test(src) && /process\.exitCode = 1/.test(src));
}

console.log('\nThe CLI refuses/usage-prints before it ever reaches the network');
// Only argument shapes that can never reach a fetch call are run for real here -
// anything with a non-empty --title, --list, --status or --release makes a
// real GitHub call and has no place in an offline check.
{
  const run = (args) => {
    try {
      return { out: execFileSync(process.execPath, [path.join(HERE, 'allocate-deliverable.js'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (err) {
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
    }
  };
  const bare = run([]);
  check('no arguments prints usage and exits 2', bare.code === 2, String(bare.code));
  check('...naming --title/--list/--status/--release', /--title/.test(bare.out) && /--list/.test(bare.out), bare.out.slice(0, 200));
  // A whitespace-only --title is a truthy JS string, so the CLI takes the
  // claim path - but claimDeliverableNumber's own trim-check throws before
  // any fetch, exactly like the direct-call test above, so this still never
  // reaches the network. Exit code 1 (a thrown error), not 2 (usage).
  const blankTitle = run(['--title', '   ']);
  check('a whitespace-only --title is refused (no network call) rather than silently claiming', blankTitle.code === 1, String(blankTitle.code));
  check('...naming the reason', /non-empty title/.test(blankTitle.out), blankTitle.out.slice(0, 200));
}

console.log('\ncheck-gh-api.js still covers the issue subcommands added alongside this (D237)');
{
  const src = fs.readFileSync(path.join(HERE, 'gh-api.js'), 'utf8');
  const block = src.match(/const ALLOW = \[([\s\S]*?)\n\];/);
  check('the ALLOW array is still parseable', Boolean(block));
  const allow = block ? [...block[1].matchAll(/\{\s*m:\s*'([A-Z]+)',\s*re:\s*(\/.*?\/),\s*why:/g)]
    .map(([, m, re]) => ({ m, re: new RegExp(re.slice(1, -1)) })) : [];
  const R = '/repos/KevinRaffay/betsheet';
  const permitted = (m, p) => allow.some((a) => a.m === m && a.re.test(p));
  check('POST can open an issue', permitted('POST', `${R}/issues`));
  check('PATCH can close/reopen an issue', permitted('PATCH', `${R}/issues/321`));
  check('PATCH cannot reach an issue\'s comments or labels', !permitted('PATCH', `${R}/issues/321/comments`) && !permitted('PATCH', `${R}/issues/321/labels`));
  check('POST cannot reach the labels endpoint through gh-api.js\'s own CLI (deliverable-issues.js calls GitHub directly, not through this allowlist)',
    !permitted('POST', `${R}/labels`));
}

if (failures) {
  console.error(`\ncheck-deliverable-issues: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-deliverable-issues: all checks passed');
