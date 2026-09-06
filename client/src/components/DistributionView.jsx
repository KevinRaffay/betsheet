import React, { useEffect, useState } from 'react';
import { getDistribution } from '../api.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>{cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}</span>
);
const pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(0)}%`);
const BUCKET_CHIP = { FULL: 'unanimous', PARTIAL: 'split', PROGRAM_ONLY: 'chaos', ODDS_ONLY: 'guess', HUMAN: 'human', LLM_GENERATED: 'llm', EQB_OTR: 'equibase-otr' };

// Distributions (D20): the SHAPE of the P/L per completeness bucket - share
// of losing days, the deepest drawdown of the running P/L, and single-ticket
// dependence. Invariant 13: buckets never pool. Dependence is shown gross
// (top ticket / total returned, refunds included) and net (top ticket's net
// / the day's net profit, winning days only); the > 80% flag is driven by net.
export default function DistributionView({ onBack, onOpenDay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState('');
  const [meet, setMeet] = useState('all');
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  useEffect(() => {
    getDistribution(version, meet).then(setData).catch((e) => setError(String(e.message)));
  }, [version, meet]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="placeholder">Loading…</p>;
  const days = onlyFlagged ? data.days.filter((d) => d.flagged) : data.days;

  return (
    <section>
      <div className="pagehead">
        <h2>Distributions</h2>
        <div className="btnrow">
          {data.meets.length > 0 && (
            <label className="dim">Meet{' '}
              <select className="in in--sm" value={data.selectedMeet ?? 'all'} onChange={(e) => setMeet(e.target.value)}>
                <option value="all">all meets</option>
                {data.meets.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
          {data.engineVersions.length > 0 && (
            <label className="dim">Engine{' '}
              <select className="in in--sm" value={data.selectedVersion ?? ''} onChange={(e) => setVersion(e.target.value)}>
                {data.engineVersions.map((v) => <option key={v} value={v}>{v}</option>)}
                <option value="all">all versions (pooled)</option>
              </select>
            </label>
          )}
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {data.buckets.length === 0 && <p className="placeholder">No graded days yet.</p>}

      {data.buckets.length > 0 && (
        <div className="bucket-row">
          {data.buckets.map((b) => (
            <div className="bucket" key={b.completeness}>
              <span className={`chip chip--${BUCKET_CHIP[b.completeness] ?? 'guess'}`}>{b.completeness}</span>
              <p className="bucket-pl">{signed(b.plCents)} <span className="dim">over {b.days} day{b.days === 1 ? '' : 's'}</span></p>
              <p className="dim">
                Losing days: <strong>{pct(b.losingDayPct)}</strong> ({b.losingDays} of {b.days}; {b.winningDays} winning{b.flatDays ? `, ${b.flatDays} flat` : ''})
                <br />
                Max drawdown: <strong>{money(b.maxDrawdown.cents)}</strong>
                {b.maxDrawdown.cents > 0 ? ` from ${b.maxDrawdown.fromDate} to ${b.maxDrawdown.toDate} (${b.maxDrawdown.days} day${b.maxDrawdown.days === 1 ? '' : 's'}, ${money(b.maxDrawdown.peakCents)} → ${money(b.maxDrawdown.troughCents)})` : ' (never below its peak)'}
                <br />
                Single-ticket dependence (net &gt; {pct(b.dependence.threshold)}): <strong>{b.dependence.flaggedNet} of {b.dependence.winningDays}</strong> winning days ({pct(b.dependence.flaggedNetPct)}); gross would flag {b.dependence.flaggedGross}
                <br />
                Mean day {signed(b.meanDayPlCents)} · refunds {money(b.refundedCents)} of {money(b.costCents)} wagered
              </p>
            </div>
          ))}
        </div>
      )}
      <p className="dim">
        Buckets never pool. One card per day per bucket (the latest card number in the selection).
        {data.selectedVersion === 'all' ? ' Showing ALL engine versions pooled - you chose this.'
          : data.selectedVersion ? ` Engine ${data.selectedVersion} only.` : ''}
        {' '}Dependence: gross = top ticket ÷ total returned (refunds included); net = the ticket with the largest net ÷ the day&apos;s net profit, winning days only (a refund can top the gross list but never the net one). The flag is net.
      </p>


      {data.days.length > 0 && (
        <>
          <div className="pagehead">
            <h3>Days</h3>
            <label className="dim"><input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> flagged only</label>
          </div>
          <table className="grid grid--click">
            <thead>
              <tr><th>Date</th><th>Meet</th><th>Bucket</th><th>Wagered</th><th>Returned</th><th>P/L</th><th>Top ticket (net on winning days)</th><th>Gross</th><th>Net</th><th>Flag</th></tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={`${d.raceDayId}-${d.completeness}`} onClick={() => onOpenDay(d.raceDayId)} className={d.flagged ? 'row--flagged' : ''}>
                  <td>{d.date}</td>
                  <td className="dim">{d.meet ?? ''}</td>
                  <td><span className={`chip chip--${BUCKET_CHIP[d.completeness] ?? 'guess'}`}>{d.completeness}</span></td>
                  <td>{money(d.costCents)}</td>
                  <td>{money(d.returnedCents)}</td>
                  <td>{signed(d.plCents)}</td>
                  <td>{(() => {
                    const tt = d.winning ? d.topNetTicket : d.topTicket;
                    if (!tt) return '—';
                    return <>{tt.betType} R{(tt.races ?? []).join('/')} {d.winning ? signed(tt.plCents) : money(tt.returnedCents)}</>;
                  })()}</td>
                  <td>{pct(d.grossShare)}</td>
                  <td>{d.netShare == null ? <span className="dim">losing day</span> : pct(d.netShare)}</td>
                  <td>{d.flagged ? <span className="tag tag--red">&gt; 80%</span> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
