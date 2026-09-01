// Manual-picks parser: pasted picks for ONE source -> the same consensus
// structure the automated fetchers produce. The fallback path for sources
// behind bot protection or paywalls (invariant 6: back off and paste).
//
// Runs in browser and Node, never throws, reports problems in `warnings` -
// same contract as entries-parser. The preview built from this is read-only
// (invariant 9): fix the pasted text and re-parse.
//
// Format, one race per line (case-insensitive, flexible):
//
//   Race 1: 4, 2, 7
//   R2: Howie's Law, 6 | watch: 3, Fumano's Magic
//   3: 5, 1A | contrarian: 9
//
// Ranked picks come first (top, second, third - extras beyond three are
// watch-outs); "watch:"/"w:" and "contrarian:"/"c:" sections add flagged
// horses. Tokens are program numbers or horse names; the caller resolves
// names against the race day's entries.

const LINE = /^(?:race\s+|r)?(\d+)\s*[:.-]\s*(.+)$/i;
const RANK_TYPES = ['top', 'second', 'third'];

export function parsePicksText(text) {
  const warnings = [];
  const races = [];

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE);
    if (!m) {
      warnings.push({ type: 'unrecognized_line', message: `Unrecognized line: "${line.slice(0, 80)}"` });
      continue;
    }
    const race = Number(m[1]);
    if (races.some((r) => r.race === race)) {
      warnings.push({ type: 'duplicate_race', message: `Race ${race} appears more than once; keeping the first.` });
      continue;
    }

    const picks = [];
    const sections = m[2].split('|').map((s) => s.trim()).filter(Boolean);
    for (const [si, section] of sections.entries()) {
      const flagged = section.match(/^(watch|w|contrarian|c)\s*:\s*(.+)$/i);
      const pickType = flagged
        ? (/^c/i.test(flagged[1]) ? 'contrarian' : 'watch_out')
        : null;
      if (!flagged && si > 0) {
        warnings.push({ type: 'unrecognized_section', message: `Race ${race}: section "${section.slice(0, 40)}" needs a watch:/contrarian: label.` });
        continue;
      }
      const tokens = (flagged ? flagged[2] : section).split(',').map((t) => t.trim()).filter(Boolean);
      for (const [ti, token] of tokens.entries()) {
        picks.push({
          programNumber: /^\d+A?$/i.test(token) ? token.toUpperCase() : null,
          horseName: /^\d+A?$/i.test(token) ? null : token,
          pickType: pickType ?? (RANK_TYPES[ti] ?? 'watch_out'),
        });
      }
    }
    if (picks.length === 0) {
      warnings.push({ type: 'empty_race', message: `Race ${race} has no picks.` });
      continue;
    }
    races.push({ race, picks });
  }

  races.sort((a, b) => a.race - b.race);
  if (races.length === 0) {
    warnings.push({ type: 'no_picks', message: 'No "Race N: ..." lines found.' });
  }
  return { races, warnings };
}
