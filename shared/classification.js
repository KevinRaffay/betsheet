// Race classification: the consensus table and the UNANIMOUS / SPLIT /
// CHAOS call, plus contrarian flags. Pure functions in shared/ so the
// simulator (Phase 3) replays the exact logic that classified live days.
//
// The rules (from the Del Mar session, encoded exactly):
//   * UNANIMOUS - every available source agrees on the winner - requires
//     GENUINE multi-source agreement: with fewer than 2 EXTERNAL sources
//     the classification caps at SPLIT (invariant 4). The program's own
//     analysis counts as a source but never as an external one.
//   * SPLIT - top picks disagree 2 ways (or a unanimous vote was capped).
//   * CHAOS - 3+ different top picks.
//   * A race with no external consensus defaults to its program-analysis
//     classification: SPLIT when the program names a top pick, CHAOS when
//     even the program is silent. Missing consensus never blocks anything
//     (invariant 3) - the sheet just says which sources were used.
//
// Contrarian flags:
//   * algo_fades_favorite - an algorithmic source's full expected order
//     ranks the public favorite (lowest morning line) 4th or worse.
//   * corroborated_longshot - 2+ sources independently land on the same
//     horse at 10-1 or higher (any pick type). That corroboration upgrades
//     a longshot from a price to a real bet.
//
// Inputs are plain data: entries rows (program_number, horse_name,
// morning_line_decimal, program_rank, scratched, best_bet) and consensus
// picks rows (source_name, source_kind, pick_type, program_number, note).

const RANK_TYPES = { top: 1, second: 2, third: 3 };

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
 * Returns { classification, cappedFromUnanimous, externalSourceCount,
 * topVotes: [{programNumber, sources:[names]}] }.
 */
export function classifyRace(table) {
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
  } else if (votes.size === 2) {
    classification = 'SPLIT';
  } else {
    classification = 'CHAOS';
  }

  return { classification, cappedFromUnanimous, externalSourceCount: external.length, topVotes };
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
