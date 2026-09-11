import React from 'react';
import { flagRaceEntries } from '@shared/entry-flags.js';
import { dollars } from '@shared/betmath.js';
import EntryFlagTags from './EntryFlagTags.jsx';

// D224: the win probability a morning line implies, 0-1 -> a percent string.
const pct = (p) => (p == null ? '—' : `${(p * 100).toFixed(0)}%`);

// D236: the move between the two Win% columns, in percentage POINTS - the
// plain difference of the two columns beside it. Both are the NORMALISED
// readings and so is this, which is what makes a race's deltas sum to zero
// and makes this number agree with the STEAM/DRIFT tag on the horse's name.
const deltaPoints = (f) => {
  if (!f || f.mlFairProbability == null || f.liveFairProbability == null) return '—';
  const pts = (f.liveFairProbability - f.mlFairProbability) * 100;
  // U+2212 MINUS, not a hyphen: the column is numeric and right-aligned.
  return `${pts > 0 ? '+' : pts < 0 ? '\u2212' : ''}${Math.abs(pts).toFixed(1)}`;
};

// The raw reading, kept one hover away rather than deleted - D224 put it on
// screen to make the track's take visible, and that is still worth seeing.
const rawTitle = (p) => (p == null ? undefined
  : `Raw implied probability ${(p * 100).toFixed(1)}% (1 / (odds + 1)); a full field sums well over 100% because of the track's own take. The column shows this horse's share of the book instead, so a race sums to 100%.`);

// Shared entries dropdown for a single race, used by the LLM card generator,
// the day-level ticket builder (D134) and the Replay blind race view (D135)
// so the same rendering exists in exactly one place. Callers pass entries in
// whichever shape their own endpoint returns - a raw DB row (server/cards.js,
// snake_case) or the replay/human-cards camelCase payload (server/replay.js's
// `entriesPayload`) - normalized here rather than at each call site.
const normalizeEntry = (e) => ({
  programNumber: e.programNumber ?? e.program_number,
  horseName: e.horseName ?? e.horse_name,
  jockey: e.jockey,
  trainer: e.trainer,
  morningLine: e.morningLine ?? e.morning_line,
  liveOdds: e.liveOdds ?? e.live_odds,   // D236; undefined wherever no board was typed
  bestBet: Boolean(e.bestBet ?? e.best_bet),
  scratched: Boolean(e.scratched),
});

// `open`: Replay's blind race view shows exactly one race per screen, so its
// entries are the primary content and start expanded (matching the adjacent
// Bottom Line `<details open>` already on that view) - D135. The LLM and
// day-builder modals stack every race in one scroll, so theirs default
// collapsed (the historical behavior, unchanged).
//
// `showRank` (D158) exists for the static at-track builder, where the column
// is width a phone does not have to spare. It defaults TRUE so all three
// desktop callers are untouched. D223: the column is now the MORNING-LINE
// rank (`flags[i].mlRank`, shared/entry-flags.js) - the predicted order of
// finish from the line alone - and no longer reads `program_rank`, which
// D113 stopped ingesting and which rendered as a dash on every row since.
//
// D224 added `$2 win` and `Win %`, unconditional (unlike `showRank`) - they
// derive from the morning line, which the static payload DOES carry (unlike
// `program_rank`), so a phone at the track gets these for free. Both come
// from `flags[i]`, computed once in shared/entry-flags.js so the SAME
// forecast a person sees here is the one `mlRank`'s ordering already used.
export default function EntriesTable({ entries, open = false, showRank = true }) {
  // D216: computed from the RAW rows, before `normalizeEntry` - the flags need
  // the morning line (and, where the caller has it, the stored decimal), which
  // the render shape does not carry. `.map` preserves order, so index i lines
  // the two up.
  //
  // D236: `comparableCount` is how many runners carry BOTH a morning line and
  // a typed live price, so it is also the test for whether a board exists to
  // show. Deriving it rather than taking a prop is what keeps the static
  // at-track builder and the ingest preview - neither of which has ever seen a
  // live price - at exactly the columns they had before, with no call site
  // changed and no width spent on a phone for three columns of dashes.
  const { flags, comparableCount } = flagRaceEntries(entries);
  const hasBoard = comparableCount >= 2;
  return (
    <details className="race-entries" open={open}>
      <summary>Entries ({entries.length})</summary>
      <table className="grid grid--entries">
        <thead>
          <tr>
            <th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th>
            <th title="What $2-to-win pays if this horse wins - the printed line as a forecast, not the actual tote price">$2 win</th>
            <th title="This horse's share of the morning-line book, so a race sums to 100%. Hover a cell for the raw 1 / (odds + 1) reading, which sums to well over 100% because of the track's take">ML Win%</th>
            {hasBoard && <th title="The typed post-time price, the tote board as it stood when this race was priced">Live</th>}
            {hasBoard && <th title="The same reading off the typed live board, normalised over the same runners - which is what makes it subtractable from the column beside it">Live Win%</th>}
            {hasBoard && <th title="Live Win% minus ML Win%, in percentage points. Both books are normalised over the runners priced in each, so a race's moves sum to zero">&Delta;%</th>}
            {showRank && <th title="Predicted order of finish from the morning line (1 = shortest line; ties share a rank)">ML rank</th>}
            {showRank && hasBoard && <th title="The same ordering read off the live board (1 = shortest live price; ties share a rank)">Live rank</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(normalizeEntry).map((e, i) => (
            <tr
              key={e.programNumber ?? i}
              className={[e.scratched ? 'row--scratched' : '',
                (flags[i]?.baffert || flags[i]?.favorite) ? 'row--entry-flag' : ''].filter(Boolean).join(' ')}
            >
              <td>{e.programNumber ?? '—'}</td>
              <td>
                {e.horseName}
                {e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}
                {e.scratched ? <span className="tag tag--red">SCR</span> : null}
                <EntryFlagTags flag={flags[i]} />
              </td>
              <td>{e.jockey ?? '—'}</td>
              <td>{e.trainer ?? '—'}</td>
              <td>{e.morningLine ?? '—'}</td>
              <td className="dim">{flags[i]?.mlPayoutCents != null ? dollars(flags[i].mlPayoutCents) : '—'}</td>
              <td className="dim" title={rawTitle(flags[i]?.mlWinProbability)}>{pct(flags[i]?.mlFairProbability)}</td>
              {hasBoard && <td>{e.liveOdds ?? '—'}</td>}
              {hasBoard && <td className="dim" title={rawTitle(flags[i]?.liveWinProbability)}>{pct(flags[i]?.liveFairProbability)}</td>}
              {hasBoard && (
                <td className={`odds-delta odds-delta--${flags[i]?.move?.direction ?? 'flat'}`}>{deltaPoints(flags[i])}</td>
              )}
              {showRank && <td>{flags[i]?.mlRank ?? '—'}</td>}
              {showRank && hasBoard && <td>{flags[i]?.liveRank ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
