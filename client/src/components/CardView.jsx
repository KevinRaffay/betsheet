import React, { useEffect, useState } from 'react';
import { deleteCard, getCard, getGrades, getLlmNotes, gradeCardApi, modelLabel } from '../api.js';
import CardSheet from './CardSheet.jsx';

// The card page: fetches by id, owns the standalone pagehead, and renders
// the sheet itself via CardSheet.jsx (D237 extracted the sheet's read-only
// render tree so it can be fed data directly rather than only by id - see
// that file's own header for why).
//
// `embedded` (D95) drops the pagehead - the title line and the Export /
// Grade / Delete / Back row - so the sheet can be mounted inside another
// view that owns its own header and navigation. Delete in particular has no
// business firing from a page whose subject is a race day rather than this
// card.
export default function CardView({ cardId, onBack, onDeleted, embedded = false }) {
  const [card, setCard] = useState(null);
  const [gradeData, setGradeData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Read-only, same data RaceDayView.jsx's per-race panel shows (D164) - the
  // analyst notes entered via "Enter Analyst Notes" or the LLM generator's
  // own notes fields (same `llm_notes` draft, D92), keyed by race number.
  const [notesByRace, setNotesByRace] = useState(new Map());

  useEffect(() => {
    getCard(cardId).then(setCard).catch((e) => setError(String(e.message)));
    getGrades(cardId).then(setGradeData).catch(() => setGradeData(null));
  }, [cardId]);

  useEffect(() => {
    if (card?.race_day_id == null) return;
    getLlmNotes(card.race_day_id)
      .then((n) => setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v]))))
      .catch(() => {}); // supplementary display only - a fetch failure here shouldn't block the sheet
  }, [card?.race_day_id]);

  const handleGrade = async () => {
    setBusy(true);
    setError(null);
    try {
      await gradeCardApi(cardId);
      setGradeData(await getGrades(cardId));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Permanently delete this card and all of its tickets, grades, and related records?')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCard(cardId);
      onDeleted();
    } catch (e) {
      setError(String(e.message));
      setBusy(false);
    }
  };

  if (error && !card) return <p className="notice notice--error">{error}</p>;
  if (!card) return <p className="placeholder">Loading…</p>;

  const graded = (gradeData?.grades ?? []).length > 0;

  return (
    <>
      {!embedded && (
        <div className="pagehead">
          <h2>
            {card.track} — {card.date} · card #{card.card_number}
            {card.variant !== 'default' ? ` (${card.variant})` : ''}
            {card.name ? ` — “${card.name}”` : ''}
          </h2>
          <div className="btnrow">
            <a className="btn" href={`/api/cards/${cardId}/export`}>Export JSON</a>
            <button className="btn" onClick={handleGrade} disabled={busy}>
              {graded ? 'Regrade vs results' : 'Grade vs results'}
            </button>
            <button className="btn btn--danger" onClick={handleDelete} disabled={busy}>
              Delete card
            </button>
            <button className="btn" onClick={onBack}>Back</button>
          </div>
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      <CardSheet
        card={{ ...card, llmModelLabel: modelLabel(card.llm_model) }}
        races={card.races}
        results={card.results}
        notesByRace={notesByRace}
        grades={gradeData}
      />
    </>
  );
}
