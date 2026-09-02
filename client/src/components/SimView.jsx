import React, { useEffect, useState } from 'react';
import { getSimulation, getSimulationCompare, runSimulation } from '../api.js';

const money = (cents) => (cents == null ? '—'
  : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>
    {cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}
  </span>
);
const roi = (plCents, costCents) =>
  (costCents > 0 ? `${plCents >= 0 ? '+' : ''}${(100 * plCents / costCents).toFixed(1)}%` : '—');
const BUCKET_CHIP = { FULL: 'unanimous', PARTIAL: 'split', PROGRAM_ONLY: 'chaos', ODDS_ONLY: 'guess' };
const BUCKET_ORDER = ['FULL', 'PARTIAL', 'PROGRAM_ONLY', 'ODDS_ONLY'];

// The simulator (D19): every strategy template replayed against every
// stored day that has a chart, the latest run per template side by side.
// Invariant 13 shapes the screen: one comparison table PER completeness
// bucket, never a pooled one. Expanding a template shows its bankroll
// over time, day by day, inside each bucket.
export default function SimView({ onBack, onOpenDay }) {
  const [compare, setCompare] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null); // runId
  const [run, setRun] = useState(null);

  const reload = () => getSimulationCompare().then(setCompare).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, []);

  const handleRun = async () => {
    setBusy(true);
    setError(null);
    try {
      await runSimulation({});
      setExpanded(null);
      setRun(null);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (runId) => {
    if (expanded === runId) { setExpanded(null); setRun(null); return; }
    setExpanded(runId);
    setRun(null);
    try {
      setRun(await getSimulation(runId));
    } catch (e) {
      setError(String(e.message));
      setExpanded(null);
    }
  };

  const templates = compare?.templates ?? [];
  const bucketsPresent = BUCKET_ORDER.filter((k) => templates.some((t) => t.buckets.some((b) => b.completeness === k)));

  return (
    <section>
      <div className="pagehead">
        <h2>Simulator</h2>
        <div className="btnrow">
          <button className="btn btn--primary" onClick={handleRun} disabled={busy}>
            {busy ? 'Running…' : 'Run every template'}
          </button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>
      {error && <p className="notice notice--error">{error}</p>}
      {compare && templates.length === 0 && (
        <p className="placeholder">
          No runs yet. Every template is replayed against every stored day that has a chart; the day's own bankroll and per-race minimum apply.
        </p>
      )}
      {templates.length > 0 && bucketsPresent.length === 0 && (
        <p className="placeholder">Runs exist but cover no days: ingest a chart for a stored day, then run again.</p>
      )}

      {bucketsPresent.map((k) => (
        <div className="race race--sheet" key={k}>
          <div className="race-sheet-head">
            <span className={`chip chip--${BUCKET_CHIP[k]}`}>{k}</span>
            <span className="dim">latest run per template · this bucket only</span>
          </div>
          <table className="grid grid--click">
            <thead>
              <tr>
                <th>Template</th><th>Days</th><th>Losing days</th><th>Wagered</th>
                <th>Returned</th><th>P/L</th><th>ROI</th><th>Hits</th><th>Run</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const b = t.buckets.find((x) => x.completeness === k);
                if (!b) return null;
                return (
                  <tr key={t.runId} onClick={() => toggle(t.runId)}>
                    <td><strong>{t.template}</strong>{t.simulationOnly && <span className="dim"> (simulation only)</span>}</td>
                    <td>{b.days}</td>
                    <td>{b.losingDays}/{b.days}</td>
                    <td>{money(b.costCents)}</td>
                    <td>{money(b.returnedCents)}</td>
                    <td>{signed(b.plCents)}</td>
                    <td>{roi(b.plCents, b.costCents)}</td>
                    <td className="dim">{b.wins}/{b.tickets}</td>
                    <td className="dim">#{t.runId} · {t.finishedAt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {bucketsPresent.length > 0 && (
        <p className="dim">
          Buckets never pool: a program-only backfill day and a full-consensus day never share a total. Click a template for its bankroll over time.
        </p>
      )}

      {expanded != null && (
        run ? <RunDetail run={run} onOpenDay={onOpenDay} /> : <p className="placeholder">Loading…</p>
      )}
    </section>
  );
}

// Bankroll over time for one run: a day-by-day table per bucket with the
// running P/L (and the running bankroll when the run was given one).
function RunDetail({ run, onOpenDay }) {
  return (
    <div className="race race--sheet">
      <div className="race-sheet-head">
        <strong>{run.template} · run #{run.runId}</strong>
        <span className="dim">
          {run.params.bankrollCents ? `${money(run.params.bankrollCents)} per day` : "each day's own bankroll"}
          {run.params.startingBankrollCents ? ` · starting bankroll ${money(run.params.startingBankrollCents)}` : ''}
          {' '}· {run.days.length} day{run.days.length === 1 ? '' : 's'}
        </span>
      </div>
      {run.buckets.map((b) => (
        <div key={b.completeness}>
          <p><span className={`chip chip--${BUCKET_CHIP[b.completeness]}`}>{b.completeness}</span>{' '}
            <strong>{signed(b.plCents)}</strong> <span className="dim">over {b.days} day{b.days === 1 ? '' : 's'} · ROI {roi(b.plCents, b.costCents)}</span></p>
          <table className="grid grid--click">
            <thead>
              <tr><th>Day</th><th>Wagered</th><th>Returned</th><th>Day P/L</th><th>Running P/L</th>{b.series[0]?.bankrollCents != null && <th>Bankroll</th>}</tr>
            </thead>
            <tbody>
              {b.series.map((d) => (
                <tr key={d.raceDayId} onClick={() => onOpenDay(d.raceDayId)}>
                  <td>{d.track} — {d.date}</td>
                  <td>{money(d.costCents)}</td>
                  <td>{money(d.returnedCents)}</td>
                  <td>{signed(d.plCents)}</td>
                  <td>{signed(d.runningCents)}</td>
                  {d.bankrollCents != null && <td>{money(d.bankrollCents)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
