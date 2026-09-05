import React, { useEffect, useState } from 'react';
import { generateCardApi, getTemplates, listCards, modelLabel } from '../api.js';
import LlmCardModal from './LlmCardModal.jsx';
import DayTicketBuilderModal from './DayTicketBuilderModal.jsx';

// The cards section of a stored race day: existing cards and the generate
// action - append-only, every run is a new numbered card carrying its
// full recipe (template, variant, bankroll, per-race min, completeness).
export default function CardsPanel({ dayId, bankrollCents, onOpenCard }) {
  const [cards, setCards] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('lean');
  const [variant, setVariant] = useState('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showLlmModal, setShowLlmModal] = useState(false);
  const [showHandModal, setShowHandModal] = useState(false);

  const reload = () => listCards(dayId).then(setCards).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);
  useEffect(() => { getTemplates().then(setTemplates).catch(() => setTemplates([])); }, []);

  const selected = templates.find((t) => t.name === template);
  // D98: resume the day's own latest human card rather than minting a second
  // one every time the builder is opened - the same rule ReplayDayLanding and
  // ReplayRaceView follow (D60). Read off the cards already fetched here, so
  // no extra call. A brand-new day simply has none and the first lock mints it
  // (D28).
  const humanCardId = (cards ?? [])
    .filter((c) => c.template === 'human')
    .sort((a, b) => b.card_number - a.card_number)[0]?.id ?? null;

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await generateCardApi(dayId, { variant: variant.trim() || 'default', template });
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
          <label>Template
            <select className="in in--sm" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {(templates.length ? templates : [{ name: 'lean', simulationOnly: false }]).map((t) => (
                <option key={t.name} value={t.name} disabled={t.simulationOnly}>
                  {t.name}{t.simulationOnly ? ' (simulation only)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>Variant
            <input className="in in--sm" value={variant} onChange={(e) => setVariant(e.target.value)} />
          </label>
          <button className="btn btn--primary" disabled={busy} onClick={handleGenerate}>
            {busy ? 'Generating…' : 'Generate card'}
          </button>
          <button className="btn" onClick={() => setShowLlmModal(true)}>
            Generate Card from LLM
          </button>
          <button className="btn" onClick={() => setShowHandModal(true)}>
            Build card by hand
          </button>
        </div>
      </div>
      {selected?.description && <p className="dim">{selected.description}</p>}
      {error && <p className="notice notice--error">{error}</p>}
      {cards && cards.length > 0 && (
        <table className="grid grid--click">
          <thead>
            <tr>
              <th>#</th><th>Template</th><th>Variant</th><th>Engine</th><th>Bankroll</th><th>Per-race min</th>
              <th>Consensus</th><th>Tickets</th><th>Day total</th><th>Generated</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id} onClick={() => onOpenCard(c.id)}>
                <td><strong>#{c.card_number}</strong></td>
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
          cardId={humanCardId}
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
