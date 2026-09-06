import React, { useState } from 'react';
import { parseEntriesText, parseEquibaseEntries, saveRaceDay } from '../api.js';
import ParsePreview from './ParsePreview.jsx';

// The ingest screen: paste entries text, review the parse, then save. The
// preview is READ-ONLY - it shows exactly what Save will write, warnings
// first. To correct something, fix the pasted text and re-parse; the parser's
// output is never hand-edited in place.
//
// D116 added the Equibase entries page upload - the ingest path for any track
// with no automated feed, and how a Kentucky Downs card gets made at all now
// that Del Mar program ingestion is gone (D113). It is not a fetcher: the file
// is one a person saved and chose to upload, and its markup is read in the
// browser and posted as text. Invariant 6 is untouched.
//
// The pasted-entries path stays for now as the fallback for a page this
// parser cannot read, and because a track whose page is not Equibase-shaped
// still has to be enterable somehow.
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
  // The capture time travels with the parse rather than the form: it is a fact
  // about the FILE, so a later re-parse of different text must not inherit it.
  const [oddsCapturedAt, setOddsCapturedAt] = useState(null);

  const applyParse = (result) => {
    setParsed(result);
    setCorrelationId(result.correlationId);
    setOddsCapturedAt(result.oddsCapturedAt ?? null);
    setError(null);
    setConflict(false);
    // The Equibase page prints its own track name, so trust it over a typed
    // one: `canonicalizeTrack` at save turns any spelling into the registry's.
    if (result.track && !track) setTrack(titleCase(result.track));
    if (result.date && !date) setDate(result.date);
  };

  const handleEquibaseHtml = async (file) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      // The file's last-modified time is when the page was saved, which is the
      // only capture time available - the page itself prints none. Read in the
      // browser so the server never sees a path and never opens a file.
      applyParse(await parseEquibaseEntries(await file.text(), {
        oddsCapturedAt: new Date(file.lastModified).toISOString().replace(/\.\d+Z$/, 'Z'),
        correlationId,
      }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
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
        // The parse says where it came from; 'program' is the schema default
        // for the pasted-text path, which carries no source of its own.
        entriesSource: parsed.entriesSource ?? 'program',
        oddsCapturedAt,
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
          Paste entries text (fallback - the Equibase upload is the main path)
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the track's daily entries page here..."
          />
        </label>
        <div className="ingest-actions">
          <label className="btn btn--primary">
            {busy ? 'Parsing…' : 'Upload Equibase entries page'}
            <input
              type="file"
              accept=".html,.htm,text/html"
              style={{ display: 'none' }}
              disabled={busy}
              onChange={(e) => handleEquibaseHtml(e.target.files?.[0])}
            />
          </label>
          <button className="btn" disabled={busy || !text.trim()} onClick={handleParseText}>
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
