import React, { useEffect, useState } from 'react';
import { FAILURE_MODE_WARNINGS } from '@shared/card-engine.js';
import { getCard, getGrades, gradeCardApi } from '../api.js';

const RESPONSIBLE_LINE =
  'Entertainment wagering with a pre-committed budget. No mid-card increases.';

const money = (cents) => (cents == null ? '—'
  : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

const estDisplay = (t) => {
  if (t.est_payout_min_cents == null) return '—';
  if (!t.est_is_range) return money(t.est_payout_min_cents);
  return `${money(t.est_payout_min_cents)}–${money(t.est_payout_max_cents)} (est.)`;
};

const splitThesis = (text) => {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  return {
    thesis: lines.filter((l) => !l.startsWith('TRIGGER:')).join(' '),
    triggers: lines.filter((l) => l.startsWith('TRIGGER:')).map((l) => l.slice(8).trim()),
  };
};

// The betting card - the sheet itself. One table per race:
// Bet Type | Selections / Rationale | Say to the teller | If it hits | Cost.
export default function CardView({ cardId, onBack }) {
  const [card, setCard] = useState(null);
  const [gradeData, setGradeData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getCard(cardId).then(setCard).catch((e) => setError(String(e.message)));
    getGrades(cardId).then(setGradeData).catch(() => setGradeData(null));
  }, [cardId]);

  const handleGrade = async () => {
    setBusy(true);
    setError(null);
    try {
      await gradeCardApi(cardId);
      setGradeData(await getGrades(cardId));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  if (error && !card) return <p className="notice notice--error">{error}</p>;
  if (!card) return <p className="placeholder">Loading…</p>;

  const gradeByTicket = new Map((gradeData?.grades ?? []).map((g) => [g.ticket_id, g]));
  const graded = gradeByTicket.size > 0;

  const summary = graded ? gradeData.summary : null;

  const singles = card.tickets.filter((t) => t.race_id != null);
  const multis = card.tickets.filter((t) => t.race_id == null);
  const total = card.tickets.reduce((a, t) => a + t.cost_cents, 0);
  const remaining = card.bankroll_cents - total;
  const allTriggers = card.allocations.flatMap((a) => {
    const { triggers } = splitThesis(a.thesis);
    return triggers.map((t) => ({ race: a.race_number, text: t }));
  });

  return (
    <section className="card-sheet">
      <div className="pagehead">
        <h2>
          {card.track} — {card.date} · card #{card.card_number}
          {card.variant !== 'default' ? ` (${card.variant})` : ''}
        </h2>
        <div className="btnrow">
          <a className="btn" href={`/api/cards/${cardId}/export`}>Export JSON</a>
          <button className="btn" onClick={handleGrade} disabled={busy}>
            {graded ? 'Regrade vs results' : 'Grade vs results'}
          </button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      <p className="dim">
        <span className={`chip chip--${card.consensus_completeness === 'FULL' ? 'unanimous' : card.consensus_completeness === 'PARTIAL' ? 'split' : 'chaos'}`}>
          {card.consensus_completeness}
        </span>
        {' '}consensus · template {card.template ?? '—'} · bankroll {money(card.bankroll_cents)}
        {' '}· per-race min {money(card.per_race_min_cents)} · generated {card.created_at}
      </p>

      {remaining < 0 && (
        <p className="notice notice--warn">
          Tickets exceed the bankroll by {money(-remaining)}. The card stands — but that is house money you have not won yet.
        </p>
      )}

      {card.allocations.map((a) => {
        const raceTickets = singles.filter((t) => {
          const races = t.selections.races ?? [];
          return races.length === 1 && races[0] === a.race_number;
        });
        const subtotal = raceTickets.reduce((s, t) => s + t.cost_cents, 0);
        const { thesis, triggers } = splitThesis(a.thesis);
        const flags = a.contrarian_flags ? JSON.parse(a.contrarian_flags) : [];
        return (
          <div className="race race--sheet" key={a.race_number}>
            <div className="race-sheet-head">
              <strong>Race {a.race_number}</strong>
              <span className={`chip chip--${(a.classification ?? 'chaos').toLowerCase()}`}>{a.classification ?? '—'}</span>
              <span className="dim">
                post {a.post_time ?? '?'} · {a.surface ?? '?'} · {a.distance ?? '?'} · {a.race_type ?? '?'}
              </span>
              <span className="race-alloc">{money(a.amount_cents)} allocated</span>
            </div>
            {thesis && <p className="thesis">{thesis}</p>}
            {triggers.map((t, i) => <p className="trigger" key={i}>▸ {t}</p>)}
            {flags.map((f, i) => (
              <p className="trigger" key={`f${i}`}>
                ▸ {f.type === 'algo_fades_favorite' ? 'FADE' : 'LONGSHOT×2'}: #{f.programNumber} {f.horseName} — {f.detail}
              </p>
            ))}
            {raceTickets.length === 0
              ? <p className="dim">No tickets this race.</p>
              : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Bet type</th><th>Selections / rationale</th>
                      <th>Say to the teller</th><th>If it hits</th><th>Cost</th>
                      {graded && <><th>Result</th><th>P/L</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {raceTickets.map((t) => (
                      <TicketRow key={t.id} t={t} g={gradeByTicket.get(t.id)} graded={graded} />
                    ))}
                    <tr className="row--subtotal">
                      <td colSpan={4}>Race {a.race_number} subtotal</td>
                      <td>{money(subtotal)}</td>
                      {graded && <GradeSubtotal tickets={raceTickets} gradeByTicket={gradeByTicket} />}
                    </tr>
                  </tbody>
                </table>
              )}
          </div>
        );
      })}

      {multis.length > 0 && (
        <div className="race race--sheet">
          <div className="race-sheet-head"><strong>Multi-race tickets</strong></div>
          <table className="grid">
            <thead>
              <tr>
                <th>Bet type</th><th>Selections / rationale</th>
                <th>Say to the teller</th><th>If it hits</th><th>Cost</th>
                {graded && <><th>Result</th><th>P/L</th></>}
              </tr>
            </thead>
            <tbody>
              {multis.map((t) => (
                <TicketRow key={t.id} t={t} g={gradeByTicket.get(t.id)} graded={graded} />
              ))}
              <tr className="row--subtotal">
                <td colSpan={4}>Multi-race subtotal</td>
                <td>{money(multis.reduce((s, t) => s + t.cost_cents, 0))}</td>
                {graded && <GradeSubtotal tickets={multis} gradeByTicket={gradeByTicket} />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="race race--sheet card-footer">
        <p>
          <strong>Day total {money(total)}</strong> · {card.tickets.length} tickets
          · bankroll {money(card.bankroll_cents)}
          · {remaining >= 0 ? `${money(remaining)} unspent` : `${money(-remaining)} OVER`}
        </p>
        {summary && (
          <p>
            <strong>Graded:</strong> returned {money(summary.returnedCents)} on {money(summary.costCents)} wagered
            {' '}· <strong className={summary.plCents >= 0 ? 'pl--pos' : 'pl--neg'}>
              {summary.plCents >= 0 ? '+' : '−'}{money(Math.abs(summary.plCents))}
            </strong>
          </p>
        )}
        <p className="dim">
          Sources used: {card.sources.used.length
            ? card.sources.used.map((s) => `${s.name} (${s.ts?.slice(0, 10) ?? '—'})`).join(', ')
            : 'program analysis and morning lines only'}
          {card.sources.unavailable.length > 0 && (
            <> · Unavailable: {card.sources.unavailable.map((s) => s.name).join(', ')}</>
          )}
        </p>
        {card.scratches.length > 0 && (
          <p className="dim">
            Scratches: {card.scratches.map((s) => `R${s.race_number} #${s.program_number ?? '?'} ${s.horse_name}`).join(' · ')}
          </p>
        )}
        {allTriggers.length > 0 && (
          <>
            <p><strong>Board watch</strong></p>
            {allTriggers.map((t, i) => <p className="trigger" key={i}>▸ R{t.race}: {t.text}</p>)}
          </>
        )}
        <div className="notice notice--warn">
          <ul>{FAILURE_MODE_WARNINGS.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
        <p className="responsible">{RESPONSIBLE_LINE}</p>
      </div>
    </section>
  );
}

function TicketRow({ t, g, graded }) {
  return (
    <tr>
      <td className="bt">{t.bet_type.replace(/_/g, ' ')}</td>
      <td>
        {t.selections.legs.map((l) => l.join(',')).join(' / ')}
        {t.rationale ? <span className="dim"> — {t.rationale}</span> : null}
      </td>
      <td className="teller">{t.teller_call}</td>
      <td>{estDisplay(t)}</td>
      <td>{money(t.cost_cents)}</td>
      {graded && (g
        ? (
          <>
            <td>
              <span className={`outcome outcome--${g.outcome}`}>{g.outcome.toUpperCase()}</span>
              {g.outcome !== 'loss' && <span className="dim"> {money(g.returned_cents)}</span>}
              {g.details?.note ? <span className="dim"> — {g.details.note}</span> : null}
            </td>
            <td className={g.pl_cents >= 0 ? 'pl--pos' : 'pl--neg'}>
              {g.pl_cents >= 0 ? '+' : '−'}{money(Math.abs(g.pl_cents))}
            </td>
          </>
        )
        : <><td className="dim">—</td><td className="dim">—</td></>)}
    </tr>
  );
}

function GradeSubtotal({ tickets, gradeByTicket }) {
  const gs = tickets.map((t) => gradeByTicket.get(t.id)).filter(Boolean);
  const returned = gs.reduce((a, g) => a + g.returned_cents, 0);
  const pl = gs.reduce((a, g) => a + g.pl_cents, 0);
  return (
    <>
      <td>{money(returned)} back</td>
      <td className={pl >= 0 ? 'pl--pos' : 'pl--neg'}>{pl >= 0 ? '+' : '−'}{money(Math.abs(pl))}</td>
    </>
  );
}
