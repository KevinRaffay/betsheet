import React from 'react';
import { navigate } from './app.jsx';

// The day landing: every race in the payload, read-only (D236 removed the
// card picker and "Start a new card" - there is no card being built here).
export default function DayView({ payload }) {
  return (
    <section className="panel">
      <h2>Races</h2>
      <table className="grid">
        <thead>
          <tr>
            <th>#</th><th>Post</th>
            {/* col-detail: dropped at mobile width so the View link - the
                only reason this table exists - never lands off the right
                edge. See the house rule in CLAUDE.md's Gotchas. */}
            <th className="col-detail">Distance</th>
            <th className="col-detail">Surface</th>
            <th className="col-detail">Runners</th>
            <th /></tr>
        </thead>
        <tbody>
          {payload.races.map((r) => {
            const live = r.entries.filter((e) => !e.scratched).length;
            return (
              <tr key={r.number}>
                <td>{r.number}</td>
                <td>{r.postTime ?? '—'}</td>
                <td className="col-detail">{r.distance ?? '—'}</td>
                <td className="col-detail">{r.surface ?? '—'}</td>
                <td className="col-detail">{live}{live !== r.entries.length && <span className="dim"> of {r.entries.length}</span>}</td>
                <td>
                  <button className="btn btn--sm" onClick={() => navigate(`/race/${r.number}`)}>
                    View
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
