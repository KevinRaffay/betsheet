import React, { useEffect, useMemo, useState } from 'react';
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
export default function RaceView({ payload, raceNumber, card, deviceId, onSaveCard }) {
  const race = raceOf(payload, raceNumber);
  const state = card?.races?.[raceNumber] ?? null;
  const committed = state?.text ?? '';
  const [builderText, setBuilderText] = useState('');
  const [busy, setBusy] = useState(false);

  // Anything typed before this race was opened is committed text; the builder
  // always starts empty on a race change, never mid-race (which would drop
  // what the user is composing right now).
  useEffect(() => { setBuilderText(''); }, [raceNumber, card?.cardId]);

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
    navigate('/');
  };

  const pass = async () => {
    await writeRace({ text: '', tickets: [], lockedAt: new Date().toISOString(), passed: true });
    setBuilderText('');
    navigate('/');
  };

  const unlock = async () => {
    // Re-opening a locked race is allowed here and only here: nothing on this
    // device has been graded or revealed, so no reported figure can move. The
    // moment the card reaches home, invariant 15's rules apply and a locked
    // race becomes delete-only.
    await writeRace({ lockedAt: null, tickets: [] });
  };

  const discard = async () => { await writeRace({ text: '', tickets: [] }); setBuilderText(''); };

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
