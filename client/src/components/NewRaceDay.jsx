import React, { useState } from 'react';
import { parseEntriesText, parseProgramPdf, saveRaceDay } from '../api.js';

// The ingest screen: paste entries text or upload a program PDF, review the
// parse, then save. The preview is READ-ONLY - it shows exactly what Save
// will write, warnings first. To correct something, fix the pasted text and
// re-parse; the parser's output is never hand-edited in place.
export default function NewRaceDay({ onSaved, onCancel }) {
  const [track, setTrack] = useState('');
  const [date, setDate] = useState('');
  const [bankroll, setBankroll] = useState('200');
  const [perRaceMin, setPerRaceMin] = useState('5');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);

  const applyParse = (result) => {
    setParsed(result);
    setCorrelationId(result.correlationId);
    setError(null);
    setConflict(false);
    if (result.track && !track) setTrack(titleCase(result.track));
    if (result.date && !date) setDate(result.date);
  };

  const handleParseText = async () => {
    setBusy(true);
    try {
      applyParse(await parseEntriesText(text, correlationId));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      applyParse(await parseProgramPdf(file, { track, date, correlationId }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (replace = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveRaceDay({
        track: track.trim(),
        date,
        bankrollCents: Math.round(Number(bankroll || 0) * 100),
        perRaceMinCents: Math.round(Number(perRaceMin || 0) * 100),
        replace,
        races: parsed.races,
      }, correlationId);
      onSaved(result.id);
    } catch (e) {
      if (e.status === 409) setConflict(true);
      else setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const entryCount = parsed ? parsed.races.reduce((a, r) => a + r.entries.length, 0) : 0;
  // Save needs a track and a date; a program that names neither (or one the
  // parser could not read) leaves the button disabled - say so, never guess.
  const missing = [!track.trim() && 'Track', !date && 'Date'].filter(Boolean);

  return (
    <section>
      <div className="pagehead">
        <h2>New race day</h2>
        <button className="btn" onClick={onCancel}>Back</button>
      </div>

      <div className="formrow">
        <label>Track
          <input value={track} onChange={(e) => setTrack(e.target.value)} placeholder="Del Mar" />
        </label>
        <label>Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>Bankroll ($)
          <input type="number" min="0" value={bankroll} onChange={(e) => setBankroll(e.target.value)} />
        </label>
        <label>Per-race min ($)
          <input type="number" min="0" value={perRaceMin} onChange={(e) => setPerRaceMin(e.target.value)} />
        </label>
      </div>

      <div className="ingest-inputs">
        <label className="pastebox">
          Paste entries text
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the track's daily entries page here..."
          />
        </label>
        <div className="ingest-actions">
          <button className="btn btn--primary" disabled={busy || !text.trim()} onClick={handleParseText}>
            {busy ? 'Parsing…' : 'Parse pasted text'}
          </button>
          <label className="btn">
            {busy ? 'Parsing…' : 'Upload program PDF'}
            <input
              type="file"
              accept="application/pdf"
              style={{ display: 'none' }}
              disabled={busy}
              onChange={(e) => handlePdf(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {conflict && (
        <div className="notice notice--warn">
          <p>A race day for {track} {date} already exists.</p>
          <button className="btn btn--danger" disabled={busy} onClick={() => handleSave(true)}>
            Replace it with this parse
          </button>
        </div>
      )}

      {parsed && (
        <>
          <div className="pagehead">
            <h3>
              Preview — {parsed.races.length} races, {entryCount} entries
            </h3>
            <button
              className="btn btn--primary"
              disabled={busy || !track.trim() || !date || parsed.races.length === 0}
              onClick={() => handleSave(false)}
            >
              Save race day
            </button>
          </div>
          {missing.length > 0 && (
            <p className="notice notice--warn">
              Save is disabled until {missing.join(' and ')} {missing.length === 1 ? 'is' : 'are'} filled in above -
              the parse could not read {missing.length === 1 ? 'it' : 'them'} from the program.
            </p>
          )}
          <p className="dim">
            Read-only preview of exactly what Save will store. To correct
            something, fix the pasted text and parse again.
          </p>

          {parsed.warnings.length > 0 && (
            <div className="notice notice--warn">
              <strong>{parsed.warnings.length} parse warning{parsed.warnings.length === 1 ? '' : 's'} — review before saving:</strong>
              <ul>
                {parsed.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
              </ul>
            </div>
          )}

          {parsed.races.map((race) => <RacePreview key={race.number} race={race} />)}
        </>
      )}
    </section>
  );
}

function RacePreview({ race }) {
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
            <tr key={ei} className={e.scratched ? 'row--scratched' : ''}>
              <td>{e.programNumber ?? 'SCR'}</td>
              <td className="dim">{e.postPosition ?? ''}</td>
              <td>
                {e.horseName}
                {e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}
                {e.alsoEligible ? <span className="tag">AE</span> : null}
                {e.notToBeClaimed ? <span className="tag">NTC</span> : null}
                {e.scratched ? <span className="tag tag--red">SCR</span> : null}
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

function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}
