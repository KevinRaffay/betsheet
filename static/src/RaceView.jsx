import React from 'react';
import EntriesTable from '@client/components/EntriesTable.jsx';
import { navigate } from './app.jsx';
import { useIsMobile } from './mobile.js';

// One race, read-only. D236 removed the ticket builder, the lock/PASS/discard
// state machine and the render-time committed-text snapshot that used to live
// here - there is no ticket being composed on this screen any more.
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

  return (
    <section className="panel">
      <div className="formrow formrow--tight">
        <button className="btn btn--sm" onClick={() => navigate(`/day/${dayId}`)}>← All races</button>
        <h2>Race {race.number}</h2>
        <span className="dim">
          {[race.postTime, race.distance, race.surface, race.raceType].filter(Boolean).join(' · ')}
        </span>
      </div>
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
    </section>
  );
}
