// Standing cautions printed at the foot of every card sheet (D109).
//
// Moved out of shared/card-engine.js because CardView.jsx renders them on
// EVERY card - human, LLM and OTR included - not just engine-generated ones.
// The engine itself is gone (D111); these outlived it because they are about
// betting, not about generation.
//
// D112 pruned the two consensus-era lines the D109 relocation deliberately
// carried over unchanged. They spoke of unanimous agreement, chaos days and
// "2+-source horses" - a vocabulary that described the deleted engine's own
// D09 classification, was already wrong on the three non-engine buckets, and
// after the consensus removal named nothing that exists. The third line said
// something true of every card whoever built it, so it stayed; the two that
// replace the pruned pair are in the same register and are true of what the
// system actually produces now.
export const FAILURE_MODE_WARNINGS = [
  'A pick you agree with is not a pick that wins: a short-priced horse everyone likes still loses most of the time, and the race it loses often comes apart completely.',
  'Every card here is one sample. A day\'s result - good or bad - is not evidence about the source that produced it until there are enough days to say so.',
  'Expert sources and the public draw from the same well; a card of double-digit winners beats every source simultaneously. This card promises nothing variance does not allow.',
];
