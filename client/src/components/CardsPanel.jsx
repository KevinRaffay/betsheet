import React, { useEffect, useState } from 'react';
import { listCards, modelLabel } from '../api.js';
import LlmCardModal from './LlmCardModal.jsx';
import DayTicketBuilderModal from './DayTicketBuilderModal.jsx';

// The cards section of a stored race day: the cards on file, and the two
// ways left to make one. D111 removed the engine's "Generate card" button
// along with the engine, the template picker and the variant field - a card
// now comes from the LLM generator, the hand builder, or the Equibase OTR
// upload panel next door, and each of those writes its own tickets. The table
// still shows Template and Variant because stored cards carry them, retired
// lean-* rows included.
export default function CardsPanel({ dayId, bankrollCents, onOpenCard }) {
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);
  const [showLlmModal, setShowLlmModal] = useState(false);
  const [showHandModal, setShowHandModal] = useState(false);
  // D137: which human card "Build card by hand" opens. null follows D98's
  // original rule (resume the latest, whatever it currently is); a numeric
  // id pins to that exact card even once a newer one exists; the sentinel
  // 'new' starts a brand-new one (D28 append-only already allows several
  // human cards per day - this is what gives the user a deliberate way to
  // reach for it instead of always resuming). A brand-new day has no human
  // cards to pick among, so `effectiveSelection` falls through to 'new' on
  // its own and the name input is all that shows.
  const [selectedHumanCard, setSelectedHumanCard] = useState(null);
  const [newCardName, setNewCardName] = useState('');

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  const humanCards = (cards ?? [])
    .filter((c) => c.template === 'human')
    .sort((a, b) => b.card_number - a.card_number);

  const effectiveSelection = selectedHumanCard ?? humanCards[0]?.id ?? 'new';
  const startingNew = effectiveSelection === 'new';
  const resumedCard = startingNew ? null : humanCards.find((c) => c.id === effectiveSelection) ?? null;

  // Closing the modal (whether it saved anything or not) drops back to
  // "follow the latest" and clears the name draft, so the picker reflects
  // whatever the day actually has on file the next time it's opened.
  const handleModalClosed = () => {
    setShowHandModal(false);
    setSelectedHumanCard(null);
    setNewCardName('');
    reload();
  };

  return (
    <section className="consensus">
      <div className="pagehead">
        <h3>Betting cards</h3>
        <div className="formrow formrow--tight">
          <button className="btn btn--primary" onClick={() => setShowLlmModal(true)}>
            Generate Card from LLM
          </button>
          <button className="btn" onClick={() => setShowHandModal(true)}>
            Build card by hand
          </button>
        </div>
      </div>
      {humanCards.length > 0 && (
        <div className="formrow formrow--tight">
          <label>
            Human card{' '}
            <select
              className="in in--sm" value={String(effectiveSelection)}
              onChange={(e) => setSelectedHumanCard(e.target.value === 'new' ? 'new' : Number(e.target.value))}
            >
              {humanCards.map((c) => (
                <option key={c.id} value={c.id}>#{c.card_number}{c.name ? ` — ${c.name}` : ''}</option>
              ))}
              <option value="new">+ Start a new card…</option>
            </select>
          </label>
          {startingNew && (
            <label>
              Name (optional){' '}
              <input
                className="in in--sm" value={newCardName} placeholder="e.g. Aggressive"
                onChange={(e) => setNewCardName(e.target.value)}
              />
            </label>
          )}
        </div>
      )}
      {humanCards.length === 0 && (
        <div className="formrow formrow--tight">
          <label>
            New card's name (optional){' '}
            <input
              className="in in--sm" value={newCardName} placeholder="e.g. Aggressive"
              onChange={(e) => setNewCardName(e.target.value)}
            />
          </label>
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      {cards && cards.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr>
              <th>#</th><th>Name</th><th>Template</th><th>Variant</th><th>Engine</th><th>Bankroll</th><th>Per-race min</th>
              <th>Bucket</th><th>Tickets</th><th>Day total</th><th>Generated</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} onClick={() => onOpenCard(c.id)}>
                <td><strong>#{c.card_number}</strong></td>
                <td>{c.name ?? '—'}</td>
                <td>{c.template ?? '—'}</td>
                <td>{c.variant}</td>
                <td><code>{c.engine_version ?? 'lean-0'}</code>{c.llm_model && <span className="dim"> ({modelLabel(c.llm_model)})</span>}{c.notes_present ? <span className="tag tag--gold">notes</span> : null}</td>
                <td>${(c.bankroll_cents / 100).toFixed(0)}</td>
                <td>{c.per_race_min_cents != null ? `$${(c.per_race_min_cents / 100).toFixed(0)}` : '—'}</td>
                <td>{c.consensus_completeness}</td>
                <td>{c.tickets}</td>
                <td>${(c.total_cents / 100).toFixed(0)}</td>
                <td className="dim">{c.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showHandModal && (
        <DayTicketBuilderModal
          context="live"
          dayId={dayId}
          cardId={resumedCard?.id ?? null}
          cardName={startingNew ? (newCardName.trim() || null) : (resumedCard?.name ?? null)}
          bankrollCents={bankrollCents}
          onCardChanged={reload}
          onClose={handleModalClosed}
        />
      )}
      {showLlmModal && (
        <LlmCardModal
          dayId={dayId}
          onCardChanged={reload}
          onClose={() => { setShowLlmModal(false); reload(); }}
        />
      )}
    </section>
  );
}
