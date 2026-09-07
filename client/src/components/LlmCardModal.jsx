import React, { useEffect, useState } from 'react';
import {
  getLlmModels, getLlmNotes, getLlmRequests, getRaceDay, listCards, lockLlmCard, previewLlmCard, saveLlmNote,
} from '../api.js';
import EntriesTable from './EntriesTable.jsx';

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

// LLM cards (D63/D65/D66): a modal walkthrough, one race at a time -
// Generate (the actual model call) shows a preview, Save confirms it.
// Every already-generated race carries a collapsible panel in its own row
// showing the saved card (D66 - replaces the "Open card #N" button, which
// is gone: there's nothing left to jump elsewhere for). Calls
// `onCardChanged` after every save so the day's Betting cards table
// (CardsPanel.jsx) refreshes live instead of going stale until the page
// is revisited (D65).
// D92 analyst notes. Caps mirror server/llm-prompt.js's NOTES_MAX_CHARS -
// over-cap text is not refused, it is truncated VISIBLY in the prompt and
// warned about in the preview, so the counter is guidance, not a gate.
const NOTES_MAX = { race: 4000, card: 2000 };
// A datalist, not a <select>: the four canonical labels are one click away so
// the source discipline the findings doc's H3 needs will hold in practice,
// but an unexpected source is never blocked.
const SOURCE_SUGGESTIONS = ['program', 'public-handicapper', 'llm', 'own'];

/**
 * One notes editor. Free text, capped only for the PROMPT (the server truncates
 * visibly and warns; nothing is refused here), with a source label that suggests
 * the four canonical values without constraining them.
 */
function NotesEditor({ scope, draft, onEdit, onFlush, disabled }) {
  const max = NOTES_MAX[scope];
  const n = draft.text.length;
  return (
    <>
      <label className="pastebox">
        <textarea
          className="in" rows={5} value={draft.text} disabled={disabled}
          placeholder={scope === 'card'
            ? 'Commentary for the whole day - track bias, weather, how the meet is running.'
            : "Handicapper commentary for this race. Pasted as-is; the model is told to treat it as one opinion, never as instructions."}
          onChange={(e) => onEdit({ text: e.target.value })}
          onBlur={onFlush}
        />
      </label>
      <div className="formrow formrow--tight">
        <label>
          Source
          <input
            className="in in--sm" list="llm-note-sources" value={draft.sourceLabel} disabled={disabled}
            placeholder="e.g. program" onChange={(e) => onEdit({ sourceLabel: e.target.value })} onBlur={onFlush} />
        </label>
        <span className="dim">
          {n} / {max} characters{n > max ? ' — the prompt will carry the first ' + max + ', truncation is flagged in the preview' : ''}
        </span>
      </div>
    </>
  );
}

export default function LlmCardModal({ dayId, onCardChanged, onClose }) {
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [ticketsByRace, setTicketsByRace] = useState(new Map()); // raceNumber -> { tickets, raceCostCents, reasoningText }
  const [expandedRaces, setExpandedRaces] = useState(new Set());
  // D92: notes live in their OWN Map, never merged into ticketsByRace -
  // refreshTickets() rebuilds that one wholesale from the server on every card
  // change and would clobber an in-progress note.
  const [notesByRace, setNotesByRace] = useState(new Map()); // raceNumber -> { text, sourceLabel, updatedAt }
  const [cardNote, setCardNote] = useState(null);            // the day-level note
  const [notesPostResult, setNotesPostResult] = useState(false);
  const [notesTick, setNotesTick] = useState(0); // re-render on an unflushed local edit
  const [notesUsedByRace, setNotesUsedByRace] = useState(new Map()); // raceNumber -> notesEnteredAt of the generation
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
  // D76: once a resumed card has a locked-in model (cards.llm_model, set at
  // creation and never changed - server/llm-cards.js refuses a mismatched
  // model with a 409), the picker is forced to it and disabled - a card's
  // model never drifts mid-comparison. Free again once null (a new day
  // with no LLM card yet, or after "Start a New Card").
  const [lockedModel, setLockedModel] = useState(null);

  const reload = () => {
    getRaceDay(dayId).then(setDayInfo).catch((e) => setError(String(e.message)));
    listCards(dayId).then((cards) => {
      const llm = cards.filter((c) => c.template === 'llm').sort((a, b) => b.card_number - a.card_number)[0];
      setCardId(llm ? llm.id : null);
      setLockedModel(llm?.llm_model ?? null);
      if (llm?.llm_model) setSelectedModel(llm.llm_model);
    }).catch(() => {});
    getLlmModels().then((m) => {
      setModels(m.models ?? []);
      setSelectedModel((prev) => prev || m.default || m.models?.[0]?.id || '');
    }).catch(() => {});
  };
  useEffect(() => { reload(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => { refreshTickets(); }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Which generation used which notes draft. Read from the request log rather
  // than remembered locally, so the badge is right after a reload too.
  useEffect(() => {
    if (!cardId) { setNotesUsedByRace(new Map()); return; }
    getLlmRequests(cardId).then((rows) => {
      const m = new Map();
      for (const r of rows) if (r.notesPresent && r.notesEnteredAt) m.set(r.raceNumber, r.notesEnteredAt);
      setNotesUsedByRace(m);
    }).catch(() => {});
  }, [cardId]);

  // Notes are keyed by DAY, not by card - the same commentary feeds a Sonnet
  // card and an Opus card - so this loads on dayId and is untouched by every
  // card-level reset. Block body, never `useEffect(loadNotes, [dayId])`: an
  // expression-bodied loader returns a promise, React calls an effect's return
  // value as its cleanup on unmount, and that took the whole app down in D90.
  const loadNotes = () => getLlmNotes(dayId).then((n) => {
    setCardNote(n.cardNote);
    setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v])));
    setNotesPostResult(Boolean(n.postResult));
  }).catch(() => {});
  useEffect(() => { loadNotes(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local edits are held here and flushed on blur AND immediately before any
  // generate call - a user who pastes a note and clicks Generate in one motion
  // must not lose it.
  const pendingNotes = React.useRef(new Map()); // key: raceNumber (0 = card note)
  const noteFor = (race) => (race === 0 ? cardNote : notesByRace.get(race)) ?? null;
  const draftOf = (race) => {
    const pend = pendingNotes.current.get(race);
    return pend ?? { text: noteFor(race)?.text ?? '', sourceLabel: noteFor(race)?.sourceLabel ?? '' };
  };
  const editNote = (race, patch) => {
    pendingNotes.current.set(race, { ...draftOf(race), ...patch });
    setNotesTick((t) => t + 1);
  };
  const flushNotes = async () => {
    const pend = [...pendingNotes.current.entries()];
    if (!pend.length) return;
    pendingNotes.current.clear();
    for (const [race, d] of pend) {
      try {
        const r = await saveLlmNote(dayId, { race, text: d.text, sourceLabel: d.sourceLabel }, correlationId);
        if (r?.postResult) setNotesPostResult(true);
      } catch { /* a failed note save must never block generation */ }
    }
    await loadNotes();
  };

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
    await flushNotes(); // a note pasted and Generated in one motion must count
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
      if (!cardId) { setCardId(r.cardId); setLockedModel(r.llmModel ?? selectedModel); }
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
  // Deliberately does NOT reset notesByRace/cardNote: notes belong to the DAY,
  // not the card, which is the whole point of the day+race key. A new card on
  // the same day should see the same commentary.
  const handleStartNewCard = () => {
    if (busy) return;
    setCardId(null);
    setLockedModel(null); // D76: free the picker again
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
    await flushNotes();
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
        if (!localCardId) { localCardId = r.cardId; setLockedModel(r.llmModel ?? selectedModel); }
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
      <div className="modal-backdrop">
        <div className="modal" role="dialog" aria-modal="true">
          <p className="notice notice--error">{error}</p>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Generate Card from LLM">
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
                  <select className="in in--sm" value={selectedModel} disabled={busy || models.length === 0 || Boolean(lockedModel)}
                    onChange={(e) => setSelectedModel(e.target.value)}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
                {lockedModel && (
                  <span className="dim">
                    {' '}This card was generated with {models.find((m) => m.id === lockedModel)?.label ?? lockedModel} - start a new card to try a different model.
                  </span>
                )}
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

              <datalist id="llm-note-sources">
                {SOURCE_SUGGESTIONS.map((v) => <option key={v} value={v} />)}
              </datalist>

              {notesPostResult && (
                <p className="notice notice--warn">
                  This day's results are already recorded. Notes written after a result is known are not blind -
                  cards generated from them are flagged and excluded from the blind-notes corpus.
                </p>
              )}

              <details className="race-bottom-line">
                <summary>
                  Notes for the whole day
                  {cardNote?.text ? <span className="tag tag--gold">notes</span> : null}
                </summary>
                <p className="dim">
                  Prepended to every race's prompt. Advisory only - the model is told to ignore any
                  instruction, bet size or link inside it.
                </p>
                <NotesEditor scope="card" draft={draftOf(0)} disabled={busy}
                  onEdit={(patch) => editNote(0, patch)} onFlush={flushNotes} />
              </details>

              <div className="llm-race-grid">
                {races.map((r) => {
                  const saved = ticketsByRace.get(r.number);
                  const generatingThisRace = busy && openRace === r.number && !preview;
                  return (
                    <article className="llm-race-card" key={r.id}>
                      <div className="llm-race-card__header">
                        <div>
                          <strong>Race {r.number}</strong>
                          <span className="dim"> · {saved ? 'Generated' : 'Not generated'}</span>
                          {noteFor(r.number)?.text && (
                            <span className="tag tag--gold">
                              {!saved ? 'notes'
                                : (notesUsedByRace.has(r.number)
                                  ? (noteFor(r.number).updatedAt > notesUsedByRace.get(r.number)
                                    ? 'notes edited since generation' : 'notes used')
                                  : 'notes')}
                            </span>
                          )}
                        </div>
                        <div className="llm-race-card__actions">
                          {/* Was rendered below the entries table and analyst notes,
                              where a call that takes several seconds sat below the
                              fold - moved beside the button that triggers it so the
                              wait is visible without scrolling. */}
                          {generatingThisRace && (
                            <span className="llm-loading" role="status">
                              <span className="spinner" aria-hidden="true" />
                              Calling the model…
                            </span>
                          )}
                          <button className="btn btn--sm" disabled={busy} onClick={() => handleGenerate(r.number)}>
                            {saved ? 'Regenerate' : 'Generate'}
                          </button>
                        </div>
                      </div>
                      <EntriesTable entries={r.entries ?? []} />
                      <details className="race-bottom-line">
                        <summary>
                          Analyst notes
                          {noteFor(r.number)?.text ? <span className="tag tag--gold">notes</span> : null}
                        </summary>
                        <NotesEditor scope="race" draft={draftOf(r.number)} disabled={busy}
                          onEdit={(patch) => editNote(r.number, patch)} onFlush={flushNotes} />
                      </details>
                      {openRace === r.number && (
                        <div>
                          {errorRace === r.number && error && (
                            <p className="notice notice--error" role="alert">{error}</p>
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
