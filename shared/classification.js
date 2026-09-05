// Race classification: the consensus table and the UNANIMOUS / SPLIT /
// CHAOS call, plus contrarian flags. Pure functions in shared/ so the
// simulator (Phase 3) replays the exact logic that classified live days.
//
// The rules (from the Del Mar session, encoded exactly; extended D74 for a
// third external source):
//   * UNANIMOUS - every external source with a top pick agrees, and there
//     are >= 2 of them (invariant 4; unchanged semantics - with 3 sources
//     this means 3/3). The program's own analysis counts as a source but
//     never as an external one.
//   * CHAOS - no two sources (external or program) share a top pick - i.e.
//     the plurality vote group has exactly one supporter. With at most 2
//     external + 1 program source (the world before D74), "3+ different
//     top picks" and "nobody agrees with anybody" were the same condition,
//     so this reads identically to the original rule for every input that
//     rule could ever see. A 3rd external source (D74's Equibase OTR) makes
//     them diverge - 4 total sources can produce 3 distinct picks where two
//     of them still agree - so CHAOS is defined on agreement directly, not
//     on the distinct-pick count.
//   * SPLIT - everything else: 2 distinct picks (always was SPLIT,
//     regardless of source count), or 3+ distinct picks where some pair
//     still agrees, or a unanimous vote that got capped (< 2 externals).
//   * A race with no external consensus defaults to its program-analysis
//     classification: SPLIT when the program names a top pick, CHAOS when
//     even the program is silent. Missing consensus never blocks anything
//     (invariant 3) - the sheet just says which sources were used.
//   * `agreement` - the plurality vote group's size (how many sources
//     share the most-picked horse) - stored on every classification result
//     regardless of the call above, so a majority view exists without
//     reclassifying anything.
//   * `CLASSIFY_UNANIMOUS` ('all' default | 'majority'): with 'majority',
//     a SPLIT race where >= 2 of >= 3 external sources agree on the
//     plurality pick AND the program (if it named one) doesn't contradict
//     it is promoted to UNANIMOUS. Off by default - flipping it is an
//     engine change (invariant 14, bumps ENGINE_VERSION), never done as a
//     side effect of adding a source.
//
// Contrarian flags:
//   * algo_fades_favorite - two variants. An algorithmic source that
//     publishes a full expected order (its top pick's note carries JSON
//     `{fullOrder}`) fades the favorite when that order ranks it
//     4th or worse. An algorithmic source that publishes only a BOX (no
//     rank at all, e.g. D74's Equibase OTR - its 4-horse exacta box) fades
//     the favorite when it is absent from the box entirely - a distinct,
//     weaker "partial order" rule, since a box makes no ranking claim.
//   * corroborated_longshot - 2+ sources independently land on the same
//     horse at 10-1 or higher (any pick type, any source - an OTR win pick
//     or box mention counts exactly like any other source's pick). That
//     corroboration upgrades a longshot from a price to a real bet.
//
// Inputs are plain data: entries rows (program_number, horse_name,
// morning_line_decimal, program_rank, scratched, best_bet) and consensus
// picks rows (source_name, source_kind, pick_type, program_number, note).

const RANK_TYPES = { top: 1, second: 2, third: 3 };

/** Default UNANIMOUS rule with 3+ sources (D74). 'majority' is a configured
 * engine change (invariant 14), never the default - see classifyRace. */
export const CLASSIFY_UNANIMOUS = 'all';

/**
 * Build one race's consensus table: per source, its ranked picks and
 * flagged horses. The program's handicapper analysis joins as the
 * non-external source "Program analysis" when any entry carries a
 * program_rank.
 */
export function buildConsensusTable(entries, picks) {
  const sources = new Map();
  const sourceFor = (name, kind, external) => {
    if (!sources.has(name)) {
      sources.set(name, { name, kind, external, top: null, second: null, third: null, flagged: [] });
    }
    return sources.get(name);
  };

  const ranked = entries
    .filter((e) => e.program_rank != null && !e.scratched)
    .sort((a, b) => a.program_rank - b.program_rank);
  if (ranked.length) {
    const s = sourceFor('Program analysis', 'program', false);
    if (ranked[0]) s.top = pickRef(ranked[0]);
    if (ranked[1]) s.second = pickRef(ranked[1]);
    if (ranked[2]) s.third = pickRef(ranked[2]);
  }

  for (const p of picks) {
    const s = sourceFor(p.source_name, p.source_kind, p.source_kind !== 'program');
    const ref = { programNumber: p.program_number, horseName: p.horse_name, note: p.note ?? null };
    if (p.pick_type === 'top') s.top = ref;
    else if (p.pick_type === 'second') s.second = ref;
    else if (p.pick_type === 'third') s.third = ref;
    else s.flagged.push({ ...ref, pickType: p.pick_type });
  }

  return [...sources.values()];
}

const pickRef = (e) => ({ programNumber: e.program_number, horseName: e.horse_name, note: null });

/**
 * Classify one race from its consensus table.
 * `classifyUnanimous`: 'all' (default, CLASSIFY_UNANIMOUS) | 'majority' -
 * see the module doc comment; callers pass this through only to compare
 * settings (e.g. a findings run), never as a silent default flip.
 * Returns { classification, cappedFromUnanimous, externalSourceCount,
 * agreement, topVotes: [{programNumber, sources:[names]}] }.
 */
export function classifyRace(table, { classifyUnanimous = CLASSIFY_UNANIMOUS } = {}) {
  const withTop = table.filter((s) => s.top?.programNumber);
  const external = withTop.filter((s) => s.external);

  const votes = new Map();
  for (const s of withTop) {
    const key = s.top.programNumber;
    if (!votes.has(key)) votes.set(key, []);
    votes.get(key).push(s.name);
  }
  const topVotes = [...votes.entries()]
    .map(([programNumber, sourceNames]) => ({ programNumber, sources: sourceNames }))
    .sort((a, b) => b.sources.length - a.sources.length);
  const agreement = topVotes[0]?.sources.length ?? 0;

  let classification;
  let cappedFromUnanimous = false;
  if (withTop.length === 0) {
    classification = 'CHAOS'; // nobody, not even the program, names a winner
  } else if (votes.size === 1) {
    if (external.length >= 2) {
      classification = 'UNANIMOUS';
    } else {
      classification = 'SPLIT'; // one source agreeing with itself is not consensus
      cappedFromUnanimous = withTop.length > 1 || external.length > 0;
    }
  } else if (votes.size === 2 || agreement > 1) {
    // 2 distinct picks was always SPLIT regardless of source count
    // (unchanged). 3+ distinct picks with some pair still agreeing (only
    // reachable with a 3rd external source, D74) is SPLIT too, not CHAOS -
    // CHAOS means NOBODY agrees, not merely "not everybody".
    classification = 'SPLIT';
    if (classifyUnanimous === 'majority') {
      const plurality = topVotes[0];
      const externalSupporters = plurality.sources
        .filter((name) => withTop.find((s) => s.name === name)?.external).length;
      const programVote = withTop.find((s) => !s.external);
      const programContradicts = programVote && programVote.top.programNumber !== plurality.programNumber;
      if (external.length >= 3 && externalSupporters >= 2 && !programContradicts) {
        classification = 'UNANIMOUS';
      }
    }
  } else {
    classification = 'CHAOS'; // every distinct pick has exactly one supporter
  }

  return { classification, cappedFromUnanimous, externalSourceCount: external.length, agreement, topVotes };
}

/** The public favorite: lowest morning line among unscratched entries. */
export function publicFavorite(entries) {
  return entries
    .filter((e) => !e.scratched && e.morning_line_decimal > 0)
    .sort((a, b) => a.morning_line_decimal - b.morning_line_decimal)[0] ?? null;
}

/**
 * Contrarian flags for one race. `picks` are the race's consensus rows.
 */
export function contrarianFlags(entries, picks) {
  const flags = [];
  const favorite = publicFavorite(entries);

  // An algorithmic source's full expected order (carried in its top pick's
  // note) ranking the favorite 4th or worse.
  if (favorite) {
    for (const p of picks.filter((x) => x.source_kind === 'algorithmic' && x.pick_type === 'top' && x.note)) {
      let note;
      try { note = JSON.parse(p.note); } catch { continue; }
      const row = note?.fullOrder?.find((f) => f.programNumber === favorite.program_number);
      const rank = row?.rank ?? (note?.fullOrder ? Infinity : null);
      if (rank != null && rank >= 4) {
        flags.push({
          type: 'algo_fades_favorite',
          programNumber: favorite.program_number,
          horseName: favorite.horse_name,
          detail: `${p.source_name} ranks the ${favorite.morning_line ?? ''} favorite ${Number.isFinite(rank) ? `#${rank}` : 'unplaced'} in its expected order`,
        });
      }
    }

    // D74: an algorithmic source that publishes only a BOX - a set of
    // horses it likes with no rank at all (Equibase OTR's 4-horse exacta
    // box: pick_type top/second/also from one source, its 'top' note NOT
    // JSON-with-fullOrder) - fades the favorite when it's absent from the
    // box entirely. Distinct from the ranked rule above: a box makes no
    // claim about ORDER, only membership, so "ranks it 4th or worse" has
    // no meaning here - "left it off the box" is the box's own version of
    // fading. A source with a real fullOrder is excluded here (already
    // covered by the ranked rule) so it is never flagged twice.
    // A source's fullOrder status is decided once, from its 'top' pick,
    // then applied to EVERY row of that source (not just the 'top' row) -
    // a fullOrder source that also writes 'second'/'third' picks must not
    // leak those into a phantom "box" here (found live on the then-live
    // ranked source, removed in D82: its non-top rows slipped through when
    // only the 'top' row itself was checked, double-flagging the same fade
    // under two rule names). No ranked source ships today - ATR and
    // Equibase OTR are both unranked - but the rule stays keyed on the
    // note's shape, never on a source name, so one can return for free.
    const fullOrderSources = new Set();
    for (const p of picks) {
      if (p.source_kind !== 'algorithmic' || p.pick_type !== 'top' || !p.note) continue;
      try { if (JSON.parse(p.note)?.fullOrder) fullOrderSources.add(p.source_name); } catch { /* not JSON => box-only source */ }
    }
    const boxes = new Map(); // source_name -> Set(programNumber)
    for (const p of picks) {
      if (p.source_kind !== 'algorithmic' || !p.program_number) continue;
      if (fullOrderSources.has(p.source_name)) continue;
      if (!['top', 'second', 'third', 'also'].includes(p.pick_type)) continue;
      if (!boxes.has(p.source_name)) boxes.set(p.source_name, new Set());
      boxes.get(p.source_name).add(p.program_number);
    }
    for (const [sourceName, box] of boxes) {
      if (box.size && !box.has(favorite.program_number)) {
        flags.push({
          type: 'algo_fades_favorite',
          programNumber: favorite.program_number,
          horseName: favorite.horse_name,
          detail: `${sourceName} omits the ${favorite.morning_line ?? ''} favorite from its box (partial order, no ranked expected order)`,
        });
      }
    }
  }

  // 2+ sources independently on the same 10-1+ horse (any pick type).
  const byHorse = new Map();
  for (const p of picks) {
    if (!p.program_number) continue;
    if (!byHorse.has(p.program_number)) byHorse.set(p.program_number, new Set());
    byHorse.get(p.program_number).add(p.source_name);
  }
  for (const [programNumber, sourceSet] of byHorse) {
    const entry = entries.find((e) => e.program_number === programNumber);
    if (!entry || entry.scratched) continue;
    if (entry.morning_line_decimal >= 10 && sourceSet.size >= 2) {
      flags.push({
        type: 'corroborated_longshot',
        programNumber,
        horseName: entry.horse_name,
        detail: `${[...sourceSet].join(' + ')} independently on a ${entry.morning_line} shot`,
      });
    }
  }

  return flags;
}

/**
 * Per-horse source coverage - how many distinct sources mention each horse
 * in any capacity. Feeds the lean-mode rule "any horse flagged by 2+
 * sources gets small coverage even on chaos days".
 */
export function sourceCounts(picks) {
  const counts = new Map();
  for (const p of picks) {
    if (!p.program_number) continue;
    if (!counts.has(p.program_number)) counts.set(p.program_number, new Set());
    counts.get(p.program_number).add(p.source_name);
  }
  return Object.fromEntries([...counts.entries()].map(([k, v]) => [k, v.size]));
}

/** Classify every race of a day. entriesByRace/picksByRace keyed by race number. */
export function classifyDay(raceNumbers, entriesByRace, picksByRace) {
  return raceNumbers.map((number) => {
    const entries = entriesByRace[number] ?? [];
    const picks = picksByRace[number] ?? [];
    const table = buildConsensusTable(entries, picks);
    const result = classifyRace(table);
    return {
      number,
      table,
      ...result,
      contrarianFlags: contrarianFlags(entries, picks),
      sourceCounts: sourceCounts(picks),
    };
  });
}
