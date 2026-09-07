import React from 'react';

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
  programRank: e.programRank ?? e.program_rank,
  bestBet: Boolean(e.bestBet ?? e.best_bet),
  scratched: Boolean(e.scratched),
});

// `open`: Replay's blind race view shows exactly one race per screen, so its
// entries are the primary content and start expanded (matching the adjacent
// Bottom Line `<details open>` already on that view) - D135. The LLM and
// day-builder modals stack every race in one scroll, so theirs default
// collapsed (the historical behavior, unchanged).
//
// `showRank` (D158) exists for the static at-track builder, whose payload
// carries no `program_rank` at all - the column renders a dash on every row
// there, which is width a phone does not have to spare. It defaults TRUE so
// all three desktop callers are untouched: they read a real DB row, where the
// program handicapper's rank is a genuine column and a null means "this day
// has no program analysis", which is worth showing as such.
export default function EntriesTable({ entries, open = false, showRank = true }) {
  return (
    <details className="race-entries" open={open}>
      <summary>Entries ({entries.length})</summary>
      <table className="grid grid--entries">
        <thead>
          <tr>
            <th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th>
            {showRank && <th>Rank</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(normalizeEntry).map((e, i) => (
            <tr key={e.programNumber ?? i} className={e.scratched ? 'row--scratched' : ''}>
              <td>{e.programNumber ?? '—'}</td>
              <td>
                {e.horseName}
                {e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}
                {e.scratched ? <span className="tag tag--red">SCR</span> : null}
              </td>
              <td>{e.jockey ?? '—'}</td>
              <td>{e.trainer ?? '—'}</td>
              <td>{e.morningLine ?? '—'}</td>
              {showRank && <td>{e.programRank ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
