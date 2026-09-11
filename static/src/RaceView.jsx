import React from 'react';
import EntriesTable from '@client/components/EntriesTable.jsx';
import { navigate } from './app.jsx';
import { useIsMobile } from './mobile.js';
import RacePicks from './RacePicks.jsx';

// One race, read-only. D236 removed the ticket builder, the lock/PASS/discard
// state machine and the render-time committed-text snapshot that used to live
// here - there is no ticket being composed on this screen any more.
//
// D364 added what emubets.com puts on a race: previous/next race links, and
// the same picks-and-result block the day screen shows (RacePicks.jsx), so a
// person who opened a race for its runners also sees what was bet on it.
export default function RaceView({ day, raceNumber }) {
  const race = day.races.find((r) => r.number === raceNumber);
  const isMobile = useIsMobile();
  const dayId = day.raceDay.raceDayId;

  if (!race) {
    return (
      <section className="panel">
        <p className="notice notice--error">No race {raceNumber} on this day.</p>
        <button className="btn" onClick={() => navigate(`/day/${dayId}`)}>Back to the day</button>
      </section>
    );
  }

  const numbers = day.races.map((r) => r.number);
  const idx = numbers.indexOf(race.number);
  const prev = idx > 0 ? numbers[idx - 1] : null;
  const next = idx < numbers.length - 1 ? numbers[idx + 1] : null;

  return (
    <section className="panel">
      <div className="formrow formrow--tight race-nav">
        <button className="btn btn--sm" onClick={() => navigate(`/day/${dayId}`)}>← {day.raceDay.track}</button>
        <span className="race-nav__spacer" />
        <button className="btn btn--sm" disabled={prev == null} onClick={() => navigate(`/day/${dayId}/race/${prev}`)}>‹ R{prev ?? ''}</button>
        <button className="btn btn--sm" disabled={next == null} onClick={() => navigate(`/day/${dayId}/race/${next}`)}>R{next ?? ''} ›</button>
      </div>
      <h2 className="race-section__title">Race {race.number}</h2>
      <p className="dim">
        {[race.postTime, race.distance, race.surface, race.raceType].filter(Boolean).join(' · ')}
      </p>
      {/* The race CONDITIONS line is deliberately not rendered (D158). It is
          three lines of eligibility boilerplate that push the entries below
          the fold on a phone for information nobody reads a card for. It
          stays in the payload, and therefore in `payloadHash`, so removing it
          here changes no hash; it is simply not shown on this surface. */}

      {/* Collapsed on a phone, expanded on a desktop, keyed on the breakpoint
          so a change remounts the panel and re-applies the default (`<details
          open>` is DOM state the browser and the user also own, once toggled
          React's record no longer matches the DOM and a later render carrying
          the same value will not correct it - a remount always will). `showRank`
          is off because the static payload carries no program_rank at all, so
          the column would be a dash on every row. */}
      <EntriesTable
        key={isMobile ? 'mobile' : 'desktop'}
        entries={race.entries}
        open={!isMobile}
        showRank={false}
      />

      <RacePicks day={day} race={race} />
    </section>
  );
}
