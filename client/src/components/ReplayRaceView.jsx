import React, { useEffect, useState } from 'react';
import {
  closeReplayCard, getRaceDay, getReplayRace, getReplaySummary, listCards, lockHumanCard, previewHumanCard,
  revealClassification, revealReplayRace,
} from '../api.js';
import TicketBuilder from './TicketBuilder.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (cents == null ? '—' : (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>{cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}</span>
));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
const BLINDNESS_LABEL = { PRE_COMMIT: 'Pre-commit', SEQUENTIAL: 'Sequential', NON_BLIND: 'Non-blind' };

// Replay (D55) blind race view: paste/preview/lock/PASS call D54's own
// endpoints directly - this component adds nothing to how a human ticket
// gets built, only the blind-then-reveal session around it. Consensus
// shown is raw per-source picks only (shared/classification.js's
// buildConsensusTable) - the engine's own UNANIMOUS/SPLIT/CHAOS read and
// contrarian flags stay hidden unless this card opts in.
export default function ReplayRaceView({ dayId, initialRace = 1, onBack, onOpenStanding }) {
  const [raceNumber, setRaceNumber] = useState(initialRace);
  const [totalRaces, setTotalRaces] = useState(null);
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);
  const [blind, setBlind] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);   // D86: the escape hatch back to raw text
  const [editing, setEditing] = useState(false); // re-open a locked, unrevealed race

  useEffect(() => {
    getRaceDay(dayId).then((d) => { setDayInfo(d); setTotalRaces(d.races.length); }).catch((e) => setError(String(e.message)));
    // Resume the day's own human card on a fresh visit (a different tab, a
    // reload, or navigating back from Standing) - otherwise a closed day
    // would show as never-played every time you return to it. The latest
    // card_number wins; starting a genuinely new playthrough isn't a UI
    // action yet, so there's nothing to disambiguate.
    setCardId(null);
    listCards(dayId).then((cards) => {
      const human = cards.filter((c) => c.template === 'human').sort((a, b) => b.card_number - a.card_number)[0];
      if (human) setCardId(human.id);
    }).catch(() => {});
  }, [dayId]);

  const reload = () => getReplayRace(dayId, raceNumber, cardId).then(setBlind).catch((e) => setError(String(e.message)));
  useEffect(() => { setPreview(null); setText(''); setEditing(false); reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [raceNumber, cardId]);

  // `summary.closed` is server truth, not "did I click Close in this tab" -
  // a day closed in an earlier session (or by revealing every race without
  // ever clicking Close) must still show as closed after a reload.
  const refreshSummary = () => {
    if (!cardId) { setSummary(null); return; }
    getReplaySummary(cardId).then(setSummary).catch(() => {});
  };
  useEffect(() => { refreshSummary(); }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const withBusy = (fn) => async (...args) => {
    setBusy(true); setError(null);
    try { await fn(...args); } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const handlePreview = withBusy(async () => {
    const p = await previewHumanCard(dayId, raceNumber, text, cardId, correlationId);
    if (p.correlationId) setCorrelationId(p.correlationId);
    setPreview(p);
  });

  const handleLock = withBusy(async () => {
    const r = await lockHumanCard(dayId, { race: raceNumber, text, bankrollCents: dayInfo?.bankroll_cents, cardId }, correlationId);
    if (r.correlationId) setCorrelationId(r.correlationId);
    if (!cardId) setCardId(r.cardId);
    setPreview(null); setText(''); setEditing(false);
    await reload();
    refreshSummary();
  });

  const handlePass = withBusy(async () => {
    const r = await lockHumanCard(dayId, { race: raceNumber, pass: true, bankrollCents: dayInfo?.bankroll_cents, cardId }, correlationId);
    if (!cardId) setCardId(r.cardId);
    await reload();
  });

  const handleReveal = withBusy(async () => {
    await revealReplayRace(cardId, raceNumber);
    await reload();
    refreshSummary(); // revealing the last remaining race can make the card closed without ever clicking Close
  });

  const handleRevealClassification = withBusy(async () => {
    await revealClassification(cardId);
    await reload();
  });

  const handleClose = withBusy(async () => {
    setSummary(await closeReplayCard(cardId));
  });

  if (error && !blind) return <p className="notice notice--error">{error}</p>;
  if (!blind || totalRaces == null) return <p className="placeholder">Loading…</p>;

  const revealed = Array.isArray(blind.finishOrder);
  const canGoPrev = raceNumber > 1;
  const canGoNext = raceNumber < totalRaces;

  return (
    <section className="card-sheet">
      <div className="pagehead">
        <h2>{dayInfo.track} — {dayInfo.date} · Replay, race {raceNumber} of {totalRaces}</h2>
        <div className="btnrow">
          <button className="btn" disabled={!canGoPrev} onClick={() => setRaceNumber((n) => n - 1)}>◂ Prev race</button>
          <button className="btn" disabled={!canGoNext} onClick={() => setRaceNumber((n) => n + 1)}>Next race →</button>
          {cardId && <button className="btn" disabled={busy} onClick={handleClose}>Close day</button>}
          <button className="btn" onClick={onOpenStanding}>Standing</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      <p className="dim">
        Bankroll {money(blind.bankrollCents)} · per-race min {money(blind.perRaceMinCents)}
        {cardId && <> · card #{cardId} · running cost {money(blind.runningCardCostCents)}</>}
      </p>

      {summary?.closed && (
        <div className="notice">
          <p><strong>Day closed.</strong> Blindness: <span className="chip chip--human">{BLINDNESS_LABEL[summary.blindness] ?? summary.blindness ?? 'undetermined'}</span></p>
          <p>
            Human: {money(summary.human.wageredCents)} wagered, {signed(summary.human.plCents)}
            {' '}· ROI wagered {pct(summary.human.roiOnWageredPct)} / bankroll {pct(summary.human.roiOnBankrollPct)} · {summary.human.hits} hits
          </p>
          {summary.lean && (
            <p>Lean: {money(summary.lean.wageredCents)} wagered, {signed(summary.lean.plCents)} · ROI {pct(summary.lean.roiOnWageredPct)}</p>
          )}
        </div>
      )}

      <div className="race race--sheet">
        <div className="race-sheet-head">
          <strong>Race {raceNumber}</strong>
          <span className="dim">{blind.surface ?? '?'} · {blind.distance ?? '?'} · {blind.raceType ?? '?'} · post {blind.postTime ?? '?'}</span>
        </div>
        {blind.conditions && <p className="conditions">{blind.conditions}</p>}
        {blind.wagerMenu && <p className="dim wager">{blind.wagerMenu}</p>}
        <table className="grid grid--entries">
          <thead>
            <tr><th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th><th>Rank</th></tr>
          </thead>
          <tbody>
            {blind.entries.map((e) => (
              <tr key={e.programNumber} className={e.scratched ? 'row--scratched' : ''}>
                <td>{e.programNumber}</td>
                <td>{e.horseName}{e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}{e.scratched ? <span className="tag tag--red">SCR</span> : null}</td>
                <td>{e.jockey ?? ''}</td>
                <td>{e.trainer ?? ''}</td>
                <td>{e.morningLine ?? ''}</td>
                <td className="dim">{e.programRank ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {blind.bottomLineText && (
          <details className="race-bottom-line" open>
            <summary>Bottom Line</summary>
            <p>{blind.bottomLineText}</p>
          </details>
        )}

        <details className="race-entries" open>
          <summary>Consensus ({blind.consensus.table.length} source{blind.consensus.table.length === 1 ? '' : 's'})</summary>
          {blind.consensus.table.length === 0
            ? <p className="dim">Program only - no consensus on file.</p>
            : (
              <table className="grid">
                <thead><tr><th>Source</th><th>Top</th><th>2nd</th><th>3rd</th><th>Watch/contrarian</th></tr></thead>
                <tbody>
                  {blind.consensus.table.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.top ? `#${s.top.programNumber} ${s.top.horseName}` : '—'}</td>
                      <td>{s.second ? `#${s.second.programNumber} ${s.second.horseName}` : '—'}</td>
                      <td>{s.third ? `#${s.third.programNumber} ${s.third.horseName}` : '—'}</td>
                      <td className="dim">{s.flagged.map((f) => `#${f.programNumber} ${f.horseName}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {'classification' in blind.consensus ? (
            <p className="dim">
              Engine's read revealed: <span className={`chip chip--${blind.consensus.classification.toLowerCase()}`}>{blind.consensus.classification}</span>
              {blind.consensus.contrarianFlags?.length > 0 && <> · {blind.consensus.contrarianFlags.map((f) => f.detail).join('; ')}</>}
            </p>
          ) : cardId && (
            <p className="dim">
              <button className="btn btn--sm" disabled={busy} onClick={handleRevealClassification}>
                Reveal the engine's read of this race (one-way, applies to the whole card)
              </button>
            </p>
          )}
        </details>

        {(!blind.locked || editing) && (
          <div className="formrow">
            {editing && (
              <p className="notice notice--warn">
                Re-locking re-stamps this race's lock time. Nothing has been revealed on this card yet,
                so the card stays Pre-commit.
              </p>
            )}
            {typing ? (
              <>
                <textarea className="in" rows={6} value={text} onChange={(e) => setText(e.target.value)}
                  placeholder={'$10 W 5 / $2 EX BOX 2-4-5 / $1 TRI 5 WITH 2-4 WITH 2-4\n\nor the spreadsheet grammar:\nWin | #2 | $25'} />
                <p className="dim">
                  Teller format, tickets separated by " / " - the money first and per combo,
                  WITH between finishing positions, "-" within one. A trailing "(9/2 big overlay)"
                  records odds and a rationale. The spreadsheet grammar
                  (bet type | selections | total stake) still works, tabs included.
                </p>
              </>
            ) : (
              <TicketBuilder
                raceNumber={raceNumber}
                entries={blind.entries}
                wagerMenu={blind.wagerMenu}
                disabled={busy}
                onChange={setText}
              />
            )}
            <p className="dim">
              <button type="button" className="linkish" onClick={() => setTyping((v) => !v)}>
                {typing ? 'Use the ticket builder' : 'Type it instead'}
              </button>
            </p>
            <div className="formrow formrow--tight">
              <button className="btn" disabled={busy || !text.trim()} onClick={handlePreview}>Preview</button>
              <button className="btn btn--primary" disabled={busy || !preview || preview.warnings.some((w) => w.blocking)} onClick={handleLock}>
                {editing ? 'Re-lock race' : 'Lock race'}
              </button>
              {editing
                ? <button className="btn" disabled={busy} onClick={() => { setEditing(false); setPreview(null); setText(''); }}>Cancel</button>
                : <button className="btn" disabled={busy} onClick={handlePass}>PASS this race</button>}
            </div>
            <p className="dim">Read-only preview of exactly what Lock will store. To correct something, fix the pasted text and preview again.</p>
            {preview && (
              <>
                {preview.warnings.length > 0 && (
                  <div className={`notice ${preview.warnings.some((w) => w.blocking) ? 'notice--error' : 'notice--warn'}`}>
                    <ul>{preview.warnings.map((w, i) => <li key={i}>{w.blocking ? <strong>BLOCKING: </strong> : null}{w.message}</li>)}</ul>
                  </div>
                )}
                {preview.overBankroll && <p className="notice notice--warn">This would put the card over its bankroll.</p>}
                <table className="grid">
                  <thead><tr><th>Bet type</th><th>Selections</th><th>Say to the teller</th><th>Cost</th></tr></thead>
                  <tbody>
                    {preview.tickets.map((t, i) => (
                      <tr key={i}>
                        <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
                        <td>{t.legs.map((l) => l.join(',')).join(' / ')}</td>
                        <td className="teller">{t.tellerCall}</td>
                        <td>{money(t.costCents)}</td>
                      </tr>
                    ))}
                    <tr className="row--subtotal"><td colSpan={3}>Race total</td><td>{money(preview.raceCostCents)}</td></tr>
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {blind.locked && blind.pass && <p className="dim">PASSED this race.</p>}

        {blind.locked && !blind.pass && Array.isArray(blind.tickets) && (
          <table className="grid">
            <thead><tr><th>Bet type</th><th>Selections / rationale</th><th>Say to the teller</th><th>Cost</th></tr></thead>
            <tbody>
              {blind.tickets.map((t, i) => (
                <tr key={i}>
                  <td className="bt">{t.betType.replace(/_/g, ' ')}</td>
                  <td>{t.legs.map((l) => l.join(',')).join(' / ')}{t.rationaleText ? <span className="dim"> — {t.rationaleText}</span> : null}</td>
                  <td className="teller">{t.tellerCall}</td>
                  <td>{money(t.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Editing a locked race after ANY race on the card was revealed would
            re-stamp picks_locked_at past the first reveal, silently flipping the
            card PRE_COMMIT -> SEQUENTIAL in the standing table. Invariant 15 says
            blindness is derived from the timestamps, never hand-set, so this is a
            rule rather than a warning: the affordance is simply absent, and the
            D28 remedy (an edit after a reveal is a NEW card) is named instead. */}
        {blind.locked && !editing && !revealed && !summary?.anyRevealed && (
          <p className="dim">
            <button type="button" className="linkish" disabled={busy} onClick={() => { setEditing(true); setPreview(null); setText(''); }}>
              Edit this race
            </button>
          </p>
        )}
        {blind.locked && !editing && !revealed && summary?.anyRevealed && (
          <p className="dim">
            A race on this card has already been revealed, so this one can no longer be edited -
            re-locking would change the card's recorded blindness from Pre-commit to Sequential.
            Per D28, an edit after a reveal is a new card: play the day again to start one.
          </p>
        )}

        {blind.locked && !editing && !revealed && (
          <button className="btn btn--primary" disabled={busy} onClick={handleReveal}>Reveal results</button>
        )}

        {revealed && (
          <div className="race race--sheet card-footer">
            <p><strong>Finish order</strong></p>
            <table className="grid">
              <thead><tr><th>Pos</th><th>#</th><th>Horse</th><th>Win</th><th>Place</th><th>Show</th></tr></thead>
              <tbody>
                {blind.finishOrder.map((f) => (
                  <tr key={f.program_number}>
                    <td>{f.finish_position ?? '—'}</td><td>{f.program_number}</td><td>{f.horse_name}</td>
                    <td>{money(f.win_cents)}</td><td>{money(f.place_cents)}</td><td>{money(f.show_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {blind.payoffs?.length > 0 && (
              <table className="grid">
                <thead><tr><th>Payoff</th><th>Combination</th><th>Base</th><th>Pays</th></tr></thead>
                <tbody>
                  {blind.payoffs.map((p, i) => (
                    <tr key={i}>
                      <td className="bt">{p.bet_type.replace(/_/g, ' ')}</td>
                      <td>{p.combination}</td>
                      <td className="dim">{money(p.base_cents)}</td>
                      <td>{money(p.payout_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p>
              <strong>Human this race:</strong> {money(blind.humanAllocatedCents)} allocated, race P/L {signed(blind.humanRacePl)}
            </p>
            <p>
              <strong>Lean this race:</strong>{' '}
              {blind.leanGraded == null ? <span className="dim">no lean card on this day</span> : <>{money(blind.leanAllocatedCents)} allocated, race P/L {signed(blind.leanRacePl)}</>}
            </p>
            {summary?.closed && (
              <>
                <GradedTicketsTable title="Human card, this race" graded={blind.humanGraded} />
                <GradedTicketsTable title="Lean card, this race" graded={blind.leanGraded} />
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// The actual betting card, ticket by ticket, with the grader's outcome and
// payout - shown only once the day is closed (mid-play the one-line race
// P/L summary above is enough; the full card is for the after-the-fact
// review). `graded`: [{ticket: {betType, legs, costCents, tellerCall,
// rationaleText}, outcome, returnedCents, plCents, note}] from the grader,
// or null when there's no card at all (e.g. no lean card on this day).
function GradedTicketsTable({ title, graded }) {
  if (graded == null) return <p className="dim">{title}: no card.</p>;
  if (graded.length === 0) return <p className="dim">{title}: no tickets this race.</p>;
  const totalCost = graded.reduce((a, g) => a + g.ticket.costCents, 0);
  const totalReturned = graded.reduce((a, g) => a + g.returnedCents, 0);
  return (
    <>
      <p><strong>{title}</strong></p>
      <table className="grid">
        <thead>
          <tr><th>Bet type</th><th>Selections / rationale</th><th>Say to the teller</th><th>Cost</th><th>Result</th><th>P/L</th></tr>
        </thead>
        <tbody>
          {graded.map((g, i) => (
            <tr key={i}>
              <td className="bt">{g.ticket.betType.replace(/_/g, ' ')}</td>
              <td>
                {g.ticket.legs.map((l) => l.join(',')).join(' / ')}
                {g.ticket.rationaleText ? <span className="dim"> — {g.ticket.rationaleText}</span> : null}
              </td>
              <td className="teller">{g.ticket.tellerCall}</td>
              <td>{money(g.ticket.costCents)}</td>
              <td>
                <span className={`outcome outcome--${g.outcome}`}>{g.outcome.toUpperCase()}</span>
                {g.outcome !== 'loss' && <span className="dim"> {money(g.returnedCents)}</span>}
                {g.note ? <span className="dim"> — {g.note}</span> : null}
              </td>
              <td className={g.plCents >= 0 ? 'pl--pos' : 'pl--neg'}>
                {g.plCents >= 0 ? '+' : '−'}{money(Math.abs(g.plCents))}
              </td>
            </tr>
          ))}
          <tr className="row--subtotal">
            <td colSpan={3}>Race total</td>
            <td>{money(totalCost)}</td>
            <td>{money(totalReturned)} back</td>
            <td className={(totalReturned - totalCost) >= 0 ? 'pl--pos' : 'pl--neg'}>
              {signed(totalReturned - totalCost)}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
