import React, { useEffect, useState } from 'react';
import { getDayPL, getPL } from '../api.js';

const money = (cents) => (cents == null ? '—'
  : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>
    {cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}
  </span>
);
const roi = (plCents, costCents) =>
  (costCents > 0 ? `${plCents >= 0 ? '+' : ''}${(100 * plCents / costCents).toFixed(1)}%` : '—');

const BUCKET_CHIP = { FULL: 'unanimous', PARTIAL: 'split', PROGRAM_ONLY: 'chaos', ODDS_ONLY: 'guess', HUMAN: 'human', LLM_GENERATED: 'llm' };

// P/L across every stored card. Invariant 13 shapes this screen: every
// number lives inside its consensus_completeness bucket and there is no
// pooled all-bucket total anywhere on it. Invariant 14 adds the engine
// version: the buckets show ONE version (default: the latest graded) and
// pool across versions only when the user picks "all versions".
export default function PLView({ onBack, onOpenCard, onOpenDay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expandedDay, setExpandedDay] = useState(null); // raceDayId
  const [dayPL, setDayPL] = useState(null);
  const [version, setVersion] = useState(''); // '' = server default (latest)
  const [meet, setMeet] = useState('all'); // D43: one meet, or all meets

  useEffect(() => {
    getPL(version, meet).then(setData).catch((e) => setError(String(e.message)));
  }, [version, meet]);

  const toggleDay = async (raceDayId) => {
    if (expandedDay === raceDayId) { setExpandedDay(null); setDayPL(null); return; }
    setExpandedDay(raceDayId);
    setDayPL(null);
    try {
      setDayPL(await getDayPL(raceDayId));
    } catch (e) {
      setError(String(e.message));
      setExpandedDay(null);
    }
  };

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="placeholder">Loading…</p>;

  // Group graded cards by day for the per-day rows and the compare toggle.
  const days = [];
  const dayIndex = new Map();
  for (const c of data.cards) {
    if (!dayIndex.has(c.raceDayId)) {
      dayIndex.set(c.raceDayId, days.length);
      days.push({ raceDayId: c.raceDayId, track: c.track, date: c.date, cards: [] });
    }
    days[dayIndex.get(c.raceDayId)].cards.push(c);
  }

  return (
    <section>
      <div className="pagehead">
        <h2>P/L</h2>
        <div className="btnrow">
          {data.meets && data.meets.length > 0 && (
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

      {data.cards.length === 0 && (
        <p className="placeholder">
          No graded cards yet. Generate a card, ingest the day's chart, and the grades land here.
        </p>
      )}

      {data.buckets.length > 0 && (
        <>
          <div className="bucket-row">
            {data.buckets.map((b) => (
              <div className="bucket" key={b.completeness}>
                <span className={`chip chip--${BUCKET_CHIP[b.completeness] ?? 'guess'}`}>{b.completeness}</span>
                <p className="bucket-pl">{signed(b.plCents)}</p>
                <p className="dim">
                  {b.cards} card{b.cards === 1 ? '' : 's'} · {b.tickets} tickets
                  <br />
                  {money(b.returnedCents)} back on {money(b.costCents)} · ROI {roi(b.plCents, b.costCents)} wagered
                  {' '}/ {roi(b.plCents, b.bankrollCents)} bankroll
                </p>
              </div>
            ))}
          </div>
          <p className="dim">
            Buckets never pool: a program-only backfill card and a full-consensus card never share a total.
            {data.selectedVersion === 'all'
              ? ' Showing ALL engine versions pooled - you chose this; improvement is measured by comparing versions.'
              : ` Showing engine ${data.selectedVersion} only.`}
          </p>
        </>
      )}

      {days.map((d) => (
        <div className="race race--sheet" key={d.raceDayId}>
          <div className="race-sheet-head">
            <strong className="linkish" onClick={() => onOpenDay(d.raceDayId)}>{d.track} — {d.date}</strong>
            <button className="btn btn--sm" onClick={() => toggleDay(d.raceDayId)}>
              {expandedDay === d.raceDayId ? 'Hide races' : d.cards.length > 1 ? 'Compare by race' : 'By race'}
            </button>
          </div>
          <table className="grid grid--click">
            <thead>
              <tr>
                <th>Card</th><th>Template</th><th>Variant</th><th>Engine</th><th>Consensus</th><th>Bankroll</th>
                <th>Wagered</th><th>Returned</th><th>P/L</th><th>ROI (wagered)</th><th>ROI (bankroll)</th><th>Hits</th>
              </tr>
            </thead>
            <tbody>
              {d.cards.map((c) => (
                <tr key={c.cardId} onClick={() => onOpenCard(c.cardId, c.raceDayId)}>
                  <td><strong>#{c.cardNumber}</strong></td>
                  <td>{c.template ?? '—'}</td>
                  <td>{c.variant}</td>
                  <td><code>{c.engineVersion}</code></td>
                  <td><span className={`chip chip--${BUCKET_CHIP[c.completeness] ?? 'guess'}`}>{c.completeness}</span></td>
                  <td>{money(c.bankrollCents)}</td>
                  <td>{money(c.costCents)}</td>
                  <td>{money(c.returnedCents)}</td>
                  <td>{signed(c.plCents)}</td>
                  <td>{roi(c.plCents, c.costCents)}</td>
                  <td>{roi(c.plCents, c.bankrollCents)}</td>
                  <td className="dim">{c.wins}/{c.tickets}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {expandedDay === d.raceDayId && (
            dayPL ? <RaceMatrix dayPL={dayPL} /> : <p className="placeholder">Loading…</p>
          )}
        </div>
      ))}

      {data.ungraded.length > 0 && (
        <div className="race race--sheet">
          <div className="race-sheet-head"><strong>Not graded yet</strong>
            <span className="dim">cards still waiting on the day's chart</span>
          </div>
          <table className="grid grid--click">
            <thead>
              <tr><th>Day</th><th>Card</th><th>Variant</th><th>Consensus</th><th>Wagered</th></tr>
            </thead>
            <tbody>
              {data.ungraded.map((c) => (
                <tr key={c.cardId} onClick={() => onOpenCard(c.cardId, c.raceDayId)}>
                  <td>{c.track} — {c.date}</td>
                  <td><strong>#{c.cardNumber}</strong></td>
                  <td>{c.variant}</td>
                  <td><span className={`chip chip--${BUCKET_CHIP[c.completeness] ?? 'guess'}`}>{c.completeness}</span></td>
                  <td>{money(c.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Race rows x card columns: where each card won and lost the day. This is
// the variant-compare surface - same races, different recipes, side by side.
function RaceMatrix({ dayPL }) {
  const graded = dayPL.cards.filter((c) => c.graded);
  if (graded.length === 0) return <p className="dim">No graded cards on this day.</p>;
  const labels = [];
  for (const c of graded) {
    for (const pr of c.perRace) if (!labels.includes(pr.race)) labels.push(pr.race);
  }
  labels.sort((a, b) => (a === 'multi' ? Infinity : a) - (b === 'multi' ? Infinity : b));
  const cell = (c, label) => c.perRace.find((pr) => pr.race === label);
  return (
    <table className="grid grid--matrix">
      <thead>
        <tr>
          <th>Race</th>
          {graded.map((c) => <th key={c.cardId}>#{c.cardNumber} {c.variant}</th>)}
        </tr>
      </thead>
      <tbody>
        {labels.map((label) => (
          <tr key={label}>
            <td><strong>{label === 'multi' ? 'Multi-race' : `R${label}`}</strong></td>
            {graded.map((c) => {
              const pr = cell(c, label);
              return (
                <td key={c.cardId}>
                  {pr
                    ? <>{signed(pr.plCents)} <span className="dim">({pr.wins}/{pr.tickets} on {money(pr.costCents)})</span></>
                    : <span className="dim">—</span>}
                </td>
              );
            })}
          </tr>
        ))}
        <tr className="row--subtotal">
          <td>Card total</td>
          {graded.map((c) => <td key={c.cardId}>{signed(c.plCents)}</td>)}
        </tr>
      </tbody>
    </table>
  );
}
