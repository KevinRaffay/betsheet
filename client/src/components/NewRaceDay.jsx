import React, { useState } from 'react';
import { parseEntriesText, saveRaceDay } from '../api.js';
import ParsePreview from './ParsePreview.jsx';

// The ingest screen: paste entries text, review the parse, then save. The
// preview is READ-ONLY - it shows exactly what Save will write, warnings
// first. To correct something, fix the pasted text and re-parse; the parser's
// output is never hand-edited in place.
//
// D113 removed the ML-sheet upload, the ML fetch and the program-PDF upload
// with the Del Mar parsers behind them. **The pasted-entries path is kept
// deliberately, and is currently the only way to create a race day** - the
// Equibase entries HTML parser (D104) is built and verified but not yet wired
// to a route, so removing this too would leave the app unable to create a day
// at all. It goes when that wiring lands, not before.
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
        // Pasted text is the only surviving source, and 'program' is the
        // schema's default value for it (the CHECK admits program /
        // ml_sheet / both; the Equibase wiring adds its own).
        entriesSource: parsed.entriesSource ?? 'program',
        races: parsed.races,
        analysis: parsed.analysis,
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
          <input value={track} onChange={(e) => setTrack(e.target.value)} placeholder="Enter track name..." />
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
              {' '}<span className="dim">
                · {parsed.entriesSource === 'both' ? 'ML sheet (record) + program (analysis)'
                  : parsed.entriesSource === 'ml_sheet' ? 'ML sheet only - no program analysis (ODDS_ONLY)'
                    : 'program only'}
                {parsed.fetchedFrom ? ` · fetched from ${parsed.fetchedFrom}` : ''}
              </span>
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

          <ParsePreview parsed={parsed} />
        </>
      )}
    </section>
  );
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}
