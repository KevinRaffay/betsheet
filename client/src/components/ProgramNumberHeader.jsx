import React from 'react';

// The "#" (program number) header cell, click-to-sort, shared by the same four
// entries tables MlRankHeader serves. `direction` is null | 'asc' | 'desc';
// the ordering itself is shared/entry-flags.js's `programNumberOrder`.
export default function ProgramNumberHeader({ direction, onClick }) {
  const arrow = direction === 'asc' ? ' ▲' : direction === 'desc' ? ' ▼' : '';
  return (
    <th className="th-sort" title="Program number. Click to sort." onClick={onClick}>
      #{arrow}
    </th>
  );
}
