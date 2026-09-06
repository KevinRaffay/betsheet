import React from 'react';

// Shared entries dropdown for a single race, used by both the LLM card
// generator and the day-level ticket builder (D134) so the same collapsible
// view exists in exactly one place. Callers pass entries in whichever shape
// their own endpoint returns - a raw DB row (server/cards.js, snake_case) or
// the replay/human-cards camelCase payload (server/replay.js's
// `entriesPayload`) - normalized here rather than at each call site.
const normalizeEntry = (e) => ({
  programNumber: e.programNumber ?? e.program_number,
  horseName: e.horseName ?? e.horse_name,
  jockey: e.jockey,
  trainer: e.trainer,
  morningLine: e.morningLine ?? e.morning_line,
  programRank: e.programRank ?? e.program_rank,
  scratched: Boolean(e.scratched),
});

export default function EntriesTable({ entries }) {
  return (
    <details className="race-entries">
      <summary>Entries ({entries.length})</summary>
      <table className="grid grid--entries">
        <thead>
          <tr><th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th><th>Rank</th></tr>
        </thead>
        <tbody>
          {entries.map(normalizeEntry).map((e, i) => (
            <tr key={e.programNumber ?? i} className={e.scratched ? 'row--scratched' : ''}>
              <td>{e.programNumber ?? '—'}</td>
              <td>{e.horseName}</td>
              <td>{e.jockey ?? '—'}</td>
              <td>{e.trainer ?? '—'}</td>
              <td>{e.morningLine ?? '—'}</td>
              <td>{e.programRank ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
