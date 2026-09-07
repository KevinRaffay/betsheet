import React from 'react';

// D164: the read-only analyst-notes panel, shared by RaceDayView.jsx (`/day`)
// and CardView.jsx (`/card`) so the two never drift into separate renderings
// of the same `llm_notes` data (D92) - the same extraction discipline as
// EntriesTable.jsx and AnalystNotesEditor.jsx. Collapsed by default, no
// editing surface: writing happens only through RaceDayNotesModal.jsx or the
// LLM generator's own notes fields.
export default function RaceNotes({ note }) {
  const hasNote = Boolean(note?.text);
  return (
    <details className="race-notes">
      <summary>Analyst Notes{hasNote ? '' : ' — none'}</summary>
      {hasNote ? (
        <>
          <p className="notes-text">{note.text}</p>
          <p className="dim">
            {note.sourceLabel ? `Source: ${note.sourceLabel}` : 'Source: —'}
            {note.updatedAt ? ` · updated ${note.updatedAt}` : ''}
          </p>
        </>
      ) : (
        <p className="dim">No analyst notes for this race.</p>
      )}
    </details>
  );
}
