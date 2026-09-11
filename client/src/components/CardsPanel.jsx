import React, { useEffect, useRef, useState } from 'react';
import { listCards, modelLabel, plMoney, plClass, bulkDeleteCards } from '../api.js';
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
  // Bulk-select (checkbox column), mirroring RaceDayList.jsx's pattern.
  // Unlike a race day, a card has no grading guard here at all (user
  // decision 2026-09-09) - any card, graded or not, may be selected and
  // deleted.
  const [selected, setSelected] = useState(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const selectAllRef = useRef(null);

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  useEffect(() => {
    setSelected(new Set());
    setConfirmBulk(false);
    setBulkResult(null);
  }, [dayId]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allIds = (cards || []).map((c) => c.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) allIds.forEach((id) => next.delete(id));
      else allIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleBulkDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await bulkDeleteCards([...selected]);
      setBulkResult(result);
      setSelected(new Set());
      setConfirmBulk(false);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const selectedCards = (cards || []).filter((c) => selected.has(c.id));

  return (
    <section className="consensus">
      <div className="pagehead">
        <h3>Betting cards</h3>
        <div className="formrow formrow--tight">
          <button
            className="btn btn--danger"
            disabled={selected.size === 0 || busy}
            onClick={() => setConfirmBulk(true)}
          >
            Delete selected ({selected.size})
          </button>
          <button className="btn btn--primary" onClick={() => setShowLlmModal(true)}>
            Generate Card from LLM
          </button>
          <button className="btn" onClick={() => setShowHandModal(true)}>
            Build card by hand
          </button>
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {confirmBulk && (
        <div className="notice notice--warn">
          <p>
            <strong>Delete {selectedCards.length} card{selectedCards.length === 1 ? '' : 's'}?</strong>
            {' '}{selectedCards.map((c) => `#${c.card_number}${c.name ? ` (${c.name})` : ''}`).join(', ')}.
            {' '}This permanently deletes each card and every ticket, allocation and grade on it -
            graded cards included. Not reversible.
          </p>
          <div className="formrow formrow--tight">
            <button className="btn btn--danger" disabled={busy} onClick={handleBulkDelete}>
              Delete them
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmBulk(false)}>Cancel</button>
          </div>
        </div>
      )}
      {bulkResult && (
        <p className="notice">
          Deleted {bulkResult.deleted.length} card{bulkResult.deleted.length === 1 ? '' : 's'}.
          {bulkResult.skipped.length > 0 && (
            <>
              {' '}{bulkResult.skipped.length} not deleted: {bulkResult.skipped.map((s) => `#${s.id} (no longer exists)`).join(', ')}.
            </>
          )}
        </p>
      )}
      {cards && cards.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr>
              <th>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={allIds.length === 0}
                  onClick={(e) => e.stopPropagation()}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>#</th><th>Name</th><th>Template</th><th>Variant</th><th>Engine</th><th>Bankroll</th><th>Per-race min</th>
              <th>Bucket</th><th>Tickets</th><th>Day total</th><th>P/L</th><th>Generated</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} onClick={() => onOpenCard(c.id)}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelect(c.id)}
                  />
                </td>
                <td><strong>#{c.card_number}</strong></td>
                <td>{c.name ?? '—'}</td>
                <td>{c.template ?? '—'}</td>
                <td>{c.variant}</td>
                <td><code>{c.engine_version ?? 'lean-0'}</code>{c.llm_model && <span className="dim"> ({modelLabel(c.llm_model)})</span>}{c.notes_present ? <span className="tag tag--gold">notes</span> : null}{c.live_odds_present ? <span className="tag">board</span> : null}{c.tip_sheets_present ? <span className="tag">tips</span> : null}</td>
                <td>${(c.bankroll_cents / 100).toFixed(0)}</td>
                <td>{c.per_race_min_cents != null ? `$${(c.per_race_min_cents / 100).toFixed(0)}` : '—'}</td>
                <td>{c.consensus_completeness}</td>
                <td>{c.tickets}</td>
                <td>${(c.total_cents / 100).toFixed(0)}</td>
                {/* D175: P/L here once the card is graded, so a result is
                    readable where the cards are. An UNGRADED card shows a dash,
                    never $0 - "not graded yet" and "broke even" are different
                    facts, and the same distinction shared/tip-scoring.js makes
                    by returning null rather than zero. */}
                <td className={c.graded ? plClass(c.pl_cents) : 'dim'}>
                  {c.graded ? plMoney(c.pl_cents) : '—'}
                </td>
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
