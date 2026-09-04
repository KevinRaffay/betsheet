import React, { useEffect, useState } from 'react';
import { getLlmModels, getRaceDay, listCards, lockLlmCard, previewLlmCard } from '../api.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// A ticket may come from a live preview (parseHumanPicksText's camelCase
// shape: betType/costCents/tellerCall/legs) or a saved DB row (snake_case:
// bet_type/cost_cents/teller_call/selections.legs) - normalize once so the
// same table renders either.
const normalizeTicket = (t) => ({
  betType: t.betType ?? t.bet_type,
  legsText: (t.legs ?? t.selections?.legs ?? []).map((l) => l.join(',')).join(' / '),
  tellerCall: t.tellerCall ?? t.teller_call,
  estMinCents: t.estMinCents ?? t.est_payout_min_cents,
  estMaxCents: t.estMaxCents ?? t.est_payout_max_cents,
  estIsRange: t.estIsRange ?? Boolean(t.est_is_range),
  costCents: t.costCents ?? t.cost_cents,
  rationaleText: t.rationale_text ?? t.rationaleText,
});

const estDisplay = (ticket) => {
  if (ticket.estMinCents == null) return '—';
  if (!ticket.estIsRange) return money(ticket.estMinCents);
  return `${money(ticket.estMinCents)}–${money(ticket.estMaxCents)} (est.)`;
};

function TicketsTable({ tickets, totalCents }) {
  if (!tickets.length) return <p className="dim">No tickets on this race.</p>;
  return (
    <table className="grid">
      <thead><tr><th>Bet type</th><th>Selections / rationale</th><th>Say to the teller</th><th>If it hits</th><th>Cost</th></tr></thead>
      <tbody>
        {tickets.map(normalizeTicket).map((t, i) => (
          <tr key={i}>
            <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
            <td>{t.legsText}{t.rationaleText ? <span className="dim"> — {t.rationaleText}</span> : null}</td>
            <td className="teller">{t.tellerCall}</td>
            <td>{estDisplay(t)}</td>
            <td>{money(t.costCents)}</td>
          </tr>
        ))}
        <tr className="row--subtotal"><td colSpan={4}>Race total</td><td>{money(totalCents)}</td></tr>
      </tbody>
    </table>
  );
}

function EntriesTable({ entries }) {
  return (
    <details className="race-entries">
      <summary>Entries ({entries.length})</summary>
      <table className="grid grid--entries">
        <thead>
          <tr><th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th><th>Rank</th></tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className={entry.scratched ? 'row--scratched' : ''}>
              <td>{entry.program_number ?? '—'}</td>
              <td>{entry.horse_name}</td>
              <td>{entry.jockey ?? '—'}</td>
              <td>{entry.trainer ?? '—'}</td>
              <td>{entry.morning_line ?? '—'}</td>
              <td>{entry.program_rank ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// LLM cards (D63/D65/D66): a modal walkthrough, one race at a time -
// Generate (the actual model call) shows a preview, Save confirms it.
// Every already-generated race carries a collapsible panel in its own row
// showing the saved card (D66 - replaces the "Open card #N" button, which
// is gone: there's nothing left to jump elsewhere for). Calls
// `onCardChanged` after every save so the day's Betting cards table
// (CardsPanel.jsx) refreshes live instead of going stale until the page
// is revisited (D65).
export default function LlmCardModal({ dayId, onCardChanged, onClose }) {
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [ticketsByRace, setTicketsByRace] = useState(new Map()); // raceNumber -> { tickets, raceCostCents, reasoningText }
  const [expandedRaces, setExpandedRaces] = useState(new Set());
  const [openRace, setOpenRace] = useState(null); // race actively being generated/previewed (unsaved)
  const [lastSavedRace, setLastSavedRace] = useState(null);
  const [preview, setPreview] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [errorRace, setErrorRace] = useState(null);
  const [regenerateAllProgress, setRegenerateAllProgress] = useState(null); // { index, total, raceNumber }
  const [regenerateAllResults, setRegenerateAllResults] = useState(null); // [{ race, status: 'saved'|'blocked'|'error', message }]
  const [models, setModels] = useState([]); // D75: [{id, label}]
  const [selectedModel, setSelectedModel] = useState('');

  const reload = () => {
    getRaceDay(dayId).then(setDayInfo).catch((e) => setError(String(e.message)));
    listCards(dayId).then((cards) => {
      const llm = cards.filter((c) => c.template === 'llm').sort((a, b) => b.card_number - a.card_number)[0];
      setCardId(llm ? llm.id : null);
    }).catch(() => {});
    getLlmModels().then((m) => {
      setModels(m.models ?? []);
      setSelectedModel((prev) => prev || m.default || m.models?.[0]?.id || '');
    }).catch(() => {});
  };
  useEffect(reload, [dayId]);

  const refreshTickets = (requestedCardId = cardId) => {
    if (!requestedCardId) { setTicketsByRace(new Map()); return; }
    fetch(`/api/cards/${requestedCardId}`).then((r) => r.json()).then((c) => {
      const numberByRaceId = new Map((c.races ?? []).map((r) => [r.id, r.number]));
      const byRace = new Map();
      for (const allocation of c.allocations ?? []) {
        const num = allocation.race_number;
        if (num == null) continue;
        byRace.set(num, {
          tickets: [],
          raceCostCents: allocation.amount_cents ?? 0,
          reasoningText: allocation.thesis ?? '',
        });
      }
      for (const t of c.tickets ?? []) {
        const num = numberByRaceId.get(t.race_id);
        if (num == null) continue;
        if (!byRace.has(num)) byRace.set(num, { tickets: [], raceCostCents: 0, reasoningText: '' });
        const entry = byRace.get(num);
        entry.tickets.push(t);
        entry.raceCostCents += t.cost_cents;
      }
      setTicketsByRace(byRace);
    }).catch(() => {});
  };
  useEffect(refreshTickets, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape, from anywhere in the dialog.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const races = dayInfo?.races ?? [];
  const firstUngenerated = races.find((r) => r.number !== lastSavedRace && !ticketsByRace.has(r.number));
  const lastSavedIndex = lastSavedRace == null
    ? -1
    : races.findIndex((r) => r.number === lastSavedRace);
  const nextUngenerated = races.slice(lastSavedIndex + 1).find((r) => !ticketsByRace.has(r.number))
    ?? firstUngenerated;
  const allGenerated = races.length > 0 && races.every((r) => ticketsByRace.has(r.number));

  const toggleExpanded = (raceNumber, open) => {
    setExpandedRaces((prev) => {
      const next = new Set(prev);
      if (open) next.add(raceNumber); else next.delete(raceNumber);
      return next;
    });
  };

  const handleGenerate = async (raceNumber) => {
    setOpenRace(raceNumber);
    setPreview(null);
    setErrorRace(null);
    setBusy(true);
    setError(null);
    try {
      const p = await previewLlmCard(dayId, raceNumber, cardId, correlationId, selectedModel);
      if (p.correlationId) setCorrelationId(p.correlationId);
      setPreview(p);
    } catch (e) {
      setErrorRace(raceNumber);
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
      const savedRace = openRace;
      setLastSavedRace(savedRace);
      setOpenRace(null);
      setPreview(null);
      refreshTickets(r.cardId);
      toggleExpanded(savedRace, true); // "the card will display" - open its panel right away
      onCardChanged?.();
    } catch (e) {
      setErrorRace(openRace);
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelPreview = () => {
    setOpenRace(null);
    setPreview(null);
    setErrorRace(null);
    setError(null);
  };

  // D75: stop resuming the day's latest LLM card so the next Generate
  // starts a brand-new one (the API already supports this - cardId
  // omitted mints a new card, same D28 append-only convention every other
  // card type follows - the modal just never exposed the path before).
  // The old card is untouched, still visible in the Betting cards table.
  const handleStartNewCard = () => {
    if (busy) return;
    setCardId(null);
    setTicketsByRace(new Map());
    setExpandedRaces(new Set());
    setOpenRace(null);
    setLastSavedRace(null);
    setPreview(null);
    setError(null);
    setErrorRace(null);
    setRegenerateAllResults(null);
    setRegenerateAllProgress(null);
  };

  // Regenerate every race, one call at a time, auto-saving each in place -
  // same generate-then-save operation "Regenerate" already does per race,
  // just run for the whole card in race order. A race whose preview comes
  // back with a BLOCKING warning is left as-is (its previous ticket, if
  // any, is untouched) rather than saved half-broken; the run continues to
  // the next race regardless (invariant-style: one bad race never blocks
  // the rest, same as a missing consensus source never blocks generation).
  const handleRegenerateAll = async () => {
    if (busy || races.length === 0) return;
    setOpenRace(null);
    setPreview(null);
    setErrorRace(null);
    setError(null);
    setRegenerateAllResults(null);
    setBusy(true);
    let localCardId = cardId;
    let localCorrelationId = correlationId;
    const results = [];
    for (let i = 0; i < races.length; i++) {
      const raceNumber = races[i].number;
      setRegenerateAllProgress({ index: i + 1, total: races.length, raceNumber });
      try {
        const p = await previewLlmCard(dayId, raceNumber, localCardId, localCorrelationId, selectedModel);
        if (p.correlationId) localCorrelationId = p.correlationId;
        const blocking = p.warnings.find((w) => w.blocking);
        if (blocking) {
          results.push({ race: raceNumber, status: 'blocked', message: blocking.message });
          continue;
        }
        const r = await lockLlmCard(dayId, {
          race: raceNumber, requestId: p.requestId, bankrollCents: dayInfo.bankroll_cents, cardId: localCardId,
        }, localCorrelationId);
        if (!localCardId) localCardId = r.cardId;
        results.push({ race: raceNumber, status: 'saved' });
      } catch (e) {
        results.push({ race: raceNumber, status: 'error', message: String(e.message) });
      }
      if (localCardId !== cardId) setCardId(localCardId);
      refreshTickets(localCardId); // live feedback race by race, not one batch update at the end
    }
    setCorrelationId(localCorrelationId);
    setRegenerateAllProgress(null);
    setRegenerateAllResults(results);
    onCardChanged?.();
    setBusy(false);
  };

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
        {!dayInfo && <div className="modal__body"><p className="placeholder">Loading…</p></div>}
        {dayInfo && (
          <>
            <div className="modal__body">
              <p className="dim">
                Generate one race at a time - reasoning and the raw model response are logged per race regardless of
                whether you save it.
              </p>
              {error && openRace == null && <p className="notice notice--error">{error}</p>}

              <div className="formrow formrow--tight">
                <label>
                  Model{' '}
                  <select className="in in--sm" value={selectedModel} disabled={busy || models.length === 0}
                    onChange={(e) => setSelectedModel(e.target.value)}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
              </div>

              <div className="formrow formrow--tight">
                <button className="btn" disabled={busy || races.length === 0} onClick={handleRegenerateAll}>
                  Regenerate All Races
                </button>
                <button className="btn" disabled={busy || ticketsByRace.size === 0} onClick={handleStartNewCard}
                  title="Start a brand-new LLM card instead of overwriting the current one - the current card stays in the Betting cards table">
                  Start a New Card
                </button>
                {regenerateAllProgress && (
                  <p className="llm-loading" role="status">
                    <span className="spinner" aria-hidden="true" />
                    Regenerating race {regenerateAllProgress.raceNumber} ({regenerateAllProgress.index} of {regenerateAllProgress.total})…
                  </p>
                )}
              </div>
              {regenerateAllResults && (
                <div className={`notice ${regenerateAllResults.every((r) => r.status === 'saved') ? '' : 'notice--warn'}`}>
                  <p>
                    Regenerate all: {regenerateAllResults.filter((r) => r.status === 'saved').length} of {regenerateAllResults.length} races saved.
                  </p>
                  {regenerateAllResults.some((r) => r.status !== 'saved') && (
                    <ul>
                      {regenerateAllResults.filter((r) => r.status !== 'saved').map((r) => (
                        <li key={r.race}>Race {r.race}: {r.status === 'blocked' ? 'blocked' : 'failed'} — {r.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="llm-race-grid">
                {races.map((r) => {
                  const saved = ticketsByRace.get(r.number);
                  return (
                    <article className="llm-race-card" key={r.id}>
                      <div className="llm-race-card__header">
                        <div>
                          <strong>Race {r.number}</strong>
                          <span className="dim"> · {saved ? 'Generated' : 'Not generated'}</span>
                        </div>
                        <button className="btn btn--sm" disabled={busy} onClick={() => handleGenerate(r.number)}>
                          {saved ? 'Regenerate' : 'Generate'}
                        </button>
                      </div>
                      <EntriesTable entries={r.entries ?? []} />
                      {openRace === r.number && (
                        <div>
                          {errorRace === r.number && error && (
                            <p className="notice notice--error" role="alert">{error}</p>
                          )}
                          {busy && !preview && (
                            <p className="llm-loading" role="status">
                              <span className="spinner" aria-hidden="true" />
                              Calling the model…
                            </p>
                          )}
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
                              {preview.tickets.length > 0 && <TicketsTable tickets={preview.tickets} totalCents={preview.raceCostCents} />}
                              <div className="formrow formrow--tight">
                                <button
                                  className="btn btn--primary" disabled={busy || preview.warnings.some((w) => w.blocking)}
                                  onClick={handleSave}
                                >
                                  Save this race
                                </button>
                                <button className="btn" disabled={busy} onClick={handleCancelPreview}>Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {openRace !== r.number && saved && (
                        <>
                          {saved.reasoningText && (
                            <p className="llm-reasoning"><strong>Model reasoning:</strong> {saved.reasoningText}</p>
                          )}
                          <details
                            className="race-bottom-line"
                            open={expandedRaces.has(r.number)}
                            onToggle={(e) => toggleExpanded(r.number, e.target.open)}
                          >
                            <summary>Race {r.number} card ({money(saved.raceCostCents)})</summary>
                          <TicketsTable tickets={saved.tickets} totalCents={saved.raceCostCents} />
                          </details>
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="modal__footer formrow formrow--tight">
              {nextUngenerated && (
                <button className="btn btn--primary" disabled={busy} onClick={() => handleGenerate(nextUngenerated.number)}>
                  Generate next race (Race {nextUngenerated.number}) →
                </button>
              )}
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
