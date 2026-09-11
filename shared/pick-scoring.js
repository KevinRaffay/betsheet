// Pick-source scoring (D220, PS-1 of docs/requirements/pick-source-scoring.md):
// did the horses a source BACKED actually win, place, show - for every source
// that produces picks, not only tip sheets.
//
// PURE and browser-safe - no `node:` import, ever. Reads no database, fetches
// nothing, decides no policy. shared/tip-scoring.js (D170) is the model: this
// module extends the same money-free measurement to sources that have TICKETS
// rather than a ranked list, by reducing every source to the same ROLE shape.
//
// THIS CARRIES NO MONEY. A stake is read exactly once, to decide which win
// ticket is the PRIMARY pick (user decision 2026-09-10: the largest stake is
// what the source put its money behind). Nothing here is a grade, nothing is
// versioned, and nothing is stored - a score is recomputed from results on
// every read, so a corrected chart changes the answer with no regrade step.
//
// ROLES, NOT RANKS. OTR names a win pick and a show pick with no order between
// them; an LLM writes free-form tickets; a tip sheet ranks three horses. The
// one shape all of them reduce to, per race:
//   winBacked   - program numbers on a WIN ticket
//   placeBacked - on a PLACE ticket
//   showBacked  - on a SHOW ticket
//   named       - on ANY ticket for the race, boxes and straight exotics too
//   primary     - the single win-backed horse with the largest stake, or null
// A rank is never invented for a source that has none.
//
// EVERY RATE CARRIES ITS OWN `n`, and a rate is NULL at n=0, never 0. The
// denominators genuinely differ per role: a race with no place ticket says
// nothing about the source's place picks and must not count against them.
// This is the project's oldest surviving discipline ("no figure without its
// n"), and the reason `{ hits, n, rate }` is the only shape a rate takes here.

import { impliedWinProbability } from './betmath.js';

const up = (pgm) => String(pgm).trim().toUpperCase();
const uniq = (arr) => [...new Set(arr)];

/**
 * Reduce ONE race's tickets to role sets.
 *
 * `tickets` - [{ betType, legs, stakeCents, sequence }], already filtered to
 *             one race by the caller. `legs` is the stored selections shape:
 *             an array of legs, each an array of program numbers (a box holds
 *             the whole set in one leg; a straight exotic has one leg per
 *             position).
 *
 * Returns { winBacked, placeBacked, showBacked, named, primary } with the
 * sets as de-duplicated arrays of upper-cased program-number strings.
 * `primary` is the win-backed horse from the win ticket with the largest
 * stakeCents (ties: lowest sequence, then the ticket's first horse), or null
 * when nothing was backed to win. Multiple win tickets are the norm for LLM
 * cards (168 of 293 races in the corpus on 2026-09-10), which is exactly why
 * "primary" and "any" are both scored.
 */
export function rolesFromTickets(tickets) {
  const roles = { winBacked: [], placeBacked: [], showBacked: [], named: [], primary: null };
  if (!Array.isArray(tickets)) return roles;

  let best = null;
  for (const t of tickets) {
    if (!t || !Array.isArray(t.legs)) continue;
    const all = t.legs.flat().filter((p) => p !== null && p !== undefined && String(p).trim() !== '').map(up);
    roles.named.push(...all);
    const first = (t.legs[0] ?? []).map(up).filter(Boolean);
    if (t.betType === 'win') {
      roles.winBacked.push(...first);
      const stake = Number(t.stakeCents) || 0;
      const seq = Number.isFinite(Number(t.sequence)) ? Number(t.sequence) : Number.MAX_SAFE_INTEGER;
      if (first.length && (best === null || stake > best.stake || (stake === best.stake && seq < best.seq))) {
        best = { stake, seq, pgm: first[0] };
      }
    } else if (t.betType === 'place') {
      roles.placeBacked.push(...first);
    } else if (t.betType === 'show') {
      roles.showBacked.push(...first);
    }
  }
  roles.winBacked = uniq(roles.winBacked);
  roles.placeBacked = uniq(roles.placeBacked);
  roles.showBacked = uniq(roles.showBacked);
  roles.named = uniq(roles.named);
  roles.primary = best ? best.pgm : null;
  return roles;
}

/**
 * Reduce a tip_picks row's ranked list to the same role shape.
 *
 * Rank 1 is the horse the sheet backs to win (and the primary); ranks 1-3 are
 * `named`. A tip sheet backs nothing to place or show as such - it ranks -
 * so those roles stay empty rather than being invented from rank 2 and 3.
 * `named` against the real top three is D170's `top3Overlap` by another name,
 * and check-pick-scoring asserts the two agree on a real row.
 */
export function rolesFromTipPicks(picks) {
  const roles = { winBacked: [], placeBacked: [], showBacked: [], named: [], primary: null };
  if (!Array.isArray(picks) || picks.length === 0) return roles;
  const ordered = [...picks]
    .filter((p) => p && p.horse_no !== null && p.horse_no !== undefined && String(p.horse_no).trim() !== '')
    .sort((a, b) => a.rank - b.rank);
  if (ordered.length === 0) return roles;
  roles.named = uniq(ordered.slice(0, 3).map((p) => up(p.horse_no)));
  roles.winBacked = [up(ordered[0].horse_no)];
  roles.primary = roles.winBacked[0];
  return roles;
}

/** Any live horse in `set` finished at or above `pos`; NULL when nothing live. */
const hitAt = (live, finishOf, pos) => {
  if (live.length === 0) return null;
  return live.some((p) => { const f = finishOf.get(p); return typeof f === 'number' && f <= pos; });
};

/**
 * The market's own win probabilities for one race, from the chart's post-time
 * odds (D229).
 *
 * A board's raw implied probabilities sum to MORE than 1 - that excess is the
 * takeout, typically 15-20% in North America. Dividing by the sum removes it
 * and leaves a proper distribution, which is what makes `1{won} - q` a fair
 * question rather than a rigged one: against RAW implied probabilities every
 * source on earth scores negative, because the track's cut is priced into
 * every horse.
 *
 * Returns a Map of program number -> probability, or null when no finisher in
 * the race carries a price. NULL is the honest answer for an Apify-sourced day
 * (win odds per finisher are structurally absent there) and must never be
 * read as "the race had no board".
 */
export function impliedProbabilities(finishers) {
  if (!Array.isArray(finishers)) return null;
  const raw = finishers
    .map((f) => ({
      pgm: up(f.programNumber ?? f.program_number),
      // `impliedWinProbability` (D224, betmath) is this exact conversion, and
      // the two functions are deliberate complements: it makes the OVERROUND
      // visible - its own docstring says a full field sums well over 1 - and
      // this one divides it back out. Reused rather than re-derived so the
      // morning-line and post-time readings can never drift apart on the
      // arithmetic; all that differs is which price is fed in.
      p: impliedWinProbability(f.postTimeOdds ?? f.post_time_odds),
    }))
    .filter((f) => f.p !== null);
  if (raw.length === 0) return null;
  const total = raw.reduce((a, b) => a + b.p, 0);
  if (!(total > 0)) return null;
  return new Map(raw.map((r) => [r.pgm, r.p / total]));
}

/**
 * The POST-TIME favorite's own result - the baseline `favoriteBaseline` has
 * always wanted and never had.
 *
 * That function's docstring says it plainly: "the post-time favorite is
 * unavailable: D171 measured `entries.live_odds` empty corpus-wide". It is
 * available now, from a different source than D171 was looking at - the chart
 * has printed it all along and D229 stores it. The morning-line favorite stays
 * exactly where it is, because the two answer different questions and a day
 * whose results came from Apify still has only the first.
 *
 * Prefers the chart's own `favorite` asterisk over deriving one from the odds:
 * the chart ASSERTS which horse was favorite, including the tie-break, and
 * re-deriving would mean inventing a rule it already applied. Falls back to
 * the lowest price when no row is flagged.
 */
export function marketBaseline(finishers, finishOf) {
  if (!Array.isArray(finishers) || finishers.length === 0) return null;
  const rows = finishers.map((f) => ({
    pgm: up(f.programNumber ?? f.program_number),
    odds: f.postTimeOdds ?? f.post_time_odds,
    flagged: Boolean(f.favorite),
  }));
  let favs = rows.filter((r) => r.flagged).map((r) => r.pgm);
  let tied = favs.length > 1;
  if (favs.length === 0) {
    const priced = rows.filter((r) => typeof r.odds === 'number' && Number.isFinite(r.odds));
    if (priced.length === 0) return null;
    const min = Math.min(...priced.map((r) => r.odds));
    favs = priced.filter((r) => r.odds === min).map((r) => r.pgm);
    tied = favs.length > 1;
  }
  const at = (n) => favs.some((p) => { const f = finishOf.get(p); return typeof f === 'number' && f <= n; });
  return { programNumbers: favs, tied, win: at(1), place: at(2), show: at(3) };
}

/**
 * The morning-line favorite's own result on this race - the baseline every
 * source rate is read against (the post-time favorite is unavailable: D171
 * measured `entries.live_odds` empty corpus-wide).
 *
 * `entries` - [{ programNumber, morningLineDecimal, scratched? }]. Live
 * entries with a numeric decimal line compete; a tie for lowest line is a
 * hit if ANY tied horse finished at the position. Returns null when no entry
 * carries a line.
 */
function favoriteBaseline(entries, finishOf, scr) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const live = entries
    .filter((e) => e && e.programNumber !== null && e.programNumber !== undefined)
    .map((e) => ({ pgm: up(e.programNumber), ml: e.morningLineDecimal, scratched: Boolean(e.scratched) }))
    .filter((e) => !e.scratched && !scr.has(e.pgm));
  const priced = live.filter((e) => typeof e.ml === 'number' && Number.isFinite(e.ml));
  if (priced.length === 0) return null;
  const min = Math.min(...priced.map((e) => e.ml));
  const favs = priced.filter((e) => e.ml === min).map((e) => e.pgm);
  return {
    horseNos: favs,
    morningLineDecimal: min,
    tied: favs.length > 1,
    win: hitAt(favs, finishOf, 1),
    place: hitAt(favs, finishOf, 2),
    show: hitAt(favs, finishOf, 3),
  };
}

/**
 * Score ONE race.
 *
 * `roles`     - from rolesFromTickets / rolesFromTipPicks
 * `finishers` - [{ programNumber, finishPosition }]; a null position is an
 *               also-ran that RAN and lost, distinct from a scratch.
 * `scratched` - program numbers scratched from this race.
 * `entries`   - optional [{ programNumber, morningLineDecimal, scratched? }]
 *               for the favorite and field-size baselines.
 *
 * Returns null when the race cannot be scored at all: nothing named, no
 * result on file, or every named horse scratched. A null is honest and
 * aggregates skip it; a zero would be a claim.
 *
 * Per role the answer is true / false / NULL, where NULL means "this source
 * backed nothing live in that role here" - never a miss. A scratched primary
 * is NOT promoted to the next win ticket (that would be inventing a rank);
 * `primary` simply scores null on that race.
 */
export function scorePickRace(input) {
  const { roles, finishers = [], scratched = [], entries = null } = input ?? {};
  if (!roles || !Array.isArray(roles.named) || roles.named.length === 0) return null;
  if (!Array.isArray(finishers) || finishers.length === 0) return null;

  const scr = new Set((scratched ?? []).filter((s) => s !== null && s !== undefined).map(up));
  const finishOf = new Map(finishers.map((f) => [
    up(f.programNumber ?? f.program_number),
    f.finishPosition ?? f.finish_position ?? null,
  ]));
  const liveOf = (arr) => (arr ?? []).map(up).filter((p) => !scr.has(p));

  const named = liveOf(roles.named);
  if (named.length === 0) return null;   // every named horse scratched: nothing to score
  const winBacked = liveOf(roles.winBacked);
  const placeBacked = liveOf(roles.placeBacked);
  const showBacked = liveOf(roles.showBacked);

  const primaryPgm = roles.primary !== null && roles.primary !== undefined && !scr.has(up(roles.primary))
    ? up(roles.primary) : null;
  const primaryFinish = primaryPgm !== null && finishOf.has(primaryPgm) ? finishOf.get(primaryPgm) : null;
  const primaryAt = (n) => (primaryPgm === null ? null : typeof primaryFinish === 'number' && primaryFinish <= n);

  const actualTop3 = new Set(finishers
    .filter((f) => { const p = f.finishPosition ?? f.finish_position; return p >= 1 && p <= 3; })
    .map((f) => up(f.programNumber ?? f.program_number)));
  const winner = finishers.find((f) => (f.finishPosition ?? f.finish_position) === 1);

  const liveEntries = Array.isArray(entries)
    ? entries.filter((e) => e && !e.scratched && !scr.has(up(e.programNumber))).length
    : null;
  const fieldSize = liveEntries !== null && liveEntries > 0 ? liveEntries : finishers.length;

  return {
    primary: primaryPgm === null ? null : { horseNo: primaryPgm, finish: primaryFinish },
    primaryScratched: roles.primary !== null && roles.primary !== undefined && scr.has(up(roles.primary)),
    primaryWin: primaryAt(1),
    primaryPlace: primaryAt(2),
    primaryShow: primaryAt(3),
    anyWin: hitAt(winBacked, finishOf, 1),
    placeHit: hitAt(placeBacked, finishOf, 2),
    showHit: hitAt(showBacked, finishOf, 3),
    winBackedCount: winBacked.length,
    placeBackedCount: placeBacked.length,
    showBackedCount: showBacked.length,
    namedCount: named.length,
    // How many of the REAL top three the source named anywhere, out of how
    // many top-three finishers the chart actually placed (3 in any normal
    // field; fewer only when the chart placed fewer).
    namedTop3: [...actualTop3].filter((p) => named.includes(p)).length,
    top3Possible: actualTop3.size,
    scratchedCount: uniq((roles.named ?? []).map(up)).filter((p) => scr.has(p)).length,
    // Named horses the result has never heard of - a misread program number,
    // surfaced rather than scored as a loss.
    unknownPicks: named.filter((p) => !finishOf.has(p)),
    winnerProgramNumber: winner ? up(winner.programNumber ?? winner.program_number) : null,
    fieldSize,
    favorite: favoriteBaseline(entries, finishOf, scr),
    // D229: the same race read against the CLOSING PRICE rather than against
    // the morning line. `closeEdge` is `1{the primary pick won} - q`, where q
    // is that horse's own takeout-normalised market probability. Zero means
    // "you are the market"; positive means the pick won more often than its
    // price said it would, which is the only shape of evidence that can
    // distinguish an edge from an opinion. NULL - never 0 - whenever the
    // board is unavailable, which is every Apify-sourced day.
    market: marketOf(finishers, finishOf, primaryPgm, primaryFinish),
  };
}

/** The market block of a scored race. NULL fields, never zeros, when unpriced. */
function marketOf(finishers, finishOf, primaryPgm, primaryFinish) {
  const implied = impliedProbabilities(finishers);
  const favorite = marketBaseline(finishers, finishOf);
  if (implied === null) return { priced: false, favorite, primaryImplied: null, closeEdge: null };
  const q = primaryPgm !== null && implied.has(primaryPgm) ? implied.get(primaryPgm) : null;
  const won = typeof primaryFinish === 'number' && primaryFinish === 1;
  return {
    priced: true,
    favorite,
    primaryImplied: q,
    closeEdge: q === null ? null : (won ? 1 : 0) - q,
  };
}

/** { hits, n, rate } over the races where `pick(s)` is a boolean; NULL rate at n=0. */
const tally = (scored, pick) => {
  const answered = scored.map(pick).filter((v) => v === true || v === false);
  const hits = answered.filter(Boolean).length;
  const n = answered.length;
  return { hits, n, rate: n > 0 ? hits / n : null };
};

const mean = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * Aggregate many scored races into one source's record.
 *
 * `n` is the count of races that could actually be SCORED; `unscored` is the
 * rest (no result yet, everything scratched). Every rate below carries its
 * own `n`, because a race contributes to a role only when the source backed
 * something live in that role - a source that never bets place has
 * `place.n === 0` and `place.rate === null`, not a 0% place record.
 */
export function aggregatePickScores(scores) {
  const scored = (scores ?? []).filter(Boolean);
  const n = scored.length;
  const sum = (f) => scored.reduce((t, s) => t + (f(s) || 0), 0);
  const withWin = scored.filter((s) => s.winBackedCount > 0);
  const namedTop3 = sum((s) => s.namedTop3);
  const top3Possible = sum((s) => s.top3Possible);
  return {
    n,
    unscored: (scores ?? []).length - n,
    primaryWin: tally(scored, (s) => s.primaryWin),
    primaryPlace: tally(scored, (s) => s.primaryPlace),
    primaryShow: tally(scored, (s) => s.primaryShow),
    anyWin: tally(scored, (s) => s.anyWin),
    place: tally(scored, (s) => s.placeHit),
    show: tally(scored, (s) => s.showHit),
    namedTop3: { hits: namedTop3, n: top3Possible, rate: top3Possible > 0 ? namedTop3 / top3Possible : null },
    // How much "any" is buying over "primary": the mean number of horses
    // backed to win, over the races where at least one was.
    meanWinBacked: withWin.length ? sum((s) => s.winBackedCount) / withWin.length : null,
    meanNamed: n ? sum((s) => s.namedCount) / n : null,
    racesWithPrimaryScratched: sum((s) => (s.primaryScratched ? 1 : 0)),
    racesWithUnknownPicks: sum((s) => (s.unknownPicks.length > 0 ? 1 : 0)),
    scratchedPicks: sum((s) => s.scratchedCount),
    baselines: {
      // The morning-line favorite, on THIS source's own scored races only.
      favoriteWin: tally(scored, (s) => s.favorite?.win ?? null),
      favoritePlace: tally(scored, (s) => s.favorite?.place ?? null),
      favoriteShow: tally(scored, (s) => s.favorite?.show ?? null),
      racesWithTiedFavorite: sum((s) => (s.favorite?.tied ? 1 : 0)),
      // Random-pick rates from field size: 1/field for a win, min(3,field)/field
      // for naming a top-three finisher.
      randomWin: mean(scored.map((s) => (s.fieldSize > 0 ? 1 / s.fieldSize : null))),
      randomTop3: mean(scored.map((s) => (s.fieldSize > 0 ? Math.min(3, s.fieldSize) / s.fieldSize : null))),
      meanFieldSize: mean(scored.map((s) => s.fieldSize)),
      // D229: the POST-TIME favorite, on the subset of this source's races
      // whose results actually carried a board. Its `n` is deliberately its
      // OWN and will be smaller than `favoriteWin`'s - an Apify-sourced day
      // has a morning line but no closing price, and folding those races in
      // at 0 would report a market that was never read as a market that was
      // wrong.
      marketFavoriteWin: tally(scored, (s) => s.market?.favorite?.win ?? null),
      marketFavoritePlace: tally(scored, (s) => s.market?.favorite?.place ?? null),
      marketFavoriteShow: tally(scored, (s) => s.market?.favorite?.show ?? null),
    },
    // D229: beat-the-close. The mean of `1{the primary pick won} - q` over the
    // races where a board was read AND the primary pick carried a price.
    //
    // This is the one figure here that can distinguish an EDGE from an
    // opinion. Every other rate on this object answers "did this source pick
    // winners", which a source can do well simply by preferring short prices -
    // and a short price is exactly what you get paid least for. `closeEdge`
    // asks the harder question: did the horses it backed win MORE often than
    // the money said they would.
    //
    // Zero is the null hypothesis, not the floor: a source that is neither
    // better nor worse than the market scores 0, and negative is both possible
    // and, going in, the likelier reading.
    //
    // `racesPriced` is its own denominator for the same reason the market
    // baselines above carry theirs, and the figure is NULL at n=0 rather than
    // 0 - this module's oldest rule.
    closeEdge: (() => {
      const edges = scored.map((s) => s.market?.closeEdge).filter((e) => typeof e === 'number' && Number.isFinite(e));
      return { mean: edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : null, n: edges.length };
    })(),
    racesPriced: sum((s) => (s.market?.priced ? 1 : 0)),
  };
}

/**
 * Group scored races by source and aggregate each - NEVER pooling them.
 *
 * `rows` - [{ source, score, ...anything }]. `source` is the grouping key:
 * a bucket (EQB_OTR, HUMAN), a model id (LLM_GENERATED per llm_model), a
 * tip_picks source label. Invariant 13's shape: two sources are two
 * different opinions and a combined figure answers no question. Sorted by
 * n descending so the rows with something to say come first.
 */
export function bySource(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    if (!row) continue;
    const key = String(row.source ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.score ?? null);
  }
  return [...groups.entries()]
    .map(([source, scores]) => ({ source, ...aggregatePickScores(scores) }))
    .sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
}
