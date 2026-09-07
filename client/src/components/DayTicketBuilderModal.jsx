import React, { useEffect, useState } from 'react';
import { deleteHumanTicket, getReplayDayRaces, listCards, lockHumanCard, previewHumanCard } from '../api.js';
import { clearDraft, loadDayDrafts, saveDraft } from '../drafts.js';
import TicketBuilder from './TicketBuilder.jsx';
import EntriesTable from './EntriesTable.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The day-level ticket builder (D87; opened from BOTH the Replay day landing
// and the ordinary /day view since D98). Build several races, then lock them -
// which is exactly the shape PRE_COMMIT was designed to detect: every lock
// lands before any reveal, so shared/replay.js's computeBlindness (max lock
// vs. min reveal) reads the card as genuinely pre-committed.
//
// `context` changes NOTHING but the wording. A card built on a live race day
// and a card built by replaying a past one are the same HUMAN card - same
// template, same engine_version, same bucket, same derived blindness - and
// keeping one component is what guarantees that. Only the framing differs:
// on a live day there is no result to be blind to yet, so "before any reveal"
// is better said as "before the gates open".
//
// Structure is LlmCardModal.jsx's, deliberately: same modal chrome, same
// per-race collapsible cards, same sequential save loop threading a local
// cardId because the first save is what mints it. The builder itself is the
// same TicketBuilder ReplayRaceView mounts inline - it produces TEXT, and this
// modal posts that text to D54's own endpoints, so the server still re-parses
// independently (invariant 9) and nothing here constructs a ticket.
//
// D103: CLOSING THE DIALOG LOCKS EVERY RACE THAT HAS A CLEAN PREVIEW. A
// preview is the deliberate act - it is already "read-only, exactly what Lock
// will store" - so closing commits it rather than discarding it, and the
// footer button says so whenever there is something to commit. Races with text
// but no preview, or a preview carrying a blocking warning, are left as drafts
// (D102): nothing is ever saved that the server has not agreed to.
//
// A race that is already locked is shown read-only and can only be DELETED,
// ticket by ticket - never edited. That asymmetry is the blindness rule, not
// squeamishness: re-locking re-stamps `picks_locked_at`, which is exactly what
// `computeBlindness` reads (invariant 15), so an edit here could silently flip
// a card from PRE_COMMIT to SEQUENTIAL. A delete touches no timestamp. Editing
// proper still lives in the race view, which owns that rule.
//
// D102: a race BUILT but not LOCKED is kept as a draft (client/src/drafts.js)
// and restored the next time the modal opens on this day, so closing it no
// longer throws the work away. A restored draft shows as read-only text on
// the collapsed race card; TicketBuilder is a one-way text producer that
// starts empty and emits '' on mount, so opening the race to build again
// starts fresh rather than reloading the draft into it.
//
// D139: card identity - which human card this session builds onto, its
// name, and "start a new one" - is resolved and managed ENTIRELY INSIDE this
// modal, the same way LlmCardModal.jsx owns its own card/model identity
// (D75/D76). D137 first tried putting the picker and name field in the
// panel that opens this modal (CardsPanel.jsx / ReplayDayLanding.jsx); that
// split management across two components for no reason a caller ever needed
// to know which card id they were passing, so it is undone here - callers
// pass only `dayId`, `bankrollCents` and `context`, nothing card-specific.
export default function DayTicketBuilderModal({
  dayId, bankrollCents, onClose, onCardChanged, context = 'replay',
}) {
  const live = context === 'live';
  const [cardId, setCardId] = useState(null);
  const [cardNumber, setCardNumber] = useState(null);
  const [cardName, setCardName] = useState(null); // the RESOLVED name of `cardId`, once one exists
  const [newCardName, setNewCardName] = useState(''); // draft name, editable only while cardId is null
  const [races, setRaces] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [textByRace, setTextByRace] = useState(() => new Map());
  const [draftAt, setDraftAt] = useState(() => new Map());
  const [previewByRace, setPreviewByRace] = useState(() => new Map());
  const [correlationId, setCorrelationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  // D139: resume the day's own latest human card on open - the same D98
  // resume rule, now resolved HERE rather than by whichever panel opened
  // this modal. Also the source of truth for `cardName`/`cardNumber` after
  // any lock, so re-run it whenever a save might have minted or added to a
  // card, not just on mount.
  const loadCard = () => listCards(dayId).then((cards) => {
    const human = cards.filter((c) => c.template === 'human').sort((a, b) => b.card_number - a.card_number);
    const latest = human[0] ?? null;
    setCardId(latest?.id ?? null);
    setCardNumber(latest?.card_number ?? null);
    setCardName(latest?.name ?? null);
  }).catch(() => {});
  useEffect(() => { loadCard(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => getReplayDayRaces(dayId, cardId)
    .then((d) => setRaces(d.races))
    .catch((e) => setError(String(e.message)));
  // Wrapped so the effect returns undefined, never the promise `reload`
  // hands back: React treats an effect's return value as its cleanup and
  // calls it on unmount, so a bare `useEffect(reload, ...)` here threw
  // "destroy is not a function" the moment the modal closed and took the
  // whole app down with it. Same shape as CardsPanel/ConsensusPanel.
  useEffect(() => { reload(); }, [dayId, cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Restore this day's drafts once. Deliberately not merged into the reload
  // effect: that one re-runs whenever the card id changes (the first lock
  // mints it), and re-reading storage there would resurrect a draft the lock
  // had just cleared.
  useEffect(() => {
    const stored = loadDayDrafts(dayId);
    if (stored.size === 0) return;
    setTextByRace(new Map(Array.from(stored, ([n, d]) => [n, d.text])));
    setDraftAt(new Map(Array.from(stored, ([n, d]) => [n, d.savedAt])));
  }, [dayId]);

  const setText = (n, t) => {
    setTextByRace((m) => new Map(m).set(n, t));
    const savedAt = saveDraft(dayId, n, t);
    setDraftAt((m) => {
      const next = new Map(m);
      if (savedAt) next.set(n, savedAt); else next.delete(n);
      return next;
    });
  };

  // Forget one race's draft everywhere at once - storage, text, timestamp,
  // preview. Called on lock, on PASS, and by the explicit Discard draft.
  const forgetDraft = (n) => {
    clearDraft(dayId, n);
    setTextByRace((m) => { const next = new Map(m); next.delete(n); return next; });
    setDraftAt((m) => { const next = new Map(m); next.delete(n); return next; });
    setPreviewByRace((m) => { const next = new Map(m); next.delete(n); return next; });
  };
  const toggleOpen = (n) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });

  const handlePreview = async (n) => {
    setBusy(true); setError(null);
    try {
      const p = await previewHumanCard(dayId, n, textByRace.get(n) ?? '', cardId, correlationId);
      if (p.correlationId) setCorrelationId(p.correlationId);
      setPreviewByRace((m) => new Map(m).set(n, p));
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  // One race's save. Returns the (possibly newly minted) card id so the batch
  // loop below can thread it through - React state does not apply mid-loop,
  // which is the same reason LlmCardModal's handleRegenerateAll uses a local.
  // `name` only takes effect on the call that mints the card (localCardId
  // still null) - the server ignores it once a card already exists (D137,
  // mirrors llm_model's frozen-at-creation rule) - so it is only ever the
  // freshly-typed `newCardName`, never the already-resolved `cardName`.
  const saveRace = async (n, localCardId, localCorrelationId) => {
    const r = await lockHumanCard(
      dayId,
      { race: n, text: textByRace.get(n) ?? '', bankrollCents, cardId: localCardId, name: localCardId ? undefined : (newCardName.trim() || null) },
      localCorrelationId,
    );
    return { cardId: r.cardId ?? localCardId, correlationId: r.correlationId ?? localCorrelationId };
  };

  const handleLockOne = async (n) => {
    setBusy(true); setError(null);
    try {
      const r = await saveRace(n, cardId, correlationId);
      setCardId(r.cardId); setCorrelationId(r.correlationId);
      forgetDraft(n);
      await reload();
      await loadCard();
      onCardChanged?.();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const handlePass = async (n) => {
    setBusy(true); setError(null);
    try {
      const r = await lockHumanCard(dayId, {
        race: n, pass: true, bankrollCents, cardId, name: cardId ? undefined : (newCardName.trim() || null),
      }, correlationId);
      setCardId(r.cardId ?? cardId);
      forgetDraft(n);
      await reload();
      await loadCard();
      onCardChanged?.();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  // Lock every race that has a clean preview, in race order. A race whose
  // preview is missing or blocking is skipped and the run continues - one bad
  // race never stops the rest, the same rule LlmCardModal's batch loop follows.
  const pending = (races ?? []).filter((r) => {
    if (r.locked) return false;
    const p = previewByRace.get(r.raceNumber);
    return p && p.tickets.length > 0 && !p.warnings.some((w) => w.blocking);
  });

  const lockPending = async () => {
    setBusy(true); setError(null); setResults(null);
    let localCard = cardId;
    let localCorr = correlationId;
    const out = [];
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i].raceNumber;
      setProgress(`Locking race ${n} (${i + 1} of ${pending.length})…`);
      try {
        const r = await saveRace(n, localCard, localCorr);
        localCard = r.cardId; localCorr = r.correlationId;
        out.push({ race: n, status: 'locked' });
        // Per race, not wholesale: a race that FAILED must keep its text and
        // its draft, or the batch would eat exactly the work worth keeping.
        forgetDraft(n);
      } catch (e) {
        out.push({ race: n, status: 'error', detail: String(e.message) });
      }
    }
    setCardId(localCard); setCorrelationId(localCorr);
    setProgress(null); setResults(out);
    await reload();
    await loadCard();
    onCardChanged?.();
    setBusy(false);
    return out;
  };

  // D139: stop resuming this day's latest human card so the next lock mints
  // a brand-new one (D28 already allows this - the modal simply never
  // exposed the path before, unlike LlmCardModal's "Start a New Card",
  // D75). The old card is untouched, still visible in the Betting cards
  // table. Deliberately does NOT clear textByRace/drafts: a draft is a
  // property of (day, race), not of a card, so unsaved text a user typed
  // survives switching which card it will eventually lock onto.
  const handleStartNewCard = () => {
    if (busy) return;
    setCardId(null);
    setCardNumber(null);
    setCardName(null);
    setNewCardName('');
    setPreviewByRace(new Map());
    setOpen(new Set());
    setResults(null);
    setError(null);
  };

  // Closing IS the commit (D103). A failure keeps the dialog open with its
  // results block showing, rather than closing over an error nobody saw.
  const handleClose = async () => {
    if (busy) return;
    if (pending.length === 0) { onClose(); return; }
    const out = await lockPending();
    if (out.some((r) => r.status !== 'locked')) return;
    onClose();
  };

  // The Escape handler is registered once but must call the CURRENT close,
  // which closes over `pending` - hence the ref.
  const closeRef = React.useRef(handleClose);
  closeRef.current = handleClose;

  const handleDeleteTicket = async (ticketId) => {
    setBusy(true); setError(null);
    try {
      await deleteHumanTicket(cardId, ticketId, correlationId);
      await reload();
      onCardChanged?.();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const totalStaged = pending.reduce((a, r) => a + (previewByRace.get(r.raceNumber)?.raceCostCents ?? 0), 0);
  // Drafts still held: an unlocked race with text. Counted off the races the
  // server says are unlocked, so a draft for a race locked in another tab is
  // never advertised as pending work.
  const draftCount = (races ?? []).filter(
    (r) => !r.locked && (textByRace.get(r.raceNumber) ?? '').trim(),
  ).length;
  const anyRevealed = (races ?? []).some((r) => r.revealed);
  // The name to SHOW: the resolved name of an existing card, or whatever is
  // being typed for a not-yet-minted one - never both at once, since typing
  // is only possible while cardId is null.
  const displayName = cardId ? cardName : (newCardName.trim() || null);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={live ? 'Build the card by hand' : 'Build tickets for the day'}>
        <div className="modal__header">
          <h3>
            {live ? 'Build the card by hand' : 'Build tickets for the day'}
            {displayName && <span className="dim"> — “{displayName}”</span>}
          </h3>
          <button className="modal__close" disabled={busy} onClick={handleClose} aria-label="Close">×</button>
        </div>

        <div className="modal__body">
          {error && <p className="notice notice--error">{error}</p>}
          {anyRevealed && (
            <p className="notice notice--warn">
              A race on this card has already been revealed, so this day is no longer a blind pre-commit.
              Races you lock from here on are recorded as Sequential.
            </p>
          )}
          <p className="dim">
            {live
              ? <>Build the card you'll actually play, then lock the races together before the gates open.
                  Bankroll {money(bankrollCents)}.</>
              : <>Build as many races as you like, then lock them together — every lock landing before any
                  reveal is what makes the card read as Pre-commit. Bankroll {money(bankrollCents)}.</>}
          </p>
          <p className="dim">
            <strong>Closing this dialog locks every race you have previewed</strong> — a preview is already
            exactly what Lock would store, so it is committed rather than thrown away. A race you built but
            did not preview (or whose preview is blocking) is kept as a draft on this browser instead, and
            comes back the next time you open this day. A locked race can then be deleted ticket by ticket,
            but not edited.
          </p>
          {live && (
            <p className="dim">
              A locked card is not finished. It grades itself when you save the day's results, but its
              blindness reads <em>undetermined</em> until you reveal those results from Replay and close
              the day — only then is it recorded as a Pre-commit and counted in the standing table.
              Until then it is a card in progress, not a missing one.
            </p>
          )}

          {/* D139: card identity lives here, not in the panel that opened
              this modal - mirrors LlmCardModal's Model row + "Start a New
              Card" (D75). Resuming an existing card shows its name (if any)
              read-only, since a name is frozen at creation like llm_model;
              a not-yet-minted card offers the name field instead. */}
          <div className="formrow formrow--tight">
            {cardId != null ? (
              <>
                <span className="dim">
                  Building onto card #{cardNumber}{cardName ? ` — “${cardName}”` : ''}.
                </span>
                <button
                  className="btn btn--sm" disabled={busy} onClick={handleStartNewCard}
                  title="Start a brand-new human card instead of adding to this one - the current card stays in the Betting cards table"
                >
                  Start a New Card
                </button>
              </>
            ) : (
              <label>
                New card's name (optional){' '}
                <input
                  className="in in--sm" value={newCardName} placeholder="e.g. Aggressive" disabled={busy}
                  onChange={(e) => setNewCardName(e.target.value)}
                />
              </label>
            )}
          </div>

          {!races ? <p className="placeholder">Loading…</p> : (
            <div className="race-grid">
              {races.map((r) => {
                const p = previewByRace.get(r.raceNumber);
                const blocking = p?.warnings.some((w) => w.blocking);
                const status = r.revealed ? 'Revealed' : r.pass ? 'Passed' : r.locked ? 'Locked' : 'Not played';
                const draftText = (textByRace.get(r.raceNumber) ?? '').trim();
                const hasDraft = !r.locked && draftText.length > 0;
                return (
                  <article className="race-card" key={r.raceNumber}>
                    <div className="race-card__header">
                      <strong>Race {r.raceNumber}</strong>
                      <span className="dim">{r.distance ?? '?'} · {r.raceType ?? '?'}</span>
                      <span className={`chip${r.locked ? ' chip--human' : ''}`}>{status}</span>
                      {hasDraft && <span className="tag tag--gold">draft</span>}
                      {!r.locked && (
                        <button className="btn btn--sm" disabled={busy} onClick={() => toggleOpen(r.raceNumber)}>
                          {open.has(r.raceNumber) ? 'Collapse' : 'Build'}
                        </button>
                      )}
                    </div>

                    <EntriesTable entries={r.entries ?? []} />

                    {r.locked && Array.isArray(r.tickets) && r.tickets.length > 0 && (
                      <>
                        <table className="grid">
                          <thead>
                            <tr>
                              <th>Bet type</th><th>Say to the teller</th><th>Cost</th>
                              {!r.revealed && <th />}
                            </tr>
                          </thead>
                          <tbody>
                            {r.tickets.map((t, i) => (
                              <tr key={t.id ?? i}>
                                <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
                                <td className="teller">{t.tellerCall}</td>
                                <td>{money(t.costCents)}</td>
                                {!r.revealed && (
                                  <td>
                                    <button className="btn btn--sm btn--danger" disabled={busy || t.id == null}
                                      onClick={() => handleDeleteTicket(t.id)}>Delete</button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!r.revealed && (
                          <p className="dim">
                            Locked tickets can be deleted, not edited — editing would re-stamp when this race
                            was locked. Delete the last one and the race is yours to build again.
                          </p>
                        )}
                      </>
                    )}
                    {r.locked && r.pass && <p className="dim">PASSED this race.</p>}

                    {hasDraft && !open.has(r.raceNumber) && (
                      <p className="dim draft-line">
                        <code>{draftText}</code>
                        <br />saved, not yet locked — open to preview and lock it
                      </p>
                    )}

                    {!r.locked && open.has(r.raceNumber) && (
                      <>
                        <TicketBuilder
                          raceNumber={r.raceNumber}
                          entries={r.entries ?? []}
                          wagerMenu={r.wagerMenu}
                          disabled={busy}
                          onChange={(t) => setText(r.raceNumber, t)}
                        />
                        <div className="formrow formrow--tight">
                          <button className="btn btn--sm" disabled={busy || !(textByRace.get(r.raceNumber) ?? '').trim()}
                            onClick={() => handlePreview(r.raceNumber)}>Preview</button>
                          <button className="btn btn--sm btn--primary" disabled={busy || !p || blocking}
                            onClick={() => handleLockOne(r.raceNumber)}>Lock race {r.raceNumber}</button>
                          <button className="btn btn--sm" disabled={busy} onClick={() => handlePass(r.raceNumber)}>PASS</button>
                          {hasDraft && (
                            <button className="btn btn--sm" disabled={busy}
                              onClick={() => forgetDraft(r.raceNumber)}>Discard draft</button>
                          )}
                        </div>
                        {p && (
                          <>
                            {p.warnings.length > 0 && (
                              <div className={`notice ${blocking ? 'notice--error' : 'notice--warn'}`}>
                                <ul>{p.warnings.map((w, i) => <li key={i}>{w.blocking ? <strong>BLOCKING: </strong> : null}{w.message}</li>)}</ul>
                              </div>
                            )}
                            {p.overBankroll && <p className="notice notice--warn">This would put the card over its bankroll.</p>}
                            <p className="dim">
                              Previewed: {p.tickets.length} ticket{p.tickets.length === 1 ? '' : 's'} · {money(p.raceCostCents)}
                              {' '}— read-only, exactly what Lock will store.
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {results && (
            <div className="notice">
              <p><strong>Locked {results.filter((r) => r.status === 'locked').length} of {results.length} race(s).</strong></p>
              {results.filter((r) => r.status !== 'locked').length > 0 && (
                <ul>{results.filter((r) => r.status !== 'locked').map((r, i) => <li key={i}>Race {r.race}: {r.detail}</li>)}</ul>
              )}
            </div>
          )}
        </div>

        <div className="modal__footer">
          {progress && <span className="dim">{progress}</span>}
          <span className="dim">
            {pending.length} race{pending.length === 1 ? '' : 's'} previewed and ready · {money(totalStaged)}
            {draftCount > 0 && <> · {draftCount} draft{draftCount === 1 ? '' : 's'} kept</>}
          </span>
          <div className="modal__footer-actions">
            <button className="btn btn--primary" disabled={busy || pending.length === 0} onClick={lockPending}>
              Lock all previewed races
            </button>
            <button className="btn" disabled={busy} onClick={handleClose}>
              {pending.length > 0 ? `Lock ${pending.length} & close` : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
