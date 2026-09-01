import React, { useState } from 'react';
import { morningLineToDecimal } from '@shared/entries-parser.js';
import { parseEntriesText, parseProgramPdf, saveRaceDay } from '../api.js';

const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(0));

// The ingest screen: paste entries text or upload a program PDF, review the
// parse (warnings first), correct anything inline, then save. Nothing is
// written until Save - the preview is the contract (invariant 9).
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

  const updateRace = (ri, field, value) => {
    setParsed((p) => {
      const races = p.races.map((r, i) => (i === ri ? { ...r, [field]: value } : r));
      return { ...p, races };
    });
  };

  const updateEntry = (ri, ei, field, value) => {
    setParsed((p) => {
      const races = p.races.map((r, i) => {
        if (i !== ri) return r;
        const entries = r.entries.map((e, j) => {
          if (j !== ei) return e;
          const next = { ...e, [field]: value };
          if (field === 'morningLine') next.morningLineDecimal = morningLineToDecimal(value);
          return next;
        });
        return { ...r, entries };
      });
      return { ...p, races };
    });
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

          {parsed.warnings.length > 0 && (
            <div className="notice notice--warn">
              <strong>{parsed.warnings.length} parse warning{parsed.warnings.length === 1 ? '' : 's'} — review before saving:</strong>
              <ul>
                {parsed.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
              </ul>
            </div>
          )}

          {parsed.races.map((race, ri) => (
            <RacePreview key={race.number} race={race} ri={ri}
              updateRace={updateRace} updateEntry={updateEntry} />
          ))}
        </>
      )}
    </section>
  );
}

function RacePreview({ race, ri, updateRace, updateEntry }) {
  return (
    <details className="race" open>
      <summary>
        <strong>Race {race.number}</strong>
        {' '}· {race.surface ?? '?'} · {race.distance ?? '?'} · {race.raceType ?? '?'}
        {' '}· post {race.postTime ?? '?'} · {race.entries.length} entries
      </summary>
      <div className="formrow formrow--tight">
        <label>Surface
          <input value={race.surface ?? ''} onChange={(e) => updateRace(ri, 'surface', e.target.value)} />
        </label>
        <label>Distance
          <input value={race.distance ?? ''} onChange={(e) => updateRace(ri, 'distance', e.target.value)} />
        </label>
        <label>Type
          <input value={race.raceType ?? ''} onChange={(e) => updateRace(ri, 'raceType', e.target.value)} />
        </label>
        <label>Post time
          <input value={race.postTime ?? ''} onChange={(e) => updateRace(ri, 'postTime', e.target.value)} />
        </label>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>#</th><th>PP</th><th>Horse</th><th>Jockey</th><th>Trainer</th>
            <th>Wt</th><th>M/L</th><th>Rank</th><th>Scr</th>
          </tr>
        </thead>
        <tbody>
          {race.entries.map((e, ei) => (
            <tr key={ei} className={e.scratched ? 'row--scratched' : ''}>
              <td><input className="in in--xs" value={e.programNumber ?? ''}
                onChange={(ev) => updateEntry(ri, ei, 'programNumber', ev.target.value)} /></td>
              <td className="dim">{e.postPosition ?? ''}</td>
              <td>
                <input className="in" value={e.horseName ?? ''}
                  onChange={(ev) => updateEntry(ri, ei, 'horseName', ev.target.value)} />
                {e.bestBet ? <span className="tag tag--gold">BEST BET</span> : null}
                {e.alsoEligible ? <span className="tag">AE</span> : null}
                {e.notToBeClaimed ? <span className="tag">NTC</span> : null}
              </td>
              <td><input className="in in--sm" value={e.jockey ?? ''}
                onChange={(ev) => updateEntry(ri, ei, 'jockey', ev.target.value)} /></td>
              <td><input className="in in--sm" value={e.trainer ?? ''}
                onChange={(ev) => updateEntry(ri, ei, 'trainer', ev.target.value)} /></td>
              <td><input className="in in--xs" value={e.weight ?? ''}
                onChange={(ev) => updateEntry(ri, ei, 'weight', Number(ev.target.value) || null)} /></td>
              <td><input className="in in--xs" value={e.morningLine ?? ''}
                onChange={(ev) => updateEntry(ri, ei, 'morningLine', ev.target.value)} /></td>
              <td className="dim">{e.programRank ?? ''}</td>
              <td><input type="checkbox" checked={Boolean(e.scratched)}
                onChange={(ev) => updateEntry(ri, ei, 'scratched', ev.target.checked)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}
