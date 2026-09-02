// Sports from the Basement - algorithmic expected order of finish.
// https://www.sportsfromthebasement.com, WordPress, robots-friendly (only
// /wp-admin/ is disallowed; verified 2026-09-01, re-verified 2026-09-02).
//
// They publish one post per track per race day ("Del Mar Horse Racing Picks
// for Sunday, August 30, 2026"), each race a table ordered by their
// algorithm's expected finish: Prgm / Post / Name / ML / Expected / Value.
// The post URL contains the PUBLISH date (usually ~2 days before the race),
// so the page is DISCOVERED via their sitemap rather than constructed:
// resolveUrl fetches the Jetpack sitemap index, scans the newest few
// sitemaps for the race-date slug, and hands the runner the post URL plus
// the discovery details for the audit row (all sub-fetches go through the
// runner's robots-respecting fetchText).
//
// Pick mapping: rows 1-3 of each table become top/second/third - by ROW
// ORDER only. The ML / Expected / Value columns ride along in the notes as
// information; on some posts they are placeholders (0.00 / 1 / 2-1, the
// 2026-09-03 fixture) and nothing downstream keys on them: the public
// favorite for D09's algo_fades_favorite comes from the race day's own
// entries (the ML sheet), never from this column. Every stored pick's note
// carries {rank, expected, value}; the top pick's note additionally carries
// the table's FULL expected order, because contrarian detection needs to
// see where the public favorite ranks.

const BASE = 'https://www.sportsfromthebasement.com';
export const SITEMAP_INDEX_URL = `${BASE}/sitemap-index-1.xml`;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NUM = Object.fromEntries(MONTHS.map((m, i) => [m, i + 1]));
const SLUG_FILLER = new Set(['horse', 'racing', 'picks', 'for']);

const slugify = (s) => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Track strings reach the fetcher in whatever spelling the ingest path
// produced - the program's panel letters give "Delmar", the Bottom Line
// header "Del Mar", the Equibase header "DEL MAR" (the D35 gap). The site
// slugs the track's WORDS ("del-mar"), so the known keys map to their word
// form here until D35 canonicalizes the track at save. Letters-only keys;
// an unknown track slugs as typed.
const TRACK_WORDS = {
  DELMAR: 'del mar',
  DMR: 'del mar',
  SANTAANITA: 'santa anita',
  GOLDENGATE: 'golden gate fields',
  GOLDENGATEFIELDS: 'golden gate fields',
  LOSALAMITOS: 'los alamitos',
  GULFSTREAM: 'gulfstream park',
  GULFSTREAMPARK: 'gulfstream park',
  PRAIRIEMEADOWS: 'prairie meadows',
  REMINGTONPARK: 'remington park',
  DELAWAREPARK: 'delaware park',
};
export const trackKey = (track) => String(track ?? '').toUpperCase().replace(/[^A-Z]/g, '');
export function trackSlug(track) {
  return slugify(TRACK_WORDS[trackKey(track)] ?? track);
}

export function slugFor(track, date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${trackSlug(track)}-horse-racing-picks-for-${WEEKDAYS[dt.getUTCDay()]}-${MONTHS[m - 1]}-${d}-${y}`;
}

/** The slug of a post URL: its last non-empty path segment. */
export const slugOfUrl = (url) => String(url).replace(/\/+$/, '').split('/').pop() ?? '';

/**
 * The closest slug to `candidate` among `slugs`, by track + date words:
 * one point per shared non-filler token (weekday, month, day, year, track
 * words) and two more when the track parts agree letters-only - so the
 * "delmar" vs "del-mar" near-miss surfaces as a Del Mar post, not another
 * track's post for the same date. Ties go to the later entry (newer).
 * Null when nothing shares a word.
 */
export function nearestSlug(slugs, candidate) {
  const trackPart = (s) => s.split('-horse-racing-picks-for-')[0];
  const tokens = (s) => s.split('-').filter((t) => t && !SLUG_FILLER.has(t));
  const want = new Set(tokens(candidate));
  const wantTrack = trackKey(trackPart(candidate));
  let best = null;
  let bestScore = 0;
  for (const s of slugs) {
    let score = tokens(s).filter((t) => want.has(t)).length;
    if (wantTrack && trackKey(trackPart(s)) === wantTrack) score += 2;
    if (score >= bestScore && score > 0) { best = s; bestScore = score; }
  }
  return best;
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

const httpStatusOf = (err) => {
  const m = String(err?.message ?? err).match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : null;
};

const sftbFetcher = {
  id: 'sftb-expected-finish',
  name: 'Sports from the Basement',
  kind: 'algorithmic',

  supports: () => true, // per-track coverage is decided by discovery

  buildUrl: ({ track, date }) => `${BASE}/?s=${slugFor(track, date)}`, // fallback only

  /**
   * Discover the post for a track + date. Returns { url, discovery }:
   * url is the post URL or null; discovery is what the audit row records
   * (D53) - sitemapUrl (the index on a miss, the sitemap page on a hit),
   * sitemapStatus, candidateSlug, entriesScanned, nearestSlug (miss only),
   * sitemaps (each page scanned with its status and entry count), error
   * (the sub-fetch failure, if one stopped discovery).
   */
  async resolveUrl({ track, date }, { fetchText }) {
    const slug = slugFor(track, date);
    const discovery = {
      sitemapUrl: SITEMAP_INDEX_URL, sitemapStatus: null, candidateSlug: slug,
      entriesScanned: 0, nearestSlug: null, sitemaps: [], error: null,
    };
    let index;
    try {
      index = await fetchText(SITEMAP_INDEX_URL);
      discovery.sitemapStatus = 200;
    } catch (err) {
      discovery.sitemapStatus = httpStatusOf(err);
      discovery.error = String(err?.message ?? err);
      return { url: null, discovery };
    }
    const maps = [...index.matchAll(/<loc>\s*([^<]*sitemap-(\d+)\.xml)\s*</g)]
      .map((m) => ({ url: m[1], n: Number(m[2]) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3); // posts land in the newest sitemaps
    const seen = [];
    for (const map of maps) {
      let xml;
      try {
        xml = await fetchText(map.url);
      } catch (err) {
        discovery.sitemaps.push({ url: map.url, status: httpStatusOf(err), entries: 0 });
        discovery.error = String(err?.message ?? err);
        continue;
      }
      const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*</g)].map((m) => m[1]);
      discovery.sitemaps.push({ url: map.url, status: 200, entries: locs.length });
      discovery.entriesScanned += locs.length;
      const hit = locs.find((u) => slugOfUrl(u) === slug);
      if (hit) return { url: hit, discovery: { ...discovery, sitemapUrl: map.url } };
      seen.push(...locs.map(slugOfUrl));
    }
    discovery.nearestSlug = nearestSlug(seen, slug);
    return { url: null, discovery };
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
        // `ml` (the post's own morning-line column) is deliberately not
        // stored: it is a placeholder on some posts and the race day's
        // entries are the morning line of record.
        void ml;
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
