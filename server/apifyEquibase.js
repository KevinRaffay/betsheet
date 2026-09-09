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
// that from a raw JSON STRING, so `fetchEntries`/`fetchResults` return
// `{ items, runId }` - `items` is the actor's raw dataset, unreshaped, and
// the CALLER `JSON.stringify`s it back into that exact contract, preserving
// both parsers' golden-tested input shape exactly rather than inventing a
// second calling convention for a live source. `runId` (D204) names the
// exact Apify run that produced `items`, for a caller to log - Kentucky
// Downs, 2026-09-09, undercounted a 14-race card as 9 on one live pull and
// 2 on another. **D205 found the actual cause, confirmed by the user
// running the identical input directly in the Apify portal**: the actor's
// own `maxItems` default is too low for a big field (168 real entries
// that day) and was silently truncating the dataset - `maxItems: 10000`
// in the portal returned all 14 races/168 entries. `runId`'s own
// diagnostic value stands regardless (a future undercount from a
// DIFFERENT cause is still checkable this way). Swapping actors later (this
// codebase's own comparison discipline, `docs/requirements/
// multi-parser-entries-ingest.md`) is a change to `ACTOR_ID` and the input
// shape below, not to any caller of these two functions.
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

// D205: the actor's OWN default `maxItems` is too low for a big field and
// silently TRUNCATES the dataset rather than warning - confirmed live,
// 2026-09-09: a Kentucky Downs entries pull (168 real rows across 14
// races) came back as 9 races/100 rows and, on an earlier attempt, 2
// races/19 rows, with no error of any kind either time. The user
// reproduced the exact input directly in the Apify portal and got the
// correct 14 races/168 rows only once `maxItems: 10000` was set
// explicitly - this codebase's own calls never set it before, so every
// live call so far relied entirely on whatever the actor defaults to.
// 10000 is the user's own confirmed-working value, generously above any
// real single-track single-day row count this codebase has ever seen
// (the largest fixture on file is 123 rows). The same "override the
// actor's own default rather than trust it" shape `includeWagers` already
// uses below - overridable via an explicit `maxItems` in the call.
const DEFAULT_MAX_ITEMS = 10000;

// `client` is an optional injection seam, used ONLY by
// scripts/check-apify-equibase-client.js so this file's real logic (input
// shaping, the includeWagers default, the run-status check) can be verified
// without ever making a real, billed call to Apify - a live call belongs to
// a person running a CLI script (Phase 4), never a check script. A real
// caller never passes it; `getApifyClient()` still throws its own clear
// error when APIFY_TOKEN is unset.
// Returns { items, runId } rather than bare items (D204) - `runId` names
// the exact Apify run a caller's log line came from, so a suspicious
// row count is answerable from
// https://console.apify.com/actors/runs/<runId> without re-running (and
// re-paying for) the call. The undercount that motivated this (Kentucky
// Downs, 2026-09-09) turned out to be `maxItems` (D205, see above), but
// `runId`'s diagnostic value is not specific to that one cause.
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
  return { items, runId: run.id };
}

export function fetchEntries({ raceDate, tracks, maxItems = DEFAULT_MAX_ITEMS, ...rest } = {}, client) {
  return runActor({ resultType: 'entries', date: raceDate, tracks: tracks ?? [], maxItems, ...rest }, client);
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
export function fetchResults({ raceDate, tracks, includeWagers = true, maxItems = DEFAULT_MAX_ITEMS, ...rest } = {}, client) {
  return runActor({ resultType: 'results', date: raceDate, tracks: tracks ?? [], includeWagers, maxItems, ...rest }, client);
}
