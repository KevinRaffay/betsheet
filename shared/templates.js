// Strategy templates: named, reusable rule bundles for the card engine,
// and the signal/structure layer map the simulator keys on. Pure data +
// helpers (browser + Node) - the code here is the source of truth; the
// server seeds it into the strategy_templates table for FK integrity.
//
// The layer split (backtesting addendum, invariant 13):
//   * STRUCTURE rules shape money given ANY classification - they read
//     prices, program ranks and race types, so they are benchmarkable on
//     every completeness bucket, PROGRAM_ONLY backfill included.
//   * SIGNAL rules consume the consensus itself (votes, source counts) -
//     on a day with no external sources they degenerate, so conclusions
//     about them require the bucket that actually had the signal.
// `allocationCurve` is structure by the addendum's explicit wording: the
// curve is how money spreads across confidence levels, not where the
// confidence came from.

import { DEFAULT_RULES } from './card-engine.js';

export const RULE_LAYERS = {
  placeMoneyRule: 'structure',
  hedgeCut: 'structure',
  fadeThePrice: 'structure',
  chaosTrifectaBox: 'structure',
  midPriceCoverage: 'structure',
  longshotOnTop: 'structure',
  allocationCurve: 'structure',
  coverageAdds: 'signal',   // fires off 2+-source counts
  parlays: 'signal',        // legs are picked BY the consensus
};

export const TEMPLATES = {
  lean: {
    description: 'The live methodology: every rule on, lean allocation - heaviest on UNANIMOUS, minimum on guesswork races.',
    rules: {},
  },
  spread: {
    description: 'Flatter allocation curve: agreement is trusted less, the day is spread wider. Same ticket construction.',
    rules: { allocationCurve: 'spread' },
  },
  'no-fade': {
    description: 'Fade-the-price off: legit odds-on favorites get win bets instead of going on top of exactas.',
    rules: { fadeThePrice: false },
  },
  'no-chaos-box': {
    description: 'Chaos trifecta box off: wide-open races keep the anchor win + longshot exacta only.',
    rules: { chaosTrifectaBox: false },
  },
  'structure-only': {
    description: 'Signal-layer rules off (no parlays, no 2+-source coverage adds): pure construction, benchmarkable on any completeness bucket.',
    rules: { parlays: false, coverageAdds: false },
  },
  'no-place-money': {
    description: 'SIMULATION ONLY - disables invariant 1 to measure what the mandatory place-money rule earns. Live cards refuse this template.',
    rules: { placeMoneyRule: false },
    simulationOnly: true,
  },
};

/** Resolve a template name to full engine rules (unknown name -> null). */
export function resolveTemplate(name) {
  const t = TEMPLATES[name];
  if (!t) return null;
  return { ...DEFAULT_RULES, ...t.rules };
}

/** The layers a template's overrides touch, for the UI and the simulator. */
export function templateLayers(name) {
  const t = TEMPLATES[name];
  if (!t) return [];
  return [...new Set(Object.keys(t.rules).map((k) => RULE_LAYERS[k]))].sort();
}

/** List view: everything the UI dropdown and GET /api/templates need. */
export function listTemplates() {
  return Object.entries(TEMPLATES).map(([name, t]) => ({
    name,
    description: t.description,
    rules: t.rules,
    layers: templateLayers(name),
    simulationOnly: Boolean(t.simulationOnly),
  }));
}
