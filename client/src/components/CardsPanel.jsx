import React, { useEffect, useState } from 'react';
import { generateCardApi, listCards } from '../api.js';

// The cards section of a stored race day: existing cards and the generate
// action. Generating the same variant again replaces it (fresh picks in,
// fresh card out).
export default function CardsPanel({ dayId, onOpenCard }) {
  const [cards, setCards] = useState(null);
  const [variant, setVariant] = useState('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await generateCardApi(dayId, { variant: variant.trim() || 'default' });
      await reload();
      onOpenCard(out.id);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="consensus">
      <div className="pagehead">
        <h3>Betting cards</h3>
        <div className="formrow formrow--tight">
          <label>Variant
            <input className="in in--sm" value={variant} onChange={(e) => setVariant(e.target.value)} />
          </label>
          <button className="btn btn--primary" disabled={busy} onClick={handleGenerate}>
            {busy ? 'Generating…' : 'Generate card'}
          </button>
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {cards && cards.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr>
              <th>#</th><th>Variant</th><th>Bankroll</th><th>Per-race min</th>
              <th>Consensus</th><th>Tickets</th><th>Day total</th><th>Generated</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} onClick={() => onOpenCard(c.id)}>
                <td><strong>#{c.card_number}</strong></td>
                <td>{c.variant}</td>
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
    </section>
  );
}
