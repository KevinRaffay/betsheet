import React, { useEffect, useState } from 'react';
import { getRaceDay, listCards, lockLlmCard, previewLlmCard } from '../api.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// LLM cards (D63): "Generate Card from LLM" alongside the day's other
// cards - one race at a time, preview (the actual model call) then an
// explicit Save, exactly like D54's human paste flow except the "typing"
// step is a network call instead of a textarea. Resumes the day's own
// latest LLM card on mount, same resume rule Replay's ReplayRaceView uses
// for human cards (D60).
export default function LlmCardPanel({ dayId, onOpenCard }) {
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [generatedRaces, setGeneratedRaces] = useState(new Set());
  const [openRace, setOpenRace] = useState(null);
  const [preview, setPreview] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = () => {
    getRaceDay(dayId).then(setDayInfo).catch((e) => setError(String(e.message)));
    listCards(dayId).then((cards) => {
      const llm = cards.filter((c) => c.template === 'llm').sort((a, b) => b.card_number - a.card_number)[0];
      setCardId(llm ? llm.id : null);
    }).catch(() => {});
  };
  useEffect(reload, [dayId]);

  // Which races already carry a ticket on this card (drives the status
  // column) - derived from the card's own tickets rather than a separate
  // state table, since there's no lock/reveal machinery here.
  useEffect(() => {
    if (!cardId) { setGeneratedRaces(new Set()); return; }
    fetch(`/api/cards/${cardId}`).then((r) => r.json()).then((c) => {
      const numberByRaceId = new Map((c.races ?? []).map((r) => [r.id, r.number]));
      const races = new Set((c.tickets ?? []).map((t) => numberByRaceId.get(t.race_id)).filter((n) => n != null));
      setGeneratedRaces(races);
    }).catch(() => {});
  }, [cardId, preview]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!dayInfo) return <p className="placeholder">Loading…</p>;

  const handleGenerate = async (raceNumber) => {
    setOpenRace(raceNumber);
    setPreview(null);
    setBusy(true);
    setError(null);
    try {
      const p = await previewLlmCard(dayId, raceNumber, cardId, correlationId);
      if (p.correlationId) setCorrelationId(p.correlationId);
      setPreview(p);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await lockLlmCard(dayId, { race: openRace, requestId: preview.requestId, bankrollCents: dayInfo.bankroll_cents, cardId }, correlationId);
      if (!cardId) setCardId(r.cardId);
      setPreview(null);
      setOpenRace(null);
      reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const races = dayInfo.races ?? [];

  return (
    <section className="consensus">
      <div className="pagehead">
        <h3>LLM card</h3>
        {cardId && <button className="btn btn--sm" onClick={() => onOpenCard(cardId)}>Open card #{cardId}</button>}
      </div>
      <p className="dim">
        Generated one race at a time - reasoning and the raw model response are logged per race regardless of
        whether you save it.
      </p>
      {error && <p className="notice notice--error">{error}</p>}
      <table className="grid">
        <thead><tr><th>Race</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {races.map((r) => (
            <React.Fragment key={r.id}>
              <tr>
                <td>{r.number}</td>
                <td className="dim">{generatedRaces.has(r.number) ? 'Generated' : 'Not generated'}</td>
                <td>
                  <button className="btn btn--sm" disabled={busy} onClick={() => handleGenerate(r.number)}>
                    {generatedRaces.has(r.number) ? 'Regenerate' : 'Generate'}
                  </button>
                </td>
              </tr>
              {openRace === r.number && (
                <tr>
                  <td colSpan={3}>
                    {busy && !preview && <p className="placeholder">Calling the model…</p>}
                    {preview && (
                      <div className="formrow">
                        <p className="dim">
                          Race bankroll {money(preview.perRaceBankrollCents)} · card total {money(preview.cardCostCents)}
                          {' '}of {money(preview.bankrollCents)}
                          {preview.overBankroll && <span className="notice notice--warn"> over bankroll</span>}
                        </p>
                        {preview.reasoningText && (
                          <details className="race-bottom-line" open>
                            <summary>Model reasoning</summary>
                            <p>{preview.reasoningText}</p>
                          </details>
                        )}
                        {preview.warnings.length > 0 && (
                          <div className={`notice ${preview.warnings.some((w) => w.blocking) ? 'notice--error' : 'notice--warn'}`}>
                            <ul>{preview.warnings.map((w, i) => <li key={i}>{w.blocking ? <strong>BLOCKING: </strong> : null}{w.message}</li>)}</ul>
                          </div>
                        )}
                        {preview.tickets.length === 0 && preview.warnings.length === 0 && (
                          <p className="dim">The model proposed no bet on this race.</p>
                        )}
                        {preview.tickets.length > 0 && (
                          <table className="grid">
                            <thead><tr><th>Bet type</th><th>Selections / rationale</th><th>Say to the teller</th><th>Cost</th></tr></thead>
                            <tbody>
                              {preview.tickets.map((t, i) => (
                                <tr key={i}>
                                  <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
                                  <td>{t.legs.map((l) => l.join(',')).join(' / ')}{t.rationale_text ? <span className="dim"> — {t.rationale_text}</span> : null}</td>
                                  <td className="teller">{t.tellerCall}</td>
                                  <td>{money(t.costCents)}</td>
                                </tr>
                              ))}
                              <tr className="row--subtotal"><td colSpan={3}>Race total</td><td>{money(preview.raceCostCents)}</td></tr>
                            </tbody>
                          </table>
                        )}
                        <div className="formrow formrow--tight">
                          <button
                            className="btn btn--primary" disabled={busy || preview.warnings.some((w) => w.blocking)}
                            onClick={handleSave}
                          >
                            Save this race
                          </button>
                          <button className="btn" disabled={busy} onClick={() => { setOpenRace(null); setPreview(null); }}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
