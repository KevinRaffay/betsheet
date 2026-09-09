import React, { useEffect, useState } from 'react';
import { getLlmNotes, saveLlmNote } from '../api.js';
import { NoteSourceDatalist, NotesEditor } from './AnalystNotesEditor.jsx';

// D159: analyst notes, entered right after entries are uploaded - before any
// card exists. Writes through the SAME draft store (`llm_notes`, D92) the LLM
// generator's own notes UI reads and writes, keyed by (race_day_id,
// race_number), never by card_id - so a note entered here shows up in the
// generator exactly as if it had been typed there, and editing it in either
// place is the same row. This modal adds no schema and no new endpoint: it is
// a second entry point onto GET/PUT /api/race-days/:id/llm-notes.
//
// D184: THE WHOLE-DAY NOTE (race 0) IS ALL THIS WRITES. Per-race notes moved
// into each race's own panel (RaceNotesEditor.jsx) under the house rule that a
// race-specific input belongs in the Race UI component. It still writes race
// 0's slot in the same table through the same endpoint, so nothing about the
// storage or the prompt changed - this dialog simply stopped being twelve
// editors deep.
export default function RaceDayNotesModal({ dayId, onClose }) {
  // D184: this dialog no longer lists the day's races, so it no longer
  // fetches the day. `loaded` gates on the NOTES call alone - `cardNote`
  // cannot be that gate, since "no note yet" is a legitimate null.
  const [loaded, setLoaded] = useState(false);
  const [notesByRace, setNotesByRace] = useState(new Map());
  const [cardNote, setCardNote] = useState(null); // the day-level note (race 0)
  const [notesPostResult, setNotesPostResult] = useState(false);
  const [notesTick, setNotesTick] = useState(0); // re-render on an unflushed local edit
  const [error, setError] = useState(null);

  const loadNotes = () => getLlmNotes(dayId).then((n) => {
    setCardNote(n.cardNote);
    setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v])));
    setNotesPostResult(Boolean(n.postResult));
    setLoaded(true);
  }).catch((e) => setError(String(e.message)));

  // Block bodies, never `useEffect(loadFn, deps)` - an expression-bodied
  // loader returns a promise, and React would call it as its own cleanup on
  // unmount, which took the whole app down once (D90; see CLAUDE.md Gotchas).
  useEffect(() => { loadNotes(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingNotes = React.useRef(new Map()); // key: raceNumber (0 = day note)
  const noteFor = (race) => (race === 0 ? cardNote : notesByRace.get(race)) ?? null;
  const draftOf = (race) => {
    const pend = pendingNotes.current.get(race);
    return pend ?? { text: noteFor(race)?.text ?? '', sourceLabel: noteFor(race)?.sourceLabel ?? '' };
  };
  const editNote = (race, patch) => {
    pendingNotes.current.set(race, { ...draftOf(race), ...patch });
    setNotesTick((t) => t + 1);
  };
  const flushNotes = async () => {
    const pend = [...pendingNotes.current.entries()];
    if (!pend.length) return;
    pendingNotes.current.clear();
    for (const [race, d] of pend) {
      try {
        const r = await saveLlmNote(dayId, { race, text: d.text, sourceLabel: d.sourceLabel }, null);
        if (r?.postResult) setNotesPostResult(true);
      } catch (e) {
        setError(String(e.message));
      }
    }
    await loadNotes();
  };

  // A pending edit must not be lost on Close/Escape - flush before closing,
  // same as LlmCardModal's own notes editor.
  const handleClose = () => { flushNotes().finally(onClose); };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // House rule (D131-D133): a modal-backdrop never closes/locks its dialog
    // on click - no onClick here, ever. Only the header's × and Escape close.
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Analyst Notes for the whole day">
        <div className="modal__header">
          <h3>Analyst Notes — whole day</h3>
          <button className="modal__close" onClick={handleClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          {error && <p className="notice notice--error">{error}</p>}
          {!loaded && <p className="placeholder">Loading…</p>}
          {loaded && (
            <>
              <p className="dim">
                Commentary about the WHOLE DAY - track bias, weather, how the meet is running.
                Available to every LLM card generated for this race day afterward, and shown in the
                LLM generator's own notes fields too - they are the same notes. A note about one
                RACE is typed in that race's own <strong>Analyst Notes</strong> panel.
              </p>

              <NoteSourceDatalist />

              {notesPostResult && (
                <p className="notice notice--warn">
                  This day's results are already recorded. Notes written after a result is known are not blind -
                  cards generated from them are flagged and excluded from the blind-notes corpus.
                </p>
              )}

              <NotesEditor
                scope="card" draft={draftOf(0)}
                onEdit={(patch) => editNote(0, patch)} onFlush={flushNotes} />
            </>
          )}
        </div>
        <div className="modal__footer">
          <button className="btn btn--primary" onClick={handleClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
