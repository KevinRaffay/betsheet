import React from 'react';
import { flagRaceEntries } from '@shared/entry-flags.js';
import EntryFlagTags from './EntryFlagTags.jsx';

// The READ-ONLY ingest preview (invariant 9): exactly what Save will store,
// warnings first. Shared by the New race day screen and the Backfill queue
// (D43) so a queued day is reviewed in the same view a hand-ingested day
// is. Nothing here is editable - corrections happen at the source.
export default function ParsePreview({ parsed, showWarnings = true }) {
  if (!parsed) return null;
  const warnings = parsed.warnings ?? [];
  return (
    <>
      {showWarnings && warnings.length > 0 && (
        <div className="notice notice--warn">
          <strong>{warnings.length} parse warning{warnings.length === 1 ? '' : 's'} — review before saving:</strong>
          <ul>
            {warnings.map((w, i) => <li key={i}>{w.message}</li>)}
          </ul>
        </div>
      )}
      {parsed.races.map((race) => <RacePreview key={race.number} race={race} />)}
    </>
  );
}

export function RacePreview({ race }) {
  // D216: the flags are a reading aid over exactly the rows below, computed
  // from the parser's own output. Invariant 9 is untouched - nothing here is
  // editable and nothing about what Save stores changes.
  const { flags } = flagRaceEntries(race.entries);
  return (
    <details className="race" open>
      <summary>
        <strong>Race {race.number}</strong>
        {' '}· {race.surface ?? '?'} · {race.distance ?? '?'} · {race.raceType ?? '?'}
        {' '}· post {race.postTime ?? '?'} · {race.entries.length} entries
      </summary>
      {race.conditions && <p className="conditions">{race.conditions}</p>}
      <table className="grid">
        <thead>
          <tr>
            <th>#</th><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th>
            <th>Wt</th><th>M/L</th><th>Rank</th>
          </tr>
        </thead>
        <tbody>
          {race.entries.map((e, ei) => (
            <tr
              key={ei}
              className={[e.scratched ? 'row--scratched' : '',
                (flags[ei]?.baffert || flags[ei]?.favorite) ? 'row--entry-flag' : ''].filter(Boolean).join(' ')}
            >
              <td>{e.programNumber ?? 'SCR'}</td>
              <td className="dim">{e.postPosition ?? ''}</td>
              <td>
                {e.horseName}
                {e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}
                {e.alsoEligible ? <span className="tag">AE</span> : null}
                {e.notToBeClaimed ? <span className="tag">NTC</span> : null}
                {e.scratched ? <span className="tag tag--red">SCR</span> : null}
                <EntryFlagTags flag={flags[ei]} />
              </td>
              <td>{e.jockey ?? ''}</td>
              <td>{e.trainer ?? ''}</td>
              <td>{e.weight ?? ''}</td>
              <td>{e.morningLine ?? ''}</td>
              <td className="dim">{e.programRank ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {race.wagerMenu && <p className="dim wager">{race.wagerMenu}</p>}
    </details>
  );
}
