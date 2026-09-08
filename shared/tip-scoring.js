// TIPSHEET scoring (D170): how good were a tip sheet's picks, against results.
//
// PURE and browser-safe - no `node:` import, ever. Given one race's picks and
// one race's result it returns concrete counters; given many, it aggregates
// them. It reads no database, fetches nothing, and decides no policy.
//
// THIS IS NOT P/L, AND DELIBERATELY CARRIES NO MONEY. Nothing stakes a tip
// sheet yet, so a dollar figure here would be an invention. Scoring is
// rank-based - did the top pick win, place, show; how much of the top three
// it caught - which is exactly what the D166 scope named and what answers the
// only question worth asking first: is this source worth reading at all.
//
// EVERY AGGREGATE CARRIES ITS `n`, and the rate fields are NULL when n is 0
// rather than 0. That is this project's oldest surviving discipline ("no P&L
// figure without its n", kept most deliberately through the pivot, because
// the pivot's own motivating anecdote turned out to rest on 1 card and 3
// graded tickets). A 100% win rate over two races is not a finding, and this
// module refuses to let it render as one by hiding the denominator.

/** A pick was scratched: excluded from hit/miss entirely, never counted a miss. */
const isScratched = (pgm, scratched) => scratched.has(String(pgm).toUpperCase());

/**
 * Score ONE race.
 *
 * `picks`     - the stored ranked list: [{ horse_no, rank, ... }]
 * `finishers` - [{ programNumber, finishPosition }]; finishPosition may be
 *               null for an "also ran" the chart did not place, which is
 *               DIFFERENT from "did not run" and is treated as ran-and-lost.
 * `scratched` - program numbers scratched from this race.
 *
 * Returns null when the race cannot be scored at all (no picks, or no result
 * on file) - a null is honest and aggregates skip it; a zero would be a claim.
 */
export function scoreTipRace(input) {
  // A destructuring default only fires on `undefined`, so an explicit null
  // would throw - and "never throws" is the contract every parser and scorer
  // in this codebase holds to. Found by this module's own junk-input check.
  const { picks = [], finishers = [], scratched = [] } = input ?? {};
  if (!Array.isArray(picks) || picks.length === 0) return null;
  if (!Array.isArray(finishers) || finishers.length === 0) return null;

  const scr = new Set(scratched.filter(Boolean).map((s) => String(s).toUpperCase()));
  const finishOf = new Map(
    finishers.map((f) => [String(f.programNumber ?? f.program_number).toUpperCase(),
      f.finishPosition ?? f.finish_position ?? null]),
  );

  const ordered = [...picks].sort((a, b) => a.rank - b.rank);
  const rows = ordered.map((p) => {
    const pgm = String(p.horse_no).toUpperCase();
    return {
      rank: p.rank,
      horseNo: p.horse_no,
      scratched: isScratched(pgm, scr),
      // undefined = the pick is not in the result at all, which usually means
      // an extraction misread a program number. Kept distinct from a null
      // finish (ran, unplaced) so it can be counted rather than absorbed.
      finish: finishOf.has(pgm) ? finishOf.get(pgm) : undefined,
      inResult: finishOf.has(pgm),
    };
  });

  const live = rows.filter((r) => !r.scratched);
  if (live.length === 0) return null;   // every pick scratched: nothing to score

  const top = live[0];
  const finishedAt = (r, n) => typeof r.finish === 'number' && r.finish <= n;
  const winner = finishers.find((f) => (f.finishPosition ?? f.finish_position) === 1);
  const actualTop3 = new Set(finishers
    .filter((f) => { const p = f.finishPosition ?? f.finish_position; return p >= 1 && p <= 3; })
    .map((f) => String(f.programNumber ?? f.program_number).toUpperCase()));

  return {
    picks: rows,
    scratchedCount: rows.length - live.length,
    // The top LIVE pick, which is what a bettor reading this sheet at the
    // window would actually have backed once a scratch was announced.
    topPick: { rank: top.rank, horseNo: top.horseNo, finish: top.finish ?? null },
    topPickSubstituted: top.rank !== ordered[0].rank,
    win: finishedAt(top, 1),
    place: finishedAt(top, 2),
    show: finishedAt(top, 3),
    anyPickWon: live.some((r) => finishedAt(r, 1)),
    // How many of the sheet's top three LIVE picks landed in the real top
    // three, in any order. 0-3, and the plainest measure of "was this sheet
    // looking at the right horses".
    top3Overlap: live.slice(0, 3).filter((r) => actualTop3.has(String(r.horseNo).toUpperCase())).length,
    top3Possible: Math.min(3, live.length),
    // Picks the result has never heard of - a program number the extraction
    // (or a correction) got wrong. Surfaced, never silently scored as a loss.
    unknownPicks: rows.filter((r) => !r.inResult && !r.scratched).map((r) => r.horseNo),
    winnerProgramNumber: winner
      ? String(winner.programNumber ?? winner.program_number) : null,
  };
}

/** A rate, or NULL when there is nothing to divide by. Never 0-for-0. */
const rate = (hits, n) => (n > 0 ? hits / n : null);

/**
 * Aggregate many scored races into one source's record.
 *
 * `n` is the count of races that could actually be SCORED - not the count of
 * tip sheets on file. A sheet for a race with no results yet contributes
 * nothing and is reported separately as `unscored`, so a source is never
 * flattered by the races it has no answer for.
 */
export function aggregateTipScores(scores) {
  const scored = scores.filter(Boolean);
  const n = scored.length;
  const sum = (f) => scored.reduce((t, s) => t + f(s), 0);
  return {
    n,
    unscored: scores.length - n,
    winRate: rate(scored.filter((s) => s.win).length, n),
    placeRate: rate(scored.filter((s) => s.place).length, n),
    showRate: rate(scored.filter((s) => s.show).length, n),
    anyPickWonRate: rate(scored.filter((s) => s.anyPickWon).length, n),
    // Mean overlap expressed against what was actually possible, so a race
    // where only two picks survived scratches is not scored out of three.
    top3OverlapRate: rate(sum((s) => s.top3Overlap), sum((s) => s.top3Possible)),
    racesWithSubstitutedTopPick: sum((s) => (s.topPickSubstituted ? 1 : 0)),
    racesWithUnknownPicks: sum((s) => (s.unknownPicks.length > 0 ? 1 : 0)),
  };
}

/**
 * Group scored races by source label and aggregate each - NEVER pooling them.
 *
 * Invariant 13's shape applied to this bucket: two tip apps are two different
 * opinions, and a combined "tipsheets went 4 for 10" would answer no question
 * anyone has. `byTipSource` is the only total this module produces.
 */
export function byTipSource(rows) {
  const bySource = new Map();
  for (const row of rows) {
    if (!bySource.has(row.sourceLabel)) bySource.set(row.sourceLabel, []);
    bySource.get(row.sourceLabel).push(row.score);
  }
  return [...bySource.entries()]
    .map(([sourceLabel, scores]) => ({ sourceLabel, ...aggregateTipScores(scores) }))
    .sort((a, b) => b.n - a.n || a.sourceLabel.localeCompare(b.sourceLabel));
}
