import React, { useEffect, useState } from 'react';
import { deleteRaceDay, deletionPreview, getLlmNotes, getRaceDay, listTipPicks } from '../api.js';
import CardsPanel from './CardsPanel.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import EquibaseOtrPanel from './EquibaseOtrPanel.jsx';
import TipPicksPanel from './TipPicksPanel.jsx';
import TipPicksEntryModal from './TipPicksEntryModal.jsx';
import RaceDayNotesModal from './RaceDayNotesModal.jsx';
import RaceNotes from './RaceNotes.jsx';
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
  // Bumped when a SIBLING of CardsPanel writes cards CardsPanel has no way to
  // know about on its own - the Equibase OTR upload (D142) and the tip-sheet
  // staking panel (D173). Any future sibling that writes a card needs the same
  // `onSaved` wire, or its cards appear only after a page reload -
  // CardsPanel self-fetches on mount, so remounting it via `key` is the
  // reload. The two in-panel modals don't need this: they're CardsPanel's
  // own children and call its `reload` directly.
  const [cardsVersion, setCardsVersion] = useState(0);
  const [showNotesModal, setShowNotesModal] = useState(false);
  // D176: which race's tip-pick dialog is open, and a counter that remounts
  // TipPicksPanel when it saves - the same wire D173 had to add for staking.
  const [tipRace, setTipRace] = useState(null);
  const [tipVersion, setTipVersion] = useState(0);
  const [tipRows, setTipRows] = useState([]);
  // Read-only: the analyst notes entered via "Enter Analyst Notes" / the LLM
  // generator's own notes fields (same `llm_notes` draft, D92), keyed by race
  // number so each race's collapsible panel below can look itself up.
  const [notesByRace, setNotesByRace] = useState(new Map());

  useEffect(() => {
    getRaceDay(id).then(setDay).catch((e) => setError(String(e.message)));
  }, [id]);

  const loadNotes = () => getLlmNotes(id)
    .then((n) => setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v]))))
    .catch(() => {}); // supplementary display only - a fetch failure here shouldn't block the page
  useEffect(() => { loadNotes(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // D176: the race's existing tip picks, so the entry dialog opens EDITING
  // what is already there rather than blank. Refetched on tipVersion so a save
  // is reflected without a reload. `cancelled` guards the documented
  // stale-response race (Gotchas): two loads in flight have no ordering
  // guarantee, and the cleanup must be a FUNCTION, never a promise.
  useEffect(() => {
    let cancelled = false;
    listTipPicks(id)
      .then((r) => { if (!cancelled) setTipRows(r.rows ?? []); })
      .catch(() => {}); // supplementary - a failure here must not blank the page
    return () => { cancelled = true; };
  }, [id, tipVersion]);

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

      {showNotesModal && (
        <RaceDayNotesModal dayId={day.id} onClose={() => { setShowNotesModal(false); loadNotes(); }} />
      )}

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
      {/* The key is NAMESPACED, and must stay that way. These remount counters
          are siblings in one children list, they both start at 0, and a
          duplicate key among siblings does not warn-and-carry-on: React
          duplicates or omits the children outright (D181 - the /day page grew
          a second, then a fourth, "Betting cards" panel on any re-render).
          A bare `key={someVersion}` is only safe while nothing beside it uses
          one, which is not a property a later edit can be expected to check. */}
      <CardsPanel key={`cards-${cardsVersion}`} dayId={day.id} bankrollCents={day.bankroll_cents} onOpenCard={onOpenCard} />
      {tipRace && (
        <TipPicksEntryModal
          dayId={day.id}
          race={tipRace}
          entries={tipRace.entries ?? []}
          existing={tipRows.filter((r) => r.raceNo === tipRace.number)}
          onClose={() => setTipRace(null)}
          onSaved={() => setTipVersion((v) => v + 1)}
        />
      )}

      <TipPicksPanel key={`tips-${tipVersion}`} dayId={day.id} races={day.races ?? []} onSaved={() => setCardsVersion((v) => v + 1)} />
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
          {/* D176: tip picks are typed here, per race, rather than
              photographed - three horses and three ranks is faster to enter
              than to screenshot, and costs no API call. */}
          <div className="formrow">
            <button type="button" className="btn btn--sm" onClick={() => setTipRace(race)}>
              Enter tipsheet picks
            </button>
          </div>
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
          <RaceNotes note={notesByRace.get(race.number) ?? null} />
        </details>
      ))}
    </section>
  );
}
