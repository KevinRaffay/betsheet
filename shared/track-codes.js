// Track name canonicalization (D35): every ingest path hands the save layer
// whatever spelling it parsed - the program panel letters read "DELMAR", the
// Bottom Line header fallback "Del Mar", the Equibase chart header "DEL MAR",
// a track's own footer credit "DelMarRacing.com". Comparing those as plain
// text let the same track land as two different `race_days` rows (D31/D53
// root cause). `canonicalizeTrack` maps every known spelling to one code +
// display name; an unrecognized track still gets a derived code (never a
// block - invariant 3's "missing detail warns, never blocks" spirit) so it
// can still be saved and compared consistently.
//
// Pure - browser + Node, no I/O. A new track gets a new entry here, not a
// special case at a call site.
//
// An UNRECOGNIZED track is not an error and never has been - it gets a derived
// code and saves fine. A registry entry buys two things: one canonical display
// spelling however the source wrote it, and a stable code that survives a
// source changing its mind about capitalisation.

const REGISTRY = [
  { code: 'DMR', display: 'Del Mar', aliases: ['DELMARRACINGCOM'] },
  // D115: the first target for the Equibase entries ingest, and the first
  // non-Del-Mar track in this registry. Equibase's own page header prints
  // "Kentucky Downs"; the aliases cover its report code and the spaceless form
  // a saved filename tends to carry.
  { code: 'KD', display: 'Kentucky Downs', aliases: ['KD', 'KDOWNS'] },

  // D122: the 37 tracks a 91-page Equibase capture turned up, added together
  // rather than one at a time, because the corpus that names them exists now
  // and will not be re-downloadable later - these pages are replaced daily.
  //
  // The CODE is Equibase's own track id, read out of each page's own links.
  // Not invented, and not derived: `canonicalizeTrack`'s fallback takes the
  // first three letters of whatever the page printed, which had Canterbury
  // Park as CAN, Charles Town as HOL, Horseshoe Indianapolis as HOR and
  // Mountaineer as RES - codes that collide with each other's tracks and move
  // whenever a page changes its wording. Registering pins them.
  //
  // A registry entry still blocks nothing: an unlisted track saves fine with a
  // derived code. What these buy is one canonical display spelling per track
  // and a code that survives the source rewording itself.
  { code: 'AJX', display: 'Ajax Downs', aliases: ['AJX'] },
  { code: 'ALB', display: 'Albuquerque', aliases: ['ALB'] },
  { code: 'ASD', display: 'Assiniboia Downs', aliases: ['ASD', 'ASSINIBOIA'] },
  { code: 'ATO', display: 'Atokad Downs', aliases: ['ATO', 'ATOKAD'] },
  { code: 'BKF', display: 'Blackfoot', aliases: ['BKF'] },
  { code: 'BTP', display: 'Belterra Park', aliases: ['BTP', 'BELTERRA'] },
  { code: 'CBY', display: 'Canterbury Park', aliases: ['CBY', 'CANTERBURY'] },
  { code: 'CD', display: 'Churchill Downs', aliases: ['CD'] },
  { code: 'CNL', display: 'Colonial Downs', aliases: ['CNL', 'COLONIAL'] },
  { code: 'CTM', display: 'Century Mile', aliases: ['CTM'] },
  { code: 'DEL', display: 'Delaware Park', aliases: ['DEL', 'DELAWARE'] },
  { code: 'ELK', display: 'Elko County Fair', aliases: ['ELK', 'ELKOFAIR', 'ELKO'] },
  { code: 'EMD', display: 'Emerald Downs', aliases: ['EMD', 'EMERALD'] },
  { code: 'EVD', display: 'Evangeline Downs', aliases: ['EVD', 'EVANGELINE'] },
  { code: 'FE', display: 'Fort Erie', aliases: ['FE'] },
  { code: 'FL', display: 'Finger Lakes', aliases: ['FL'] },
  { code: 'FP', display: 'Fairmount Park', aliases: ['FP', 'FAIRMOUNT'] },
  { code: 'GP', display: 'Gulfstream Park', aliases: ['GP', 'GULFSTREAM'] },
  { code: 'IND', display: 'Horseshoe Indianapolis', aliases: ['IND', 'INDIANAGRANDRACING', 'INDIANAGRAND'] },
  { code: 'LA', display: 'Los Alamitos', aliases: ['LA', 'LOSALAMITOSQUARTERHORSE', 'LOSAL'] },
  { code: 'LAD', display: 'Louisiana Downs', aliases: ['LAD', 'LOUISIANA'] },
  { code: 'LRL', display: 'Laurel Park', aliases: ['LRL', 'LAUREL'] },
  { code: 'LS', display: 'Lone Star Park', aliases: ['LS', 'LONESTAR'] },
  { code: 'MTH', display: 'Monmouth Park', aliases: ['MTH', 'MONMOUTH'] },
  { code: 'PID', display: 'Presque Isle Downs', aliases: ['PID', 'PRESQUEISLE'] },
  { code: 'PRM', display: 'Prairie Meadows', aliases: ['PRM'] },
  { code: 'PRX', display: 'Parx Racing', aliases: ['PRX', 'PARX'] },
  { code: 'RP', display: 'Remington Park', aliases: ['RP', 'REMINGTON'] },
  { code: 'SAR', display: 'Saratoga', aliases: ['SAR'] },
  { code: 'SRR', display: 'Sandy Ridge Racing', aliases: ['SRR', 'SANDYRIDGE'] },
  { code: 'SWF', display: 'Sweetwater Downs', aliases: ['SWF', 'SWEETWATER'] },
  { code: 'TDN', display: 'Thistledown', aliases: ['TDN'] },
  { code: 'TIM', display: 'Timonium', aliases: ['TIM'] },
  { code: 'WO', display: 'Woodbine', aliases: ['WO'] },

  // Three whose page name is not the track's name. The long form is kept as
  // an alias so a save that arrives spelled the page's way still lands on the
  // same row, while the short form is what gets stored and shown.
  { code: 'CT', display: 'Charles Town', aliases: ['CT', 'HOLLYWOODCASINOATCHARLESTOWNRACES', 'CHARLESTOWNRACES'] },
  // "Lethbridge Rmtc" in the page header, "Lethbridge - Rmtc" in every race
  // block on the same page - the mismatch behind D122's wager-menu bug.
  { code: 'LBG', display: 'Lethbridge', aliases: ['LBG', 'LETHBRIDGERMTC'] },
  // "Mountaineer Casino Racetrack & Resort". Until D122 widened the entries
  // header's character class the `&` fell outside it and this parsed as the
  // bare word "Resort" - which is what would have been stored and keyed on,
  // so that spelling is an alias too, for any row already written that way.
  { code: 'MNR', display: 'Mountaineer', aliases: ['MNR', 'MOUNTAINEERCASINORACETRACKRESORT', 'RESORT'] },
];

const lettersOnly = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * `raw` -> { code, display, recognized }. `display` is the canonical name to
 * store/show for a recognized track, or the trimmed input as typed for an
 * unrecognized one. `code` is always present (derived for the unrecognized
 * case) so every comparison - the one-day-per-track+date rule, the results
 * chart mismatch refusal - can key on it.
 */
/**
 * Every track this codebase has personally seen in a real captured page -
 * NOT an exhaustive Equibase master list (an unregistered track still saves
 * fine via canonicalizeTrack's derived-code fallback). For a UI suggestion
 * list (a `<datalist>`, never a hard dropdown - the same "suggest, don't
 * restrict" shape `shared/source-labels.js`'s own suggestions already use),
 * not a validation source.
 */
export function listTracks() {
  return REGISTRY.map(({ code, display }) => ({ code, display }));
}

export function canonicalizeTrack(raw) {
  const key = lettersOnly(raw);
  const trimmed = String(raw ?? '').trim();
  if (!key) return { code: null, display: trimmed, recognized: false };
  for (const t of REGISTRY) {
    if (key === lettersOnly(t.display) || t.aliases.some((a) => key === a)) {
      return { code: t.code, display: t.display, recognized: true };
    }
  }
  return { code: key.slice(0, 3) || 'UNK', display: trimmed, recognized: false };
}

// ---------- meets ----------
//
// Relocated here from server/dmtc-crawler.js by D113, which deleted that
// file. `race_days.meet` (D43) is still written at save and is still the
// dimension the P/L and Distributions meet selectors filter on, so the
// derivation had to survive the crawler that happened to define it. This is
// its natural home: it is a fact about a track and a date, which is what this
// module already owns.
//
// Del Mar runs two meets a year and nothing else does, so a non-Del Mar day
// simply has no meet - null, never a guessed label. A second track that runs
// named meets gets a registry entry here, the same way a new track spelling
// does, rather than a call-site special case.
const DMR = 'DMR';

/** `DMR-<year>-summer` (Jul-Sep) or `-fall` (Oct-Dec); null outside those months. */
export function meetFor(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month >= 7 && month <= 9) return `${DMR}-${m[1]}-summer`;
  if (month >= 10 && month <= 12) return `${DMR}-${m[1]}-fall`;
  return null;
}

/** meetFor() for a Del Mar day (any spelling - canonicalizeTrack handles it), null for other tracks. */
export function meetForDay(track, date) {
  return canonicalizeTrack(track).code === DMR ? meetFor(date) : null;
}
