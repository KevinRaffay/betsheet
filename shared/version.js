// The engine version, on its own so it outlives the engine (D109).
//
// It used to live in shared/card-engine.js, which the simulator pivot deletes.
// But invariant 14 is not the engine's rule, it is grading's: every card and
// every grade set records the version it was produced under, and
// server/grading.js's gradeVersionFor still needs a value to fall back on for
// a card whose own engine_version is missing.
//
// Post-pivot this is a LEGACY LABEL, not a live version. No new `lean-*` card
// is created once the engine is gone, so the only rows carrying it are the
// archived ones and, until the factory reset, the 80-odd lean cards still in
// the database. It stops being bumped, because there is no longer generation,
// allocation or ticket-construction behaviour behind it to bump for.
export const ENGINE_VERSION = 'lean-1.1';
