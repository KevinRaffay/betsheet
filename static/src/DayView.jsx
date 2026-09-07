import React, { useState } from 'react';
import { navigate } from './app.jsx';
import { newCard, lockedRaces, cardCostCents, cardTickets } from './card.js';
import { isUnexported } from './storage.js';
import ReferenceCards from './ReferenceCards.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The day landing (D151): pick a card, see every race and its state, open one.
//
// Card identity lives here and in the header's picker, mirroring the desktop's
// D139/D140/D147 rule that a builder owns its own card selection rather than
// being handed one - and for the same reason: a half-built card must stay
// reachable once a newer one exists.
export default function DayView({ payload, cards, activeCardId, deviceId, onSelectCard, onSaveCard }) {
  const [name, setName] = useState('');
  const active = cards.find((c) => c.cardId === activeCardId) ?? null;

  const startCard = async () => {
    const card = newCard({ deviceId, raceDay: payload.raceDay, payloadHash: payload.payloadHash, name });
    await onSaveCard(card);
    onSelectCard(card.cardId);
    setName('');
  };

  const locked = active ? lockedRaces(active) : [];

  return (
    <>
      <section className="panel">
        <h2>Card</h2>
        <div className="formrow">
          <label>
            Building
            <select className="in in--sm" value={activeCardId ?? ''}
              onChange={(e) => onSelectCard(e.target.value || null)}>
              <option value="">— pick a card —</option>
              {cards.map((c) => (
                <option key={c.cardId} value={c.cardId}>
                  {c.name ? `${c.name} · ` : ''}{c.cardId.slice(-6)} · {lockedRaces(c).length} race(s) · {money(cardCostCents(c))}
                  {isUnexported(c) ? ' · unexported' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name (optional, frozen at creation)
            <input className="in in--sm" value={name} placeholder="e.g. chalk day"
              onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btn--primary" onClick={startCard}>Start a new card</button>
        </div>
        {active ? (
          <p className="dim">
            Card <code>{active.cardId}</code>{active.name ? ` — ${active.name}` : ''} ·
            {' '}{locked.length} race(s) locked · {cardTickets(active).length} ticket(s) ·
            {' '}{money(cardCostCents(active))}
            {active.bankrollCents != null && <> of {money(active.bankrollCents)} bankroll</>}
            {active.sawReferenceCards && <> · <span className="tag tag--gold">saw reference cards</span></>}
          </p>
        ) : (
          <p className="dim">Pick a card above, or start one, before building a race.</p>
        )}
      </section>

      <ReferenceCards payload={payload} card={active} onSaveCard={onSaveCard} />

      <section className="panel">
        <h2>Races</h2>
        <table className="grid">
          <thead>
            <tr><th>#</th><th>Post</th><th>Distance</th><th>Surface</th><th>Runners</th><th>State</th><th /></tr>
          </thead>
          <tbody>
            {payload.races.map((r) => {
              const state = active?.races?.[r.number] ?? null;
              const live = r.entries.filter((e) => !e.scratched).length;
              return (
                <tr key={r.number}>
                  <td>{r.number}</td>
                  <td>{r.postTime ?? '—'}</td>
                  <td>{r.distance ?? '—'}</td>
                  <td>{r.surface ?? '—'}</td>
                  <td>{live}{live !== r.entries.length && <span className="dim"> of {r.entries.length}</span>}</td>
                  <td>
                    {!state && <span className="dim">not played</span>}
                    {state?.passed && <span className="tag">PASSED</span>}
                    {state?.lockedAt && !state.passed && (
                      <span className="tag tag--gold">{state.tickets.length} ticket(s) · {money(state.tickets.reduce((a, t) => a + t.costCents, 0))}</span>
                    )}
                    {state && !state.lockedAt && state.text?.trim() && <span className="tag">draft</span>}
                  </td>
                  <td>
                    <button className="btn btn--sm" disabled={!active}
                      onClick={() => navigate(`/race/${r.number}`)}>
                      {state?.lockedAt ? 'View' : 'Build'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
