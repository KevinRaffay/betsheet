import React, { useMemo, useState } from 'react';
import TicketBuilder from '@client/components/TicketBuilder.jsx';
import EntriesTable from '@client/components/EntriesTable.jsx';
import { navigate } from './app.jsx';
import { previewRace, blockingWarnings, raceOf, builderEntries } from './card.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** Two tickets in the teller grammar are joined by ' / ' - the same separator the parser splits on. */
const joinText = (a, b) => [a, b].map((s) => (s ?? '').trim()).filter(Boolean).join(' / ');

// One race, built (D151). The real TicketBuilder and the real EntriesTable,
// imported from client/ rather than reimplemented - the components are already
// server-free, so the static app gets identical validation and identical
// arithmetic for free.
//
// PERSISTENCE MODEL, and why it is not the desktop's. The desktop day builder
// keeps a draft as whatever the builder last composed, so mounting the builder
// on a race with a draft overwrites it (client/src/drafts.js is a convenience
// there - the server holds the record). Here there is no server, and D151's
// done-when is explicit: a partially built card must survive a hard refresh
// with all tickets intact. So the race's stored text is COMMITTED text, the
// builder composes ON TOP of it, and every keystroke writes the sum. The
// builder starting empty after a refresh is then harmless: nothing it produced
// was ever only in its own state.
export default function RaceView({ payload, raceNumber, card, deviceId, onSaveCard, onBackup }) {
  const race = raceOf(payload, raceNumber);
  const state = card?.races?.[raceNumber] ?? null;
  const [builderText, setBuilderText] = useState('');
  const [busy, setBusy] = useState(false);

  // `committed` is a SNAPSHOT taken when this race is opened, never a live
  // read of the stored text - and that distinction is the whole correctness of
  // this screen. Two separate bugs, both found in browser testing, both fixed
  // by this one shape:
  //
  //  1. DUPLICATION. Reading it live is the obvious implementation. The builder
  //     emits "$20 W 1", the race is written as committed("") + builder("$20 W
  //     1"), the saved card flows back down as a prop, a live `committed` would
  //     now BE "$20 W 1" - and the next render recomputes the sum as "$20 W 1 /
  //     $20 W 1". No new event is needed; the render alone does it.
  //
  //  2. WIPING. Snapshotting in an EFFECT fixes duplication and introduces
  //     something worse. Child effects run before parent effects, so
  //     TicketBuilder's mount-time `onChange('')` fires while the parent still
  //     holds the previous (empty) snapshot - and writes an empty race over
  //     saved text. Re-opening a race with work in it erased the work.
  //
  // Adjusting during RENDER (React's documented pattern for state that must
  // track a prop) fixes both: the new snapshot is in place before any child
  // commits, so nothing can observe or write the stale value.
  const [committed, setCommitted] = useState('');
  const [snapshotKey, setSnapshotKey] = useState(null);
  const key = `${card?.cardId ?? ''}:${raceNumber}`;
  if (snapshotKey !== key) {
    setSnapshotKey(key);
    setCommitted(card?.races?.[raceNumber]?.text ?? '');
    setBuilderText('');
  }

  const text = joinText(committed, builderText);
  const preview = useMemo(
    () => (text.trim() ? previewRace(payload, raceNumber, text) : null),
    [payload, raceNumber, text],
  );
  const blocking = preview ? blockingWarnings(preview.warnings) : [];
  const lockedHere = Boolean(state?.lockedAt);

  const writeRace = async (patch) => {
    if (!card) return;
    setBusy(true);
    try {
      await onSaveCard({
        ...card,
        races: { ...card.races, [raceNumber]: { text: '', tickets: [], lockedAt: null, passed: false, ...state, ...patch } },
      });
    } finally { setBusy(false); }
  };

  // EVERY MUTATION WRITES (D151). The builder's onChange fires on each chip
  // click and each stake keystroke, and each one lands in IndexedDB - there is
  // no save button because a phone killed in the background never gets to
  // press one.
  const onBuilderChange = async (t) => {
    setBuilderText(t);
    if (!card || lockedHere) return;
    await writeRace({ text: joinText(committed, t) });
  };

  const lock = async () => {
    if (!preview || blocking.length) return;
    await writeRace({
      text,
      tickets: preview.tickets,
      lockedAt: new Date().toISOString(),
      passed: false,
    });
    setBuilderText('');
    setCommitted(text);
    // The rolling backup (D152): a locked race is work that exists in exactly
    // one browser until a file leaves it, so every lock offers one.
    await onBackup?.(card.cardId);
    navigate('/');
  };

  const pass = async () => {
    await writeRace({ text: '', tickets: [], lockedAt: new Date().toISOString(), passed: true });
    setBuilderText('');
    setCommitted('');
    await onBackup?.(card.cardId);
    navigate('/');
  };

  const unlock = async () => {
    // Re-opening a locked race is allowed here and only here: nothing on this
    // device has been graded or revealed, so no reported figure can move. The
    // moment the card reaches home, invariant 15's rules apply and a locked
    // race becomes delete-only.
    //
    // The locked text becomes the new snapshot: re-opening hands the race back
    // as it was, with the builder empty and ready to add to it.
    setCommitted(state?.text ?? '');
    setBuilderText('');
    await writeRace({ lockedAt: null, tickets: [] });
  };

  const discard = async () => {
    setCommitted('');
    setBuilderText('');
    await writeRace({ text: '', tickets: [] });
  };

  if (!race) {
    return (
      <section className="panel">
        <p className="notice notice--error">No race {raceNumber} in this payload.</p>
        <button className="btn" onClick={() => navigate('/')}>Back to the day</button>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="formrow formrow--tight">
        <button className="btn btn--sm" onClick={() => navigate('/')}>← All races</button>
        <h2>Race {race.number}</h2>
        <span className="dim">
          {[race.postTime, race.distance, race.surface, race.raceType].filter(Boolean).join(' · ')}
        </span>
      </div>
      {race.conditions && <p className="dim">{race.conditions}</p>}

      <EntriesTable entries={race.entries} open />

      {!card && <p className="notice notice--warn">Pick or start a card on the day screen before building.</p>}

      {card && lockedHere && (
        <>
          {state.passed ? (
            <p className="dim">PASSED this race.</p>
          ) : (
            <>
              <h3>Locked tickets</h3>
              <table className="grid">
                <thead><tr><th>Teller call</th><th>Cost</th><th>If it hits</th></tr></thead>
                <tbody>
                  {state.tickets.map((t, i) => (
                    <tr key={i}>
                      <td><code className="teller">{t.tellerCall}</code></td>
                      <td>{money(t.costCents)}</td>
                      <td>{t.estMinCents == null ? '—'
                        : t.estIsRange ? `${money(t.estMinCents)}–${money(t.estMaxCents)}` : money(t.estMinCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="formrow formrow--tight">
            <button className="btn btn--sm" disabled={busy} onClick={unlock}>Re-open this race</button>
          </div>
          <p className="dim">
            Re-opening is offered here because nothing on this device is graded or revealed yet.
            Once this card is imported at home it follows the usual rule: locked tickets can be
            deleted, not edited.
          </p>
        </>
      )}

      {card && !lockedHere && (
        <>
          {committed.trim() && (
            <p className="dim draft-line">
              <code>{committed}</code><br />
              saved on this device, not yet locked
            </p>
          )}
          <TicketBuilder
            raceNumber={race.number}
            entries={builderEntries(race)}
            wagerMenu={race.wagerMenu}
            disabled={busy}
            onChange={onBuilderChange}
          />

          {preview && (
            <>
              {preview.warnings.length > 0 && (
                <div className={`notice ${blocking.length ? 'notice--error' : 'notice--warn'}`}>
                  <ul>
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w.blocking ? <strong>BLOCKING: </strong> : null}{w.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <table className="grid">
                <thead><tr><th>Bet</th><th>Teller call</th><th>Cost</th><th>If it hits</th></tr></thead>
                <tbody>
                  {preview.tickets.map((t, i) => (
                    <tr key={i}>
                      <td>{t.betType}</td>
                      <td><code className="teller">{t.tellerCall}</code></td>
                      <td>{money(t.costCents)}</td>
                      <td>{t.estMinCents == null ? '—'
                        : t.estIsRange ? `${money(t.estMinCents)}–${money(t.estMaxCents)}` : money(t.estMinCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="dim">Race total <strong>{money(preview.raceCostCents)}</strong></p>
            </>
          )}

          <div className="formrow formrow--tight">
            <button className="btn btn--primary" disabled={busy || !preview || blocking.length > 0}
              onClick={lock}>Lock race {race.number}</button>
            <button className="btn" disabled={busy} onClick={pass}>PASS</button>
            {committed.trim() && (
              <button className="btn" disabled={busy} onClick={discard}>Discard what is saved</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
