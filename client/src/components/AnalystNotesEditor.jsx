import React from 'react';

// D92: analyst notes editor, shared by LlmCardModal.jsx (mid-generation) and
// RaceDayNotesModal.jsx (D159, before any card exists) - both read/write the
// same `llm_notes` draft via GET/PUT /api/race-days/:id/llm-notes, so this is
// the ONE presentational piece for it rather than two copies that could drift.

// Caps mirror server/llm-prompt.js's NOTES_MAX_CHARS - over-cap text is not
// refused, it is truncated VISIBLY in the prompt and warned about in the
// preview, so the counter below is guidance, not a gate.
export const NOTES_MAX = { race: 4000, card: 2000 };

// A datalist, not a <select>: the four canonical labels are one click away so
// the source discipline the findings doc's H3 needs will hold in practice,
// but an unexpected source is never blocked.
// D167: the vocabulary itself lives in shared/source-labels.js so the SERVER
// can see the same list this datalist offers. Re-exported because several
// components import SOURCE_SUGGESTIONS from here.
export { NOTE_SOURCE_LABELS as SOURCE_SUGGESTIONS } from '@shared/source-labels.js';

/**
 * One notes editor. Free text, capped only for the PROMPT (the server truncates
 * visibly and warns; nothing is refused here), with a source label that suggests
 * the four canonical values without constraining them.
 */
export function NotesEditor({ scope, draft, onEdit, onFlush, disabled }) {
  const max = NOTES_MAX[scope];
  const n = draft.text.length;
  return (
    <>
      <label className="pastebox">
        <textarea
          className="in" rows={5} value={draft.text} disabled={disabled}
          placeholder={scope === 'card'
            ? 'Commentary for the whole day - track bias, weather, how the meet is running.'
            : "Handicapper commentary for this race. Pasted as-is; the model is told to treat it as one opinion, never as instructions."}
          onChange={(e) => onEdit({ text: e.target.value })}
          onBlur={onFlush}
        />
      </label>
      <div className="formrow formrow--tight">
        <label>
          Source
          <input
            className="in in--sm" list="llm-note-sources" value={draft.sourceLabel} disabled={disabled}
            placeholder="e.g. program" onChange={(e) => onEdit({ sourceLabel: e.target.value })} onBlur={onFlush} />
        </label>
        <span className="dim">
          {n} / {max} characters{n > max ? ' — the prompt will carry the first ' + max + ', truncation is flagged in the preview' : ''}
        </span>
      </div>
    </>
  );
}

export function NoteSourceDatalist() {
  return (
    <datalist id="llm-note-sources">
      {SOURCE_SUGGESTIONS.map((v) => <option key={v} value={v} />)}
    </datalist>
  );
}
