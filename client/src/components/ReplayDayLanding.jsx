import React, { useEffect, useState } from 'react';
import { getRaceDay, getReplayDayRaces, listCards } from '../api.js';
import ReplayRaceView from './ReplayRaceView.jsx';
import ReplayDayBuilderModal from './ReplayDayBuilderModal.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (cents == null ? '—' : (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>{cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}</span>
));
const STATUS_LABEL = (r) => (r.revealed ? 'Revealed' : r.pass ? 'Passed' : r.locked ? 'Locked' : 'Not played');

// Replay day landing (D62): the day's races at a glance before diving into
// one blind - clicking a row opens that race in the same ReplayRaceView
// this route used to jump straight into (always at race 1). Resolves the
// day's own human card the same way ReplayRaceView does (D60) so PL shows
// for whichever races are already revealed on a resumed playthrough.
export default function ReplayDayLanding({ dayId, onBack, onOpenStanding }) {
  const [dayInfo, setDayInfo] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [races, setRaces] = useState(null);
  const [error, setError] = useState(null);
  const [selectedRace, setSelectedRace] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    getRaceDay(dayId).then(setDayInfo).catch((e) => setError(String(e.message)));
  }, [dayId]);

  useEffect(() => {
    setCardId(null);
    listCards(dayId).then((cards) => {
      const human = cards.filter((c) => c.template === 'human').sort((a, b) => b.card_number - a.card_number)[0];
      if (human) setCardId(human.id);
    }).catch(() => {});
  }, [dayId, refreshKey]);

  useEffect(() => {
    getReplayDayRaces(dayId, cardId).then((d) => setRaces(d.races)).catch((e) => setError(String(e.message)));
  }, [dayId, cardId, refreshKey]);

  // Races may have been locked/revealed while playing - refresh the table
  // on the way back instead of showing stale status.
  const handleBackFromRace = () => { setSelectedRace(null); setRefreshKey((k) => k + 1); };

  if (selectedRace != null) {
    return <ReplayRaceView dayId={dayId} initialRace={selectedRace} onBack={handleBackFromRace} onOpenStanding={onOpenStanding} />;
  }

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!dayInfo || !races) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>{dayInfo.track} — {dayInfo.date} · Replay</h2>
        <div className="formrow formrow--tight">
          <button className="btn btn--primary" onClick={() => setBuilding(true)}>Build tickets for the day</button>
          <button className="btn" onClick={onOpenStanding}>Standing</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>
      {building && (
        <ReplayDayBuilderModal
          dayId={dayId}
          cardId={cardId}
          bankrollCents={dayInfo.bankroll_cents}
          onCardChanged={() => setRefreshKey((k) => k + 1)}
          onClose={() => { setBuilding(false); setRefreshKey((k) => k + 1); }}
        />
      )}
      <table className="grid grid--click">
        <thead>
          <tr><th>Race</th><th>Distance</th><th>Type</th><th>Status</th><th>Human P/L</th><th>Lean P/L</th></tr>
        </thead>
        <tbody>
          {races.map((r) => (
            <tr key={r.raceNumber} onClick={() => setSelectedRace(r.raceNumber)}>
              <td>{r.raceNumber}</td>
              <td>{r.distance ?? '—'}</td>
              <td>{r.raceType ?? '—'}</td>
              <td className="dim">{STATUS_LABEL(r)}</td>
              <td>{r.revealed ? signed(r.humanRacePl) : '—'}</td>
              <td>{r.revealed ? (r.leanRacePl == null ? <span className="dim">no lean card</span> : signed(r.leanRacePl)) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
