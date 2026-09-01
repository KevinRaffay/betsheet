// Pasted-entries parser: track entries text (as copied from a track's daily
// entries page or an overnight sheet) -> structured race day.
//
// Runs in both the browser (ingest preview) and Node (scripts, server), so
// no Node imports here. Never throws on malformed input: it parses what it
// can and reports the rest in `warnings` - the ingest UI shows both and the
// user confirms or corrects before anything is saved (invariant 9).
//
// The reference format is the Del Mar daily entries layout (see
// tests/fixtures/entries/): a "Race N" line; a header line
// "SURFACE, DISTANCE  /  RACE TYPE  /  PURSE: $X  /  POST TIME: H:MMPM";
// the conditions paragraph; a "PGM# PP RUNNER ..." column header; then per
// horse a pgm/pp line, a name line, a breeding line ("Sire - Dam [Damsire]")
// and a tab-separated stats line (jockey, trainer, equipment, weight,
// morning line). "Also Eligibles:" and "SCRATCHED: name - reason" sections
// and the wager-menu footer are recognized per race.

const RACE_LINE = /^Race\s+(\d+)\s*$/i;
const COLUMN_HEADER = /PGM#/i;
const PGM_PP_LINE = /^(SCR|\d+A?)\t+(-|\d+)\t*\s*$/;
const BREEDING_LINE = /\s-\s.*\[.+\]/;
const ALSO_ELIGIBLE = /^Also Eligibles:?$/i;
const SCRATCHED_LINE = /^SCRATCHED:\s*(.+)$/i;
const WAGER_MENU = /^(\$|\d+c\s).*\b(Exacta|Quinella|Trifecta|Double|Pick|Parlay|Superfecta|High.?5)\b/i;
const DATE_LINE = /^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*$/;
const TRACK_LINE = /^(.+?)\s+Daily Entries\s*$/i;

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "5/2" -> 2.5, "15/1" -> 15, "8/5" -> 1.6; "-"/empty -> null. */
export function morningLineToDecimal(ml) {
  if (!ml || ml === '-') return null;
  const m = ml.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!den) return null;
  return num / den;
}

const moneyToCents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);

function parseRaceHeader(line) {
  const parts = line.split(/\s+\/\s+/).map((p) => p.trim()).filter(Boolean);
  const out = { surface: null, distance: null, raceType: null, purseCents: null, postTime: null };
  for (const part of parts) {
    const purse = part.match(/^PURSE:\s*\$?([\d,]+)/i);
    const post = part.match(/^POST TIME:\s*(.+)$/i);
    if (purse) out.purseCents = moneyToCents(purse[1]);
    else if (post) out.postTime = post[1].trim();
    else if (out.surface === null && part.includes(',')) {
      const comma = part.indexOf(',');
      out.surface = part.slice(0, comma).trim();
      out.distance = part.slice(comma + 1).trim();
    } else if (out.raceType === null) {
      out.raceType = part;
    }
  }
  return out;
}

// A stats line is tab-separated with a leading empty field:
// "\tJ. Rosario\tR. Baltas\tL\t120\t3/1". Positional split keeps an EMPTY
// equipment field (two adjacent tabs) in place. Falls back to a loose split
// for pastes that lost their tabs.
function parseStatsLine(line) {
  const tabs = line.split('\t');
  if (tabs.length >= 6) {
    const f = tabs.slice(tabs[0].trim() === '' ? 1 : 0);
    return {
      jockey: f[0]?.trim() || null,
      trainer: f[1]?.trim() || null,
      equipment: f[2]?.trim() || null,
      weight: /^\d+$/.test(f[3]?.trim()) ? Number(f[3].trim()) : null,
      morningLine: f[4]?.trim() || null,
    };
  }
  const loose = line.trim().split(/\t+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  if (loose.length < 4) return null;
  const morningLine = loose[loose.length - 1];
  const weight = loose[loose.length - 2];
  return {
    jockey: loose[0] || null,
    trainer: loose[1] || null,
    equipment: loose.slice(2, loose.length - 2).join(' ') || null,
    weight: /^\d+$/.test(weight) ? Number(weight) : null,
    morningLine: morningLine || null,
  };
}

/**
 * Parse a pasted entries block.
 * Returns { track, date, races, warnings }. Never throws on bad input.
 */
export function parseEntries(text) {
  const warnings = [];
  const lines = String(text ?? '').split(/\r?\n/);

  let track = null;
  let date = null;
  const races = [];

  // Locate race sections first; the preamble is scanned only for track/date.
  const raceStarts = [];
  lines.forEach((line, i) => {
    const m = line.trim().match(RACE_LINE);
    if (m) raceStarts.push({ index: i, number: Number(m[1]) });
  });

  const preambleEnd = raceStarts.length ? raceStarts[0].index : lines.length;
  for (let i = 0; i < preambleEnd; i++) {
    const line = lines[i].trim();
    const t = line.match(TRACK_LINE);
    if (t && !track) track = t[1].trim();
    const d = line.match(DATE_LINE);
    if (d && !date) {
      const month = MONTHS[d[1].toLowerCase()];
      if (month) {
        date = `${d[3]}-${String(month).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
      }
    }
  }
  if (!track) warnings.push({ type: 'missing_track', message: 'No track name found; set it manually.' });
  if (!date) warnings.push({ type: 'missing_date', message: 'No race date found; set it manually.' });

  for (let r = 0; r < raceStarts.length; r++) {
    const { index, number } = raceStarts[r];
    const end = r + 1 < raceStarts.length ? raceStarts[r + 1].index : lines.length;
    const block = lines.slice(index + 1, end);

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

    let stage = 'header'; // header -> conditions -> rows
    const conditionLines = [];
    let alsoEligible = false;
    let pending = null; // the entry being assembled across its 4 lines

    const finishPending = () => {
      if (!pending) return;
      if (!pending.statsSeen) {
        warnings.push({
          type: 'incomplete_entry',
          race: number,
          message: `Race ${number}: entry ${pending.entry.horseName ?? pending.entry.programNumber ?? '?'} has no jockey/trainer/odds line.`,
        });
      }
      race.entries.push(pending.entry);
      pending = null;
    };

    for (const raw of block) {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (stage === 'header') {
        Object.assign(race, parseRaceHeader(trimmed));
        stage = 'conditions';
        continue;
      }
      if (stage === 'conditions') {
        if (COLUMN_HEADER.test(trimmed)) {
          race.conditions = conditionLines.join(' ') || null;
          const claim = race.conditions?.match(/Claiming Price \$([\d,]+)/i);
          if (claim) race.claimingPriceCents = moneyToCents(claim[1]);
          stage = 'rows';
        } else {
          conditionLines.push(trimmed);
        }
        continue;
      }

      // stage === 'rows'
      const pgmPp = trimmed.match(PGM_PP_LINE);
      if (pgmPp) {
        finishPending();
        const scratched = pgmPp[1] === 'SCR';
        pending = {
          statsSeen: false,
          entry: {
            programNumber: scratched ? null : pgmPp[1],
            postPosition: pgmPp[2] === '-' ? null : Number(pgmPp[2]),
            horseName: null,
            breeding: null,
            jockey: null,
            trainer: null,
            equipment: null,
            weight: null,
            morningLine: null,
            morningLineDecimal: null,
            scratched,
            alsoEligible,
            scratchReason: null,
          },
        };
        continue;
      }
      if (ALSO_ELIGIBLE.test(trimmed)) {
        finishPending();
        alsoEligible = true;
        continue;
      }
      const scr = trimmed.match(SCRATCHED_LINE);
      if (scr) {
        finishPending();
        for (const part of scr[1].split(/,(?=[^[\]]*(?:\[|$))/)) {
          const m = part.trim().match(/^(.+?)\s+-\s+(.+)$/);
          const name = (m ? m[1] : part).trim();
          const reason = m ? m[2].trim() : null;
          race.scratches.push({ horseName: name, reason });
          const entry = race.entries.find((e) => e.horseName === name)
            || (pending && pending.entry.horseName === name ? pending.entry : null);
          if (entry) {
            entry.scratched = true;
            entry.scratchReason = reason;
          }
        }
        continue;
      }
      if (WAGER_MENU.test(trimmed)) {
        finishPending();
        race.wagerMenu = race.wagerMenu ? `${race.wagerMenu} / ${trimmed}` : trimmed;
        continue;
      }
      if (pending && !pending.entry.horseName) {
        pending.entry.horseName = trimmed;
        continue;
      }
      if (pending && !pending.entry.breeding && BREEDING_LINE.test(trimmed)) {
        pending.entry.breeding = trimmed;
        continue;
      }
      if (pending && !pending.statsSeen) {
        const stats = parseStatsLine(line);
        if (stats) {
          pending.statsSeen = true;
          const e = pending.entry;
          e.jockey = stats.jockey === '-' ? null : stats.jockey;
          e.trainer = stats.trainer === '-' ? null : stats.trainer;
          e.equipment = stats.equipment || null;
          e.weight = stats.weight;
          e.morningLine = stats.morningLine === '-' ? null : stats.morningLine;
          e.morningLineDecimal = morningLineToDecimal(e.morningLine);
          continue;
        }
      }
      warnings.push({
        type: 'unrecognized_line',
        race: number,
        message: `Race ${number}: unrecognized line: "${trimmed.slice(0, 80)}"`,
      });
    }
    finishPending();

    if (race.entries.length === 0) {
      warnings.push({ type: 'empty_race', race: number, message: `Race ${number} has no entries.` });
    }
    races.push(race);
  }

  // Race numbering should be contiguous from 1; a gap usually means a race
  // failed to parse at all.
  for (let i = 0; i < races.length; i++) {
    if (races[i].number !== i + 1) {
      warnings.push({
        type: 'race_numbering',
        message: `Race numbers are not contiguous: found ${races.map((x) => x.number).join(', ')}.`,
      });
      break;
    }
  }

  if (races.length === 0) {
    warnings.push({ type: 'no_races', message: 'No "Race N" sections found in the pasted text.' });
  }

  return { track, date, races, warnings };
}
