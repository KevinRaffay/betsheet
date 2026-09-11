import React, { useState } from 'react';
import { navigate } from './app.jsx';

// The landing screen: every race day in the bundle, filterable by date and
// track - mirrors client/src/components/RaceDayList.jsx's own pattern
// (derive filter options from the data already loaded, two independent
// selects AND-combined, "Clear filters" only when active) rather than a
// server-side filter endpoint, since there is no server here.
export default function DayList({ raceDays, onOpenCalendar }) {
  const [dateFilter, setDateFilter] = useState('');
  const [trackFilter, setTrackFilter] = useState('');

  const dateOptions = [...new Set(raceDays.map((d) => d.raceDay.date))].sort().reverse();
  const trackOptions = [...new Set(raceDays.map((d) => d.raceDay.track))].sort();
  const filtered = raceDays.filter((d) => (!dateFilter || d.raceDay.date === dateFilter)
    && (!trackFilter || d.raceDay.track === trackFilter));
  const filtersActive = Boolean(dateFilter || trackFilter);

  return (
    <section className="panel">
      <div className="pagehead">
        <h2>Race days</h2>
        <div className="formrow formrow--tight">
          <label>
            Date
            <select className="in in--sm" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
              <option value="">All dates</option>
              {dateOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label>
            Track
            <select className="in in--sm" value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)}>
              <option value="">All tracks</option>
              {trackOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          {filtersActive && (
            <button className="btn btn--sm" onClick={() => { setDateFilter(''); setTrackFilter(''); }}>
              Clear filters
            </button>
          )}
          <button className="btn btn--sm" onClick={onOpenCalendar}>Calendar</button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="placeholder">
          {raceDays.length === 0 ? 'No race days in this snapshot.' : 'No race days match the current filters.'}
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th><th>Track</th>
              <th className="col-detail">Races</th>
              <th className="col-detail">Cards</th>
              <th /></tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.raceDay.raceDayId}>
                <td>{d.raceDay.date}</td>
                <td>{d.raceDay.track}</td>
                <td className="col-detail">{d.races.length}</td>
                <td className="col-detail">{d.cards.length}</td>
                <td>
                  <button className="btn btn--sm" onClick={() => navigate(`/day/${d.raceDay.raceDayId}`)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
