// The consensus-source fetcher registry.
//
// A fetcher is one module describing how to get and read one source's picks:
//
//   {
//     id: 'dmtc-picks',            // stable slug, used in logs and the DB
//     name: 'Del Mar track picks', // display name (sources.name)
//     kind: 'track_picks',         // sources.kind vocabulary (see schema)
//     supports({ track, date }),   // -> bool: does this source cover the day?
//     buildUrl({ track, date }),   // -> the URL to fetch
//     parse(body, { track, date })  // -> {
//       track?, date?,             //   what the PAGE says it covers, if it
//                                  //   says; the runner discards mismatches
//       races: [{ race, picks: [{ programNumber?, horseName?, pickType, note? }] }],
//       warnings?: [...]
//     }
//     produces?: 'entries'         // an ENTRIES source (the ML sheet, D40):
//                                  //   shares the registry, audit and robots
//                                  //   guard, but the consensus runner skips it
//   }
//
// pickType vocabulary is the consensus_picks CHECK constraint:
// top / second / third / watch_out / contrarian.
//
// Concrete fetchers register here. Only the ML sheet (D40) is fetched
// today: D08a/D08b were closed manual-only, and D08c's Sports from the
// Basement was removed (D82) - At The Races and Equibase OTR are manual
// uploads, not fetchers.
// BETSHEET_EXTRA_FETCHERS (comma-separated module paths, each default-
// exporting an array of fetchers) exists for the check scripts, which point
// it at stub sources on a local port - the framework is exercised end to
// end without touching the network.

import dmtcMlFetcher from './dmtc-ml.js';

const fetchers = [];

export function registerFetcher(f) {
  for (const key of ['id', 'name', 'kind', 'supports', 'buildUrl', 'parse']) {
    if (!f?.[key]) throw new Error(`fetcher is missing "${key}"`);
  }
  if (fetchers.some((x) => x.id === f.id)) {
    throw new Error(`fetcher id "${f.id}" is already registered`);
  }
  fetchers.push(f);
}

export const listFetchers = () => [...fetchers];

// Built-in sources. Check scripts set BETSHEET_DISABLE_BUILTIN_FETCHERS so
// their stub-only runs can never touch the network.
if (!process.env.BETSHEET_DISABLE_BUILTIN_FETCHERS) {
  registerFetcher(dmtcMlFetcher);
}

let extrasLoaded = false;

/** Load BETSHEET_EXTRA_FETCHERS modules once. Called by the runner. */
export async function loadExtraFetchers() {
  if (extrasLoaded) return;
  extrasLoaded = true;
  const paths = (process.env.BETSHEET_EXTRA_FETCHERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of paths) {
    const mod = await import(p.startsWith('file:') ? p : `file://${p.replace(/\\/g, '/')}`);
    for (const f of mod.default ?? []) registerFetcher(f);
  }
}
