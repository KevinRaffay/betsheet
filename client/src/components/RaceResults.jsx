import React from 'react';

const money = (cents) => (cents == null ? '' : `$${(cents / 100).toFixed(2)}`);

export default function RaceResults({ raceNumber, results }) {
  if (!results || results.results.length === 0) {
    return null;
  }

  const { results: finishers, exotics, scratches } = results;

  return (
    <details className="race-results">
      <summary>
        Results
        {' '}· {finishers.length} finishers
        {exotics.length > 0 && ` · ${exotics.length} payoff${exotics.length === 1 ? '' : 's'}`}
      </summary>
      <table className="grid">
        <thead>
          <tr><th>Fin</th><th>#</th><th>Horse</th><th>Win</th><th>Place</th><th>Show</th></tr>
        </thead>
        <tbody>
          {finishers.map((r, i) => (
            <tr key={i}>
              <td className="dim">{r.finishPosition}</td>
              <td>{r.programNumber}</td>
              <td>{r.horseName}</td>
              <td>{money(r.winCents)}</td>
              <td>{money(r.placeCents)}</td>
              <td>{money(r.showCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {exotics.length > 0 && (
        <p className="dim">
          {exotics.map((x) => `${x.betType.replace(/_/g, ' ')} ${x.combination} → ${money(x.payoutCents)}`).join(' · ')}
        </p>
      )}
      {scratches.length > 0 && (
        <p className="dim">
          Scratched: {scratches.map((s) => `${s.horseName}${s.reason ? ` (${s.reason})` : ''}`).join(', ')}
        </p>
      )}
    </details>
  );
}
