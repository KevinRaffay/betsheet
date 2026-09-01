import React, { useEffect, useState } from 'react';
import { generateCardApi, listCards } from '../api.js';

// The cards section of a stored race day. Generation is APPEND-ONLY and
// fully parameterized here: the race day holds the program (races, entries,
// consensus - the facts); each CARD is one parameterized sheet over it.
// Want the same day at a different bankroll or per-race minimum? Generate
// another card - every card carries its own recipe and they sit side by
// side, numbered.
export default function CardsPanel({ dayId, defaultBankrollCents, defaultPerRaceMinCents, onOpenCard }) {
  const [cards, setCards] = useState(null);
  const [variant, setVariant] = useState('default');
  const [bankroll, setBankroll] = useState(
    defaultBankrollCents != null ? String(defaultBankrollCents / 100) : '200');
  const [perRaceMin, setPerRaceMin] = useState(
    defaultPerRaceMinCents != null ? String(defaultPerRaceMinCents / 100) : '5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await generateCardApi(dayId, {
        variant: variant.trim() || 'default',
        bankrollCents: Math.round(Number(bankroll || 0) * 100),
        perRaceMinCents: Math.round(Number(perRaceMin || 0) * 100),
      });
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
          <label>Bankroll ($)
            <input className="in in--xs" type="number" min="1" value={bankroll}
              onChange={(e) => setBankroll(e.target.value)} />
          </label>
          <label>Per-race min ($)
            <input className="in in--xs" type="number" min="1" value={perRaceMin}
              onChange={(e) => setPerRaceMin(e.target.value)} />
          </label>
          <button className="btn btn--primary" disabled={busy} onClick={handleGenerate}>
            {busy ? 'Generating…' : 'Generate card'}
          </button>
        </div>
      </div>
      <p className="dim">
        Each card is one parameterized sheet over this day's program — change
        the bankroll, minimum, or variant and generate again; cards stack up
        side by side, never overwritten.
      </p>
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
