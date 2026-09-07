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
//
// D139: this panel does not know or care which human card "Build card by
// hand" opens onto, or what it's named - DayTicketBuilderModal resolves and
// manages that itself (resume the latest, or "Start a New Card" with an
// optional name), the same way LlmCardModal owns its own card/model identity
// without this panel's help. D137 first put a picker and a name field here;
// that split card management across two components for no reason a caller
// ever needed to pass a card id, so it was undone (D139) rather than kept.
export default function CardsPanel({ dayId, bankrollCents, onOpenCard }) {
  const [cards, setCards] = useState(null);
  const [error, setError] = useState(null);
  const [showLlmModal, setShowLlmModal] = useState(false);
  const [showHandModal, setShowHandModal] = useState(false);

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

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
          bankrollCents={bankrollCents}
          onCardChanged={reload}
          onClose={() => { setShowHandModal(false); reload(); }}
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
