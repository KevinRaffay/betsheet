// Thin, swappable actor-calling layer for the live Apify entries/results
// fetch (Phase 3, `docs/requirements/apify-equibase-ingest.md`). Lives
// under `server/`, NOT `shared/` - the incoming scope doc's own guessed
// path was `shared/apifyEquibase.js`, but `shared/` is this codebase's
// browser-safe zone (every parser under it is explicitly "no `node:`
// import, ever"), and this file's own client (`./apifyClient.js`) holds an
// API token that must never reach the browser bundle, the same reason
// `server/anthropic-client.js` is under `server/` and not `shared/`. Kept
// deliberately dumb: no reshaping, no parsing - `shared/parsers/
// equibase-apify-parseforge.js` and `equibase-apify-results.js` already do
// that from a raw JSON STRING, so `fetchEntries`/`fetchResults` return the
// actor's raw dataset items and the CALLER `JSON.stringify`s them back into
// that exact contract, preserving both parsers' golden-tested input shape
// exactly rather than inventing a second calling convention for a live
// source. Swapping actors later (this codebase's own comparison discipline,
// `docs/requirements/multi-parser-entries-ingest.md`) is a change to
// `ACTOR_ID` and the input shape below, not to any caller of these two
// functions.
//
// The actor's real input schema, read from its own live Store page
// (2026-09-09, not the guessed `dataMode`/`trackCodes` names an earlier,
// repo-blind scope doc assumed for a DIFFERENT actor): `resultType`
// ('entries'|'results'|'horses'), `tracks` (Equibase codes or full names,
// empty = every track racing that day), `date` (YYYY-MM-DD), plus optional
// `dateFrom`/`dateTo`/`maxDays`/`country`/`maxItems` and per-run filters
// (`raceNumbers`, `surfaces`, `onlyStakes`, ...) - passed through via `...rest`
// rather than named individually here, so a caller can use any documented
// filter without this file needing to know about it.

import { getApifyClient } from './apifyClient.js';

// parseforge/equibase-scraper - D190's own identification (from the
// dataset's export filename convention), corroborated since by three real
// captured samples (two entries shapes, one results). Not `getascraper`:
// `docs/requirements/apify-equibase-ingest.md`'s own reconciliation kept
// parseforge specifically because it is the only actor with verified real
// samples anywhere in this repo.
const ACTOR_ID = 'parseforge/equibase-scraper';

// `client` is an optional injection seam, used ONLY by
// scripts/check-apify-equibase-client.js so this file's real logic (input
// shaping, the includeWagers default, the run-status check) can be verified
// without ever making a real, billed call to Apify - a live call belongs to
// a person running a CLI script (Phase 4), never a check script. A real
// caller never passes it; `getApifyClient()` still throws its own clear
// error when APIFY_TOKEN is unset.
async function runActor(input, client) {
  const c = client ?? getApifyClient();
  const run = await c.actor(ACTOR_ID).call(input);
  if (run.status !== 'SUCCEEDED') {
    throw new Error(
      `Apify run ${run.id} did not succeed (status: ${run.status}). `
      + `Check https://console.apify.com/actors/runs/${run.id} for the log.`,
    );
  }
  const { items } = await c.dataset(run.defaultDatasetId).listItems();
  return items;
}

export function fetchEntries({ raceDate, tracks, ...rest } = {}, client) {
  return runActor({ resultType: 'entries', date: raceDate, tracks: tracks ?? [], ...rest }, client);
}

// `includeWagers` defaults to true here, deliberately overriding the
// actor's OWN default (off). The actor's live docs make exotic payoffs an
// opt-in, separately-billed field (`wager-payoffs`, $0.002/row) - every
// real sample `equibase-apify-results.js` was built and verified against
// carries `exoticWagers`, which only happens when the run that captured it
// had this flag on. A live call left at the actor's own default would come
// back with every race silently missing its exotic payoffs - not a parser
// gap, a caller bug, and one this codebase's own grading depends on
// (exacta/trifecta/etc. tickets need these payoffs to grade). Overridable
// for a caller that genuinely wants to skip the extra cost.
export function fetchResults({ raceDate, tracks, includeWagers = true, ...rest } = {}, client) {
  return runActor({ resultType: 'results', date: raceDate, tracks: tracks ?? [], includeWagers, ...rest }, client);
}
