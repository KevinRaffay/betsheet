import React, { useEffect, useState } from 'react';
import { getRaceDay, listCards, lockLlmCard, previewLlmCard } from '../api.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// LLM cards (D63/D65): a modal walkthrough, one race at a time - Generate
// (the actual model call) shows a preview, Save confirms it and the
// ticket stays displayed read-only, then either "Generate next race" or,
// once every race carries a ticket, "Close". Calls `onCardChanged` after
// every save so the day's Betting cards table (CardsPanel.jsx) refreshes
// live instead of going stale until the page is revisited - the bug this
// modal was built to fix (D65).
export default function LlmCardModal({ dayId, onOpenCard, onCardChanged, onClose }) {
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [generatedRaces, setGeneratedRaces] = useState(new Set());
  const [openRace, setOpenRace] = useState(null);
  const [preview, setPreview] = useState(null); // { ...previewFields, saved: boolean }
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

  const refreshGeneratedRaces = () => {
    if (!cardId) { setGeneratedRaces(new Set()); return; }
    fetch(`/api/cards/${cardId}`).then((r) => r.json()).then((c) => {
      const numberByRaceId = new Map((c.races ?? []).map((r) => [r.id, r.number]));
      const races = new Set((c.tickets ?? []).map((t) => numberByRaceId.get(t.race_id)).filter((n) => n != null));
      setGeneratedRaces(races);
    }).catch(() => {});
  };
  useEffect(refreshGeneratedRaces, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape, from anywhere in the dialog.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const races = dayInfo?.races ?? [];
  const nextUngenerated = races.find((r) => !generatedRaces.has(r.number) && r.number !== openRace);
  const allGenerated = races.length > 0 && races.every((r) => generatedRaces.has(r.number));

  const handleGenerate = async (raceNumber) => {
    setOpenRace(raceNumber);
    setPreview(null);
    setBusy(true);
    setError(null);
    try {
      const p = await previewLlmCard(dayId, raceNumber, cardId, correlationId);
      if (p.correlationId) setCorrelationId(p.correlationId);
      setPreview({ ...p, saved: false });
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
      // Keep the race expanded, showing the now-confirmed ticket read-only,
      // rather than collapsing the row - the user should see what was
      // saved before moving on, per the requested walkthrough.
      setPreview((p) => ({ ...p, saved: true }));
      refreshGeneratedRaces();
      onCardChanged?.();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelPreview = () => { setOpenRace(null); setPreview(null); };

  if (error && !dayInfo) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <p className="notice notice--error">{error}</p>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Generate Card from LLM" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3>Generate Card from LLM</h3>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {!dayInfo && <p className="placeholder">Loading…</p>}
        {dayInfo && (
          <>
            <p className="dim">
              Generate one race at a time - reasoning and the raw model response are logged per race regardless of
              whether you save it. {cardId && <button className="btn btn--sm" onClick={() => onOpenCard(cardId)}>Open card #{cardId}</button>}
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
                              {preview.saved ? (
                                <div className="formrow formrow--tight">
                                  <p><strong className="pl--pos">Saved ✓</strong></p>
                                  {nextUngenerated
                                    ? <button className="btn btn--primary" disabled={busy} onClick={() => handleGenerate(nextUngenerated.number)}>
                                        Generate next race (Race {nextUngenerated.number}) →
                                      </button>
                                    : <button className="btn btn--primary" disabled={busy} onClick={onClose}>All races generated - Close</button>}
                                </div>
                              ) : (
                                <div className="formrow formrow--tight">
                                  <button
                                    className="btn btn--primary" disabled={busy || preview.warnings.some((w) => w.blocking)}
                                    onClick={handleSave}
                                  >
                                    Save this race
                                  </button>
                                  <button className="btn" disabled={busy} onClick={handleCancelPreview}>Cancel</button>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>

            <div className="formrow formrow--tight" style={{ marginTop: 16 }}>
              {allGenerated
                ? <button className="btn btn--primary" onClick={onClose}>All races generated - Close</button>
                : <button className="btn" onClick={onClose}>Close</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
