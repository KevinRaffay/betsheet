import React, { useEffect, useState } from 'react';
import { blindnessLabel, getRaceDay, getReplayDayRaces, getReplaySummary, listCards } from '../api.js';
import ReplayRaceView from './ReplayRaceView.jsx';
import ReplayDayBuilderModal from './ReplayDayBuilderModal.jsx';
import CardView from './CardView.jsx';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const signed = (cents) => (cents == null ? '—' : (
  <span className={cents >= 0 ? 'pl--pos' : 'pl--neg'}>{cents >= 0 ? '+' : '−'}{money(Math.abs(cents))}</span>
));
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
const STATUS_LABEL = (r) => (r.revealed ? 'Revealed' : r.pass ? 'Passed' : r.locked ? 'Locked' : 'Not played');

// Replay day landing (D62): the day's races at a glance before diving into
// one blind - clicking a row opens that race in the same ReplayRaceView
// this route used to jump straight into (always at race 1). Resolves the
// day's own human card the same way ReplayRaceView does (D60) so PL shows
// for whichever races are already revealed on a resumed playthrough.
//
// D95: once the day is CLOSED it also renders the final card itself - the
// same CardView the /card/:id route renders, mounted `embedded` so it brings
// no Delete/Export/Back chrome of its own. Reusing that component rather
// than writing a second sheet is the whole point: per-race tables,
// subtotals, the day total and the grade join all stay in one place.
export default function ReplayDayLanding({ dayId, onBack, onOpenStanding }) {
  const [dayInfo, setDayInfo] = useState(null);
  // The whole card row, not just its id: the final-card section names the
  // card number, and the count of human cards on the day decides whether to
  // say that older playthroughs exist.
  const [humanCards, setHumanCards] = useState(null);
  const [summary, setSummary] = useState(null);
  const [races, setRaces] = useState(null);
  const [error, setError] = useState(null);
  const [selectedRace, setSelectedRace] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [building, setBuilding] = useState(false);

  // The day's LATEST human card is the one this page is about, the same
  // resume rule ReplayRaceView follows (D60). A replayed day mints a new card
  // rather than editing the old one (D28), so older playthroughs stay
  // readable at their own /card/:id.
  const card = humanCards?.[0] ?? null;
  const cardId = card?.id ?? null;

  useEffect(() => {
    getRaceDay(dayId).then(setDayInfo).catch((e) => setError(String(e.message)));
  }, [dayId]);

  useEffect(() => {
    setHumanCards(null);
    listCards(dayId)
      .then((cards) => setHumanCards(cards.filter((c) => c.template === 'human').sort((a, b) => b.card_number - a.card_number)))
      .catch(() => setHumanCards([]));
  }, [dayId, refreshKey]);

  useEffect(() => {
    getReplayDayRaces(dayId, cardId).then((d) => setRaces(d.races)).catch((e) => setError(String(e.message)));
  }, [dayId, cardId, refreshKey]);

  // `closed` is server truth (every race passed or revealed), the same bit
  // ReplayRaceView gates its own graded tables on - never "did I click Close
  // in this tab". A block body, never `useEffect(fn, deps)` with a
  // promise-returning fn: React would call the promise as this effect's
  // cleanup on unmount (D90).
  useEffect(() => {
    setSummary(null);
    if (cardId == null) return;
    getReplaySummary(cardId).then(setSummary).catch(() => {});
  }, [cardId, refreshKey]);

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

      {/* D95: the final card, once the day is genuinely closed. The gate is
          `summary.closed` - every race passed or revealed - and not merely
          "the day has results", because a Replay day ALWAYS has results (the
          picker only lists days that do) and a card can sit part-played with
          races locked but unrevealed. Rendering the sheet then would hand
          back the finish order for a race the player is still blind on, and
          buildSummary's own human totals already sum every graded ticket on
          the card regardless of reveal state. Same bit, same reason,
          ReplayRaceView gates its per-race graded tables on. */}
      {cardId != null && summary?.closed && (
        <>
          <div className="notice">
            <p>
              <strong>Day closed.</strong> Final card #{card.card_number} · blindness{' '}
              <span className="chip chip--human">{blindnessLabel(summary.blindness)}</span>
              {humanCards.length > 1 && (
                <span className="dim">
                  {' '}· {humanCards.length - 1} earlier playthrough{humanCards.length > 2 ? 's' : ''} on this day, each its own card
                </span>
              )}
            </p>
            <p>
              Human: {money(summary.human.wageredCents)} wagered, {signed(summary.human.plCents)}
              {' '}· ROI wagered {pct(summary.human.roiOnWageredPct)} / bankroll {pct(summary.human.roiOnBankrollPct)}
              {' '}· {summary.human.hits} {summary.human.hits === 1 ? 'hit' : 'hits'} on {summary.human.tickets} tickets
            </p>
            {summary.lean
              ? <p>Lean: {money(summary.lean.wageredCents)} wagered, {signed(summary.lean.plCents)} · ROI {pct(summary.lean.roiOnWageredPct)}</p>
              : <p className="dim">No lean card on this day to compare against.</p>}
          </div>
          <CardView cardId={cardId} embedded />
        </>
      )}

      {cardId != null && summary != null && !summary.closed && (
        <p className="dim">
          The final card appears here once every race is played out and the day is closed -
          open any unplayed race and use Close day. Until then the per-race view is the honest
          one: showing the whole card now would reveal races still being played blind.
        </p>
      )}
    </section>
  );
}
