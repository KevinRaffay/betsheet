// Equibase entries page -> the D04 entries structure (D104), PURE.
//
// Takes the page's HTML as a STRING and never fetches anything. Invariant 6
// forbids scraping Equibase and Equibase actively blocks it; the file arrives
// because a person opened the page and saved it, the same manual-upload
// posture as the OTR sheet (D71) and the ATR racecard (D69).
//
// Browser-safe on purpose - no `node:` imports - so the ingest preview can run
// it client-side exactly as shared/entries-parser.js does.
//
// The PDF route was measured and rejected before this existed: a print-to-PDF
// of the same page has no text layer at all (zero embedded fonts, pdftotext 14
// bytes, pdfjs 0 characters). The HTML is also simply better - every field
// arrives as a discrete table cell, so there is no column-alignment guesswork,
// no page-break bleed and no OCR near odds or weights. See
// docs/requirements/equibase-entries-ingest.md.
//
// Never throws: it parses what it can and reports the rest in `warnings`, each
// carrying its own `blocking` boolean - the per-item severity convention
// shared/parsers/human-picks.js and shared/parsers/equibase-otr.js use.

// From betmath, not entries-parser: the helper moved there in D109 precisely
// so this parser does not depend on a file the pivot deletes (P-2.5).
import { morningLineToDecimal } from '../betmath.js';

// Web-UI text that bleeds into the saved page. Appendable on purpose: more
// will turn up on other tracks' pages, and each is only visible AFTER tags are
// stripped - in raw markup the phrase is split across elements.
const UI_CRUFT = [
  /See More See Less/g,
  // Bounded to the nav list itself. An earlier `.*$` version was fine while
  // text still had line breaks, but once whitespace is collapsed the block is
  // a single line and `.*$` swallowed the race header behind it.
  /\bJump to Race:(?:\s*\d+\s*\|?)*/g,
  /\bScratches \/ Changes \/ Weather\b/g,
];

const ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-', '&copy;': '(c)',
};

/**
 * One unescape pass. `&amp;` LAST, so an entity that was escaped twice
 * (`&amp;nbsp;`) becomes `&nbsp;` here and resolves on the next pass rather
 * than collapsing to a stray ampersand.
 */
function unescapeOnce(text) {
  let out = String(text);
  for (const [ent, ch] of Object.entries(ENTITIES)) out = out.split(ent).join(ch);
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  return out.split('&amp;').join('&');
}

/**
 * A page saved from Chrome's `view-source:` view is the original markup,
 * HTML-escaped, one `<tr>` per source line. It reconstructs deterministically,
 * so both capture shapes are accepted and nobody has to remember which was
 * used: Ctrl+S "Webpage, HTML Only" gives the original directly.
 */
export function unwrapViewSource(html) {
  const rows = [...String(html).matchAll(/<td class="line-content">([\s\S]*?)<\/td>/g)];
  if (rows.length === 0) return String(html);
  // Each row's own syntax-highlighting spans are markup ABOUT the source, not
  // source - strip them, then unescape what they wrapped.
  return rows.map((m) => unescapeOnce(m[1].replace(/<[^>]+>/g, ''))).join('\n');
}

const stripTags = (h) => String(h).replace(/<[^>]+>/g, ' ');

function clean(html) {
  // Collapse whitespace BEFORE stripping cruft, not after. "See More" and
  // "See Less" are separate elements, so stripping tags leaves them with a run
  // of whitespace between - the phrase only becomes contiguous, and therefore
  // matchable, once that run is collapsed.
  let text = unescapeOnce(stripTags(html)).replace(/\s+/g, ' ');
  for (const re of UI_CRUFT) text = text.replace(re, ' ');
  return text.replace(/\s+/g, ' ').replace(/\s*\.\.\.\s*$/, '').trim();
}

const cellsOf = (tr) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => clean(m[1]));
const rowsOf = (table) => [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

// Header labels -> the field each column carries. Keyed on the header row of
// EACH race, never on a fixed index: a claiming race inserts a `Claim $`
// column, so it has 12 columns where an allowance race has 11. Indexing would
// silently shift jockey, weight, trainer, M/L and live odds by one on every
// claiming race - which is exactly the mistake made while first analysing the
// fixture, where a 12-column row's M/L was read as its live odds.
const COLUMN_FIELDS = {
  'p#': 'programNumber',
  pp: 'postPosition',
  horse: 'horseName',
  vs: 'vs',
  'a/s': 'ageSex',
  med: 'medication',
  'claim $': 'claimPrice',
  jockey: 'jockey',
  wgt: 'weight',
  trainer: 'trainer',
  'm/l': 'morningLine',
  // The header reads `LiveOdds` in the raw markup and `Live Odds` once
  // whitespace is normalised, depending on where the cell breaks. Accept both.
  liveodds: 'liveOdds',
  'live odds': 'liveOdds',
};

const norm = (label) => String(label).toLowerCase().replace(/\s+/g, ' ').trim();

/** A scratched row carries a `SCR` marker and a dashed bar spanning the rest. */
const SCRATCH_RE = /^\s*SCR\s*$/i;
const DASH_BAR_RE = /^-{4,}\s*Scratched\s*-{4,}$/i;

const blank = (v) => v == null || v === '' || v === '-' || v === '--';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function toIsoDate(printed) {
  if (!printed) return null;
  const m = String(printed).match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/**
 * Odds a ticket would actually be priced at: live when the board has posted,
 * morning line otherwise, nothing for a scratch. Both raw fields are kept on
 * the entry regardless - this is derived, never a replacement.
 */
function effectiveOdds(entry) {
  if (entry.scratched) return null;
  if (!blank(entry.liveOdds)) return entry.liveOdds;
  return blank(entry.morningLine) ? null : entry.morningLine;
}

function parseEntryRow(cells, fields, raceNumber, warnings) {
  // Shape first, never column position: a scratch row is short (6 cells in the
  // reference capture) whatever its race's column count, because the dashed
  // bar spans the remainder by colspan.
  const isScratch = cells.some((c) => SCRATCH_RE.test(c)) || cells.some((c) => DASH_BAR_RE.test(c));
  if (isScratch && cells.length < fields.length) {
    const horseName = cells.find((c) => c && !SCRATCH_RE.test(c) && !DASH_BAR_RE.test(c)) ?? null;
    if (!horseName) {
      warnings.push({
        type: 'scratch_row_unreadable', race: raceNumber, blocking: false,
        message: `Race ${raceNumber}: a scratched row carried no horse name and was skipped.`,
      });
      return null;
    }
    return {
      programNumber: null, postPosition: null, horseName, ageSex: null, medication: null,
      claimPrice: null, jockey: null, trainer: null, weight: null,
      morningLine: null, morningLineDecimal: null, liveOdds: null, liveOddsDecimal: null,
      effectiveOdds: null, effectiveOddsDecimal: null,
      scratched: true,
    };
  }

  const entry = {
    programNumber: null, postPosition: null, horseName: null, ageSex: null, medication: null,
    claimPrice: null, jockey: null, trainer: null, weight: null,
    morningLine: null, morningLineDecimal: null, liveOdds: null, liveOddsDecimal: null,
    effectiveOdds: null, effectiveOddsDecimal: null,
    scratched: isScratch,
  };
  fields.forEach((field, i) => {
    if (!field || field === 'vs') return;
    const raw = cells[i] ?? '';
    entry[field] = raw === '' ? null : raw;
  });
  if (blank(entry.liveOdds)) entry.liveOdds = null;
  if (blank(entry.morningLine)) entry.morningLine = null;
  entry.morningLineDecimal = morningLineToDecimal(entry.morningLine);
  entry.effectiveOdds = effectiveOdds(entry);
  // D116: the live price gets its own decimal alongside its own text, the
  // same pairing morning_line / morning_line_decimal has had since D04, so
  // the DB column has a real source rather than being derived at the call
  // site. `morningLineToDecimal` is a fractional-odds reader, not a
  // morning-line-specific one - the tote prints the same 6/1 grammar.
  entry.liveOddsDecimal = morningLineToDecimal(entry.liveOdds);
  entry.effectiveOddsDecimal = morningLineToDecimal(entry.effectiveOdds);

  if (!entry.horseName) {
    warnings.push({
      type: 'entry_without_horse', race: raceNumber, blocking: true,
      message: `Race ${raceNumber}: an entry row carried no horse name.`,
    });
    return null;
  }
  return entry;
}

/**
 * Last position of `needle` inside `haystack`, comparing letters and digits
 * only, and reported as offsets into the ORIGINAL haystack so a caller can
 * slice it. Returns null when it is not there.
 *
 * Exists because a track's name is not printed consistently even within one
 * page: "Lethbridge Rmtc" in the header, "Lethbridge - Rmtc" in every race
 * block. Comparing the squeezed forms is what makes the wager-menu split
 * survive that, without loosening into a fuzzy match that could land on the
 * wrong boundary.
 */
function looseIndexOf(haystack, needle) {
  const keep = (c) => /[a-z0-9]/i.test(c);
  const map = [];
  let squeezed = '';
  for (let i = 0; i < haystack.length; i += 1) {
    if (keep(haystack[i])) { squeezed += haystack[i].toUpperCase(); map.push(i); }
  }
  const target = [...String(needle)].filter(keep).join('').toUpperCase();
  if (!target) return null;
  const at = squeezed.lastIndexOf(target);
  if (at < 0) return null;
  return { start: map[at], end: map[at + target.length - 1] + 1 };
}

/**
 * Race metadata lives in the block of markup immediately before its table.
 *
 * The block has a stable printed grammar, and D116 anchors on it rather than
 * taking a fixed slice off the end. The old version returned the last 1400
 * characters verbatim as `conditions`, which on race 1 meant the page's own
 * "Jump to Race" navigation strip and a block of inline JavaScript - text that
 * would have gone into `races.conditions` and from there into every LLM prompt
 * built for the day. It also read no race type and no wager menu at all, and
 * the wager menu is load-bearing: `TicketBuilder` and `shared/parsers/
 * human-picks.js` both read `races.wager_menu` for minimums and combo costing,
 * and without it every race silently falls back to `BET.minimums`.
 *
 *   ... Jump to Race: 1 | 3 | ... | Top
 *   Race N
 *   POST Time - 1:30 PM PT
 *   PPs & Selections  PP (Race N)  Scratches / Changes / Weather
 *   Free Tools:                          <- wager menu starts after this
 *   $1 Exacta / $2 Quinella / 50c Trifecta $2 Rolling Double / ...
 *   Del Mar CLAIMING $25,000 - $22,500   <- track name ends the menu,
 *   Purse $43,000.                          race type sits between them
 *   One And One Eighth Miles. (Turf)
 *   For Three Year Olds And Upward. ...  <- conditions, to the end
 *
 * `track` is the page's own header track, already parsed. Passing it in is
 * what makes the menu/type boundary findable: the track name is the only
 * reliable marker between them, and it is not knowable from the block alone.
 */
function parseHeaderBlock(block, raceNumber, warnings, track) {
  const text = clean(block);
  const tail = text.slice(-1800); // the race's own header, not the whole page

  const post = tail.match(/POST\s+Time\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)(?:\s*([A-Z]{2,3}))?/i);
  const purse = tail.match(/Purse\s+\$([\d,]+)/i);
  const distance = tail.match(/\.\s*([A-Z][a-z]+(?:\s+[A-Za-z]+){0,4}?\s+(?:Furlongs?|Miles?|Yards?)[^.]*)\./);
  const surface = tail.match(/\((Turf|Dirt|All Weather|Synthetic)\)/i);

  // ---- wager menu and race type, between "Free Tools:" and "Purse $" ----
  // Anchored on the TRACK NAME, which separates them. A track the header did
  // not yield, or a block that prints neither marker, yields nulls and a
  // non-blocking warning - never a guessed split.
  let wagerMenu = null;
  let raceType = null;
  // Offsets are computed in `tail` itself rather than in a re-sliced copy:
  // "Free Tools:" is a REGEX match whose printed length varies with the
  // page's whitespace, so subtracting a hardcoded literal length leaves the
  // span one character long and the race type carrying a stray "P" off
  // "Purse". Found exactly that way.
  const toolsMatch = tail.match(/Free\s+Tools\s*:/i);
  const purseAt = purse ? tail.indexOf(purse[0]) : -1;
  if (toolsMatch && purseAt > toolsMatch.index) {
    const span = tail.slice(toolsMatch.index + toolsMatch[0].length, purseAt);
    // D122: the SAME page can spell its own track two ways - the header says
    // "Lethbridge Rmtc" while every race block says "Lethbridge - Rmtc". An
    // exact search misses, and the menu and race type both come back null on
    // every race of the card. Matched on letters and digits only, so spacing,
    // hyphens and punctuation cannot break the split; the offsets are then
    // mapped back to the original string, because that is what gets sliced.
    const at = track ? looseIndexOf(span, String(track)) : null;
    if (at && at.start > 0) {
      wagerMenu = span.slice(0, at.start).trim() || null;
      raceType = span.slice(at.end).trim() || null;
    } else {
      // No track marker inside the span: the whole thing is more likely the
      // race type than a wager menu, so claim neither rather than mislabel.
      warnings.push({
        type: 'no_wager_menu', race: raceNumber, blocking: false,
        message: `Race ${raceNumber}: could not separate the wager menu from the race `
          + `type (the track name was not found between them). Minimums fall back to defaults.`,
      });
    }
  }

  // ---- conditions: everything after the distance/surface, to the end ----
  // The trailing "See More See Less" UI artifact is already gone - clean()
  // strips it before any of this runs.
  let conditions = null;
  if (distance) {
    const after = tail.slice(tail.indexOf(distance[0]) + distance[0].length);
    const surfAt = surface ? after.indexOf(surface[0]) : -1;
    conditions = (surfAt >= 0 ? after.slice(surfAt + surface[0].length) : after).trim() || null;
  }

  if (!post) {
    warnings.push({
      type: 'no_post_time', race: raceNumber, blocking: false,
      message: `Race ${raceNumber}: no post time found in the header block.`,
    });
  }
  return {
    postTime: post ? post[1].replace(/\s+/g, ' ').toUpperCase() : null,
    postTimeZone: post && post[2] ? post[2] : null,
    purseCents: purse ? Math.round(Number(purse[1].replace(/,/g, '')) * 100) : null,
    distance: distance ? distance[1].trim() : null,
    surface: surface ? surface[1] : null,
    raceType,
    wagerMenu,
    conditions,
  };
}

/**
 * The whole page. Returns every race with its entries, plus warnings.
 * `races[].entries` keeps scratched horses (flagged) so their M/L stays
 * visible; `activeEntries` is the count that excludes them.
 */
export function parseEquibaseEntriesHtml(rawHtml, { track = null, date = null } = {}) {
  const warnings = [];
  const races = [];
  const html = unwrapViewSource(rawHtml);

  const header = clean(html).match(/([A-Za-z .'-]+?)\s*\/\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*\/\s*All Races/);
  const pageTrack = track ?? (header ? header[1].trim() : null);
  const printedDate = header ? header[2].trim() : null;
  // The page prints "September 6, 2026"; every date this codebase stores is
  // YYYY-MM-DD, so hand back both rather than making each caller re-parse.
  const pageDate = date ?? toIsoDate(printedDate);
  if (!pageTrack || !pageDate) {
    warnings.push({
      type: 'no_track_or_date', blocking: true,
      message: 'Could not read the track and date header from this page.',
    });
  }

  const chunks = html.split(/<table class="fullwidth">/);
  for (let i = 1; i < chunks.length; i += 1) {
    const raceNumber = i;
    const table = chunks[i].split('</table>')[0];
    const trs = rowsOf(table);
    if (trs.length < 2) {
      warnings.push({
        type: 'empty_race_table', race: raceNumber, blocking: true,
        message: `Race ${raceNumber}: entries table had no rows.`,
      });
      continue;
    }

    const headerCells = cellsOf(trs[0]);
    const fields = headerCells.map((h) => COLUMN_FIELDS[norm(h)] ?? null);
    const unknown = headerCells.filter((h) => h && !COLUMN_FIELDS[norm(h)]);
    if (unknown.length) {
      warnings.push({
        type: 'unknown_column', race: raceNumber, blocking: false,
        message: `Race ${raceNumber}: unrecognised column(s) ${unknown.join(', ')} - ignored.`,
      });
    }

    // D122: some tracks get a REDUCED table with no `P#` column at all -
    // `PP, Horse, VS, A/S, Med, [Claim $,] Jockey, Wgt, Trainer`, 8 or 9 wide
    // against the familiar 11/12. Found across 18 of 91 real pages, all of them
    // quarter-horse or Canadian meets (Ajax Downs, Assiniboia, Century Mile,
    // Lethbridge, Fort Erie, Los Alamitos...). They also print no M/L and no
    // live odds, so those stay genuinely empty - see the ledger.
    //
    // Without a program number a day cannot be stored at all: the column is
    // NOT NULL and UNIQUE per race. The post position is the only identifier
    // the page gives, and at these tracks it IS the betting number - the
    // reduced table has no coupled-entry column for a `1A` to live in. So it
    // is used, and SAID OUT LOUD with a warning rather than substituted
    // silently, because a program number is what every ticket keys on and what
    // every refund is graded against.
    const hasProgramColumn = fields.includes('programNumber');
    if (!hasProgramColumn && fields.includes('postPosition')) {
      warnings.push({
        type: 'program_number_from_post_position', race: raceNumber, blocking: false,
        message: `Race ${raceNumber}: this page has no program-number or morning-line column `
          + `(${headerCells.length} columns) - Equibase publishes those closer to race day. The post `
          + `position is used as the program number and MAY CHANGE when the field is drawn, so treat `
          + `these numbers as provisional and re-save the page nearer to post before betting.`,
      });
    }

    const entries = [];
    let alsoEligibleFrom = null;
    for (const tr of trs.slice(1)) {
      const cells = cellsOf(tr);
      if (cells.length === 0) continue;
      // A 1-cell row is a separator, not an entry - "Also Eligibles:" marks
      // where the AE list begins.
      if (cells.length === 1) {
        if (/also eligible/i.test(cells[0])) alsoEligibleFrom = entries.length;
        continue;
      }
      const entry = parseEntryRow(cells, fields, raceNumber, warnings);
      if (entry) {
        // D122: reduced table - the post position is the only number printed.
        // Never invented where the page prints neither (a scratch row carries
        // no cells at all), so a genuinely numberless entry stays null and the
        // writer gives it its own placeholder.
        if (!hasProgramColumn && entry.programNumber == null && entry.postPosition != null) {
          entry.programNumber = entry.postPosition;
        }
        entry.alsoEligible = alsoEligibleFrom != null;
        entries.push(entry);
      }
    }

    races.push({
      number: raceNumber,
      ...parseHeaderBlock(chunks[i - 1], raceNumber, warnings, pageTrack),
      columnCount: headerCells.length,
      entries,
      activeEntries: entries.filter((e) => !e.scratched).length,
    });
  }

  if (races.length === 0) {
    // D121: tell the difference between "this isn't an Equibase page at all"
    // and the mistake a person actually makes, which is saving the RACE-CARD
    // INDEX instead of the entries page. The two look identical in a browser
    // tab and have nearly identical titles; the index lists one row per race
    // with purse, type, distance, surface, starter count and post time, and
    // not a single horse. Diagnosed from `id="entryRaces"`, the index's own
    // table, so the message can say what to do instead of "no race tables
    // found" - which is true, unhelpful, and reads like a parser bug.
    //
    // Found live 2026-09-06: 93 saved pages across ~40 tracks, every one of
    // them the index. The parser was right about all 93 and could not say so.
    if (/id="entryRaces"/i.test(html)) {
      warnings.push({
        type: 'index_page_not_entries', blocking: true,
        message: 'This is the race-card INDEX page (one row per race: purse, type, '
          + 'distance, surface, starters, post time) - it contains no horses. Save the '
          + 'per-track entries page instead: equibase.com/static/entry/<TRACK><MMDDYY><COUNTRY>-EQB.html '
          + '(for example KD090626USA-EQB.html; CAN for Canadian tracks, PUR for Puerto Rico).',
      });
    } else {
      warnings.push({
        type: 'no_races', blocking: true,
        message: 'No race tables found. Is this an Equibase entries page?',
      });
    }
  }
  return { track: pageTrack, date: pageDate, printedDate, races, warnings };
}
