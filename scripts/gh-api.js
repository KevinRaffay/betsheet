// GitHub API access using the credential git already has (D101).
//
// The failure this exists for, twice in one session: `gh` is not installed and
// the repo is private, so an unauthenticated API call returns "Not Found" and a
// PR number has to be GUESSED. Asked to resolve conflicts on PR #133 I reasoned
// it must postdate #132, picked the wrong branch, and worked the wrong problem
// until the contradiction surfaced. #133 was this repo's own D96 branch. One
// authenticated GET would have said so immediately.
//
// Nothing is installed and nothing changes visibility: pushes already
// authenticate through Git Credential Manager, and that credential carries
// `repo` scope. This just asks git for it.
//
// SECRET HANDLING - the whole point of this file:
//   - the token is read from `git credential fill` into a local, never logged;
//   - it is set as an in-process fetch header, so it never reaches argv and
//     `ps` cannot see it (which `curl -H "Bearer ..."` would expose);
//   - it is never written to disk;
//   - EVERY byte this script prints goes through redact(), error paths
//     included, so a token cannot escape through a stack trace or an echoed
//     request line.
//
// WHAT IT MAY DO is fixed by ALLOW below, NOT by the token - GCM issued that
// for git and its scopes are wider than this needs (gist, workflow, user). The
// allowlist is the only real constraint here, so read it first.
//
// Run: npm run gh -- pr 133
//      npm run gh -- pr list [--state open|closed|all]
//      npm run gh -- pr create --title T --body-file f [--base main] [--head b]
//      npm run gh -- pr merge 133 [--squash|--merge|--rebase]
//      npm run gh -- pr close 281
//      npm run gh -- checks [ref]
//      npm run gh -- raw GET /repos/:owner/:repo/pulls/133

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// ---------- redaction ----------
const SECRETISH = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
];
const redact = (s) => SECRETISH.reduce((a, re) => a.replace(re, '[redacted]'), String(s));
const say = (...a) => process.stdout.write(`${a.map(redact).join(' ')}\n`);

// ---------- stopping ----------
// `die()` sets `process.exitCode` and THROWS a sentinel; it must NEVER call
// `process.exit()` (D218). On this machine, `process.exit()` after a fetch to
// api.github.com aborts the process instead of exiting:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
//
// and the shell then sees **127**, not the code we asked for - so every
// refusal this script takes care to report cleanly came back looking like
// "command not found". Reproduced deterministically (5 of 5) on node 24 /
// Windows, and NOT reproducible against example.com or registry.npmjs.org,
// whose responses carry `connection: keep-alive` where GitHub's carry no
// `connection` header at all. That correlation is as far as the diagnosis
// goes, and it is exactly why the fix is to stop calling `process.exit()`
// rather than to predict when it happens to be safe. Setting `exitCode` and
// letting the loop drain exits with the right code in every case tested, and
// promptly (~0.5s - undici's pooled sockets do not hold the loop open); as a
// bonus it also cannot truncate a piped stdout write the way exit() can.
class ExitSignal extends Error {}
const die = (msg, code = 1) => {
  process.stderr.write(`${redact(msg)}\n`);
  process.exitCode = code;
  throw new ExitSignal(msg);
};
// A sentinel has already reported itself. Anything else is a real bug, and
// prints its STACK - redacted, because this file's premise is that no byte
// escapes unredacted, error paths included.
const onFatal = (err) => {
  if (err instanceof ExitSignal) return;
  process.stderr.write(`${redact((err && err.stack) || String(err))}\n`);
  process.exitCode = 1;
};
process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

// ---------- what this script is permitted to do ----------
// Checked BEFORE any request is made, so a refused verb sends nothing.
const ALLOW = [
  { m: 'GET', re: /^\/(repos|user|orgs|search|rate_limit)\b/, why: 'read' },
  { m: 'POST', re: /^\/repos\/[^/]+\/[^/]+\/pulls$/, why: 'open a pull request' },
  { m: 'POST', re: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, why: 'comment on a PR or issue' },
  // Merging is permitted by user decision 2026-09-05 - which is also why
  // CLAUDE.md's delivery workflow changed from "Claude never merges" to
  // "Claude merges only when explicitly told to, per PR".
  { m: 'PUT', re: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/, why: 'merge a PR you asked me to merge' },
  // Closing (D217). Narrower than it looks and deliberately so: this same
  // PATCH endpoint can retarget a PR's base, rewrite its title and rewrite its
  // body, so the SUBCOMMAND sends `{ state: 'closed' }` and nothing else - the
  // allowlist cannot express "this verb but only this field", so the guard
  // against the rest is that no code path here ever builds a different body.
  // Reversible (a closed PR reopens), and it does NOT delete the branch, which
  // stays outside what this script may do. Added because the alternative on
  // offer was deleting a head branch to close a PR as a SIDE EFFECT - which is
  // how #142 was lost in D104/D105 (see CLAUDE.md's Gotchas), and a stale PR
  // left open because closing was awkward is its own small hazard.
  { m: 'PATCH', re: /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/, why: 'close a PR you asked me to close' },
];
const permitted = (method, path) => ALLOW.find((a) => a.m === method && a.re.test(path));

// ---------- identity ----------
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function repoSlug() {
  const url = git(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) die(`origin does not look like a GitHub remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// Read once per process. Not cached to disk, not passed anywhere but the header.
let TOKEN = null;
function token() {
  if (TOKEN) return TOKEN;
  let out;
  try {
    out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    die('git credential fill failed - is Git Credential Manager configured? (git config credential.helper)');
  }
  TOKEN = (out.match(/^password=(.*)$/m) || [])[1];
  if (!TOKEN) die('No GitHub credential stored. Push once so Git Credential Manager saves one.');
  return TOKEN;
}

// Git Bash rewrites a leading-slash argument into a Windows path before node
// ever sees it - `/repos/x/y` arrives as `C:/Program Files/Git/repos/x/y`.
// Found while testing `raw` from this machine's own shell. Cut back to the
// first real API segment rather than making the caller remember
// MSYS_NO_PATHCONV=1.
const API_ROOTS = ['repos', 'user', 'orgs', 'search', 'rate_limit'];
function normalizePath(p) {
  if (!p) return p;
  for (const root of API_ROOTS) {
    const i = p.indexOf(`/${root}`);
    if (i > 0 && /^[A-Za-z]:|^\/[a-z]\//.test(p)) return p.slice(i);
  }
  return p.startsWith('/') ? p : `/${p}`;
}

// ---------- the request ----------
async function api(method, path, body) {
  if (!permitted(method, path)) {
    die(`REFUSED: ${method} ${path}\n`
      + "Not on this script's allowlist. It permits reads, opening a PR, commenting, and merging or "
      + 'closing a PR you asked for - and nothing that deletes, force-pushes, or changes '
      + 'repository settings.\n'
      + 'Nothing was sent. Edit ALLOW in scripts/gh-api.js if that is genuinely wrong.');
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`, // in-process only: never argv, never a file
      accept: 'application/vnd.github+json',
      'user-agent': 'betsheet-gh-api',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* some endpoints return an empty body */ }
  if (!res.ok) {
    die(`HTTP ${res.status} on ${method} ${path}\n${(json && json.message) || text.slice(0, 400)}`);
  }
  return json;
}

// ---------- commands ----------
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const { owner, repo } = repoSlug();
const R = `/repos/${owner}/${repo}`;
const prLine = (p) => `  #${String(p.number).padEnd(4)} ${String(p.state).padEnd(6)} `
  + `${String(p.head && p.head.ref).padEnd(30)} ${p.title}`;

const [cmd, sub, ...rest] = argv;

if (cmd === 'pr' && sub === 'list') {
  const state = flag('state', 'open');
  const prs = await api('GET', `${R}/pulls?state=${state}&per_page=50`);
  say(`${prs.length} ${state} PR(s) in ${owner}/${repo}:`);
  for (const p of prs) say(prLine(p));
} else if (cmd === 'pr' && sub === 'create') {
  const bodyFile = flag('body-file');
  const payload = {
    title: flag('title') || die('--title is required'),
    head: flag('head') || git(['rev-parse', '--abbrev-ref', 'HEAD']),
    base: flag('base', 'main'),
    body: bodyFile ? fs.readFileSync(bodyFile, 'utf8') : (flag('body') || ''),
  };
  const p = await api('POST', `${R}/pulls`, payload);
  say(`opened #${p.number}: ${p.title}`);
  say(`  ${p.html_url}`);
} else if (cmd === 'pr' && sub === 'merge') {
  const n = Number(rest[0]);
  if (!Number.isInteger(n)) die('usage: pr merge <number> [--squash|--merge|--rebase]');
  const method = argv.includes('--rebase') ? 'rebase' : argv.includes('--merge') ? 'merge' : 'squash';
  const out = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: method });
  say(`merged #${n} (${method}): ${out.message || out.sha || ''}`);
} else if (cmd === 'pr' && sub === 'close') {
  const n = Number(rest[0]);
  if (!Number.isInteger(n)) die('usage: pr close <number>');
  // `{ state: 'closed' }` is the ONLY body this script ever PATCHes onto a
  // pull request - see the ALLOW entry for why that matters. An already-merged
  // PR is reported rather than PATCHed: GitHub answers 200 and leaves it
  // merged, so a blind PATCH would print a reassuring "closed" for a no-op.
  const before = await api('GET', `${R}/pulls/${n}`);
  if (before.merged) die(`#${n} is MERGED, not open - nothing to close.`);
  if (before.state === 'closed') {
    say(`#${n} is already closed.`);
  } else {
    const p = await api('PATCH', `${R}/pulls/${n}`, { state: 'closed' });
    say(`closed #${p.number}: ${p.title}`);
    say(`  branch ${p.head.ref} is untouched - delete it yourself if you want it gone.`);
  }
} else if (cmd === 'pr') {
  const n = Number(sub);
  if (!Number.isInteger(n)) die('usage: pr <number> | pr list | pr create | pr merge <n> | pr close <n>');
  const p = await api('GET', `${R}/pulls/${n}`);
  say(`#${p.number}  ${p.title}`);
  say(`  state      ${p.state}${p.merged ? ' (merged)' : ''}`);
  say(`  head->base ${p.head.ref} -> ${p.base.ref}`);
  say(`  mergeable  ${p.mergeable} / ${p.mergeable_state}`);
  say(`  commits    ${p.commits}, +${p.additions}/-${p.deletions} across ${p.changed_files} file(s)`);
  say(`  ${p.html_url}`);
} else if (cmd === 'checks') {
  const ref = sub || git(['rev-parse', 'HEAD']);
  const out = await api('GET', `${R}/commits/${ref}/check-runs`);
  say(`${out.total_count} check run(s) for ${ref}:`);
  for (const c of out.check_runs || []) say(`  ${String(c.conclusion ?? c.status).padEnd(12)} ${c.name}`);
} else if (cmd === 'raw') {
  const method = (sub || 'GET').toUpperCase();
  const path = normalizePath(rest[0]);
  if (!path) die('usage: raw <METHOD> <path>');
  say(`-> ${method} https://api.github.com${path}`); // the request LINE, never the header
  say(JSON.stringify(await api(method, path), null, 1));
} else {
  say('usage: npm run gh -- <pr <n> | pr list | pr create | pr merge <n> | pr close <n> | checks [ref] | raw <METHOD> <path>>');
  // `exitCode`, not `process.exit(2)` - see the note beside `die()`. This
  // branch runs before any fetch and so was never affected, but leaving one
  // `process.exit()` behind is how the next network-touching branch quietly
  // inherits the bug.
  process.exitCode = 2;
}
