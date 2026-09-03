// At The Races printed-racecard PDF parser (D69): a same-day "print to PDF"
// of https://www.attheraces.com/racecards/<track>/<date> covers every race
// on one file, replacing the per-race manual paste that source used to
// need. Pure (browser + Node), never throws - same contract as every other
// parser in the codebase (shared/picks-parser.js, shared/chart-parser.js):
// problems land in `warnings`, a bad block is skipped, not fatal.
//
// The PDF-to-text step lives in the server layer (server/pdf-text.js's
// extractPdfLines - the same pdfjs-dist line-reconstruction the chart-PDF
// upload path already feeds into shared/chart-parser.js) - this function
// takes plain text, never a file.
//
// Confirmed against a real Del Mar 2026-09-03 export: per race, in order,
// a "Race N - <type>" header (the authoritative race-scoping line - picks
// are never scoped from Top Tip's own context), then later in the same
// block "Top Tip: <NAME> (<pgm>)" and "Watch out for: <NAME> (<pgm>)",
// always together when present at all. Running header/footer noise (nav
// links, ad blocks, pagination) repeats between blocks and is naturally
// ignored - neither regex below matches it.
//
// v1 does not extract the Verdict paragraph's optional third horse (e.g.
// "...Tahini and Saratoga Special also merit consideration.") - same
// limitation already accepted for the plain-paste Verdict format.

const RACE_HEADER_RE = /^Race\s+(\d+)\s*-\s*.+$/gm;
const TOP_TIP_RE = /Top Tip:\s*(.+?)\s*\((\d+)\)/;
const WATCH_FOR_RE = /Watch out for:\s*(.+?)\s*\((\d+)\)/;

/**
 * Parse the line-reconstructed text of an ATR racecard-page PDF (or the
 * pasted equivalent) into top-pick/watch-pick pairs, one per race.
 * Returns { picks: [{race, topPick: {name, programNumber}, watchFor: {name,
 * programNumber}}], warnings }.
 */
export function parseAtrPdfText(text) {
  const warnings = [];
  const picks = [];
  const raw = String(text ?? '');

  const anchors = [...raw.matchAll(RACE_HEADER_RE)];
  if (anchors.length === 0) {
    warnings.push({ type: 'no_races', message: 'No "Race N - ..." headers found.' });
    return { picks, warnings };
  }

  for (let i = 0; i < anchors.length; i++) {
    const race = Number(anchors[i][1]);
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : raw.length;
    const block = raw.slice(start, end);

    const top = block.match(TOP_TIP_RE);
    const watch = block.match(WATCH_FOR_RE);
    if (!top || !watch) {
      warnings.push({ type: 'missing_verdict', race, message: `Race ${race}: no Top Tip / Watch out for pair found - extraction may have failed, or the page format changed.` });
      continue;
    }
    picks.push({
      race,
      topPick: { name: top[1].trim(), programNumber: top[2] },
      watchFor: { name: watch[1].trim(), programNumber: watch[2] },
    });
  }

  picks.sort((a, b) => a.race - b.race);
  return { picks, warnings };
}
