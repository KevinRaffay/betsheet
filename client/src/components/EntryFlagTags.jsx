import React from 'react';

// D216: the two entry-flag tags, in ONE place, because four different entries
// tables render them (the ingest preview, the day view, the shared entries
// dropdown and the card sheet) and a second hand-rolled copy is how the
// wording and the colour drift apart - the same reason `RaceNotes.jsx` (D165)
// and `EntriesTable.jsx` (D135) exist at all.
//
// Presentation only. `shared/entry-flags.js` decides WHICH entries are
// flagged; this decides nothing and only says so on screen.
export default function EntryFlagTags({ flag }) {
  if (!flag) return null;
  return (
    <>
      {flag.baffert
        ? <span className="tag tag--blue" title="Trainer name contains &quot;Baffert&quot;.">BAFFERT</span>
        : null}
      {flag.favorite
        ? <span className="tag tag--green" title="Shortest morning line in a five-horse field.">FAV 5</span>
        : null}
    </>
  );
}
