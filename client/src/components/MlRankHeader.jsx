import React from 'react';

// The "ML rank" header cell, in ONE place, because four different entries
// tables render it (the ingest preview, the day view, the shared entries
// dropdown and the card sheet) - same reason EntryFlagTags.jsx exists.
//
// Click-to-sort: `direction` is null (unsorted, the original row order) |
// 'asc' | 'desc'. A click cycles asc -> desc -> asc - it never returns to
// unsorted, same as any other sortable table header. The actual reordering
// (shared/entry-flags.js's `mlRankOrder`) lives with `flagRaceEntries`,
// which every caller already imports to compute the rank in the first place.
export default function MlRankHeader({ direction, onClick }) {
  const arrow = direction === 'asc' ? ' ▲' : direction === 'desc' ? ' ▼' : '';
  return (
    <th
      className="th-sort"
      title="Predicted order of finish from the morning line (1 = shortest line; ties share a rank). Click to sort."
      onClick={onClick}
    >
      ML rank{arrow}
    </th>
  );
}
