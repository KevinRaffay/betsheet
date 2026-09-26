// The card sheet footer's "Sources used" line (D439). PURE and browser-safe -
// CardSheet.jsx renders in both the desktop app and the static app.
//
// Two different facts used to share one sentence. The legacy `sources` rows
// are the day's CONSENSUS-FETCH audit (`fetch_attempts`), which nothing has
// written since D112/D113 removed fetching, so every card built after the
// pivot fell through to "program analysis and morning lines only" - false for
// an LLM card, an OTR card, a tip-sheet card and a COMBINED parlay alike.
//
// The rule now: an ENGINE-era card (FULL / PARTIAL / PROGRAM_ONLY / ODDS_ONLY)
// keeps the legacy reading, which is exactly what those cards had. Every
// other bucket states `card.inputs` - what that card itself recorded, built by
// server/card-inputs.js - and never borrows the engine fallback. A card with
// no `inputs` at all (a static snapshot published before D439) says the
// sources were not recorded rather than guessing.

export const ENGINE_BUCKETS = new Set(['FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY']);

const legacyName = (s) => `${s.name} (${s.ts?.slice(0, 10) ?? '—'})`;

/**
 * `{ used, unavailable, note }` for the footer. `used` is display text;
 * `unavailable` lists legacy source names; `note` qualifies an inferred list.
 */
export function describeCardSources(card) {
  const legacy = card.sources ?? { used: [], unavailable: [] };
  const legacyUsed = (legacy.used ?? []).map(legacyName);
  const unavailable = (legacy.unavailable ?? []).map((s) => s.name);
  const engine = ENGINE_BUCKETS.has(card.consensus_completeness ?? 'PROGRAM_ONLY');

  if (engine || !card.consensus_completeness) {
    return {
      used: legacyUsed.length ? legacyUsed.join(', ') : 'program analysis and morning lines only',
      unavailable,
      note: null,
    };
  }
  if (!card.inputs) {
    return {
      used: legacyUsed.length ? legacyUsed.join(', ') : 'not recorded for this card',
      unavailable,
      note: null,
    };
  }
  const items = [...card.inputs.used, ...legacyUsed];
  return {
    used: items.length ? items.join(', ') : 'none recorded',
    unavailable,
    note: card.inputs.note ?? null,
  };
}
