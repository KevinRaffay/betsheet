import React, { useEffect, useState } from 'react';
import { getPickScoring } from '../api.js';
import { BUCKET_CHIP } from '@shared/distribution.js';

// Pick sources (D222, PS-3 of docs/requirements/pick-source-scoring.md): for
// every source that produces picks, how often the horse it BACKED actually
// won, placed, showed - read against the morning-line favorite on the same
// races. NO MONEY anywhere on this page: P/L owns money; this is the question
// underneath it. Every rate prints as `hits/n`, a dash at n=0, and sources
// never pool - the server groups by (source, inputs) and emits no total.

const rate = (t) => {
  if (!t || !t.n) return <span className="dim">—</span>;
  return <>{t.hits}/{t.n} <span className="dim">({(100 * t.rate).toFixed(0)}%)</span></>;
};
const pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(0)}%`);
const num = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : <span className="dim">—</span>);
// D229: beat-the-close. SIGNED and always shown with its own n, because the
// sign is the whole reading - 0 is the null hypothesis ("you are the market"),
// not a floor. A dash at n=0 rather than a 0%, this module's oldest rule.
const edge = (e) => {
  if (!e || !e.n || e.mean == null) return <span className="dim">—</span>;
  const pts = 100 * e.mean;
  return (
    <span className={pts > 0 ? 'pl--pos' : pts < 0 ? 'pl--neg' : ''}>
      {pts > 0 ? '+' : ''}{pts.toFixed(1)} pts <span className="dim">(n={e.n})</span>
    </span>
  );
};

export default function PickSourcesView({ onBack, onOpenDay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [track, setTrack] = useState('');
  const [tracks, setTracks] = useState([]);
  const [showRaces, setShowRaces] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPickScoring(track).then((d) => {
      if (cancelled) return;
      setData(d);
      // The track list is learned from the UNFILTERED response, so a filter
      // never hides the other options.
      if (!track) setTracks([...new Set(d.races.map((r) => r.trackCode).filter(Boolean))].sort());
    }).catch((e) => { if (!cancelled) setError(String(e.message)); });
    return () => { cancelled = true; };
  }, [track]);

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!data) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>Pick sources</h2>
        <div className="btnrow">
          <label className="dim">Track{' '}
            <select className="in in--sm" value={track} onChange={(e) => setTrack(e.target.value)}>
              <option value="">all tracks</option>
              {tracks.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      <p className="dim">
        Did the horses a source <strong>backed</strong> actually get there? No money on this page. <strong>Primary</strong> is the
        one win ticket with the largest stake; <strong>any</strong> counts every horse backed to win, and <strong>backed/race</strong> says
        how many that was. <strong>Named in top 3</strong> is how many of the real first three the source put on any ticket.
        <strong> Favorite</strong> is the morning-line favorite&apos;s own record on the same races - the rate a source has to beat.
        Every figure is <code>hits/n</code>; a dash means the source backed nothing in that role. Sources never pool, and an
        LLM fed OTR or tip-sheet picks (its <em>inputs</em>) is a separate row from the same model fed nothing.
      </p>

      {data.bySource.length === 0 && <p className="placeholder">No picks on any race day with results yet.</p>}

      {data.bySource.length > 0 && (
        <div className="grid--wide-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>Source</th><th>Bucket</th><th>Inputs</th><th>n</th>
                <th>Primary win</th><th>Favorite win</th><th>Random</th>
                <th title="Mean of (did the primary pick win) minus (what its own closing price said it would), over races whose results carried a board. 0 = you are the market.">Beat the close</th>
                <th title="The POST-TIME favorite, on the subset of races that carried a board - a smaller n than Favorite win by design.">Close fav win</th>
                <th>Any win</th><th>Backed/race</th>
                <th>Place</th><th>Show</th><th>Favorite show</th>
                <th>Named in top 3</th><th>Field</th><th>Unknown #</th>
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((s) => (
                <tr key={s.groupKey}>
                  <td><strong>{s.source}</strong></td>
                  <td><span className={`chip chip--${BUCKET_CHIP[s.bucket] ?? 'guess'}`}>{s.bucket}</span></td>
                  <td className="dim">{s.inputs ?? ''}</td>
                  <td>{s.n}{s.unscored ? <span className="dim"> (+{s.unscored} unscored)</span> : ''}</td>
                  <td>{rate(s.primaryWin)}</td>
                  <td>{rate(s.baselines.favoriteWin)}</td>
                  <td className="dim">{pct(s.baselines.randomWin)}</td>
                  <td>{edge(s.closeEdge)}</td>
                  <td>{rate(s.baselines.marketFavoriteWin)}</td>
                  <td>{rate(s.anyWin)}</td>
                  <td className="dim">{num(s.meanWinBacked, 2)}</td>
                  <td>{rate(s.place)}</td>
                  <td>{rate(s.show)}</td>
                  <td>{rate(s.baselines.favoriteShow)}</td>
                  <td>{rate(s.namedTop3)}</td>
                  <td className="dim">{num(s.baselines.meanFieldSize)}</td>
                  <td>{s.racesWithUnknownPicks ? <span className="tag tag--red">{s.racesWithUnknownPicks}</span> : <span className="dim">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.unscoredDays.length > 0 && (
        <p className="dim">
          Picks with no results yet, which is what moves these numbers:{' '}
          {data.unscoredDays.map((d, i) => (
            <React.Fragment key={d.raceDayId}>
              {i > 0 ? ', ' : ''}
              <span className="linkish" onClick={() => onOpenDay(d.raceDayId)}>{d.track} {d.date}</span> ({d.rows})
            </React.Fragment>
          ))}.
        </p>
      )}

      {data.races.length > 0 && (
        <>
          <div className="pagehead">
            <h3>Races</h3>
            <label className="dim"><input type="checkbox" checked={showRaces} onChange={(e) => setShowRaces(e.target.checked)} /> show every scored row ({data.races.filter((r) => r.scored).length})</label>
          </div>
          {showRaces && (
            <div className="grid--wide-scroll">
              <table className="grid grid--click">
                <thead>
                  <tr>
                    <th>Date</th><th>Track</th><th>Race</th><th>Source</th><th>Primary</th><th>Finish</th>
                    <th>Win</th><th>Any win</th><th>Place</th><th>Show</th><th>Named top 3</th><th>Winner</th><th>Favorite</th><th>Fav won</th>
                    <th title="The primary pick's own closing price, as a takeout-normalised win probability">Close %</th>
                    <th title="1 (or 0) minus that probability - the per-race term the Beat the close column averages">Edge</th>
                    <th>Unknown #</th>
                  </tr>
                </thead>
                <tbody>
                  {data.races.filter((r) => r.scored).map((r) => (
                    <tr key={`${r.raceDayId}-${r.raceNo}-${r.groupKey}`} onClick={() => onOpenDay(r.raceDayId)}>
                      <td>{r.date}</td>
                      <td>{r.trackCode}</td>
                      <td>{r.raceNo}</td>
                      <td>{r.groupKey}</td>
                      <td>{r.primary ? `#${r.primary.horseNo}` : <span className="dim">—</span>}</td>
                      <td>{r.primary ? (r.primary.finish ?? <span className="dim">unplaced</span>) : ''}</td>
                      <td>{yn(r.primaryWin)}</td>
                      <td>{yn(r.anyWin)}{r.winBackedCount > 1 ? <span className="dim"> ({r.winBackedCount})</span> : ''}</td>
                      <td>{yn(r.placeHit)}</td>
                      <td>{yn(r.showHit)}</td>
                      <td>{r.namedTop3}/{r.top3Possible}</td>
                      <td>{r.winnerProgramNumber ? `#${r.winnerProgramNumber}` : ''}</td>
                      <td className="dim">{r.favorite ? r.favorite.horseNos.map((h) => `#${h}`).join('/') : '—'}</td>
                      <td>{r.favorite ? yn(r.favorite.win) : ''}</td>
                      <td className="dim">{r.market?.primaryImplied == null ? '—' : `${(100 * r.market.primaryImplied).toFixed(0)}%`}</td>
                      <td>{r.market?.closeEdge == null
                        ? <span className="dim">—</span>
                        : <span className={r.market.closeEdge > 0 ? 'pl--pos' : 'pl--neg'}>
                          {r.market.closeEdge > 0 ? '+' : ''}{(100 * r.market.closeEdge).toFixed(0)}
                        </span>}
                      </td>
                      <td>{r.unknownPicks.length ? <span className="tag tag--red">{r.unknownPicks.map((h) => `#${h}`).join(' ')}</span> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
