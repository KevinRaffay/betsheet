// Del Mar morning-line / changes sheet (D40): dmtc.com publishes one small,
// well-formed PDF per race day at a predictable URL, and keeps past dates
// (2026-08-01, 08-15, 08-16, 08-30 all answered 200 on 2026-09-02; a
// future date 404s). robots.txt allows "/" for a generic agent. This is
// the ENTRIES source of record, not a picks source: it registers in the
// D07 registry (kind 'program' - the sources vocabulary) so it shares the
// audit trail and robots guard, but the consensus runner skips it
// (`produces: 'entries'`) and server/ingest.js drives it instead.

const ORIGIN = 'https://www.dmtc.com';
const DEL_MAR = /^\s*del\s*mar\s*$/i;

export function mlSheetUrl(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  return `${ORIGIN}/data/pdf/racing/morning-line/${date.replace(/-/g, '')}.pdf`;
}

const dmtcMlFetcher = {
  id: 'dmtc-ml-sheet',
  name: 'Del Mar ML sheet',
  kind: 'program',
  produces: 'entries',
  supports: ({ track }) => DEL_MAR.test(track ?? ''),
  buildUrl: ({ date }) => mlSheetUrl(date),
  // The PDF bytes are parsed by server/ml-sheet-parser.js; the registry
  // contract wants a parse(body) - entries fetchers are driven through
  // parseBytes instead (ingest.js), so this stays a guard.
  parse: () => { throw new Error('dmtc-ml-sheet is an entries source; parse the PDF bytes with ml-sheet-parser'); },
};

export default dmtcMlFetcher;
