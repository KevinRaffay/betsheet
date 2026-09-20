import { winPayout } from './betmath.js';

// Standard American tote-board odds, shortest to longest, as printed at
// most tracks. `ml` is the decimal fraction winPayout already expects
// (num/den), so this reuses the same math real ticket grading uses rather
// than hardcoding a second, driftable set of dollar amounts.
const ODDS_LADDER = [
  ['1-9', 1 / 9], ['1-5', 1 / 5], ['2-5', 2 / 5], ['1-2', 1 / 2],
  ['3-5', 3 / 5], ['4-5', 4 / 5], ['1-1', 1], ['6-5', 6 / 5],
  ['7-5', 7 / 5], ['3-2', 3 / 2], ['8-5', 8 / 5], ['9-5', 9 / 5],
  ['2-1', 2], ['5-2', 5 / 2], ['3-1', 3], ['7-2', 7 / 2],
  ['4-1', 4], ['9-2', 9 / 2], ['5-1', 5], ['6-1', 6],
  ['7-1', 7], ['8-1', 8], ['9-1', 9], ['10-1', 10],
  ['15-1', 15], ['20-1', 20], ['30-1', 30], ['50-1', 50],
];

/** $2 win payout + ROI% for every odds on the standard board, shortest first. */
export function oddsPayoutRows() {
  return ODDS_LADDER.map(([label, ml]) => ({
    label,
    payout: (winPayout(200, ml) / 100).toFixed(2),
    roi: `${Math.round(ml * 100)}%`,
  }));
}
