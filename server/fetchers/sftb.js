// Sports from the Basement - algorithmic expected order of finish.
// https://www.sportsfromthebasement.com, WordPress, robots-friendly (only
// /wp-admin/ is disallowed; verified 2026-09-01).
//
// They publish one post per track per race day ("Del Mar Horse Racing Picks
// for Sunday, August 30, 2026"), each race a table ordered by their
// algorithm's expected finish: Prgm / Post / Name / ML / Expected / Value.
// The post URL contains the PUBLISH date (usually ~2 days before the race),
// so the page is DISCOVERED via their sitemap rather than constructed:
// resolveUrl fetches the sitemap index, scans the newest few sitemaps for
// the race-date slug, and hands the runner the post URL (all sub-fetches go
// through the runner's robots-respecting fetchText).
//
// Pick mapping: rows 1-3 of each table become top/second/third. Every
// stored pick's note carries {rank, expected, value}; the top pick's note
// additionally carries the table's FULL expected order, because contrarian
// detection (D09) needs to see where the public favorite ranks - "an
// algorithm ranking the favorite 4th" is invisible if only three rows
// survive.

const BASE = 'https://www.sportsfromthebasement.com';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NUM = Object.fromEntries(MONTHS.map((m, i) => [m, i + 1]));

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');

export function slugFor(track, date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${slugify(track)}-horse-racing-picks-for-${WEEKDAYS[dt.getUTCDay()]}-${MONTHS[m - 1]}-${d}-${y}`;
}

// HTML -> one trimmed text line per element, entities decoded enough for
// horse names. No DOM library: the pages are simple WordPress tables and
// the token-stream approach matches the house parser style.
export function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#8217;|&rsquo;|&#039;/g, "'")
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const sftbFetcher = {
  id: 'sftb-expected-finish',
  name: 'Sports from the Basement',
  kind: 'algorithmic',

  supports: () => true, // per-track coverage is decided by discovery

  buildUrl: ({ track, date }) => `${BASE}/?s=${slugFor(track, date)}`, // fallback only

  async resolveUrl({ track, date }, { fetchText }) {
    const slug = slugFor(track, date);
    const index = await fetchText(`${BASE}/sitemap-index-1.xml`);
    const maps = [...index.matchAll(/<loc>\s*([^<]*sitemap-(\d+)\.xml)\s*</g)]
      .map((m) => ({ url: m[1], n: Number(m[2]) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3); // posts land in the newest sitemaps
    for (const map of maps) {
      const xml = await fetchText(map.url);
      const hit = xml.match(new RegExp(`<loc>\\s*([^<]*/${slug}/?)\\s*<`));
      if (hit) return hit[1].trim();
    }
    return null;
  },

  parse(html) {
    const warnings = [];

    const title = [...html.matchAll(/<title>([^<]+)<\/title>/gi)]
      .map((m) => m[1]).find((t) => /Picks for/i.test(t)) ?? '';
    const tm = title.match(/^(.*?)\s+Horse Racing Picks for\s+[A-Za-z]+,?\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
    const track = tm ? tm[1].trim() : null;
    const date = tm
      ? `${tm[4]}-${String(MONTH_NUM[tm[2].toLowerCase()] ?? 0).padStart(2, '0')}-${String(tm[3]).padStart(2, '0')}`
      : null;
    if (!tm) warnings.push({ type: 'no_page_date', message: 'Could not read track/date from the post title.' });

    const lines = htmlToLines(html);
    const races = [];
    let i = 0;
    while (i < lines.length) {
      const rm = lines[i].match(/^RACE NUMBER (\d+)/i);
      if (!rm) { i++; continue; }
      const raceNumber = Number(rm[1]);
      i++;

      // Skip forward to the table header, bounded by the next race section.
      while (i < lines.length && lines[i] !== 'Prgm' && !/^RACE NUMBER \d+/i.test(lines[i])) i++;
      if (lines[i] !== 'Prgm') {
        warnings.push({ type: 'no_table', message: `Race ${raceNumber}: no picks table found.` });
        continue;
      }
      while (i < lines.length && lines[i] !== 'Value') i++;
      i++; // past 'Value'

      const rows = [];
      while (i + 4 < lines.length && /^\d+A?$/i.test(lines[i])) {
        const [prgm, post, name, ml, expected] = lines.slice(i, i + 5);
        // A scratched horse's row is 5 cells ending in SCRATCH - no Value.
        if (/^SCRATCH(ED)?$/i.test(expected)) {
          i += 5;
          continue;
        }
        const value = lines[i + 5];
        if (!/^[\d.]+$/.test(expected)) {
          warnings.push({ type: 'bad_row', message: `Race ${raceNumber}: unreadable row at "${name}".` });
          break;
        }
        rows.push({ prgm: prgm.toUpperCase(), post, name, expected: Number(expected), value });
        i += 6;
      }
      const order = rows.filter(Boolean);
      if (order.length === 0) {
        warnings.push({ type: 'empty_race', message: `Race ${raceNumber}: table had no readable rows.` });
        continue;
      }

      const fullOrder = order.map((r, rank) => ({ rank: rank + 1, programNumber: r.prgm, horseName: r.name, expected: r.expected, value: r.value }));
      const types = ['top', 'second', 'third'];
      const picks = order.slice(0, 3).map((r, idx) => ({
        programNumber: r.prgm,
        horseName: r.name,
        pickType: types[idx],
        note: JSON.stringify(idx === 0
          ? { rank: 1, expected: r.expected, value: r.value, fullOrder }
          : { rank: idx + 1, expected: r.expected, value: r.value }),
      }));
      races.push({ race: raceNumber, picks });
    }

    if (races.length === 0) warnings.push({ type: 'no_races', message: 'No "RACE NUMBER N" sections found.' });
    return { track, date, races, warnings };
  },
};

export default sftbFetcher;
