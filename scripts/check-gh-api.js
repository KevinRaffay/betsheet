// Verification for scripts/gh-api.js's ALLOWLIST (D217).
//
// OFFLINE and CREDENTIAL-FREE by construction. The allowlist is checked
// BEFORE any request is made ("a refused verb sends nothing"), so what it
// permits is a pure property of the source and can be asserted without a
// token, a network call, or a real pull request - which matters, because the
// thing under test is precisely what this script is allowed to do to a real
// repository.
//
// The regexes are re-derived by PARSING `scripts/gh-api.js` rather than
// copied here - the same technique `check-track-codes.js` uses on the track
// registry, and for the same reason: a second hand-written copy of the rule
// passes happily while the real one drifts.
//
// NEGATIVE CONTROL: widen the close entry to
// `/^\/repos\/[^/]+\/[^/]+\/pulls\b/` and the "merge endpoint is not reachable
// by PATCH" assertion fails; drop the `$` and the same happens. Exit non-zero.
//
// Run: npm run check-gh-api

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, 'gh-api.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
}

// ---------- re-derive ALLOW from the source ----------
const block = src.match(/const ALLOW = \[([\s\S]*?)\n\];/);
if (!block) { console.error('could not find the ALLOW array in scripts/gh-api.js'); process.exit(1); }
const ALLOW = [...block[1].matchAll(/\{\s*m:\s*'([A-Z]+)',\s*re:\s*(\/.*?\/),\s*why:/g)]
  .map(([, m, re]) => ({ m, re: new RegExp(re.slice(1, -1)) }));
const permitted = (method, p) => ALLOW.some((a) => a.m === method && a.re.test(p));

console.log('\nThe allowlist parsed out of the source');
check('every entry parsed (5 expected: read, open, comment, merge, close)',
  ALLOW.length === 5, `${ALLOW.length}`);
check('the verbs are exactly GET/POST/POST/PUT/PATCH',
  ALLOW.map((a) => a.m).join(',') === 'GET,POST,POST,PUT,PATCH', ALLOW.map((a) => a.m).join(','));

const R = '/repos/KevinRaffay/betsheet';

console.log('\nWhat is permitted');
check('GET a PR', permitted('GET', `${R}/pulls/281`));
check('POST to open a PR', permitted('POST', `${R}/pulls`));
check('POST a comment', permitted('POST', `${R}/issues/281/comments`));
check('PUT to merge a PR', permitted('PUT', `${R}/pulls/281/merge`));
check('PATCH a PR (D217: close)', permitted('PATCH', `${R}/pulls/281`));

console.log('\nWhat must still be refused - the point of the allowlist');
// The close entry is anchored with `$` precisely so that adding PATCH does
// not open the door to every sub-resource hanging off a pull request.
check('PATCH cannot reach the MERGE endpoint', !permitted('PATCH', `${R}/pulls/281/merge`));
check('PATCH cannot reach a PR review', !permitted('PATCH', `${R}/pulls/281/reviews/1`));
check('PATCH cannot reach the repository itself (settings, default branch)', !permitted('PATCH', R));
check('PATCH cannot reach an issue', !permitted('PATCH', `${R}/issues/281`));
check('PATCH cannot reach a branch-protection rule', !permitted('PATCH', `${R}/branches/main/protection`));
check('DELETE is not permitted anywhere at all', ALLOW.every((a) => a.m !== 'DELETE'));
check('...including a git ref (this is why closing a PR must not mean deleting its branch)',
  !permitted('DELETE', `${R}/git/refs/heads/some-branch`));
check('PUT cannot reach anything but merge', !permitted('PUT', `${R}/pulls/281`));
check('POST cannot reach a merge', !permitted('POST', `${R}/pulls/281/merge`));
check('no verb reaches another repository root than /repos, /user, /orgs, /search, /rate_limit',
  !permitted('GET', '/gists') && !permitted('GET', '/admin/hooks'));

console.log('\nThe body a PATCH may carry');
// The allowlist cannot say "this verb but only this field", so the guard is
// that exactly one PATCH call exists in the file and its body is a literal.
const patchCalls = [...src.matchAll(/api\('PATCH',[^)]*\)/g)].map((m) => m[0]);
check('exactly one PATCH call exists in the whole script', patchCalls.length === 1, String(patchCalls.length));
check("...and its body is the literal { state: 'closed' }",
  patchCalls[0] && /\{\s*state:\s*'closed'\s*\}/.test(patchCalls[0]), patchCalls[0]);
// `raw` is the one path where a caller picks the verb, so PATCH became
// reachable through it too. It stays harmless because `raw` has no body flag:
// `api(method, path)` sends `body: undefined`, and a PATCH with no fields
// changes nothing. Asserted as the ABSENCE of a third argument, since that is
// the property that would have to break for `raw` to become dangerous.
const rawCalls = [...src.matchAll(/await api\(method, path[^)]*\)/g)].map((m) => m[0]);
check('the `raw` subcommand issues exactly one api() call', rawCalls.length === 1, String(rawCalls.length));
check('...passing NO body, so `raw PATCH` is a guaranteed no-op',
  rawCalls[0] === 'await api(method, path)', rawCalls[0]);

console.log('\nThe CLI refuses before it reaches the network');
// No token is read and no request is built on these paths, so they are safe
// to run here. `--fixture`-style stubbing is unnecessary: the failure happens
// at argument parsing.
const run = (args) => {
  try {
    return { out: execFileSync(process.execPath, [SRC_PATH, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (err) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
};
const noNumber = run(['pr', 'close']);
check('`pr close` with no number exits non-zero', noNumber.code !== 0, String(noNumber.code));
check('...naming the usage rather than a stack trace', /usage: pr close <number>/.test(noNumber.out), noNumber.out.slice(0, 120));
const notANumber = run(['pr', 'close', 'main']);
check('`pr close main` is refused the same way', notANumber.code !== 0 && /usage: pr close <number>/.test(notANumber.out));
const usage = run([]);
check('the bare usage line advertises `pr close <n>`', /pr close <n>/.test(usage.out), usage.out.slice(0, 200));

if (failures) {
  console.error(`\ncheck-gh-api: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-gh-api: all checks passed');
