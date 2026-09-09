// M-1 (docs/requirements/multi-parser-entries-ingest.md): the registry of
// entries-ingest parsers. `equibase-html` (today's `equibase-entries.js`) is
// the only real entry - the HTML parser stays the default for all real
// ingestion until a comparison process (M-3, not built) says otherwise.
// Adding a challenger parser (an accessibility-tree dump, an Apify actor's
// JSON) means adding an entry here, never a call-site special case - the
// same shape `shared/track-codes.js` already uses for track spellings.
//
// Every entry's `parse(rawInput, context)` returns the shape
// `server/ingest.js`'s `insertRaceDay` consumes almost field-for-field
// (verified against the code when this scope was filed - see the doc above,
// finding 1): `{ track, date, races, warnings }`, where each race carries
// `number/postTime/distance/surface/raceType/conditions/wagerMenu` and each
// entry carries `programNumber/postPosition/horseName/morningLine/
// morningLineDecimal/jockey/trainer/weight/scratched/liveOdds/
// liveOddsDecimal/medication/ageSex/claimPrice/alsoEligible`.
//
// `toPayload(parsed, capturedAt, notes)` is each parser's OWN adapter step
// from its raw parse output to that shape - kept per-entry, not shared,
// because a source that already arrives as clean structured JSON (an Apify
// actor) may need no shaping at all, while the Equibase HTML page prints
// claim prices as formatted currency strings ("$50,000") that need parsing
// into cents. `notes` is a `Set` the adapter adds to when it drops or
// derives something for THIS run - the per-run, data-dependent counterpart
// to `fieldsNotProvided` below.
//
// `fieldsNotProvided` is the OTHER half of that distinction from the scope
// doc: a static, per-parser list of fields this source can never carry,
// regardless of what any one run's data holds. Equibase's HTML entries page
// prints every field `insertRaceDay` has a column for, so its list is empty;
// a source with structurally less information (M-1's doc, finding 7, is
// explicit that no such source is verified yet) would list them here
// instead of discovering the gap warning by warning.
//
// `costModel` is static pricing metadata for M-4 (cost tracking, not built)
// to read - never a live cost. `{ type: 'free' }` for a parser with no
// vendor invoice.

import { parseEquibaseEntriesHtml } from './equibase-entries.js';

const moneyToCents = (s) => {
  const m = String(s ?? '').match(/[\d,.]+/);
  return m ? Math.round(Number(m[0].replace(/,/g, '')) * 100) : null;
};

// Moved out of scripts/batch-import-equibase-entries.js unchanged (M-1):
// that script called this inline before a second parser existed to choose
// between. Behaviour is identical - the existing fixture batch must still
// import byte-identically through `--parser equibase-html` (the default).
function equibaseHtmlToPayload(parsed, capturedAt, notes) {
  return {
    track: parsed.track,
    date: parsed.date,
    // D115's vocabulary. NOT 'program': that would file an Equibase page
    // under the deleted program parser's source and quietly corrupt the
    // provenance this whole ingest exists to keep straight.
    entriesSource: 'equibase_html',
    oddsCapturedAt: capturedAt,
    races: parsed.races.map((race) => {
      if (race.purseCents != null) notes.add('race.purseCents');
      // A range-claiming race can carry more than one distinct claim price
      // across its entries while `races.claiming_price_cents` holds exactly
      // one. Per-entry values are preserved in `entries.claim_price`, so
      // nothing is lost - but the race-level number is still a choice, and a
      // race whose entries disagree is flagged rather than silently reduced.
      const claimPrices = [...new Set(race.entries.map((e) => e.claimPrice).filter(Boolean))];
      if (claimPrices.length > 1) {
        notes.add(`race ${race.number}: claim price varies by entry (${claimPrices.join(', ')})`);
      }
      for (const e of race.entries) {
        if (e.effectiveOdds != null) notes.add('entry.effectiveOdds');
      }
      return {
        number: race.number,
        postTime: race.postTime,
        distance: race.distance,
        surface: race.surface,
        raceType: race.raceType,
        wagerMenu: race.wagerMenu,
        conditions: race.conditions,
        claimingPriceCents: claimPrices.length ? moneyToCents(claimPrices[0]) : null,
        entries: race.entries.map((e) => ({
          programNumber: e.programNumber,
          postPosition: e.postPosition,
          horseName: e.horseName,
          morningLine: e.morningLine,
          morningLineDecimal: e.morningLineDecimal,
          jockey: e.jockey,
          trainer: e.trainer,
          weight: e.weight,
          scratched: e.scratched,
          liveOdds: e.liveOdds,
          liveOddsDecimal: e.liveOddsDecimal,
          medication: e.medication,
          ageSex: e.ageSex,
          claimPrice: e.claimPrice,
          alsoEligible: e.alsoEligible,
        })),
      };
    }),
  };
}

export const PARSER_REGISTRY = {
  'equibase-html': {
    id: 'equibase-html',
    label: 'Equibase entries page (HTML / view-source)',
    isDefault: true,
    sourceKind: 'html',
    costModel: { type: 'free' },
    fieldsNotProvided: [],
    parse: parseEquibaseEntriesHtml,
    toPayload: equibaseHtmlToPayload,
  },
};

const DEFAULT_ENTRY = Object.values(PARSER_REGISTRY).find((p) => p.isDefault);
if (!DEFAULT_ENTRY) throw new Error('parser registry: no entry is marked isDefault');
export const DEFAULT_PARSER_ID = DEFAULT_ENTRY.id;

export function listParserIds() {
  return Object.keys(PARSER_REGISTRY);
}

// Never falls back to the default on an unknown id - a typo silently
// ingesting through the wrong parser is worse than a hard error (M-1's
// stated rule). Throws rather than returning null/undefined so a caller
// cannot forget to check.
export function getParser(id) {
  const entry = PARSER_REGISTRY[id];
  if (!entry) {
    throw new Error(`Unknown parser id "${id}". Valid ids: ${listParserIds().join(', ')}`);
  }
  return entry;
}
