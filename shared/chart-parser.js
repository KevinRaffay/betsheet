// Equibase results-chart parser: pasted chart text (the text layer of the
// official chart PDF, which is what copying from the chart viewer yields)
// -> per-race results, every mutuel payoff, and scratches.
//
// Same contract as every parser here: browser + Node, never throws,
// unparsed material lands in `warnings` for the read-only preview
// (invariant 9). Charts are ingested by paste or downloaded PDF ONLY -
// Equibase is never scraped (invariant 6).
//
// Chart anatomy (one section per race):
//   "DEL MAR - August 30, 2026 - Race 1"   <- track/date/race anchor
//   conditions..., "Distance: Seven Furlongs On The Dirt", purse...
//   "Last Raced Pgm Horse Name (Jockey) ... Fin Odds Comments" table -
//     horses listed in finish order; margin fractions interleave as their
//     own lines and are skipped by shape.
//   "Fractional Times ... Final Time", Winner/Breeder/Owner/Trainer
//   "Pgm Horse Win Place Show   Wager Type Winning Numbers Payoff Pool" -
//     WPS rows and exotic rows SHARE lines (two visual columns); each line
//     splits at the first "$" into a WPS half and an exotic half.
//   "Scratched Horse(s): Name (Reason), ..." and "Claimed Horse(s): ..."

const HEADER = /^(.+?)\s+-\s+([A-Z][a-z]+ \d{1,2}, \d{4})\s+-\s+Race\s+(\d+)\s*$/;
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

const BET_TYPES = {
  exacta: 'exacta', quinella: 'quinella', trifecta: 'trifecta',
  superfecta: 'superfecta', 'daily double': 'daily_double',
  'pick 3': 'pick3', 'pick 4': 'pick4', 'pick 5': 'pick5', 'pick 6': 'pick6',
  'super high five': 'super_high_five', consolation: 'consolation',
};

const money = (s) => Math.round(Number(String(s).replace(/,/g, '')) * 100);

// "DEL [ MAR" - logo glyphs leak into the header; keep word tokens only.
const cleanTrack = (s) => s.split(/\s+/).filter((t) => /^[A-Za-z'.]+$/.test(t)).join(' ');

function parseDate(text) {
  const m = text.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// "14Aug26 DMR 1 Howie's Law (Jaramillo, Emisael) 121 L 1 1 1 1 1 1 0.40* comment"
// First-timers have no last-raced prefix. Fin is the integer right before
// the odds token; margin-fraction lines have no "(Jockey)" and are skipped.
const HORSE_LINE = /^(?:\d{1,2}[A-Za-z]{3}\d{2}\s+\S+\s+|---\s+)?(\d+A?)\s+(.+?)\s+\(([^)]+)\)\s+(\d+)\s+(.*)$/;

function parseResultLine(line) {
  const m = line.match(HORSE_LINE);
  if (!m) return null;
  const tail = m[5].trim().split(/\s+/);
  const oddsIdx = tail.findIndex((t) => /^\d+\.\d{2}\*?$/.test(t));
  if (oddsIdx < 1) return null;
  const fin = tail[oddsIdx - 1];
  if (!/^\d+$/.test(fin)) return null;
  return {
    programNumber: m[1].toUpperCase(),
    horseName: m[2].trim(),
    jockey: m[3].trim(),
    weight: Number(m[4]),
    finishPosition: Number(fin),
    odds: Number(tail[oddsIdx].replace('*', '')),
    favorite: tail[oddsIdx].endsWith('*'),
    winCents: null,
    placeCents: null,
    showCents: null,
  };
}

// Mutuel line: optional WPS half, optional exotic half, split at first "$".
const WPS_HALF = /^(\d+A?)\s+(.+?)((?:\s+\d+\.\d{2}){1,3})$/;
// Exotic rows: "$base  Type  Combination  [(N correct)]  Payout  Pool".
// Peeled from the END (payout may print without cents on jackpot payoffs),
// then the middle splits into type + combination. Combination forms seen
// in the wild: "1-6-5-4", "5-11-3-1/4-4-2" (a leg with two winners),
// "8 OF 10" (Place Pick All), "TURFPICK3(11-4-2)" (a named pool wrapping
// its combo in parens).
const EXOTIC_SHELL = /^\$(\d+(?:\.\d{2})?)\s+(.+?)\s+([\d,]+(?:\.\d{2})?)\s+([\d,]+)\s*$/;
const COMBO_TAIL = /^(.*?)\s+((?:[\dA]+(?:[-/][\dA]+)+)|(?:\d+\s+OF\s+\d+)|(?:[A-Z]+[A-Z0-9]*\([\dA/-]+\)))$/;

function parseExotic(exoticPart) {
  const shell = exoticPart.match(EXOTIC_SHELL);
  if (!shell) return null;
  const middle = shell[2].replace(/\s*\(\d+\s+correct\)\s*$/, '').trim();
  const split = middle.match(COMBO_TAIL);
  if (!split) return null;
  let type = split[1].trim();
  let combination = split[2];
  const named = combination.match(/^([A-Z]+[A-Z0-9]*)\(([\dA/-]+)\)$/);
  if (named) {
    type = named[1];
    combination = named[2];
  }
  // A type residue carrying decimal numbers means the row had extra
  // columns this parser does not model (e.g. the $1 3x3) - warn, not guess.
  if (!type || /\d\.\d/.test(type)) return null;
  const typeKey = type.toLowerCase().replace(/\s+/g, ' ');
  return {
    betType: BET_TYPES[typeKey] ?? typeKey.replace(/[^a-z0-9]+/g, '_'),
    baseCents: money(shell[1]),
    combination,
    payoutCents: money(shell[3]),
    poolCents: Number(shell[4].replace(/,/g, '')) * 100, // pools print as whole dollars
  };
}

function parseMutuelLine(line, race, warnings) {
  const dollar = line.indexOf('$');
  const wpsPart = (dollar >= 0 ? line.slice(0, dollar) : line).trim();
  const exoticPart = dollar >= 0 ? line.slice(dollar).trim() : '';

  if (wpsPart) {
    const w = wpsPart.match(WPS_HALF);
    if (w) {
      const prices = w[3].trim().split(/\s+/).map(money);
      const result = race.results.find((r) => r.programNumber === w[1].toUpperCase());
      if (result) {
        // 3 prices = win/place/show, 2 = place/show, 1 = show.
        if (prices.length === 3) [result.winCents, result.placeCents, result.showCents] = prices;
        else if (prices.length === 2) [result.placeCents, result.showCents] = prices;
        else [result.showCents] = prices;
      } else {
        warnings.push({ type: 'unmatched_payout', race: race.number, message: `Race ${race.number}: WPS payout for program ${w[1]} matched no finisher.` });
      }
    } else {
      warnings.push({ type: 'unrecognized_mutuel', race: race.number, message: `Race ${race.number}: unrecognized mutuel text: "${wpsPart.slice(0, 60)}"` });
    }
  }
  if (exoticPart) {
    const exotic = parseExotic(exoticPart);
    if (exotic) race.exotics.push(exotic);
    else warnings.push({ type: 'unrecognized_mutuel', race: race.number, message: `Race ${race.number}: unrecognized wager text: "${exoticPart.slice(0, 60)}"` });
  }
}

function parseScratches(text) {
  // "Angels Revenge (Stewards), American Glory (GB) (Trainer)" - the LAST
  // paren group is the reason; earlier parens belong to the name.
  return text.split(/,\s+/).map((part) => {
    const m = part.trim().match(/^(.+?)\s*\(([^()]*)\)$/);
    return m ? { horseName: m[1].trim(), reason: m[2].trim() } : { horseName: part.trim(), reason: null };
  }).filter((s) => s.horseName);
}

/** Parse a pasted Equibase chart. Never throws. */
export function parseChart(text) {
  const warnings = [];
  // Long wager rows wrap their "(N correct)" annotation - sometimes
  // adjacent ("(3\ncorrect)"), sometimes with the payoff columns between
  // ("(3 1,335.30 109,472\ncorrect)"). Rejoin the adjacent form, then drop
  // an orphaned "(N " that sits directly before numbers and any leftover
  // lone "correct)" line.
  const rejoined = String(text ?? '')
    .replace(/\((\d+)\s*\r?\n\s*correct\)/g, '($1 correct)')
    .replace(/\((\d+)\s+(?=[\d,]+(?:\.\d{2})?\s+[\d,]+\s*(?:\r?\n|$))/g, '')
    .replace(/^\s*correct\)\s*$/gm, '');
  const lines = rejoined.split(/\r?\n/).map((l) => l.trim());

  let track = null;
  let date = null;
  const races = [];
  let race = null;
  let section = null; // 'results' | 'mutuel' | null

  for (const line of lines) {
    if (!line) continue;

    const header = line.match(HEADER);
    if (header && parseDate(header[2])) {
      const t = cleanTrack(header[1]);
      const d = parseDate(header[2]);
      // Logo glyphs split header words unpredictably per page ("DEL M AR");
      // compare letters only, keep the first spelling seen.
      const letters = (s) => String(s ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
      if (track && letters(t) !== letters(track)) warnings.push({ type: 'track_mismatch', message: `Chart names two tracks: "${track}" and "${t}".` });
      if (date && d !== date) warnings.push({ type: 'date_mismatch', message: `Chart names two dates: ${date} and ${d}.` });
      track = track ?? t;
      date = date ?? d;
      race = {
        number: Number(header[3]),
        raceType: null,
        distance: null,
        surface: null,
        finalTime: null,
        results: [],
        exotics: [],
        scratches: [],
        claimed: [],
      };
      races.push(race);
      section = null;
      continue;
    }
    if (!race) continue;

    if (race.raceType === null && /Thoroughbred/.test(line)) {
      race.raceType = line.replace(/\s*-\s*Thoroughbred\s*$/, '').trim();
      continue;
    }
    const dist = line.match(/^Distance:\s+(.+?)\s+On\s+The\s+(\w+)/i);
    if (dist) {
      race.distance = dist[1].trim();
      race.surface = dist[2].toUpperCase();
      continue;
    }
    const finalTime = line.match(/Final Time:\s+([\d:.]+)/);
    if (finalTime) {
      race.finalTime = finalTime[1];
      section = null; // results table is over
      continue;
    }
    if (/^Last Raced\s+Pgm\s+Horse/.test(line)) { section = 'results'; continue; }
    if (/^Pgm\s+Horse\s+Win\s+Place\s+Show/.test(line)) { section = 'mutuel'; continue; }
    if (/^Past Performance|^Trainers:|^Owners:|^Footnotes/.test(line)) { section = null; continue; }

    const scr = line.match(/^Scratched Horse\(s\):\s*(.+)$/);
    if (scr) { race.scratches.push(...parseScratches(scr[1])); continue; }
    const claimed = line.match(/^Claimed Horse\(s\):\s*(.+)$/);
    if (claimed) { race.claimed.push(claimed[1]); continue; }

    if (section === 'results') {
      const result = parseResultLine(line);
      if (result) race.results.push(result);
      // margin-fraction interleave lines fail the shape and fall through
      continue;
    }
    if (section === 'mutuel') {
      if (/^Total WPS Pool/.test(line)) continue;
      parseMutuelLine(line, race, warnings);
      continue;
    }
  }

  for (const r of races) {
    if (r.results.length === 0) {
      warnings.push({ type: 'empty_race', race: r.number, message: `Race ${r.number}: no finishers parsed.` });
      continue;
    }
    // Charts list finishers in order; a Fin column disagreeing with the
    // listing order is worth an eyebrow, not a rejection.
    const misordered = r.results.some((res, i) => res.finishPosition !== i + 1);
    if (misordered) {
      warnings.push({ type: 'finish_order', race: r.number, message: `Race ${r.number}: finish positions do not match listing order (dead heat or parse gap - review).` });
    }
    if (!r.results.some((res) => res.winCents != null)) {
      warnings.push({ type: 'no_win_payout', race: r.number, message: `Race ${r.number}: no win payout parsed.` });
    }
  }
  if (races.length === 0) {
    warnings.push({ type: 'no_races', message: 'No chart race headers ("TRACK - Month D, YYYY - Race N") found.' });
  }

  return { track, date, races, warnings };
}
