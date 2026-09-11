// Shared credential/identity helpers for talking to api.github.com (D237).
//
// Extracted from scripts/gh-api.js (D101) so a second caller - the
// deliverable-issue allocator (D237) - does not have to duplicate the secret
// handling that file's own header calls out as the whole point of its
// existence: the token is read from `git credential fill` into memory only,
// never written to disk, and any byte that might contain one is redacted
// before it can reach a log or a thrown error.
//
// Nothing here decides WHAT a caller may do with the token - that policy
// (gh-api.js's ALLOWLIST) stays local to the CLI that exposes an arbitrary
// `raw` escape hatch. A caller with a narrow, hardcoded set of endpoints (like
// deliverable-issues.js) doesn't need an allowlist; its own function surface
// already is one.

import { execFileSync } from 'node:child_process';

const SECRETISH = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
];
export const redact = (s) => SECRETISH.reduce((a, re) => a.replace(re, '[redacted]'), String(s));

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

export function repoSlug() {
  const url = git(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) throw new Error(`origin does not look like a GitHub remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

// Read once per process. Not cached to disk, not passed anywhere but an
// in-process Authorization header.
let TOKEN = null;
export function token() {
  if (TOKEN) return TOKEN;
  let out;
  try {
    out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('git credential fill failed - is Git Credential Manager configured? (git config credential.helper)');
  }
  TOKEN = (out.match(/^password=(.*)$/m) || [])[1];
  if (!TOKEN) throw new Error('No GitHub credential stored. Push once so Git Credential Manager saves one.');
  return TOKEN;
}
