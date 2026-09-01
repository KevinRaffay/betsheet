// Track-program PDF parser: an official program PDF -> structured race day,
// handicapper analysis ("Bottom Line") and the alphabetical horse index.
//
// Node-only (pdfjs-dist legacy build); the ingest UI uploads the PDF and the
// server parses. Same contract as shared/entries-parser.js: parse what can
// be parsed, report the rest in `warnings`, never throw on bad content -
// the preview UI shows both (invariant 9).
//
// How it copes with PDF text extraction:
//
// Text items arrive in content-stream order, NOT reading order - the
// program's jockey/odds column interleaves arbitrarily with the owner/silks
// column. Nothing here trusts stream order. Instead:
//
//   * A race PANEL is anchored by its "MM/DD/YYYY Race N" footer - simulcast
//     pages carry no such footer, so this cannot pick up other tracks. Each
//     PDF page is a two-page spread; the footer's x says which half the
//     panel occupies.
//   * Within a panel, the big program numbers hugging the panel's left edge
//     define horse BANDS. Every other item is assigned to the band whose
//     program number is nearest in y - the coordinate-space version of
//     "map trainer/morning-line blocks to horses by post-position sequence".
//   * Fields are then recognized inside a band by position + shape: the name
//     is the tallest text, weight is 3 digits in the weight column, the
//     morning line is the number pair on the far right, the jockey is the
//     stacked column at x~541, owner/trainer share the top line of the band.
//
// The program's alphabetical horse index ("Horses ... Name (pgm) Nth") is
// parsed independently and cross-checked against every panel: a horse the
// index places in race 6 with program 9 must have parsed there, and an
// index "Scr" marks the entry scratched. Disagreement is a warning, never a
// silent fix.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { morningLineToDecimal } from '../shared/entries-parser.js';

const FOOTER = /^(\d{2})\/(\d{2})\/(\d{4})\s+Race\s+(\d+)$/;
const ORDINALS = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8,
  NINE: 9, TEN: 10, ELEVEN: 11, TWELVE: 12,
};

const norm = (s) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const nameKey = (s) => norm(s).toUpperCase().replace(/\s*\((?:GB|IRE|FR|ARG|CHI|AUS|JPN|GER|NZ|SAF|URU|BRZ|PER|MEX|KOR|CAN)\)\s*$/, '').trim();
const moneyToCents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);

async function pageItems(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  return tc.items
    .filter((i) => i.str.trim())
    .map((i) => ({
      s: i.str,
      x: i.transform[4],
      y: i.transform[5],
      h: i.height || 0,
    }));
}

const joinedText = (items) => items.map((i) => i.s).join(' ').replace(/\s+/g, ' ');

// ---------- race panels ----------

function parsePanel(items, footer, warnings) {
  const mid = 306; // spread halves of a 612pt-wide page
  const right = footer.x >= mid;
  const panel = items.filter((i) => (right ? i.x >= mid : i.x < mid));
  const number = Number(footer.s.match(FOOTER)[4]);

  const leftEdge = Math.min(...panel.map((i) => i.x));

  // Program numbers: tall pure numbers hugging the panel's left edge.
  const pgms = panel
    .filter((i) => /^\d+A?$/.test(i.s.trim()) && i.x < leftEdge + 6 && i.h >= 10)
    .sort((a, b) => b.y - a.y);

  const race = {
    number,
    surface: null,
    distance: null,
    raceType: null,
    purseCents: null,
    postTime: null,
    conditions: null,
    claimingPriceCents: null,
    wagerMenu: null,
    entries: [],
    scratches: [],
  };

  if (pgms.length === 0) {
    warnings.push({ type: 'empty_race', race: number, message: `Race ${number}: no program numbers found on its panel.` });
    return race;
  }

  const firstPgmY = pgms[0].y;
  const bandGap = pgms.length > 1
    ? (pgms[0].y - pgms[pgms.length - 1].y) / (pgms.length - 1)
    : 44;

  // ----- header region: everything comfortably above the first band -----
  const headerItems = panel.filter((i) => i.y > firstPgmY + bandGap * 0.62);
  const headerText = norm(joinedText(headerItems.sort((a, b) => b.y - a.y || a.x - b.x)));

  const post = headerText.match(/Approx\.?\s*Post\s+([0-9:]+\s*[AP]M)/i);
  if (post) race.postTime = post[1].replace(/\s+/g, '');

  const wager = headerText.match(/(\$1 Exacta.*?)(?=\s+\d+(?:st|nd|rd|th)\b|\s+Approx)/i);
  if (wager) race.wagerMenu = wager[1].trim();

  // Conditions: the small-type block ending just above the first band; the
  // distance is its own item ("Seven Furlongs." / "One Mile.").
  const condItems = headerItems.filter((i) => i.h <= 9 && i.h >= 4);
  // Distance items are excluded from the conditions text when they are
  // PURELY distance - the x-sort otherwise interleaves a standalone
  // "Five Furlongs." into the middle of a conditions sentence ("...TWO
  // Five Furlongs. YEARS OLD..."), which broke downstream text rules. An
  // item carrying more than the distance ("One Mile. (Turf) Stretch
  // Start.") stays: its (Turf) flag is content.
  const distanceOnlyItems = new Set();
  const buildCondText = () => norm(condItems
    .filter((i) => !/^Track Record:/.test(i.s.trim()) && !distanceOnlyItems.has(i))
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((i) => i.s).join(' '));
  let condText = buildCondText();

  // Distance: typographically it is the trailing sentence of the conditions
  // paragraph. Usually one item ("Seven Furlongs." / "One Mile."), but a
  // line wrap can SPLIT it - the number word ends one line far right and
  // "Furlongs." opens the next at the left edge - and the two fragments
  // interleave with conditions text in x-sorted order. So: whole item
  // first, then reunite a bare unit item with the short word item just
  // above-right of it.
  // A whole-item distance may carry a suffix ("One Mile. (Turf) Stretch
  // Start.") - capture the distance prefix, don't demand a clean item.
  const distPrefix = /^((?:About\s+)?[A-Za-z][\w/ -]{1,32}?\s(?:Furlongs?|Miles?)(?:\s[Aa]nd\s[\w/ -]{1,25}?(?:Furlongs?|Yards?))?)\.?(?:\s|$)/;
  let wholeDistItem = null;
  let wholeDistMatch = null;
  for (const i of headerItems) {
    const m = i.s.trim().match(distPrefix);
    if (m) { wholeDistItem = i; wholeDistMatch = m; break; }
  }
  if (wholeDistMatch) {
    race.distance = norm(wholeDistMatch[1]);
    // Purely-distance item (nothing but the matched text + period)?
    if (norm(wholeDistItem.s).replace(/\.$/, '') === race.distance) {
      distanceOnlyItems.add(wholeDistItem);
    }
  } else {
    const unit = headerItems.find((i) => /^(?:Furlongs?|Miles?)\.?$/.test(i.s.trim()));
    if (unit) {
      const partner = headerItems
        .filter((i) => i.y > unit.y && i.y < unit.y + 14 && i.x > unit.x &&
          /^(?:About\s+)?[A-Z][A-Za-z]+(?:\s[\w/ -]{1,20})?$/.test(i.s.trim()) && i.s.trim().length <= 24)
        .sort((a, b) => a.y - b.y)[0];
      if (partner) {
        race.distance = norm(`${partner.s} ${unit.s}`).replace(/\.$/, '');
        distanceOnlyItems.add(partner).add(unit);
      }
    }
  }
  if (distanceOnlyItems.size) condText = buildCondText();

  // The conditions body starts at the race-type sentence (ALL CAPS + PURSE),
  // or at "STAKES." for a stakes race whose purse is "$N Guaranteed".
  const typeStart = condText.search(/[A-Z][A-Z .,'/&$0-9-]*?PURSE \$|\bSTAKES\.\s/);
  const conditions = typeStart >= 0 ? condText.slice(typeStart) : condText;
  race.conditions = conditions || null;

  const typeMatch = conditions.match(/^(.*?)\.?\s*PURSE \$([\d,]+)/);
  if (typeMatch) {
    race.raceType = typeMatch[1].replace(/[\s$,\d.-]+$/, '').trim();
    race.purseCents = moneyToCents(typeMatch[2]);
  } else if (/^STAKES\./.test(conditions)) {
    // Stakes pages carry a title line ("Torrey Pines Stakes (Grade III)")
    // and a "$150,000 Guaranteed" purse line in the header.
    const title = headerItems.find((i) => /Stakes/i.test(i.s) && !/Bet Slips|Pick|Parlay/i.test(i.s));
    race.raceType = title ? `STAKES - ${norm(title.s)}` : 'STAKES';
    const guaranteed = headerText.match(/\$([\d,]+)\s+Guaranteed/i);
    if (guaranteed) race.purseCents = moneyToCents(guaranteed[1]);
  }
  const claim = conditions.match(/CLAIMING PRICE \$([\d,]+)|Claiming Price \$([\d,]+)|CLAIMING \$([\d,]+)/i);
  if (claim) race.claimingPriceCents = moneyToCents(claim[1] ?? claim[2] ?? claim[3]);

  race.surface = /\(Turf\)/i.test(condText) || /Turf/i.test(race.distance ?? '') ? 'TURF' : 'DIRT';

  // ----- footnotes region: below the last band -----
  const lastPgmY = pgms[pgms.length - 1].y;
  const footItems = panel.filter((i) => i.y < lastPgmY - bandGap * 0.8);
  const footText = norm(joinedText(footItems.sort((a, b) => b.y - a.y || a.x - b.x)));

  // "Equipment Change: Hothead will race with Blinkers Off". The change is
  // anchored to the known equipment vocabulary so trailing footnote text
  // (dates, gelding notes) can never be swallowed into it.
  const equipmentChanges = [];
  for (const m of footText.matchAll(/([A-Z][A-Za-z'. ()-]*?)\s+will race with\s+((?:Blinkers|Visor|Hood|Cheek\s?Pieces|Tongue\s?Tie)(?:\s+(?:On|Off))?)/g)) {
    const name = norm(m[1]).split(/[:.]/).pop().trim();
    if (name) equipmentChanges.push({ horseName: name, change: norm(m[2]) });
  }

  // Also-eligible boundary: an "ALSO ELIGIBLES" separator inside the list
  // (horses below it may run on a late scratch), or a name-based footnote.
  const aeSeparator = panel.find((i) => /^ALSO ELIGIBLES?\b/i.test(i.s.trim()));
  const aeNames = [];
  const aeSources = [footText, aeSeparator ? norm(aeSeparator.s) : ''];
  for (const src of aeSources) {
    for (const m of src.matchAll(/ALSO ELIGIBLES?\s*-\s*(.+?)\s+may run/gi)) {
      for (const name of m[1].split(/,\s*/)) aeNames.push(nameKey(name));
    }
  }

  // "#7 Fun to Run: Entered not to be claimed per HISA rule 2262."
  const notToBeClaimed = [];
  for (const m of footText.matchAll(/#(\d+A?)\s+[^:]+:\s*Entered not to be claimed/gi)) {
    notToBeClaimed.push(m[1]);
  }

  // ----- horse bands -----
  const bandItems = panel.filter((i) =>
    i.y <= firstPgmY + bandGap * 0.62 && i.y >= lastPgmY - bandGap * 0.8 && !pgms.includes(i));

  const bands = pgms.map((p) => ({ pgm: p, items: [] }));
  for (const it of bandItems) {
    let best = null;
    let bestDist = Infinity;
    for (const b of bands) {
      const d = Math.abs(it.y - b.pgm.y);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    if (best && bestDist <= bandGap * 0.75) best.items.push(it);
  }

  for (const band of bands) {
    const p = band.pgm;
    const nameH = p.h * 0.6;
    const entry = {
      programNumber: p.s.trim(),
      postPosition: null, // program pages list in post order; filled below
      horseName: null,
      breeding: null,
      owner: null,
      silks: null,
      color: null,
      jockey: null,
      trainer: null,
      equipment: null,
      equipmentChange: null,
      weight: null,
      morningLine: null,
      morningLineDecimal: null,
      scratched: false,
      alsoEligible: aeSeparator ? p.y < aeSeparator.y : false,
      notToBeClaimed: false,
      scratchReason: null,
      programRank: null,
      bestBet: false,
    };

    const inBand = band.items;
    const rel = (i) => i.x - leftEdge; // panel-relative x

    // A "SCRATCHED" overlay replaces the jockey/odds block for a horse
    // scratched before the program printed.
    if (inBand.some((i) => /^SCRATCHED$/i.test(i.s.trim()))) {
      entry.scratched = true;
      entry.scratchReason = 'scratched in program';
    }

    // Some layouts label each band with an explicit post position (P.P.N).
    const pp = inBand.find((i) => /^P\.P\.\s*(\d+)$/.test(i.s.trim()));
    if (pp) entry.postPosition = Number(pp.s.trim().match(/(\d+)$/)[1]);

    // Name: tallest multi-char text in the name column.
    const nameItem = inBand
      .filter((i) => rel(i) >= 20 && rel(i) <= 160 && i.h >= nameH && norm(i.s).length > 1 && !/^\d/.test(i.s.trim()))
      .sort((a, b) => b.h - a.h || b.y - a.y)[0];
    if (nameItem) entry.horseName = norm(nameItem.s);

    // Weight: three digits in the weight column.
    const w = inBand.find((i) => /^\d{3}$/.test(i.s.trim()) && rel(i) >= 160 && rel(i) <= 205);
    if (w) entry.weight = Number(w.s.trim());

    // Lasix / medication letter just left of the weight.
    const med = inBand.find((i) => /^[LlVv]$/.test(i.s.trim()) && rel(i) >= 160 && rel(i) < 195 && i.h >= 6);
    if (med) entry.equipment = med.s.trim().toUpperCase();

    // Morning line: far-right number or fraction.
    const ml = inBand.find((i) => /^\d+(\/\d+)?$/.test(i.s.trim()) && rel(i) >= 225);
    if (ml) {
      entry.morningLine = ml.s.trim().includes('/') ? ml.s.trim() : `${ml.s.trim()}/1`;
      entry.morningLineDecimal = morningLineToDecimal(entry.morningLine);
    }

    // Owner + trainer share the band's top text line: owner at the name
    // column, trainer right-aligned past it. Identified BEFORE the jockey so
    // the jockey column can exclude anything on the owner/trainer line -
    // their x ranges overlap in some layouts.
    const smallLines = inBand
      .filter((i) => i.h <= (nameItem?.h ?? p.h * 0.7) - 1 || (i.h < p.h * 0.55));
    const ownerItem = smallLines
      .filter((i) => rel(i) >= 20 && rel(i) <= 60 && !/^Bred in/i.test(i.s) && !/^\d+y\.o\./i.test(i.s))
      .sort((a, b) => b.y - a.y)[0];
    if (ownerItem) entry.owner = norm(ownerItem.s);
    const trainerItems = smallLines
      .filter((i) => rel(i) > 140 && rel(i) <= 245 && Math.abs(i.y - (ownerItem?.y ?? -1e9)) < 2.5 &&
        !/^\d+(\/\d+)?$/.test(i.s.trim()));
    if (trainerItems.length) entry.trainer = norm(trainerItems.map((i) => i.s).join(' '));

    // Jockey: the stacked two-line column between weight and morning line.
    const jockeyParts = inBand
      .filter((i) => rel(i) >= 195 && rel(i) <= 245 && /[A-Za-z]/.test(i.s) &&
        !trainerItems.includes(i) && !/^P\.P\./.test(i.s.trim()) &&
        !/^SCRATCHED$/i.test(i.s.trim()) && !/^\d+(\/\d+)?$/.test(i.s.trim()))
      .sort((a, b) => b.y - a.y);
    if (jockeyParts.length) entry.jockey = norm(jockeyParts.map((i) => i.s).join(' '));

    // Saddle-cloth color: small word under the program number at the edge.
    const color = inBand.find((i) => rel(i) < 8 && /^[A-Za-z &-]+$/.test(i.s.trim()) && i.h <= p.h && !/^P\.P\./.test(i.s.trim()));
    if (color) entry.color = norm(color.s);

    // Breeding + silks from the name column's remaining small lines.
    const breeding = inBand.find((i) => /^\d+y\.o\./i.test(i.s.trim()));
    if (breeding) entry.breeding = norm(breeding.s);
    const silks = smallLines
      .filter((i) => rel(i) >= 20 && rel(i) <= 60 && i !== ownerItem && i !== breeding &&
        !/^Bred in/i.test(i.s) && i.y > (nameItem?.y ?? -1e9))
      .sort((a, b) => b.y - a.y);
    if (silks.length) entry.silks = norm(silks.map((i) => i.s).join(' '));

    if (aeNames.includes(nameKey(entry.horseName ?? ''))) entry.alsoEligible = true;
    if (notToBeClaimed.includes(entry.programNumber)) entry.notToBeClaimed = true;
    const ec = equipmentChanges.find((c) => nameKey(c.horseName) === nameKey(entry.horseName ?? ' '));
    if (ec) entry.equipmentChange = ec.change;

    // A scratched horse's jockey/odds block is the SCRATCHED overlay, so
    // missing fields there are expected, not a parse problem.
    if (!entry.scratched && (!entry.horseName || !entry.jockey || !entry.morningLine)) {
      warnings.push({
        type: 'incomplete_entry',
        race: number,
        message: `Race ${number}, program ${entry.programNumber}: missing ${['horseName', 'jockey', 'morningLine'].filter((k) => !entry[k]).join(', ')}.`,
      });
    }
    race.entries.push(entry);
  }

  // Program pages list horses in post-position order; an explicit P.P.N
  // label (some layouts carry one) wins over the ordinal.
  race.entries.forEach((e, i) => { if (e.postPosition === null) e.postPosition = i + 1; });

  return race;
}

// ---------- handicapper analysis ("Bottom Line") ----------

function parseAnalysis(pagesText, warnings) {
  const text = norm(pagesText.join(' '));
  const bestBetM = text.match(/BEST BETS?:\s*RACE\s+(\d+),?\s+([A-Z][A-Z'’. ]+?)(?=\s+(?:[A-Z][a-z]|Del Mar Bottom Line|RACE\b))/);
  const bestBet = bestBetM
    ? { race: Number(bestBetM[1]), horseName: norm(bestBetM[2]) }
    : null;
  if (!bestBetM) warnings.push({ type: 'no_best_bet', message: 'No "BEST BET: RACE N, HORSE" line found in the analysis.' });

  const chunks = [];
  const re = /RACE\s+(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE)\b/g;
  const marks = [...text.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const raceNumber = ORDINALS[marks[i][1]];
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body.length < 80) continue; // a stray mention, not a paragraph
    chunks.push({ race: raceNumber, text: body });
  }
  chunks.sort((a, b) => a.race - b.race);
  return { bestBet, chunks };
}

// Picks = the ALL-CAPS horse names in a race's paragraph, ranked by first
// mention; only names that exist among the race's parsed entries count, so
// caps words like TOP CHOICE or N1X can never become a pick.
function extractPicks(chunkText, entryNames) {
  const t = norm(chunkText).toUpperCase();
  const found = [];
  for (const name of entryNames) {
    const idx = t.indexOf(nameKey(name));
    if (idx >= 0) found.push({ name, idx });
  }
  found.sort((a, b) => a.idx - b.idx);
  return found.map((f) => f.name);
}

// ---------- alphabetical horse index ----------

function parseIndex(text) {
  const start = text.search(/\bHorses\b/);
  if (start < 0) return [];
  let body = text.slice(start + 6);
  const stop = body.search(/\bJockeys\b/);
  if (stop >= 0) body = body.slice(0, stop);

  // Anchors are "(pgm) Nth" or "Scr Nth"; the name is whatever sits between
  // the previous anchor and this one.
  const rows = [];
  const anchor = /(?:\((\d+A?)\)|\bScr\b)\s+(\d+)(?:st|nd|rd|th)\b/g;
  let last = 0;
  for (const m of body.matchAll(anchor)) {
    const name = norm(body.slice(last, m.index));
    last = m.index + m[0].length;
    if (!name) continue;
    rows.push({
      horseName: name,
      programNumber: m[1] ?? null,
      race: Number(m[2]),
      scratched: m[1] === undefined,
    });
  }
  return rows;
}

// ---------- top level ----------

/**
 * Parse an official track program PDF.
 * `source`: file path or Uint8Array. Optional `expected`: { track, date }
 * for verification warnings (never a hard failure).
 */
export async function parseProgramPdf(source, expected = {}) {
  const warnings = [];
  const doc = await getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    useSystemFonts: true,
  }).promise;

  const races = [];
  const analysisPages = [];
  let indexText = null;
  let date = null;
  let trackText = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const items = await pageItems(doc, p);
    const footers = items.filter((i) => FOOTER.test(i.s.trim()));
    for (const footer of footers) {
      const m = footer.s.trim().match(FOOTER);
      const d = `${m[3]}-${m[1]}-${m[2]}`;
      if (date && d !== date) {
        warnings.push({ type: 'date_mismatch', message: `Race ${m[4]}'s footer says ${d}; earlier panels said ${date}.` });
      }
      date = date ?? d;
      races.push(parsePanel(items, { ...footer, s: footer.s.trim() }, warnings));

      // The spelled-out track letters in the panel header (D E L M A R).
      if (!trackText) {
        const letters = items
          .filter((i) => i.s.trim().length === 1 && /[A-Z]/.test(i.s.trim()) && i.y > footer.y + 380)
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const topRow = letters.filter((i) => Math.abs(i.y - letters[0]?.y) < 2);
        const word = topRow.map((i) => i.s.trim()).join('');
        if (word.length >= 4) trackText = word;
      }
    }

    const joined = joinedText(items);
    if (/Bottom Line|RACE (ONE|TWO|THREE)\b/.test(joined) && /RACE\s+(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)\b/.test(joined)) {
      analysisPages.push(joined);
    }
    if (!indexText && /\bHorses\b/.test(joined) && /\bScr\b\s+\d+(?:st|nd|rd|th)|\(\d+A?\)\s+\d+(?:st|nd|rd|th)/.test(joined)) {
      indexText = joined;
    }
  }

  races.sort((a, b) => a.number - b.number);

  // Duplicate race numbers would mean a simulcast panel slipped through.
  const seen = new Set();
  for (const r of races) {
    if (seen.has(r.number)) warnings.push({ type: 'duplicate_race', race: r.number, message: `Race ${r.number} parsed from more than one panel.` });
    seen.add(r.number);
  }

  // ----- analysis -> programRank + bestBet -----
  const analysis = [];
  if (analysisPages.length) {
    const { bestBet, chunks } = parseAnalysis(analysisPages, warnings);
    for (const chunk of chunks) {
      const race = races.find((r) => r.number === chunk.race);
      if (!race) continue;
      const picks = extractPicks(chunk.text, race.entries.map((e) => e.horseName).filter(Boolean));
      picks.forEach((name, i) => {
        const e = race.entries.find((x) => x.horseName === name);
        if (e) e.programRank = i + 1;
      });
      analysis.push({ race: chunk.race, picks, text: chunk.text });
    }
    if (bestBet) {
      const race = races.find((r) => r.number === bestBet.race);
      const e = race?.entries.find((x) => nameKey(x.horseName ?? '') === nameKey(bestBet.horseName));
      if (e) e.bestBet = true;
      else warnings.push({ type: 'best_bet_unmatched', message: `Best Bet "${bestBet.horseName}" (race ${bestBet.race}) matched no parsed entry.` });
    }
  } else {
    warnings.push({ type: 'no_analysis', message: 'No handicapper-analysis pages found.' });
  }

  // ----- index cross-validation -----
  // Matched BY NAME, with one real-world wrinkle handled explicitly: when a
  // horse is scratched before printing, this program's race page keeps the
  // original numbering (with a SCRATCHED overlay) while the index lists the
  // POST-SCRATCH renumbering - every horse below the scratch shifts down by
  // one. That systematic disagreement is reported once per race as
  // 'index_renumbered', not as a pile of per-horse mismatches; anything
  // that does not fit the pattern is a real mismatch.
  const index = indexText ? parseIndex(indexText) : [];
  if (!index.length) warnings.push({ type: 'no_index', message: 'No alphabetical horse index found; entries are unvalidated.' });

  for (const row of index.filter((r) => r.scratched)) {
    const race = races.find((r) => r.number === row.race);
    if (!race) continue;
    const e = race.entries.find((x) => nameKey(x.horseName ?? '') === nameKey(row.horseName));
    if (e) {
      e.scratched = true;
      e.scratchReason = e.scratchReason ?? 'scratched in program index';
    }
    if (!race.scratches.some((s) => nameKey(s.horseName) === nameKey(row.horseName))) {
      race.scratches.push({ horseName: row.horseName, reason: 'program index' });
    }
  }

  const byRace = new Map();
  for (const row of index.filter((r) => !r.scratched)) {
    if (!byRace.has(row.race)) byRace.set(row.race, []);
    byRace.get(row.race).push(row);
  }
  for (const [raceNo, rows] of byRace) {
    const race = races.find((r) => r.number === raceNo);
    if (!race) {
      warnings.push({ type: 'index_mismatch', race: raceNo, message: `Index lists ${rows.length} horses in race ${raceNo}, but that race did not parse.` });
      continue;
    }
    const disagreements = [];
    let renumberedFits = true;
    for (const row of rows) {
      const e = race.entries.find((x) => nameKey(x.horseName ?? '') === nameKey(row.horseName));
      if (!e) {
        warnings.push({ type: 'index_mismatch', race: raceNo, message: `Index: "${row.horseName}" (race ${raceNo}, program ${row.programNumber}) has no parsed entry.` });
        renumberedFits = false;
        continue;
      }
      if (e.programNumber === row.programNumber) continue;
      const scratchedAbove = race.entries.filter(
        (x) => x.scratched && Number(x.programNumber) < Number(e.programNumber),
      ).length;
      const fits = Number(e.programNumber) - scratchedAbove === Number(row.programNumber);
      if (!fits) renumberedFits = false;
      disagreements.push({ row, parsed: e.programNumber });
    }
    if (disagreements.length && renumberedFits) {
      warnings.push({
        type: 'index_renumbered',
        race: raceNo,
        message: `Race ${raceNo}: the index numbers its field after the printed scratch (e.g. "${disagreements[0].row.horseName}" is ${disagreements[0].row.programNumber} in the index, ${disagreements[0].parsed} on the page). Page numbering kept; confirm at the window.`,
      });
    } else {
      for (const d of disagreements) {
        warnings.push({ type: 'index_mismatch', race: raceNo, message: `Index: race ${raceNo} "${d.row.horseName}" is program ${d.row.programNumber} in the index but ${d.parsed} on the page.` });
      }
    }
  }

  // ----- expected track/date verification -----
  if (expected.date && date && expected.date !== date) {
    warnings.push({ type: 'wrong_date', message: `Program is dated ${date}, expected ${expected.date}.` });
  }
  if (expected.track && trackText &&
      trackText.replace(/\s+/g, '').toUpperCase() !== expected.track.replace(/\s+/g, '').toUpperCase()) {
    warnings.push({ type: 'wrong_track', message: `Program header reads "${trackText}", expected "${expected.track}".` });
  }

  return { track: trackText, date, races, analysis, index, warnings };
}
