// Equibase "Off to the Races" PDF parser (D71), PURE (browser + Node):
// takes the `pdftotext -tsv` output for the whole-day sheet and returns,
// per race, the four printed tickets (show / exacta box-of-4 on the
// SOME-REWARD tier; win / exacta box-of-3 on the HIGHER-REWARD tier) as
// program numbers - never interpreted, never re-sized, exactly as printed.
//
// Extraction method verified against the real 2026-09-03 Del Mar file
// before this parser was written (all 8 races matched hand-computed
// values exactly): `pdftotext -layout` interleaves the two tiers (they
// print side by side and exacta-box lines wrap) and plain `pdftotext`
// scrambles reading order across race blocks, so neither is usable. TSV
// word coordinates are grouped into lines by (page, round(top)), sorted
// top to bottom then left to right, and each line is split into the two
// tiers by word x-coordinate: the right tier's "$2" tokens sit at x=365,
// the left tier's content never exceeds ~345, so 360 is a safely-verified
// boundary (OTR_COLUMN_BOUNDARY below).
//
// A `Race N:` header line also carries a centered trivia sentence ("#1
// Visually is considered..." / "#7 Separator is the youngest...") that is
// NOT a pick - the header line is read only for its race number, the rest
// discarded. "Reward Opportunity" (tier column headers) and "Copyright"
// (page footer) lines are dropped before they can pollute a tier's text.
// The real file's masthead prints track and date on two SEPARATE lines
// ("Del Mar" / "Thursday, September 3, 2026" at different y), not one
// combined line - `parsedTrack`/`parsedDate` are read independently from
// the first few lines of page 1, whichever text matches each pattern.
//
// Never throws: a malformed race block warns and is skipped; the rest of
// the day still parses. Structural invariants (box3 == box4[:3], box4[0]
// == show, box4[1] == win, every program number exists in that race's
// entries) are non-blocking `otr_structure_warning`s EXCEPT an unknown
// program number, which is blocking for that one ticket only (same
// severity contract as shared/parsers/human-picks.js - blocking decides
// which ticket gets built, not the whole race or day).

export const OTR_COLUMN_BOUNDARY = 360;

const TSV_MARKER_RE = /^###(PAGE|FLOW|BLOCK|LINE)###$/;
const RACE_HEADER_RE = /^Race (\d+):/;
const SHOW_PICK_RE = /to Show on(.*?)(?=\$|$)/;
const WIN_PICK_RE = /to Win on(.*?)(?=\$|$)/;
const BOX4_RE = /\$1 Exacta box on(.*?)(?=\$|$)/;
const BOX3_RE = /\$2 Exacta box on(.*?)(?=\$|$)/;
const TICKET_LABEL_RE = /\$\d+ Ticket/g;
const PGM_RE = /#(\d+)/g;
const NAME_AFTER_PGM_RE = /#(\d+)\s+([^,#]+?)(?=,|$| and )/g;
const DATE_RE = /([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/;

/** Parse the raw `pdftotext -tsv` output into word records, TSV markers dropped. */
function parseTsvWords(tsvText) {
  const lines = String(tsvText ?? '').split(/\r?\n/);
  if (!lines.length) return [];
  const cols = lines[0].split('\t');
  const words = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split('\t');
    const rec = {};
    cols.forEach((c, i) => { rec[c] = cells[i]; });
    if (!rec.text || TSV_MARKER_RE.test(rec.text)) continue;
    words.push({
      page: Number(rec.page_num), top: Number(rec.top), left: Number(rec.left), text: rec.text,
    });
  }
  return words;
}

/** Group words into lines by (page, round(top)); lines top to bottom, words left to right. */
function groupLines(words) {
  const byKey = new Map();
  for (const w of words) {
    const key = `${w.page}:${Math.round(w.top)}`;
    if (!byKey.has(key)) byKey.set(key, { page: w.page, top: Math.round(w.top), words: [] });
    byKey.get(key).words.push(w);
  }
  const lines = [...byKey.values()];
  lines.sort((a, b) => a.page - b.page || a.top - b.top);
  for (const l of lines) l.words.sort((a, b) => a.left - b.left);
  return lines;
}

function stripTicketLabels(s) {
  return s.replace(TICKET_LABEL_RE, ' ');
}

function extractPicks(text, re, count) {
  const m = stripTicketLabels(text).match(re);
  if (!m) return null;
  const nums = [...m[1].matchAll(PGM_RE)].map((x) => x[1]);
  return count != null && nums.length !== count ? nums : nums;
}

function extractNames(text) {
  const out = {};
  for (const m of stripTicketLabels(text).matchAll(NAME_AFTER_PGM_RE)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const nameKey = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Parse the whole-day TSV. `entriesByRace` (optional): { [raceNumber]:
 * [{program_number, horse_name}] } - when given, every program number is
 * validated to exist (unknown => blocking, that ticket only) and a
 * captured name is cross-checked against the entry (mismatch => warning,
 * the program number wins, same convention as human-picks.js).
 * Returns { parsedTrack, parsedDate, races: [{race, showPick, winPick,
 * box4, box3, names, blockedTickets}], warnings }. Never throws.
 */
export function parseEquibaseOtrTsv(tsvText, { entriesByRace = {} } = {}) {
  const warnings = [];
  const words = parseTsvWords(tsvText);
  const lines = groupLines(words);

  // Masthead: track and date live on separate lines near the top of page 1.
  let parsedTrack = null;
  let parsedDate = null;
  for (const line of lines) {
    if (line.page !== 1) break;
    const text = line.words.map((w) => w.text).join(' ');
    if (!parsedTrack && /Del Mar/i.test(text)) parsedTrack = 'Del Mar';
    if (!parsedDate) {
      const m = text.match(DATE_RE);
      if (m) {
        const iso = new Date(`${m[2]} ${m[3]}, ${m[4]}`);
        if (!Number.isNaN(iso.getTime())) {
          parsedDate = `${iso.getFullYear()}-${String(iso.getMonth() + 1).padStart(2, '0')}-${String(iso.getDate()).padStart(2, '0')}`;
        }
      }
    }
    if (parsedTrack && parsedDate) break;
  }
  if (!parsedTrack) warnings.push({ type: 'otr_no_track', blocking: false, message: 'Could not read a track from the OTR sheet header.' });
  if (!parsedDate) warnings.push({ type: 'otr_no_date', blocking: false, message: 'Could not read a date from the OTR sheet header.' });

  const races = {};
  let cur = null;
  for (const line of lines) {
    const text = line.words.map((w) => w.text).join(' ');
    const header = text.match(RACE_HEADER_RE);
    if (header) {
      cur = Number(header[1]);
      races[cur] = { left: [], right: [] };
      continue; // the rest of the header line is trivia, never a pick
    }
    if (cur == null) continue;
    if (text.includes('Reward Opportunity') || text.includes('Copyright')) continue;
    const left = line.words.filter((w) => w.left < OTR_COLUMN_BOUNDARY).map((w) => w.text).join(' ');
    const right = line.words.filter((w) => w.left >= OTR_COLUMN_BOUNDARY).map((w) => w.text).join(' ');
    if (left) races[cur].left.push(left);
    if (right) races[cur].right.push(right);
  }

  const parsedRaces = [];
  for (const raceNum of Object.keys(races).map(Number).sort((a, b) => a - b)) {
    try {
      const L = races[raceNum].left.join(' ');
      const R = races[raceNum].right.join(' ');
      const showPick = extractPicks(L, SHOW_PICK_RE);
      const box4 = extractPicks(L, BOX4_RE);
      const winPick = extractPicks(R, WIN_PICK_RE);
      const box3 = extractPicks(R, BOX3_RE);
      const names = { ...extractNames(L), ...extractNames(R) };

      if (!showPick?.length || !winPick?.length || !box4?.length || !box3?.length) {
        warnings.push({ type: 'otr_unparsed_race', blocking: false, race: raceNum, message: `Race ${raceNum}: could not read one or more tickets - race skipped.` });
        continue;
      }

      // Structural invariants: non-blocking, the race is ingested regardless.
      if (box3.length !== 3 || box4.length !== 4 || showPick.length !== 1 || winPick.length !== 1) {
        warnings.push({ type: 'otr_structure_warning', blocking: false, race: raceNum, message: `Race ${raceNum}: unexpected selection count (show ${showPick.length}, win ${winPick.length}, box4 ${box4.length}, box3 ${box3.length}).` });
      } else {
        if (JSON.stringify(box3) !== JSON.stringify(box4.slice(0, 3))) {
          warnings.push({ type: 'otr_structure_warning', blocking: false, race: raceNum, message: `Race ${raceNum}: the $2 exacta box (${box3.join(',')}) does not match the $1 box's first three (${box4.slice(0, 3).join(',')}).` });
        }
        if (box4[0] !== showPick[0]) {
          warnings.push({ type: 'otr_structure_warning', blocking: false, race: raceNum, message: `Race ${raceNum}: the box's first horse (#${box4[0]}) does not match the show pick (#${showPick[0]}).` });
        }
        if (box4[1] !== winPick[0]) {
          warnings.push({ type: 'otr_structure_warning', blocking: false, race: raceNum, message: `Race ${raceNum}: the box's second horse (#${box4[1]}) does not match the win pick (#${winPick[0]}).` });
        }
      }

      // Program-number validation against entries (unknown => blocking for
      // that ticket only); name cross-check is a warning, number wins.
      const entries = entriesByRace[raceNum] ?? [];
      const blockedTickets = new Set();
      const checkPgm = (pgm, ticket) => {
        if (!entries.length) return; // no entries supplied - nothing to validate against
        const entry = entries.find((e) => e.program_number === pgm);
        if (!entry) {
          warnings.push({ type: 'unknown_program', blocking: true, race: raceNum, message: `Race ${raceNum}: no entry with program number ${pgm} (${ticket}).` });
          blockedTickets.add(ticket);
          return;
        }
        const claimedName = names[pgm];
        if (claimedName && nameKey(claimedName) !== nameKey(entry.horse_name)) {
          warnings.push({ type: 'name_mismatch', blocking: false, race: raceNum, message: `Race ${raceNum}: #${pgm} is "${entry.horse_name}", not "${claimedName}".` });
        }
      };
      for (const pgm of showPick) checkPgm(pgm, 'show');
      for (const pgm of box4) checkPgm(pgm, 'exacta_box_4');
      for (const pgm of winPick) checkPgm(pgm, 'win');
      for (const pgm of box3) checkPgm(pgm, 'exacta_box_3');

      parsedRaces.push({ race: raceNum, showPick: showPick[0], winPick: winPick[0], box4, box3, names, blockedTickets: [...blockedTickets] });
    } catch {
      warnings.push({ type: 'otr_unparsed_race', blocking: false, race: raceNum, message: `Race ${raceNum}: malformed block - race skipped.` });
    }
  }

  return { parsedTrack, parsedDate, races: parsedRaces, warnings };
}
