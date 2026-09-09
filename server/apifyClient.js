// Live Apify API access (Phase 3, `docs/requirements/
// apify-equibase-ingest.md`). A deliberate, documented SECOND exception to
// invariant 6's manual-file posture (resolved 2026-09-09, user decision:
// on-demand live calls chosen over manual-file consistency, for minimum
// friction) - the first being the mobile static-Pages surface. This is NOT
// scraping Equibase: Apify's actor does that server-side, on infrastructure
// the user pays for and explicitly triggers one call of at a time. NO
// scheduling of any kind - every call here is a person running a command
// right now, never a cron or an automatic re-fetch.
//
// Lives under `server/`, matching `anthropic-client.js` exactly and NOT the
// `shared/apifyClient.js` path an earlier, repo-blind scope doc guessed:
// this file holds an API token that must never ship to the browser, and
// `shared/` is this codebase's browser-safe zone (every file under it holds
// itself to "no `node:` import, ever" - `process.env` access here would be
// exactly as wrong on that side of the line).
//
// Mirrors server/anthropic-client.js's own fail-fast pattern exactly:
// hasToken() for a caller that wants to check before attempting (a CLI's
// own startup guard), and the actual client getter throws a clear error at
// CALL TIME if APIFY_TOKEN is unset, rather than surfacing an opaque 401
// from deep inside the SDK later.

import { ApifyClient } from 'apify-client';

export const hasToken = () => Boolean(process.env.APIFY_TOKEN);

let client = null;

// A changed .env needs a process restart to take effect, same as every
// other env-configured client in this codebase (ANTHROPIC_API_KEY, etc.) -
// this is not a bug to fix, it's the existing convention.
export function getApifyClient() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      'APIFY_TOKEN is not set - get one at https://console.apify.com/settings/integrations '
      + 'and add it to .env (see .env.example).',
    );
  }
  if (!client) client = new ApifyClient({ token });
  return client;
}
