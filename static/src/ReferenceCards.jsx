import React, { useState } from 'react';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The OTR and LLM cards for this day, when the payload was built with
// --reference-cards (D150). Absent entirely otherwise.
//
// THE REVEAL IS THE POINT. A HUMAN card built while reading the LLM card is
// not an independent source, and a later analysis that treats it as one is
// measuring a feedback loop rather than a picker. Revealing therefore stamps
// `sawReferenceCards: true` on the card being built, permanently and without
// asking twice - which turns the contamination into labeled data instead of
// an unknown. It is never cleared, and there is no way to un-see a card.
//
// Requiring a card to be selected before revealing is not an inconvenience to
// design around: with no card to stamp, a reveal would be exactly the
// unlabeled contamination this whole mechanism exists to prevent.
export default function ReferenceCards({ payload, card, onSaveCard }) {
  const [open, setOpen] = useState(false);
  const refs = payload.referenceCards;
  if (!refs || refs.length === 0) return null;

  const reveal = async () => {
    if (!card) return;
    setOpen(true);
    if (!card.sawReferenceCards) await onSaveCard({ ...card, sawReferenceCards: true });
  };

  return (
    <section className="panel">
      <h2>Reference cards ({refs.length})</h2>
      {!open ? (
        <>
          <p className="dim">
            This day's LLM and Equibase OTR cards are in the payload. Reading them before
            you build is allowed — but a card built while looking at them is not an
            independent pick, so revealing stamps <code>saw reference cards</code> on the
            card you are building. That stamp is permanent and travels home with the card.
          </p>
          <div className="formrow formrow--tight">
            <button className="btn" disabled={!card} onClick={reveal}>Reveal reference cards</button>
            {!card && <span className="dim">Pick or start a card first — there is nothing to stamp otherwise.</span>}
          </div>
        </>
      ) : (
        <>
          <p className="dim">
            Stamped on <code>{card?.cardId}</code>: this card was built with the reference
            cards visible.
          </p>
          {refs.map((rc) => (
            <details key={rc.cardId} className="race-entries">
              <summary>
                {rc.template === 'llm' ? `LLM${rc.llmModel ? ` · ${rc.llmModel}` : ''}` : `Equibase OTR · ${rc.variant}`}
                {' '}— card #{rc.cardNumber}, {rc.tickets.length} ticket(s)
              </summary>
              <table className="grid">
                <thead><tr><th>Race</th><th>Teller call</th><th>Cost</th><th>Why</th></tr></thead>
                <tbody>
                  {rc.tickets.map((t) => (
                    <tr key={t.sequence}>
                      <td>{t.race}</td>
                      <td><code className="teller">{t.tellerCall}</code></td>
                      <td>{money(t.costCents)}</td>
                      <td className="dim">{t.rationale ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
