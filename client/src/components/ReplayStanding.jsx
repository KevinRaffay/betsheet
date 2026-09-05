import React, { useEffect, useState } from 'react';
import { getReplayStanding } from '../api.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (cents == null ? '—' : (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>{cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}</span>
));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
const BLINDNESS_LABEL = { PRE_COMMIT: 'Pre-commit', SEQUENTIAL: 'Sequential', NON_BLIND: 'Non-blind' };

// Replay standing (D55): human vs lean over every closed, played day.
// Meets pool by default (mirrors P/L and Distributions - a handful of
// human days per meet would otherwise fragment into single-digit rows);
// blindness label and the classification-seen toggle are the two
// dimensions that never pool, regardless of meet selection.
export default function ReplayStanding({ onBack }) {
  const [meet, setMeet] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getReplayStanding(meet).then(setData).catch((e) => setError(String(e.message)));
  }, [meet]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>Replay standing</h2>
        <div className="formrow formrow--tight">
          {data.meets.length > 0 && (
            <label className="dim">Meet{' '}
              <select className="in in--sm" value={meet} onChange={(e) => setMeet(e.target.value)}>
                <option value="all">all meets</option>
                {data.meets.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {data.groups.length === 0 && <p className="placeholder">No closed, played days yet.</p>}

      {data.groups.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Blindness</th><th>Saw engine's read</th><th>Days</th>
              <th>Human wagered</th><th>Human P/L</th><th>ROI (wagered)</th><th>ROI (bankroll)</th><th>Hits</th>
              <th>Lean P/L</th><th>vs lean</th><th>Drawdown</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={`${g.blindness}-${g.sawClassification}`}>
                <td><span className="chip chip--human">{BLINDNESS_LABEL[g.blindness] ?? g.blindness ?? 'Undetermined'}</span></td>
                <td className="dim">{g.sawClassification ? 'yes' : 'no'}</td>
                <td>{g.days}</td>
                <td>{money(g.human.wageredCents)}</td>
                <td>{signed(g.human.plCents)}</td>
                <td>{pct(g.human.roiOnWageredPct)}</td>
                <td>{pct(g.human.roiOnBankrollPct)}</td>
                <td className="dim">{g.human.hits}</td>
                <td>{g.lean ? signed(g.lean.plCents) : <span className="dim">no lean card</span>}</td>
                <td>
                  {g.lean
                    ? <>{signed(g.human.plCents - g.lean.plCents)} <span className="dim">better on {g.paired.better} / worse on {g.paired.worse} / tied on {g.paired.tied}</span></>
                    : <span className="dim">—</span>}
                </td>
                <td>{money(g.human.maxDrawdown?.cents ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.pickerAgreement && (
        <div className="race race--sheet">
          <div className="race-sheet-head"><strong>Picker agreement</strong></div>
          <p className="dim">
            {data.pickerAgreement.racesConsidered} race{data.pickerAgreement.racesConsidered === 1 ? '' : 's'} considered
            {data.pickerAgreement.excludedRaces > 0 && (
              <> ({data.pickerAgreement.excludedRaces} excluded: {data.pickerAgreement.excludedReasons.no_win_ticket} no win ticket, {data.pickerAgreement.excludedReasons.tied_stakes} tied stakes)</>
            )}
          </p>
          <p>
            Human's largest win ticket matched the program's rank-1 pick on <strong>{data.pickerAgreement.matchesProgramRank1}</strong> race{data.pickerAgreement.matchesProgramRank1 === 1 ? '' : 's'},
            {' '}the top external-source pick on <strong>{data.pickerAgreement.matchesExternalTop}</strong> (of {data.pickerAgreement.externalComparable} comparable),
            {' '}neither on <strong>{data.pickerAgreement.matchesNeither}</strong>.
          </p>
          <p className="dim">
            Human top pick: {pct(data.pickerAgreement.humanWinPct)} win rate, {pct(data.pickerAgreement.humanFlatRoi)} flat-$2 ROI.
            {' '}Program rank-1: {pct(data.pickerAgreement.programWinPct)} win rate, {pct(data.pickerAgreement.programFlatRoi)} flat-$2 ROI.
          </p>
        </div>
      )}
    </section>
  );
}
