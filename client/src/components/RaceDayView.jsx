import React, { useEffect, useState } from 'react';
import { deleteRaceDay, deletionPreview, getRaceDay } from '../api.js';
import CardsPanel from './CardsPanel.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import EquibaseOtrPanel from './EquibaseOtrPanel.jsx';
import RaceDayNotesModal from './RaceDayNotesModal.jsx';
import { entriesStaleness } from '@shared/staleness.js';

// Read-only view of a stored race day - what actually landed in the
// database, not what the parser proposed.
export default function RaceDayView({ id, onBack, onOpenCard }) {
  const [day, setDay] = useState(null);
  // ONE clock for the whole render, so the day banner and every per-race
  // tag agree with each other. Re-read on each render rather than held in
  // state: this is a page you leave and come back to, and a stale `now`
  // reporting stale entries as fresh is the one thing it must not do.
  const now = new Date();
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // deletion-preview counts
  const [busy, setBusy] = useState(false);
  // Bumped when a sibling of CardsPanel (currently just the Equibase OTR
  // upload) writes cards CardsPanel has no way to know about on its own -
  // CardsPanel self-fetches on mount, so remounting it via `key` is the
  // reload. The two in-panel modals don't need this: they're CardsPanel's
  // own children and call its `reload` directly.
  const [cardsVersion, setCardsVersion] = useState(0);
  const [showNotesModal, setShowNotesModal] = useState(false);

  useEffect(() => {
    getRaceDay(id).then(setDay).catch((e) => setError(String(e.message)));
  }, [id]);

  const askDelete = async () => {
    setBusy(true);
    try {
      setConfirm(await deletionPreview(id));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteRaceDay(id);
      onBack();
    } catch (e) {
      setError(String(e.message));
      setBusy(false);
    }
  };

  if (error) return <p className="notice notice--error">{error}</p>;
  if (!day) return <p className="placeholder">Loading…</p>;

  return (
    <section>
      <div className="pagehead">
        <h2>{day.track} — {day.date}</h2>
        <div className="formrow formrow--tight">
          {/* D159: notes are a race-day attribute (D92), so this is reachable
              the moment entries are in - before any card exists - and writes
              through the same draft store the LLM generator's own notes UI
              reads and writes. */}
          <button className="btn" onClick={() => setShowNotesModal(true)}>Enter Analyst Notes</button>
          <button className="btn btn--danger" disabled={busy} onClick={askDelete}>Delete race day</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {showNotesModal && <RaceDayNotesModal dayId={day.id} onClose={() => setShowNotesModal(false)} />}

      {confirm && (
        <div className="notice notice--warn">
          <p>
            <strong>Delete {day.track} {day.date}?</strong> This removes from every
            view: {confirm.races} races, {confirm.entries} entries, picks from{' '}
            {confirm.sources} consensus source{confirm.sources === 1 ? '' : 's'},{' '}
            {confirm.cards} card{confirm.cards === 1 ? '' : 's'} with {confirm.tickets} tickets,
            {' '}{confirm.results ?? 0} result row{(confirm.results ?? 0) === 1 ? '' : 's'}.
            The decision-trace and fetch-audit logs are kept intact. A deleted
            day can be restored from the race-day list ("Show deleted").
          </p>
          <div className="formrow formrow--tight">
            <button className="btn btn--danger" disabled={busy} onClick={doDelete}>
              Delete it
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      <p className="dim">
        Bankroll {day.bankroll_cents != null ? `$${(day.bankroll_cents / 100).toFixed(0)}` : '—'}
        {' '}· per-race min {day.per_race_min_cents != null ? `$${(day.per_race_min_cents / 100).toFixed(0)}` : '—'}
        {' '}· {day.races.length} races
      </p>
      {/* D117: how old are the entries you are about to bet on? One
          `odds_captured_at` covers the whole card - the Equibase page prints
          no per-race time - so later races are staler than earlier ones by
          construction, and the per-race tag below is what makes that visible
          rather than something to reason about. A day ingested any other way
          has no capture time at all, and this says so rather than staying
          silent, because silence would read as "current". */}
      {(() => {
        const s = entriesStaleness({ capturedAt: day.odds_captured_at, raceDate: day.date, now });
        if (!s.known) return null;
        return (
          <p className={`notice notice--${s.state === 'stale' ? 'warn' : 'ok'}`}>
            {s.label}
            {s.state === 'stale' && ' - scratches and odds may have moved since. Re-save the page to refresh.'}
          </p>
        );
      })()}
      {/* D98: the hand-builder posts to D54's own endpoints, which take the
          card's bankroll. RaceDayView already holds the day, so pass it down
          rather than making CardsPanel fetch the day a second time. */}
      <CardsPanel key={cardsVersion} dayId={day.id} bankrollCents={day.bankroll_cents} onOpenCard={onOpenCard} />
      <ResultsPanel dayId={day.id} />
      <EquibaseOtrPanel dayId={day.id} onSaved={() => setCardsVersion((v) => v + 1)} />
      {day.races.map((race) => (
        <details className="race" key={race.id} open>
          <summary>
            <strong>Race {race.number}</strong>
            {' '}· {race.surface ?? '?'} · {race.distance ?? '?'} · {race.race_type ?? '?'}
            {' '}· post {race.post_time ?? '?'}
            {(() => {
              const s = entriesStaleness({
                capturedAt: day.odds_captured_at, raceDate: day.date, postTime: race.post_time, now,
              });
              if (!s.known) return null;
              // `ran` is null whenever saying so would need the track's
              // timezone, which nothing stores - see shared/staleness.js. The
              // tag simply does not appear in that case rather than guessing.
              if (s.ran) {
                return (
                  <span className="dim" title={s.assumesViewerClock
                    ? 'Compared against this device\'s clock - the track\'s timezone is not recorded.'
                    : 'This race day is in the past.'}
                  >{' '}· past post</span>
                );
              }
              // The separating space sits OUTSIDE the tag: inside it, the
              // tag's own padding swallows it and the summary reads
              // "post 1:30 PMentries 180m old".
              return s.state === 'stale'
                ? <>{' '}<span className="tag tag--gold" title={s.label}>entries {s.minutesOld}m old</span></>
                : null;
            })()}
          </summary>
          {race.conditions && <p className="conditions">{race.conditions}</p>}
          <table className="grid">
            <thead>
              <tr><th>#</th><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>Wt</th><th>M/L</th><th>Rank</th></tr>
            </thead>
            <tbody>
              {race.entries.map((e) => (
                <tr key={e.id} className={e.scratched ? 'row--scratched' : ''}>
                  <td>{e.program_number}</td>
                  <td className="dim">{e.post_position ?? ''}</td>
                  <td>
                    {e.horse_name}
                    {e.best_bet ? <span className="tag tag--gold">BEST BET</span> : null}
                    {e.not_to_be_claimed ? <span className="tag">NTC</span> : null}
                    {e.scratched ? <span className="tag tag--red">SCR</span> : null}
                  </td>
                  <td>{e.jockey ?? ''}</td>
                  <td>{e.trainer ?? ''}</td>
                  <td>{e.weight ?? ''}</td>
                  <td>{e.morning_line ?? ''}</td>
                  <td className="dim">{e.program_rank ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {race.wager_menu && <p className="dim wager">{race.wager_menu}</p>}
        </details>
      ))}
    </section>
  );
}
