import React from 'react';
import { flagRaceEntries } from '@shared/entry-flags.js';
import EntryFlagTags from './EntryFlagTags.jsx';

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
export default function EntriesTable({ entries, open = false, showRank = true }) {
  // D216: computed from the RAW rows, before `normalizeEntry` - the flags need
  // the morning line (and, where the caller has it, the stored decimal), which
  // the render shape does not carry. `.map` preserves order, so index i lines
  // the two up.
  const { flags } = flagRaceEntries(entries);
  return (
    <details className="race-entries" open={open}>
      <summary>Entries ({entries.length})</summary>
      <table className="grid grid--entries">
        <thead>
          <tr>
            <th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th>
            {showRank && <th title="Predicted order of finish from the morning line (1 = shortest line; ties share a rank)">ML rank</th>}
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
              {showRank && <td>{flags[i]?.mlRank ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
