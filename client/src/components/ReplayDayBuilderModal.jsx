import React, { useEffect, useState } from 'react';
import { getReplayDayRaces, lockHumanCard, previewHumanCard } from '../api.js';
import TicketBuilder from './TicketBuilder.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The day-level ticket builder (D87). Build several races, then lock them -
// which is exactly the shape PRE_COMMIT was designed to detect: every lock
// lands before any reveal, so shared/replay.js's computeBlindness (max lock
// vs. min reveal) reads the card as genuinely pre-committed.
//
// Structure is LlmCardModal.jsx's, deliberately: same modal chrome, same
// per-race collapsible cards, same sequential save loop threading a local
// cardId because the first save is what mints it. The builder itself is the
// same TicketBuilder ReplayRaceView mounts inline - it produces TEXT, and this
// modal posts that text to D54's own endpoints, so the server still re-parses
// independently (invariant 9) and nothing here constructs a ticket.
//
// A race that is already locked is shown read-only. Editing one lives in the
// race view, which owns the blindness rule (re-locking after any reveal would
// flip the card PRE_COMMIT -> SEQUENTIAL); this modal is for building a day
// that has not been played yet, so it never offers to re-lock.
export default function ReplayDayBuilderModal({ dayId, cardId: initialCardId, bankrollCents, onClose, onCardChanged }) {
  const [cardId, setCardId] = useState(initialCardId ?? null);
  const [races, setRaces] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [textByRace, setTextByRace] = useState(() => new Map());
  const [previewByRace, setPreviewByRace] = useState(() => new Map());
  const [correlationId, setCorrelationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const reload = () => getReplayDayRaces(dayId, cardId)
    .then((d) => setRaces(d.races))
    .catch((e) => setError(String(e.message)));
  useEffect(reload, [dayId, cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setText = (n, t) => setTextByRace((m) => new Map(m).set(n, t));
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
  const saveRace = async (n, localCardId, localCorrelationId) => {
    const r = await lockHumanCard(
      dayId,
      { race: n, text: textByRace.get(n) ?? '', bankrollCents, cardId: localCardId },
      localCorrelationId,
    );
    return { cardId: r.cardId ?? localCardId, correlationId: r.correlationId ?? localCorrelationId };
  };

  const handleLockOne = async (n) => {
    setBusy(true); setError(null);
    try {
      const r = await saveRace(n, cardId, correlationId);
      setCardId(r.cardId); setCorrelationId(r.correlationId);
      setPreviewByRace((m) => { const next = new Map(m); next.delete(n); return next; });
      setTextByRace((m) => { const next = new Map(m); next.delete(n); return next; });
      await reload();
      onCardChanged?.();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const handlePass = async (n) => {
    setBusy(true); setError(null);
    try {
      const r = await lockHumanCard(dayId, { race: n, pass: true, bankrollCents, cardId }, correlationId);
      setCardId(r.cardId ?? cardId);
      await reload();
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

  const handleLockAll = async () => {
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
      } catch (e) {
        out.push({ race: n, status: 'error', detail: String(e.message) });
      }
    }
    setCardId(localCard); setCorrelationId(localCorr);
    setProgress(null); setResults(out);
    setPreviewByRace(new Map()); setTextByRace(new Map());
    await reload();
    onCardChanged?.();
    setBusy(false);
  };

  const totalStaged = pending.reduce((a, r) => a + (previewByRace.get(r.raceNumber)?.raceCostCents ?? 0), 0);
  const anyRevealed = (races ?? []).some((r) => r.revealed);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Build tickets for the day" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3>Build tickets for the day</h3>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
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
            Build as many races as you like, then lock them together — every lock landing before any
            reveal is what makes the card read as Pre-commit. Bankroll {money(bankrollCents)}.
          </p>

          {!races ? <p className="placeholder">Loading…</p> : (
            <div className="race-grid">
              {races.map((r) => {
                const p = previewByRace.get(r.raceNumber);
                const blocking = p?.warnings.some((w) => w.blocking);
                const status = r.revealed ? 'Revealed' : r.pass ? 'Passed' : r.locked ? 'Locked' : 'Not played';
                return (
                  <article className="race-card" key={r.raceNumber}>
                    <div className="race-card__header">
                      <strong>Race {r.raceNumber}</strong>
                      <span className="dim">{r.distance ?? '?'} · {r.raceType ?? '?'}</span>
                      <span className={`chip${r.locked ? ' chip--human' : ''}`}>{status}</span>
                      {!r.locked && (
                        <button className="btn btn--sm" disabled={busy} onClick={() => toggleOpen(r.raceNumber)}>
                          {open.has(r.raceNumber) ? 'Collapse' : 'Build'}
                        </button>
                      )}
                    </div>

                    {r.locked && Array.isArray(r.tickets) && r.tickets.length > 0 && (
                      <table className="grid">
                        <thead><tr><th>Bet type</th><th>Say to the teller</th><th>Cost</th></tr></thead>
                        <tbody>
                          {r.tickets.map((t, i) => (
                            <tr key={i}>
                              <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
                              <td className="teller">{t.tellerCall}</td>
                              <td>{money(t.costCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {r.locked && r.pass && <p className="dim">PASSED this race.</p>}

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
          </span>
          <button className="btn btn--primary" disabled={busy || pending.length === 0} onClick={handleLockAll}>
            Lock all previewed races
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
