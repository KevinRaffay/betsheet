import React from 'react';
import CardSheet from '@client/components/CardSheet.jsx';
import { navigate } from './app.jsx';

// The card sheet, read-only, sourced from the bundle already in memory - no
// fetch, unlike client/src/components/CardView.jsx's own id-driven page.
// CardSheet.jsx (D237) is exactly the same component the desktop uses; it
// was designed prop-driven for precisely this caller.
export default function CardView({ day, cardId }) {
  const card = day.cards.find((c) => c.id === cardId);
  if (!card) {
    return (
      <section className="panel">
        <p className="notice notice--error">No card {cardId} on this race day.</p>
        <button className="btn" onClick={() => navigate(`/day/${day.raceDay.raceDayId}`)}>Back to the day</button>
      </section>
    );
  }

  const notesByRace = new Map(Object.entries(day.notesByRace ?? {}).map(([k, v]) => [Number(k), v]));

  return (
    <section className="panel">
      <div className="formrow formrow--tight">
        <button className="btn btn--sm" onClick={() => navigate(`/day/${day.raceDay.raceDayId}`)}>← Back to the day</button>
        <h2>
          {day.raceDay.track} — {day.raceDay.date} · card #{card.card_number}
          {card.variant !== 'default' ? ` (${card.variant})` : ''}
          {card.name ? ` — "${card.name}"` : ''}
        </h2>
      </div>
      <CardSheet
        card={{ ...card, llmModelLabel: card.llm_model_label, sources: day.sources, scratches: day.scratches }}
        races={day.races}
        results={day.results}
        notesByRace={notesByRace}
        grades={card.grades}
      />
    </section>
  );
}
