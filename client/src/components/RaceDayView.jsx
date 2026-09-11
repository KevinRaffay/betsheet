import React, { useEffect, useRef, useState } from 'react';
import {
  deleteRaceDay, deletionPreview, getDayTipScoring, getLlmNotes, getRaceDay, getResults, listTipPicks,
} from '../api.js';
import CardsPanel from './CardsPanel.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import EquibaseOtrPanel from './EquibaseOtrPanel.jsx';
import RaceTipPicks from './RaceTipPicks.jsx';
import RaceResults from './RaceResults.jsx';
import TipPicksEntryModal from './TipPicksEntryModal.jsx';
import RaceDayNotesModal from './RaceDayNotesModal.jsx';
import LiveOddsModal from './LiveOddsModal.jsx';
import LlmCardModal from './LlmCardModal.jsx';
import {
  LiveOddsBar, LiveOddsCell, LiveOddsHistory, useRaceLiveOdds,
} from './RaceLiveOdds.jsx';
import RaceNotesEditor from './RaceNotesEditor.jsx';
import { NoteSourceDatalist } from './AnalystNotesEditor.jsx';
import { entriesStaleness } from '@shared/staleness.js';
import { flagRaceEntries } from '@shared/entry-flags.js';
import { dollars } from '@shared/betmath.js';
import EntryFlagTags from './EntryFlagTags.jsx';

// D224: the win probability a morning line implies, 0-1 -> a percent string.
const pct = (p) => (p == null ? '' : `${(p * 100).toFixed(0)}%`);

// D240: the move between the two Win% columns, in percentage POINTS - the
// plain difference of the two figures beside it, so the arithmetic on screen
// is checkable by eye. (The columns round to whole points, so a +5.5 can sit
// beside 28% and 23%.) Both are the NORMALISED readings and so is this, which
// is what makes a race's deltas sum to zero and makes this number agree with
// the STEAM/DRIFT tag on the horse's name; shared/entry-flags.js's header has
// the measurement that forced it.
const deltaPoints = (f) => {
  if (!f || f.mlFairProbability == null || f.liveFairProbability == null) return '';
  const pts = (f.liveFairProbability - f.mlFairProbability) * 100;
  // U+2212 MINUS, not a hyphen: the column is numeric and right-aligned.
  return `${pts > 0 ? '+' : pts < 0 ? '\u2212' : ''}${Math.abs(pts).toFixed(1)}`;
};

// The raw reading, kept one hover away rather than deleted - D224 put it on
// screen to make the track's take visible, and that is still worth seeing.
const rawTitle = (p) => (p == null ? undefined
  : `Raw implied probability ${(p * 100).toFixed(1)}% (1 / (odds + 1)); a full field sums well over 100% because of the track's own take. The column shows this horse's share of the book instead, so a race sums to 100% and the moves sum to zero.`);

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
  // know about on its own - the Equibase OTR upload (D142) and, since tip
  // sheets stake automatically as soon as they're saved (replacing D183's
  // manual "Stake all tip sheets into cards" button), every tip-pick save,
  // correction or delete via `bumpTips` below. Any future sibling that writes
  // a card needs the same `onSaved`/bump wire, or its cards appear only after
  // a page reload - CardsPanel self-fetches on mount, so remounting it via
  // `key` is the reload. The two in-panel modals don't need this: they're
  // CardsPanel's own children and call its `reload` directly.
  const [cardsVersion, setCardsVersion] = useState(0);
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [showLiveOdds, setShowLiveOdds] = useState(false);
  // D176: which race's tip-pick dialog is open, and a counter that refetches
  // the day's tip rows when anything writes one. D182: the rows and their
  // scores are loaded ONCE here and passed down to each race's own panel -
  // one request for the day rather than one per race, and no second copy
  // that could disagree about which sources exist.
  const [tipRace, setTipRace] = useState(null);
  const [tipVersion, setTipVersion] = useState(0);
  // D182/D184 house rule (a race-specific action belongs in the race's own
  // panel): which race's "Generate Card from LLM" button was clicked. The
  // modal itself is still the day-wide LlmCardModal (a card is generated one
  // race at a time regardless of entry point) - this just opens it scrolled
  // to the race the user was actually looking at instead of the top of the
  // grid.
  const [llmRace, setLlmRace] = useState(null);
  const [tipRows, setTipRows] = useState([]);
  const [tipScoring, setTipScoring] = useState(null);
  // The day's analyst notes (same `llm_notes` draft, D92), keyed by race
  // number so each race's own panel can look itself up. D184: these are now
  // EDITABLE in place - the panel below is `RaceNotesEditor`, not the
  // read-only `RaceNotes` - so this map is both the display source and what a
  // save refetches into.
  const [notesByRace, setNotesByRace] = useState(new Map());
  // Whether the day's results are already on file. Carried down to every
  // race's editor so the not-blind warning appears where a note is actually
  // typed, which since D184 is the race panel rather than the day dialog.
  const [notesPostResult, setNotesPostResult] = useState(false);
  // Results data organized by race number so each race can display its own
  // results in a collapsible panel. Loaded once per day, not per race.
  const [resultsByRace, setResultsByRace] = useState(new Map());
  const racesContainerRef = useRef(null);

  const expandAll = () => {
    if (racesContainerRef.current) {
      const details = racesContainerRef.current.querySelectorAll('details.race');
      details.forEach((d) => { d.open = true; });
    }
  };

  const collapseAll = () => {
    if (racesContainerRef.current) {
      const details = racesContainerRef.current.querySelectorAll('details.race');
      details.forEach((d) => { d.open = false; });
    }
  };

  // Named so a capture that changed this day's prices can re-read it, not just
  // the mount effect. Block body (D90): an expression-bodied loader would be
  // stored as the effect's cleanup and called on unmount.
  const loadDay = () => getRaceDay(id).then(setDay).catch((e) => setError(String(e.message)));

  useEffect(() => { loadDay(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // D232: typed live odds. The drafts live here so the inputs can sit inside
  // the entries table while the save bar sits under it; re-reading the day on
  // save is what flushes the drafts back to stored values.
  const oddsCtl = useRaceLiveOdds(id, loadDay);

  const loadNotes = () => getLlmNotes(id)
    .then((n) => {
      setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v])));
      setNotesPostResult(Boolean(n.postResult));
    })
    .catch(() => {}); // supplementary display only - a fetch failure here shouldn't block the page
  useEffect(() => { loadNotes(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle anchor navigation to a specific race (#race-N)
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#race-')) {
      // Wait for the next render to ensure details elements exist
      setTimeout(() => {
        const allRaces = racesContainerRef.current?.querySelectorAll('details.race') ?? [];
        const targetElement = document.querySelector(hash);

        // Collapse all races
        allRaces.forEach((d) => { d.open = false; });

        // Open only the target race and its nested panels
        if (targetElement && targetElement.tagName === 'DETAILS') {
          targetElement.open = true;

          // Expand analyst notes and tip sheets panels within the target race
          const notesPanel = targetElement.querySelector('details.race-notes');
          if (notesPanel) notesPanel.open = true;

          const tipsPanel = targetElement.querySelector('details.race-tips');
          if (tipsPanel) tipsPanel.open = true;

          targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 0);
    }
  }, [day]);

  // Load race results organized by race number for per-race display
  useEffect(() => {
    let cancelled = false;
    getResults(id)
      .then((data) => {
        if (!cancelled) {
          const byRace = new Map();
          if (data?.results) {
            for (const r of data.results) {
              if (!byRace.has(r.race_number)) {
                byRace.set(r.race_number, { results: [], exotics: [], scratches: [] });
              }
              byRace.get(r.race_number).results.push(r);
            }
          }
          if (data?.exotics) {
            for (const x of data.exotics) {
              if (byRace.has(x.race_number)) {
                byRace.get(x.race_number).exotics.push(x);
              }
            }
          }
          if (data?.scratches) {
            for (const s of data.scratches) {
              if (byRace.has(s.race_number)) {
                byRace.get(s.race_number).scratches.push(s);
              }
            }
          }
          setResultsByRace(byRace);
        }
      })
      .catch(() => {}); // supplementary - a failure here must not blank the page
    return () => { cancelled = true; };
  }, [id]);

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
    // Scoring is a SEPARATE, equally supplementary read: a day with no
    // results on file has nothing to score, and that must leave the picks
    // themselves perfectly visible.
    getDayTipScoring(id)
      .then((s) => { if (!cancelled) setTipScoring(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, tipVersion]);

  // Bumps CardsPanel's remount key too: a tip-pick save, correction or delete
  // now stakes its source automatically server-side (`autoStake` in
  // server/tip-picks.js), so cards can change on every one of these, not just
  // on an explicit staking action.
  const bumpTips = () => { setTipVersion((v) => v + 1); setCardsVersion((v) => v + 1); };
  const scoreFor = (rowId) => tipScoring?.races?.find((r) => r.id === rowId)?.score ?? null;

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

  // D216: one entry-flag array per race, keyed by race number, computed here
  // rather than inside the races `.map` below - that callback is an expression
  // arrow, and widening it to a block body to hold one `const` would rewrite
  // fifty lines of JSX indentation for nothing.
  const raceFlags = new Map(
    day.races.map((r) => [r.number, flagRaceEntries(r.entries ?? [])]),
  );
  const entryFlags = new Map([...raceFlags].map(([n, r]) => [n, r.flags]));
  // D240: the three board columns appear only on a race that HAS a board -
  // two or more runners priced both ways, which is exactly when a move can be
  // computed at all. A race with no live odds typed yet keeps the pre-D240
  // table rather than gaining three columns of dashes, which also keeps the
  // width off a phone until there is something on it worth the width.
  const hasBoard = new Map([...raceFlags].map(([n, r]) => [n, r.comparableCount >= 2]));

  return (
    <section>
      <div className="pagehead">
        <h2>{day.track} — {day.date}</h2>
        <div className="formrow formrow--tight">
          {/* D159: notes are a race-day attribute (D92), so this is reachable
              the moment entries are in - before any card exists - and writes
              through the same draft store the LLM generator's own notes UI
              reads and writes. D184: WHOLE-DAY note only; a race's own note is
              typed in that race's panel. */}
          <button className="btn" onClick={() => setShowLiveOdds(true)}>Capture live odds</button>
          <button className="btn" onClick={() => setShowNotesModal(true)}>Day Analyst Notes</button>
          <button className="btn btn--danger" disabled={busy} onClick={askDelete}>Delete race day</button>
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      {/* The source datalist is referenced by id from every race's notes
          editor, so it is rendered ONCE for the page rather than per race. */}
      <NoteSourceDatalist />

      {showLiveOdds && (
        <LiveOddsModal dayId={day.id} onClose={() => setShowLiveOdds(false)} onSaved={() => loadDay()} />
      )}

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
          onSaved={bumpTips}
        />
      )}
      {llmRace && (
        <LlmCardModal
          dayId={day.id}
          initialRace={llmRace.number}
          onCardChanged={() => setCardsVersion((v) => v + 1)}
          onClose={() => setLlmRace(null)}
        />
      )}

      <ResultsPanel dayId={day.id} />
      <EquibaseOtrPanel dayId={day.id} onSaved={() => setCardsVersion((v) => v + 1)} />
      <div className="races-card" ref={racesContainerRef}>
        <div className="races-card__controls">
          <button className="btn" onClick={expandAll}>Expand all</button>
          <button className="btn" onClick={collapseAll}>Collapse all</button>
        </div>
        {day.races.map((race) => (
          <details className="race" key={race.id} id={`race-${race.number}`} open>
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
              <tr><th>#</th><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>Wt</th><th>M/L</th>
              <th title="The tote board, typed at post time. Equibase's own page cannot supply it - the LiveOdds column is empty in the served HTML and filled by client-side JS - so this is entered by hand, per race, and every save keeps its own capture time">Live</th>
              <th title="What $2-to-win pays if this horse wins - the printed line as a forecast, not the actual tote price">$2 win</th>
              <th title="This horse's share of the morning-line book, so a race sums to 100%. Hover a cell for the raw 1 / (odds + 1) reading, which sums to 118-136% because of the track's take">ML Win%</th>
              {hasBoard.get(race.number) && <th title="The same reading off the typed live board, normalised over the same runners - which is what makes it subtractable from the column beside it">Live Win%</th>}
              {hasBoard.get(race.number) && <th title="Live Win% minus ML Win%, in percentage points. Both books are normalised over the runners priced in each, so a race's moves sum to zero and a horse reads as moved only if another moved the other way - a raw difference would have shown every runner drifting or steaming together whenever the two books totalled differently, or whenever a scratch re-priced the field">&Delta;%</th>}
              <th title="Predicted order of finish from the morning line (1 = shortest line; ties share a rank)">ML rank</th>
              {hasBoard.get(race.number) && <th title="The same ordering read off the live board (1 = shortest live price; ties share a rank). Read against ML rank: a horse moving up the board is one the crowd backed harder than the linemaker predicted">Live rank</th>}</tr>
            </thead>
            <tbody>
              {/* D216: index-aligned with `race.entries`, computed once per race. */}
              {race.entries.map((e, ei) => (
                <tr
                  key={e.id}
                  className={[e.scratched ? 'row--scratched' : '',
                    (entryFlags.get(race.number)?.[ei]?.baffert
                      || entryFlags.get(race.number)?.[ei]?.favorite) ? 'row--entry-flag' : ''].filter(Boolean).join(' ')}
                >
                  <td>{e.program_number}</td>
                  <td className="dim">{e.post_position ?? ''}</td>
                  <td>
                    {e.horse_name}
                    {e.best_bet ? <span className="tag tag--gold">BEST BET</span> : null}
                    {e.not_to_be_claimed ? <span className="tag">NTC</span> : null}
                    {e.scratched ? <span className="tag tag--red">SCR</span> : null}
                    <EntryFlagTags flag={entryFlags.get(race.number)?.[ei]} />
                  </td>
                  <td>{e.jockey ?? ''}</td>
                  <td>{e.trainer ?? ''}</td>
                  <td>{e.weight ?? ''}</td>
                  <td>{e.morning_line ?? ''}</td>
                  <LiveOddsCell race={race} entry={e} ctl={oddsCtl} />
                  <td className="dim">{entryFlags.get(race.number)?.[ei]?.mlPayoutCents != null ? dollars(entryFlags.get(race.number)[ei].mlPayoutCents) : ''}</td>
                  <td className="dim" title={rawTitle(entryFlags.get(race.number)?.[ei]?.mlWinProbability)}>{pct(entryFlags.get(race.number)?.[ei]?.mlFairProbability)}</td>
                  {hasBoard.get(race.number) && (
                    <td className="dim" title={rawTitle(entryFlags.get(race.number)?.[ei]?.liveWinProbability)}>
                      {pct(entryFlags.get(race.number)?.[ei]?.liveFairProbability)}
                    </td>
                  )}
                  {hasBoard.get(race.number) && (
                    <td className={`odds-delta odds-delta--${(entryFlags.get(race.number)?.[ei]?.move?.direction) ?? 'flat'}`}>
                      {deltaPoints(entryFlags.get(race.number)?.[ei])}
                    </td>
                  )}
                  <td className="dim">{entryFlags.get(race.number)?.[ei]?.mlRank ?? ''}</td>
                  {hasBoard.get(race.number) && <td className="dim">{entryFlags.get(race.number)?.[ei]?.liveRank ?? ''}</td>}
                </tr>
              ))}
            </tbody>
            </table>
            <LiveOddsBar race={race} ctl={oddsCtl} />
            <LiveOddsHistory race={race} ctl={oddsCtl} />
            {race.wager_menu && <p className="dim wager">{race.wager_menu}</p>}
            <div className="formrow formrow--tight">
              <button className="btn btn--sm" onClick={() => setLlmRace(race)}>
                Generate Card from LLM
              </button>
            </div>
            {/* D184: a note about THIS race is typed here, under the house
                rule that a race-specific input belongs in the Race UI. The
                day-level dialog now writes the whole-day note only. */}
            <RaceNotesEditor
              dayId={day.id}
              raceNumber={race.number}
              note={notesByRace.get(race.number) ?? null}
              postResult={notesPostResult}
              onSaved={loadNotes}
            />
            {/* D182: a tip sheet is an opinion about THIS race, so it sits
                beside this race's notes rather than in a day-level list. D176's
                entry dialog is opened from inside the panel. */}
            <RaceTipPicks
              rows={tipRows.filter((r) => r.raceNo === race.number)}
              scoreFor={scoreFor}
              onEnter={() => setTipRace(race)}
              onChanged={bumpTips}
            />
            {/* Display race results if available */}
            <RaceResults
              raceNumber={race.number}
              results={resultsByRace.get(race.number) ?? null}
            />
          </details>
        ))}
      </div>
    </section>
  );
}
