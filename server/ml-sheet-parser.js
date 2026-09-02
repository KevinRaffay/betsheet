// Morning-line sheet parser (D40): the track's ML/changes PDF -> the D04
// entries structure. Node-only (pdfjs-dist), same contract as the other
// parsers: parse what can be parsed, report the rest in `warnings`, never
// throw on bad content (invariant 9).
//
// Layout (Del Mar "ML<yyyymmdd>.pdf", verified on 2026-08-16): one page in
// two columns. Each race: "<Ordinal> Race" + "Approx Post Time: H:MMPM",
// the wager-menu lines, a sponsor/title line, then a one-line summary
// "<dist>. (Turf). <type>. Purse $N. <ages>. Clm Price $N (...)" that may
// wrap. Then one row per horse at fixed columns relative to the column's
// left edge: [AE] pgm | name | meds | claim price | jockey | weight | ML.
// "SCRATCHED" replaces everything after the name. Text items come in
// stream order; nothing here trusts it - rows are bands keyed on the
// program-number item's y, columns on x relative to the left edge.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { morningLineToDecimal } from '../shared/entries-parser.js';

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth'];
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const NUM_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const FRACTIONS = { '1/2': 'One Half', '1/4': 'One Quarter', '1/8': 'One Eighth', '1/16': 'One Sixteenth', '3/16': 'Three Sixteenths', '3/8': 'Three Eighths', '3/4': 'Three Quarters', '70': 'Seventy Yards' };

const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const moneyToCents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);

/** "6F" -> "Six Furlongs", "5 1/2F" -> "Five And One Half Furlongs", "1 1/16M" -> "One Mile And One Sixteenth". */
export function distanceWords(abbrev) {
  const m = norm(abbrev).match(/^(?:(\d+)\s*)?(?:(\d+\/\d+)\s*)?([FM])$/i);
  if (!m) return null;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? FRACTIONS[m[2]] : null;
  const unit = m[3].toUpperCase();
  if (unit === 'F') {
    const words = [whole ? NUM_WORDS[whole] : null, frac ? (whole ? `And ${frac}` : frac) : null].filter(Boolean).join(' ');
    return words ? `${words} Furlongs` : null;
  }
  const miles = whole === 1 ? 'One Mile' : whole > 1 ? `${NUM_WORDS[whole]} Miles` : null;
  if (!miles) return null;
  return frac ? `${miles} And ${frac}` : miles;
}

/** The summary line: distance, surface, type, purse, claiming price. */
export function parseSummary(text) {
  const t = norm(text);
  const out = { distance: null, surface: 'DIRT', raceType: null, purseCents: null, claimingPriceCents: null, conditions: t || null };
  const dist = t.match(/^((?:\d+\s*)?(?:\d+\/\d+\s*)?[FM])\.\s*/i);
  if (dist) out.distance = distanceWords(dist[1]);
  if (/\(Turf\)/i.test(t)) out.surface = 'TURF';
  const rest = dist ? t.slice(dist[0].length).replace(/^\(Turf\)\.\s*/i, '') : t;
  const type = rest.match(/^([A-Za-z/ ]+?)\.\s/);
  if (type) out.raceType = type[1].trim().toUpperCase();
  const purse = t.match(/Purse \$([\d,]+)/i);
  if (purse) out.purseCents = moneyToCents(purse[1]);
  const clm = t.match(/Clm Price \$([\d,]+)/i);
  if (clm) out.claimingPriceCents = moneyToCents(clm[1]);
  return out;
}

async function pageItems(doc, p) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  return tc.items
    .filter((i) => i.str.trim())
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], h: i.height, w: i.width }));
}

// Group a column's items into text lines (y within 1.5pt), left to right.
function toLines(items) {
  const lines = [];
  for (const i of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - i.y) <= 1.5);
    if (line) line.items.push(i); else lines.push({ y: i.y, items: [i] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}
const lineText = (l) => norm(l.items.map((i) => i.s).join(' '));

const TITLE_RE = new RegExp('^(' + ORDINALS.join('|') + ')' + String.fromCharCode(92) + 's+Race$', 'i');
const ENTRY_HEAD = /^(AE|\d+[A-Z]?)$/;
const WAGER_LINE = /^(\$|\d+c\s|\*\*).*\b(Exacta|Quinella|Trifecta|Double|Pick|Parlay|Superfecta|High.?5|3x3)\b/i;
const SUMMARY_RE = /^(?:\d+\s*)?(?:\d+\/\d+\s*)?[FM]\.\s/i;

function parseColumn(lines, leftEdge, warnings) {
  const races = [];
  let race = null;
  let pendingPost = null; // a post-time line printed just ABOVE the next title
  const rel = (i) => i.x - leftEdge;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const first = line.items[0];
    const text = lineText(line);
    const title = norm(first.s).match(TITLE_RE);
    if (title && first.h >= 10) {
      race = {
        number: ORDINALS.indexOf(title[1].toLowerCase()) + 1, postTime: null, wagerMenu: [], title: null,
        summary: null, entries: [], scratches: [],
      };
      races.push(race);
      const post = text.match(/Approx\.?\s*Post\s*Time:?\s*([0-9:]+\s*[AP]M)/i);
      race.postTime = post ? post[1].replace(/\s+/g, '') : pendingPost;
      pendingPost = null;
      continue;
    }
    const post = text.match(/^Approx\.?\s*Post\s*Time:?\s*([0-9:]+\s*[AP]M)$/i);
    if (post) {
      // Before any entry it is this race's header; after the entries it
      // belongs to the race whose title comes next (the sheet prints it a
      // couple of points above the title).
      if (race && race.entries.length === 0) race.postTime = post[1].replace(/\s+/g, '');
      else pendingPost = post[1].replace(/\s+/g, '');
      continue;
    }
    if (!race) continue; // page/column header (track, date)
    if (race.summary == null) {
      if (/^Mark Bet Slips/i.test(text)) continue;
      if (WAGER_LINE.test(text)) { race.wagerMenu.push(text); continue; }
      if (SUMMARY_RE.test(text)) { race.summary = text; continue; }
      race.title = text; // sponsor / stakes title line
      continue;
    }
    if (!ENTRY_HEAD.test(norm(first.s))) {
      // Continuation of the wrapped summary ("Feet)", "(Rail at 12 Feet)").
      if (race.entries.length === 0) race.summary = `${race.summary} ${text}`;
      continue;
    }
    // ----- an entry row -----
    let items = [...line.items];
    const ae = norm(first.s) === 'AE';
    const head = ae ? items[1] : first;
    if (!head || !/^\d+[A-Z]?$/.test(norm(head.s))) continue;
    const nameOf = (its) => its.find((i) => rel(i) > 15 && rel(i) < 60 && !/^\d+[A-Z]?$/.test(norm(i.s)));
    if (!nameOf(items) && lines[li + 1] && Math.abs(lines[li + 1].y - line.y) <= 4 &&
        !ENTRY_HEAD.test(norm(lines[li + 1].items[0].s))) {
      items = [...items, ...lines[li + 1].items]; // a band split across two text lines
      li++;
    }
    const name = nameOf(items);
    const at = (lo, hi) => items.filter((i) => rel(i) >= lo && rel(i) < hi && i !== name && i !== head && !(ae && i === first));
    const scratched = items.some((i) => /^SCRATCHED$/i.test(norm(i.s)));
    const meds = at(100, 118).map((i) => norm(i.s)).filter((s) => !/^SCRATCHED$/i.test(s)).join(' ') || null;
    const claim = at(118, 150).map((i) => norm(i.s)).join(' ') || null;
    const jockey = at(150, 205).map((i) => norm(i.s)).join(' ') || null;
    const weightItem = at(205, 228).find((i) => /^\d{3}$/.test(norm(i.s)));
    const mlItem = at(228, 400).find((i) => /^\d+(\/\d+)?$/.test(norm(i.s)));
    const morningLine = mlItem ? (norm(mlItem.s).includes('/') ? norm(mlItem.s) : `${norm(mlItem.s)}/1`) : null;
    const entry = {
      programNumber: norm(head.s),
      postPosition: null,
      horseName: name ? norm(name.s) : '(unnamed)',
      jockey, trainer: null,
      equipment: meds,
      weight: weightItem ? Number(norm(weightItem.s)) : null,
      morningLine, morningLineDecimal: morningLineToDecimal(morningLine),
      claimingPriceCents: claim && /^\$/.test(claim) ? moneyToCents(claim) : null,
      claimWaived: claim != null && /waived/i.test(claim),
      scratched, alsoEligible: ae,
      scratchReason: scratched ? 'scratched on the ML sheet' : null,
    };
    if (!name) warnings.push({ type: 'unnamed_entry', race: race.number, message: `Race ${race.number}: program ${entry.programNumber} has no horse name on the sheet.` });
    if (!scratched && (!morningLine || !jockey || !entry.weight)) {
      warnings.push({ type: 'missing_field', race: race.number, message: `Race ${race.number}: #${entry.programNumber} ${entry.horseName} is missing ${[!morningLine && 'morning line', !jockey && 'jockey', !entry.weight && 'weight'].filter(Boolean).join(', ')}.` });
    }
    race.entries.push(entry);
    if (scratched) race.scratches.push({ programNumber: entry.programNumber, horseName: entry.horseName, reason: entry.scratchReason });
  }
  return races;
}


/** Parse an ML sheet PDF. `source`: file path or Uint8Array. */
export async function parseMlSheetPdf(source, expected = {}) {
  const warnings = [];
  const doc = await getDocument({ ...(typeof source === 'string' ? { url: source } : { data: source }), useSystemFonts: true }).promise;
  let track = null;
  let date = null;
  const rawRaces = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const items = await pageItems(doc, p);
    const titles = items.filter((i) => i.h >= 10 && TITLE_RE.test(norm(i.s)));
    if (!titles.length) continue;
    // Column left edges from the race titles (one cluster per column).
    const edges = [...new Set(titles.map((i) => Math.round(i.x)))].sort((a, b) => a - b)
      .filter((x, k, arr) => k === 0 || x - arr[k - 1] > 60);
    const bounds = edges.map((x, k) => [x - 20, edges[k + 1] ? edges[k + 1] - 20 : Infinity]);
    for (const [lo, hi] of bounds) {
      const col = items.filter((i) => i.x >= lo && i.x < hi);
      const lines = toLines(col);
      if (!date) {
        for (const l of lines) {
          const m = lineText(l).match(/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
          if (m && MONTHS[m[1].toLowerCase()]) {
            date = `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
            const above = lines.filter((x) => x.y > l.y).sort((a, b) => a.y - b.y)[0];
            if (above && !TITLE_RE.test(norm(above.items[0].s))) track = lineText(above);
            break;
          }
        }
      }
      const pgmX = col.filter((i) => ENTRY_HEAD.test(norm(i.s)) && i.h < 10).map((i) => i.x);
      const leftEdge = pgmX.length ? Math.min(...pgmX) : lo + 20;
      rawRaces.push(...parseColumn(lines, leftEdge, warnings));
    }
  }
  const races = rawRaces.sort((a, b) => a.number - b.number).map((r) => {
    const s = parseSummary(r.summary ?? '');
    const raceType = s.raceType === 'STAKES' && r.title ? `STAKES - ${r.title}` : s.raceType;
    if (r.entries.length === 0) warnings.push({ type: 'empty_race', race: r.number, message: `Race ${r.number}: no entries found under its header.` });
    if (!s.distance) warnings.push({ type: 'no_distance', race: r.number, message: `Race ${r.number}: the summary line "${r.summary ?? ''}" carries no distance the parser recognizes.` });
    return {
      number: r.number, postTime: r.postTime, wagerMenu: r.wagerMenu.join(' / ') || null, title: r.title,
      distance: s.distance, surface: s.surface, raceType, purseCents: s.purseCents,
      claimingPriceCents: s.claimingPriceCents, conditions: s.conditions, entries: r.entries, scratches: r.scratches,
    };
  });
  for (let k = 1; k < races.length; k++) {
    if (races[k].number !== races[k - 1].number + 1) warnings.push({ type: 'race_gap', message: `Race numbering jumps from ${races[k - 1].number} to ${races[k].number}.` });
  }
  if (!date) warnings.push({ type: 'no_date', message: 'The sheet never states its date; enter it above before saving.' });
  if (!track) warnings.push({ type: 'no_track', message: 'The sheet never names its track; enter it above before saving.' });
  if (expected.date && date && expected.date !== date) warnings.push({ type: 'wrong_date', message: `Sheet is dated ${date}, expected ${expected.date}.` });
  if (expected.track && track && track.replace(/\s+/g, '').toUpperCase() !== expected.track.replace(/\s+/g, '').toUpperCase()) {
    warnings.push({ type: 'wrong_track', message: `Sheet header reads "${track}", expected "${expected.track}".` });
  }
  return { track, date, races, warnings };
}
