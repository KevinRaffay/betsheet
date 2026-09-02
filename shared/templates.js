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
  exoticTickets: 'structure',   // D48: exacta / box / trifecta construction on or off
  winStake: 'structure',        // D48: 'share' (the branch's share of the allocation) or 'minimum'
  hedgeBoxDepth: 'structure',   // D48: horses in the split exacta box (2 = lean; 0 = no split box, D49)
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
  // ---- D48: templates that vary the rules which actually fire on a
  // PROGRAM_ONLY day (hedge_cut boxes, mid-price exactas, allocation).
  // Trace analysis of the 70-day corpus (2026-09-02) showed the six above
  // tie lean to the penny there: fade needs an algorithm order, chaos
  // boxes need a CHAOS race, and neither exists on a backfilled day.
  'exacta-primary': {
    description: 'SIMULATION ONLY - the exacta strategy without its portfolio costume: hedge_cut boxes and mid-price exactas stay, every win ticket shrinks to the per-race minimum, place-money rule off (it keys off win stake).',
    rules: { winStake: 'minimum', placeMoneyRule: false },
    simulationOnly: true,
  },
  'no-exotics': {
    description: 'SIMULATION ONLY - the inverse: WPS only. No exacta boxes, no mid-price exactas, no trifecta boxes; the freed allocation goes to the win ticket (place money still rides at 8-1+).',
    rules: { exoticTickets: false, midPriceCoverage: false },
    simulationOnly: true,
  },
  'box-depth-3': {
    description: 'SIMULATION ONLY - coverage vs concentration: the split exacta box takes the top THREE program ranks instead of two, sized inside the same per-race allocation.',
    rules: { hedgeBoxDepth: 3 },
    simulationOnly: true,
  },
  'best-bet-weighted': {
    description: 'SIMULATION ONLY - allocation keyed to the Bottom Line Best Bet flag: the Best Bet race takes the heavy weight, every other race flat; a day with no Best Bet is flat throughout.',
    rules: { allocationCurve: 'best-bet' },
    simulationOnly: true,
  },
  // ---- D49: isolate the two exotic constructions that fire on a
  // PROGRAM_ONLY day. Paired against lean on the 70-day corpus (runs
  // #17-#26, 2026-09-02) no-exotics came out +$551 while every other
  // template lost more, so the leak is in the exotics - these two say
  // WHICH one: the split exacta box (the hedge_cut races) or the $1
  // mid-price straight exacta. Each keeps the other construction exactly as
  // lean builds it; the freed share lands on the win ticket through the
  // balancer's deficit pass (place money still rides at 8-1+).
  'box-only': {
    description: 'SIMULATION ONLY - the split exacta box stays, the mid-price straight exacta is off; the freed money lands on the win ticket (place money still rides at 8-1+).',
    rules: { midPriceCoverage: false },
    simulationOnly: true,
  },
  'straight-only': {
    description: 'SIMULATION ONLY - the mid-price straight exacta stays, the split exacta box is off (hedgeBoxDepth 0); the freed money lands on the win ticket (place money still rides at 8-1+).',
    rules: { hedgeBoxDepth: 0 },
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
