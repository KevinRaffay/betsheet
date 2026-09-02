// dmtc.com results-page parser (D42): the track's own results HTML -> the
// D12 result structure, the second results source of record beside the
// Equibase chart. Browser + Node, pure, never throws on bad content - it
// parses what it can and reports the rest in `warnings` (invariant 9).
//
// Page shape (verified on 2026-08-28/29/30): one block per race
// (`<div title="Race N Results">`) carrying a header line
// "SURFACE, DISTANCE / CLASS / PURSE: $N / POST TIME: H:MMPM" (a stakes
// name precedes it), a WPS table for the top three (pgm, runner, jockey,
// trainer, win/place/show), "ORDER OF FINISH", "ALSO RAN" (finish order
// 4th onward - verified against the Equibase charts, names only),
// "SCRATCHED" (names only), one "PAYOFFS" line with every exotic
// ("$base Name [(N OF M)] paid $amount (combo)"; multi-winner legs "1/8",
// Place Pick All "8 OF 8", "TURFPICK3(4-8-3)", "3/4 OF 9" for the 3X3)
// with a "CARRYOVERS:" tail, then "Conditions <track>, Finish Time <t>".
// The page links to Equibase's chart embed; only the date is read off
// that link's text - it is NEVER fetched (invariant 6).

const TRACK_NAMES = { DMR: 'Del Mar' };
const NUM_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const FRACTIONS = { '1/2': 'One Half', '1/4': 'One Quarter', '3/4': 'Three Quarters', '1/8': 'One Eighth', '3/8': 'Three Eighths', '5/8': 'Five Eighths', '7/8': 'Seven Eighths', '1/16': 'One Sixteenth', '3/16': 'Three Sixteenths', '70': 'Seventy Yards' };
const BET_TYPES = {
  'exacta': 'exacta', 'quinella': 'quinella', 'trifecta': 'trifecta', 'superfecta': 'superfecta',
  'daily double': 'daily_double', 'pick 3': 'pick3', 'pick 4': 'pick4', 'pick 5': 'pick5', 'pick 6': 'pick6',
  'super high five': 'super_high_five', 'place pick all': 'place_pick_all', 'turf pick 3': 'turfpick3', '3x3': '3x3',
};

export const stripHtml = (html) => String(html ?? '')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#039;|&#8217;|&rsquo;/g, "'")
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const moneyToCents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);

/** "7 FURLONGS" -> "Seven Furlongs", "1 1/16 MILES" -> "One Mile And One Sixteenth", "5 1/2 FURLONGS" -> "Five And One Half Furlongs". */
export function distanceWords(text) {
  const m = String(text ?? '').trim().match(/^(?:ABOUT\s+)?(\d+)?\s*(\d+\/\d+)?\s*(FURLONGS?|MILES?|YARDS?)$/i);
  if (!m) return null;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] ? FRACTIONS[m[2]] : null;
  const unit = m[3].toUpperCase();
  if (unit.startsWith('FURLONG')) {
    const words = [whole ? NUM_WORDS[whole] : null, frac ? (whole ? `And ${frac}` : frac) : null].filter(Boolean).join(' ');
    return words ? `${words} Furlongs` : null;
  }
  if (unit.startsWith('YARD')) return whole ? `${whole} Yards` : null;
  const miles = whole === 1 ? 'One Mile' : whole > 1 ? `${NUM_WORDS[whole]} Miles` : null;
  return miles ? (frac ? `${miles} And ${frac}` : miles) : null;
}

/** The header line: "[Stakes name] SURFACE, DISTANCE / CLASS / PURSE: $N / POST TIME: T". */
export function parseHeader(text) {
  const out = { surface: null, distance: null, raceType: null, purseCents: null, postTime: null, stakesName: null };
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\b(DIRT|TURF|ALL WEATHER|SYNTHETIC),\s*(.+?)\s+\/\s+(.+?)\s+\/\s+PURSE:\s*\$([\d,]+)\s*(?:\/\s*POST TIME:\s*([0-9:]+\s*[AP]M))?/i);
  if (!m) return out;
  out.stakesName = m[1].trim() || null;
  out.surface = m[2].toUpperCase() === 'DIRT' ? 'DIRT' : m[2].toUpperCase() === 'TURF' ? 'TURF' : m[2].toUpperCase();
  out.distance = distanceWords(m[3]);
  const cls = m[4].trim().toUpperCase();
  out.raceType = cls === 'STAKES' && out.stakesName ? `STAKES - ${out.stakesName}` : cls;
  out.purseCents = moneyToCents(m[5]);
  out.postTime = m[6] ? m[6].replace(/\s+/g, '') : null;
  return out;
}

/** The PAYOFFS line -> [{ betType, baseCents, combination, payoutCents, correct?, of? }] + carryovers. */
export function parsePayoffs(text, warnings, raceNumber) {
  const exotics = []; const carryovers = [];
  let body = String(text ?? '').replace(/\s+/g, ' ').trim();
  const carry = body.match(/CARRYOVERS?:\s*(.*)$/i);
  if (carry) {
    body = body.slice(0, carry.index).trim();
    // "Pick-6 - $46,407.67, 3X3 - $1,790.23": pool names may start with a digit
    // and amounts carry thousands commas, so match pairs instead of splitting.
    for (const cm of carry[1].matchAll(/([A-Za-z0-9][A-Za-z0-9 .-]*?)\s*-\s*\$([\d,]+(?:\.[\d]{2})?)/g)) {
      carryovers.push({ pool: cm[1].trim(), amountCents: moneyToCents(cm[2]) });
    }
  }
  const re = /\$([\d.]+)\s+([A-Za-z0-9 ]+?)\s*(?:\((\d+)\s+OF\s+(\d+)\))?\s+paid\s+\$([\d,.]+)\s+\(([^()]*(?:\([^()]*\))?[^()]*)\)/g;
  let matched = 0;
  for (const m of body.matchAll(re)) {
    matched++;
    const name = m[2].trim().toLowerCase();
    const betType = BET_TYPES[name] ?? name.replace(/[^a-z0-9]+/g, '_');
    if (!BET_TYPES[name]) warnings.push({ type: 'unrecognized_mutuel', race: raceNumber, message: `Race ${raceNumber}: unrecognized wager "${m[2].trim()}" - stored as ${betType}, never graded.` });
    let combination = m[6].trim();
    const wrapped = combination.match(/^[A-Z0-9]+\((.*)\)$/);
    if (wrapped) combination = wrapped[1];
    const row = { betType, baseCents: moneyToCents(m[1]), combination, payoutCents: moneyToCents(m[5]) };
    if (m[3]) { row.correct = Number(m[3]); row.of = Number(m[4]); }
    exotics.push(row);
  }
  if (body && matched === 0) warnings.push({ type: 'no_payoffs_parsed', race: raceNumber, message: `Race ${raceNumber}: payoff line not understood: "${body.slice(0, 120)}"` });
  return { exotics, carryovers };
}

const nameKey = (s) => String(s ?? '').toUpperCase().replace(/\s*\((GB|IRE|FR|ARG|CHI|AUS|JPN|GER|NZ|SAF|URU|BRZ|PER|MEX|KOR|CAN)\)\s*$/, '').replace(/[^A-Z0-9]/g, '');

/** One race block -> the D12 race. */
export function parseRaceBlock(number, html, warnings) {
  const race = { number, raceType: null, distance: null, surface: null, purseCents: null, postTime: null, finalTime: null, trackCondition: null,
    results: [], exotics: [], scratches: [], carryovers: [], claimed: [] };
  const header = html.match(/<div class="bold text-muted-dark">([\s\S]*?)<\/div>/);
  // A stakes race names itself in a sibling element just above the header.
  const stakes = html.match(/<div class="bigger text-success bold">([^<]*)<[/]div>/);
  const headerText = header ? `${stakes ? stripHtml(stakes[1]) + ' ' : ''}${stripHtml(header[1])}` : '';
  if (header) Object.assign(race, (({ surface, distance, raceType, purseCents, postTime }) => ({ surface, distance, raceType, purseCents, postTime }))(parseHeader(headerText)));
  if (!race.distance) warnings.push({ type: 'no_distance', race: number, message: `Race ${number}: header carries no distance the parser recognizes: "${header ? stripHtml(header[1]).slice(0, 80) : ''}"` });
  // The WPS table: top three with prices.
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  let pos = 0;
  for (const row of (tbody ? tbody[1] : '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripHtml(c[1]));
    if (cells.length < 7) continue;
    pos++;
    const money = (s) => (s && /^\$[\d,.]+$/.test(s) ? moneyToCents(s) : null);
    race.results.push({ programNumber: cells[0].trim().split(/\s+/)[0], horseName: cells[1], jockey: cells[2] || null, trainer: cells[3] || null,
      finishPosition: pos, winCents: money(cells[4]), placeCents: money(cells[5]), showCents: money(cells[6]) });
  }
  if (race.results.length === 0) warnings.push({ type: 'no_finishers', race: number, message: `Race ${number}: no finishers table found.` });
  else if (race.results[0].winCents == null) warnings.push({ type: 'no_win_payout', race: number, message: `Race ${number}: the winner shows no win price.` });
  const text = stripHtml(html);
  const also = text.match(/ALSO RAN:\s*(.*?)(?=\s*(?:SCRATCHED:|PAYOFFS:|Conditions\b)|$)/);
  if (also) {
    for (const name of also[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      pos++;
      race.results.push({ programNumber: null, horseName: name, jockey: null, trainer: null, finishPosition: pos, winCents: null, placeCents: null, showCents: null });
    }
  }
  const scr = text.match(/SCRATCHED:\s*(.*?)(?=\s*(?:PAYOFFS:|ALSO RAN:|Conditions\b)|$)/);
  if (scr) race.scratches = scr[1].split(',').map((s) => s.trim()).filter(Boolean).map((horseName) => ({ horseName, reason: null }));
  const pay = text.match(/PAYOFFS:\s*(.*?)(?=\s*Conditions\b|$)/);
  if (pay) { const { exotics, carryovers } = parsePayoffs(pay[1], warnings, number); race.exotics = exotics; race.carryovers = carryovers; }
  else warnings.push({ type: 'no_payoffs', race: number, message: `Race ${number}: no PAYOFFS line.` });
  const cond = text.match(/Conditions\s+([A-Za-z ]+?),\s*Finish Time\s+([\d:.]+)/);
  if (cond) { race.trackCondition = cond[1].trim(); race.finalTime = cond[2]; }
  // Cross-check: the ORDER OF FINISH line names the same top three.
  const oof = text.match(/ORDER OF FINISH:\s*(.*?)(?=\s*(?:ALSO RAN:|SCRATCHED:|PAYOFFS:)|$)/);
  if (oof) {
    const listed = [...oof[1].matchAll(/#(\S+)\s*-\s*([^,]+)/g)].map((m) => m[1]);
    const table = race.results.slice(0, 3).map((r) => r.programNumber);
    if (listed.length && listed.join(',') !== table.join(',')) warnings.push({ type: 'finish_order_conflict', race: number, message: `Race ${number}: ORDER OF FINISH (${listed.join(',')}) disagrees with the WPS table (${table.join(',')}).` });
  }
  return race;
}

/** The whole page. `expected`: optional { races } from the calendar. */
export function parseDmtcResults(html, expected = {}) {
  const warnings = [];
  const src = String(html ?? '');
  let track = null; let date = null;
  const link = src.match(/chartEmb\.cfm\?track=([A-Z]+)&(?:amp;)?raceDate=(\d{2})\/(\d{2})\/(\d{4})/);
  if (link) { track = TRACK_NAMES[link[1]] ?? link[1]; date = `${link[4]}-${link[2]}-${link[3]}`; }
  else warnings.push({ type: 'no_date', message: 'The page never states its race date.' });
  const races = [];
  for (const m of src.matchAll(/<div title="Race (\d+) Results">([\s\S]*?)(?=<div title="Race \d+ Results">|<footer|<\/body>|$)/g)) {
    races.push(parseRaceBlock(Number(m[1]), m[2], warnings));
  }
  races.sort((a, b) => a.number - b.number);
  if (races.length === 0) warnings.push({ type: 'no_races', message: 'No race blocks found on the page.' });
  for (let k = 1; k < races.length; k++) {
    if (races[k].number !== races[k - 1].number + 1) warnings.push({ type: 'race_gap', message: `Race numbering jumps from ${races[k - 1].number} to ${races[k].number}.` });
  }
  if (expected.races != null && races.length !== expected.races) {
    warnings.push({ type: 'race_count_mismatch', message: `The calendar lists ${expected.races} races but the page has ${races.length}.` });
  }
  return { track, date, races, warnings };
}

export { nameKey as dmtcNameKey };
