// D-numbers are now GitHub Issues, not a local SQLite counter (shipped as
// the D-number this PR actually claimed - see below for why that number
// looks like a jump rather than a continuation of D236).
//
// WHY: scripts/lib/deliverable-numbers.js (D203) and its two follow-up fixes
// (D226, D230) spent three iterations building a same-machine, same-checkout
// atomic counter, specifically because git worktrees on one machine share a
// filesystem but nothing coordinates a SEPARATE clone or a cloud session -
// each of those opens its own database and has no way to see a number
// another one just minted. D230's own header says plainly what was left:
// "two clones claiming within the same minute, before either has merged,
// still collide" - closing that needed "a server-side atomic claim... which
// costs push credentials on every claim." That is exactly what this file is:
// GitHub already runs that server-side atomic counter, for free, as the
// issue/PR number sequence every repo already has. Two concurrent `POST
// .../issues` calls from two different machines cannot both get the same
// number - there is no window, because the claim and the number assignment
// are the same atomic operation on GitHub's own server, not a read followed
// by a write this codebase has to defend with WAL/busy_timeout/retry/floor-
// sync. It is also universally reachable: a fresh clone, a worktree, a cloud
// session and a human's own machine all resolve to the same repo and the
// same counter, with no seed, no floor, and no "which clone is authoritative"
// question to answer.
//
// WHAT CHANGES, CONCRETELY: claiming a deliverable now means opening a GitHub
// issue labeled `deliverable`; the issue's number IS the D-number (issue #321
// -> "D321"). D1-D236 are untouched, legacy numbers from the retired scheme -
// this file has no opinion about them and never rewrites history. D237 itself
// was claimed under the OLD scheme by a concurrent session while this
// migration was still being written and reviewed - a live demonstration of
// the exact cross-clone race this file exists to close, caught by
// `syncCounterFloor`'s own remote-ledger check the moment this branch synced
// with origin. So the first number this mechanism actually hands out is
// higher than D237+1: GitHub's shared issue/PR counter had already moved
// past it (that merge, its ledger commit, and everything else on the repo in
// between all consume the same counter). That is expected, not a bug - the
// never-recycle rule this codebase already lives by (invariant 12, this
// file's predecessor) already treats gaps as free and a renumber as the
// actual cost to avoid.
//
// WHAT DOES NOT CHANGE: DELIVERABLES.md stays the durable, prose ledger -
// this file only replaces how the NUMBER is minted, not where the deliverable
// is documented. A claimed issue is closed (never deleted) when its PR
// merges, exactly mirroring the old "claim, never recycle, annotate release"
// shape - just enforced by GitHub instead of a local table.
//
// This module makes exactly four calls, all listed here - unlike gh-api.js's
// `raw` escape hatch, there is no allowlist to bypass because there is no
// path that takes an arbitrary method/URL from a caller.
//
// TESTABILITY: `createDeliverableIssuesClient({ fetchImpl, tokenImpl,
// repoSlugImpl })` is the seam a check script uses to exercise the real
// request-building logic (label auto-create-and-retry, PR filtering, the
// `deliverable` label, number extraction) against a FAKE fetch - mirroring
// `runActor`'s own `client` parameter in server/apifyEquibase.js, for the
// same reason: this file's whole job is to open real, public GitHub issues,
// so a check script may never actually call it end to end.

import { redact, repoSlug, token } from './github-credential.js';

const LABEL = 'deliverable';

export function createDeliverableIssuesClient({
  fetchImpl = fetch, tokenImpl = token, repoSlugImpl = repoSlug,
} = {}) {
  async function ghFetch(method, path, body) {
    const { owner, repo } = repoSlugImpl();
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenImpl()}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'betsheet-deliverable-issues',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* some endpoints return an empty body */ }
    if (!res.ok) {
      // GitHub's top-level `message` on a 422 is the generic "Validation
      // Failed" - the actual reason (e.g. `already_exists`) lives one level
      // down, in `errors[].code`. ensureDeliverableLabel below matches on
      // this thrown message to treat "label already there" as success, so
      // that code must be folded in here or it can never match.
      const detail = json?.errors?.length ? ` ${JSON.stringify(json.errors)}` : '';
      throw new Error(redact(`HTTP ${res.status} on ${method} ${path.replace(`/repos/${owner}/${repo}`, '')}: ${(json && json.message) || text.slice(0, 400)}${detail}`));
    }
    return json;
  }

  /** Creates the `deliverable` label if it does not already exist. Idempotent. */
  async function ensureDeliverableLabel() {
    const { owner, repo } = repoSlugImpl();
    try {
      await ghFetch('POST', `/repos/${owner}/${repo}/labels`, {
        name: LABEL,
        color: '5319e7',
        description: 'A BetSheet deliverable (D-number), tracked as an issue - see CLAUDE.md',
      });
    } catch (err) {
      if (!/already_exists|already exists/i.test(err.message)) throw err;
    }
  }

  /**
   * Atomically claims the next D-number by opening a GitHub issue. The
   * ATOMICITY comes entirely from GitHub's own issue-number assignment - this
   * function does not read a counter and then write a claim; the single POST
   * call IS the claim. Returns { number, url, createdAt }.
   */
  async function claimDeliverableNumber({
    title, body = '', branch = null, claimedBy = null,
  } = {}) {
    if (!title || !title.trim()) {
      throw new Error('claimDeliverableNumber requires a non-empty title');
    }
    const { owner, repo } = repoSlugImpl();
    await ensureDeliverableLabel();
    const meta = [
      branch ? `Branch: \`${branch}\`` : null,
      claimedBy ? `Claimed by: ${claimedBy}` : null,
    ].filter(Boolean).join('\n');
    const issue = await ghFetch('POST', `/repos/${owner}/${repo}/issues`, {
      title: title.trim(),
      body: [body.trim(), meta].filter(Boolean).join('\n\n'),
      labels: [LABEL],
    });
    return { number: issue.number, url: issue.html_url, createdAt: issue.created_at };
  }

  /**
   * Marks a claim released (closes the issue). Never deletes it - same
   * never-recycle reasoning as the retired SQLite allocator and invariant 12.
   */
  async function releaseDeliverableNumber(number, { reason = null } = {}) {
    const { owner, repo } = repoSlugImpl();
    if (reason) {
      await ghFetch('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: `Released: ${reason}` });
    }
    return ghFetch('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { state: 'closed' });
  }

  async function getDeliverableIssue(number) {
    const { owner, repo } = repoSlugImpl();
    return ghFetch('GET', `/repos/${owner}/${repo}/issues/${number}`);
  }

  /**
   * Lists deliverable issues. `state` is 'open' | 'closed' | 'all'. Filters
   * out pull requests - GitHub's issues endpoint returns those too, since a
   * PR IS an issue under the hood; the `deliverable` label filter already
   * excludes them in practice, and this is belt-and-braces for a stray
   * manually-labeled PR.
   */
  async function listDeliverableIssues({ state = 'all' } = {}) {
    const { owner, repo } = repoSlugImpl();
    const items = await ghFetch('GET', `/repos/${owner}/${repo}/issues?state=${state}&labels=${LABEL}&per_page=100`);
    return items.filter((i) => !i.pull_request);
  }

  return {
    ensureDeliverableLabel, claimDeliverableNumber, releaseDeliverableNumber, getDeliverableIssue, listDeliverableIssues,
  };
}

const DEFAULT_CLIENT = createDeliverableIssuesClient();
export const {
  ensureDeliverableLabel, claimDeliverableNumber, releaseDeliverableNumber, getDeliverableIssue, listDeliverableIssues,
} = DEFAULT_CLIENT;
