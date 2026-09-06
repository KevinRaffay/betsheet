// Standing cautions printed at the foot of every card sheet (D109).
//
// Moved out of shared/card-engine.js, which the pivot deletes, because
// CardView.jsx renders them on EVERY card - human, LLM and OTR included - not
// just engine-generated ones.
//
// RELOCATED VERBATIM. Two of the three are consensus-era copy and speak of
// unanimous agreement, chaos days and multiple sources, none of which will
// exist after the consensus engine is removed - and which are already wrong on
// the three non-engine buckets today. Pruning them is P-1.4's job, when
// consensus actually goes; doing it here would mix a copy change into a pure
// move and make both harder to review.
export const FAILURE_MODE_WARNINGS = [
  'Unanimous consensus is not certainty: a 7/2 shot everyone agrees on still loses most of the time - and when it loses, the race often comes apart completely.',
  'On chaos days, second-tier "watch out for" horses win at prices - small coverage on 2+-source horses is on this card for that reason.',
  'Expert sources and the public draw from the same well; a card of double-digit winners beats every source simultaneously. This card promises nothing variance does not allow.',
];
