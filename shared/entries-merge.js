// Merge the two program-day sources (D40). Browser + Node, pure.
//
// The ML/changes sheet is the ENTRIES SOURCE OF RECORD: it is what the
// track publishes on race morning, so its scratches, odds, jockeys and
// weights win. The program PDF is ANALYSIS-ONLY: it contributes the Bottom
// Line (programRank, bestBet), trainer, owner and breeding, and it must
// agree with the sheet on program number + horse name to contribute at
// all. Every field where the two disagree is reported, never silently
// resolved - the preview shows the warning, the sheet's value is what
// Save stores (invariant 9).

const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

const COMPARED = ['scratched', 'morningLine', 'jockey', 'weight'];

/**
 * `ml`: the ML sheet parse; `program`: the program PDF parse (may be null).
 * Returns { track, date, races, warnings, entriesSource, analysis }.
 */
export function mergeMlAndProgram(ml, program) {
  const warnings = [...(ml.warnings ?? [])];
  if (!program) {
    return { track: ml.track, date: ml.date, races: ml.races, warnings, entriesSource: 'ml_sheet', analysis: [] };
  }
  for (const w of program.warnings ?? []) warnings.push({ ...w, message: `Program: ${w.message}` });
  if (program.date && ml.date && program.date !== ml.date) {
    warnings.push({ type: 'program_ml_date_mismatch', message: `The program is dated ${program.date} but the ML sheet ${ml.date}; the sheet's date is kept.` });
  }
  if (program.races.length !== ml.races.length) {
    warnings.push({ type: 'program_ml_race_count', message: `The program has ${program.races.length} races, the ML sheet ${ml.races.length}; the sheet's races are kept.` });
  }
  const progByNumber = new Map(program.races.map((r) => [r.number, r]));
  const races = ml.races.map((mlRace) => {
    const pr = progByNumber.get(mlRace.number);
    if (!pr) {
      warnings.push({ type: 'program_race_missing', race: mlRace.number, message: `Race ${mlRace.number}: not in the program; no analysis for it.` });
      return { ...mlRace, entries: mlRace.entries.map((e) => ({ ...e })) };
    }
    const progByPgm = new Map(pr.entries.map((e) => [String(e.programNumber), e]));
    const seen = new Set();
    const entries = mlRace.entries.map((e) => {
      const p = progByPgm.get(String(e.programNumber));
      const out = { ...e };
      if (!p) {
        warnings.push({ type: 'program_entry_missing', race: mlRace.number, message: `Race ${mlRace.number}: #${e.programNumber} ${e.horseName} is on the ML sheet but not in the program.` });
        return out;
      }
      seen.add(String(e.programNumber));
      if (nameKey(p.horseName) !== nameKey(e.horseName)) {
        warnings.push({ type: 'program_ml_name_mismatch', race: mlRace.number, message: `Race ${mlRace.number}: #${e.programNumber} is "${e.horseName}" on the ML sheet but "${p.horseName}" in the program; the program's analysis for this number is NOT applied.` });
        return out;
      }
      for (const field of COMPARED) {
        const a = e[field]; const b = p[field];
        const differs = field === 'scratched' ? Boolean(a) !== Boolean(b)
          : field === 'jockey' ? (a && b && nameKey(a.replace(/^[A-Z]\.?\s/, '')) !== nameKey(b.replace(/^[A-Z][a-z]*\.?\s/, '')) && !jockeyLoose(a, b))
            : (a != null && b != null && String(a) !== String(b));
        if (differs) {
          warnings.push({ type: 'program_ml_disagreement', race: mlRace.number, field, programNumber: e.programNumber,
            message: `Race ${mlRace.number}: #${e.programNumber} ${e.horseName} - ${field} is ${JSON.stringify(a)} on the ML sheet but ${JSON.stringify(b)} in the program; the sheet wins.` });
        }
      }
      out.programRank = p.programRank ?? null;
      out.bestBet = Boolean(p.bestBet);
      out.trainer = p.trainer ?? null;
      out.owner = p.owner ?? null;
      out.breeding = p.breeding ?? null;
      out.notToBeClaimed = Boolean(p.notToBeClaimed);
      if (e.postPosition == null && p.postPosition != null) out.postPosition = p.postPosition;
      return out;
    });
    for (const p of pr.entries) {
      if (!seen.has(String(p.programNumber)) && !mlRace.entries.some((e) => String(e.programNumber) === String(p.programNumber))) {
        warnings.push({ type: 'ml_entry_missing', race: mlRace.number, message: `Race ${mlRace.number}: #${p.programNumber} ${p.horseName} is in the program but not on the ML sheet; not saved (the sheet is the record).` });
      }
    }
    return { ...mlRace, entries };
  });
  return { track: ml.track, date: ml.date, races, warnings, entriesSource: 'both', analysis: program.analysis ?? [] };
}

// "E Jaramillo" (sheet) vs "Emisael Jaramillo" (program): initial + surname.
function jockeyLoose(a, b) {
  const ta = String(a).trim().split(/\s+/); const tb = String(b).trim().split(/\s+/);
  if (!ta.length || !tb.length) return false;
  const lastA = nameKey(ta[ta.length - 1]); const lastB = nameKey(tb[tb.length - 1]);
  return lastA === lastB && ta[0][0].toLowerCase() === tb[0][0].toLowerCase();
}
