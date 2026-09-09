import React, { useState } from 'react';
import { parseEquibaseEntries, pullApifyEntries, saveRaceDay } from '../api.js';
import { listTracks } from '@shared/track-codes.js';
import ParsePreview from './ParsePreview.jsx';
import BulkEntriesUpload from './BulkEntriesUpload.jsx';

// Suggestions only, never a restriction (the same "suggest, don't restrict"
// shape AnalystNotesEditor.jsx's own source datalist already uses) - the
// registry is every track this codebase has personally seen, not an
// exhaustive Equibase list, so an unlisted track must still type freely.
const TRACK_SUGGESTIONS = listTracks();

// The ingest screen: get a saved Equibase entries page in - by file upload or
// by pasting its HTML - review the parse, then save. The preview is
// READ-ONLY - it shows exactly what Save will write, warnings first. To
// correct something, fix the source (re-save the page, or paste it again) and
// re-parse; the parser's output is never hand-edited in place.
//
// D116 added the Equibase entries page upload - the ingest path for any track
// with no automated feed, and how a Kentucky Downs card gets made at all now
// that Del Mar program ingestion is gone (D113). It is not a fetcher: the
// page is one a person saved and chose to bring in, whether by uploading the
// file or by pasting its markup, and both read the file/paste in the browser
// and post it as text. Invariant 6 is untouched.
//
// The old plain-text entries-parser.js format (a different, non-Equibase
// paste grammar) is retired: `parseEquibaseEntries` is the ONE parser for
// both capture routes, since the server's own `/api/parse/equibase-entries`
// route already accepts a saved file's markup OR pasted markup identically
// (invariant 9 - same preview either way).
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
  // Two shapes of the same ingest: one track, or a whole day's board. The
  // single path is the default because it is the one that needs a track, a
  // date and a bankroll typed in; bulk reads all three per file.
  const [mode, setMode] = useState('single');

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
    setError(null);
    try {
      // A paste carries no file to read a last-modified time off, so the
      // capture time is unknown rather than guessed - the same honesty rule
      // staleness reporting already applies to a day with none on file.
      applyParse(await parseEquibaseEntries(text, { correlationId }));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  // Live, on-demand Apify pull (docs/requirements/apify-equibase-ingest.md).
  // Unlike the paste/upload handlers above, track and date are REQUIRED
  // up front here - there is no document to auto-detect them from, and
  // this call costs real money every time, so the button stays disabled
  // until both are typed in (checked below, not just relied on server-side).
  const handleApifyPull = async () => {
    setBusy(true);
    setError(null);
    try {
      applyParse(await pullApifyEntries(track.trim(), date, correlationId));
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
        // Both capture routes (file upload and pasted HTML) run through the
        // same parser now, so the parse always says 'equibase_html' - the
        // fallback is only for a stray call with nothing parsed yet.
        entriesSource: parsed.entriesSource ?? 'equibase_html',
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
          <input
            value={track} onChange={(e) => setTrack(e.target.value)}
            placeholder="Enter track name..." list="track-suggestions"
          />
          <datalist id="track-suggestions">
            {TRACK_SUGGESTIONS.map((t) => <option key={t.code} value={t.display} />)}
          </datalist>
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

      <div className="formrow formrow--tight">
        <button
          className={`btn ${mode === 'single' ? 'btn--primary' : ''}`}
          onClick={() => setMode('single')}
        >
          One track
        </button>
        <button
          className={`btn ${mode === 'bulk' ? 'btn--primary' : ''}`}
          onClick={() => setMode('bulk')}
        >
          A day&rsquo;s board (zip)
        </button>
        <button
          className={`btn ${mode === 'apify' ? 'btn--primary' : ''}`}
          onClick={() => setMode('apify')}
        >
          Live pull (Apify)
        </button>
        <span className="dim">
          {mode === 'single' && 'One saved Equibase entries page becomes one race day.'}
          {mode === 'bulk' && 'One zip of saved entries pages becomes every race day it holds.'}
          {mode === 'apify' && 'Calls Apify live for the Track and Date above - costs real money every time.'}
        </span>
      </div>

      {mode === 'bulk' && (
        <BulkEntriesUpload onSaved={onSaved} bankroll={bankroll} perRaceMin={perRaceMin} />
      )}

      {mode === 'apify' && (
        <div className="ingest-inputs">
          <p className="notice notice--warn">
            Pulling live from Apify (parseforge/equibase-scraper) costs real money every time this
            runs, whether or not you go on to save. Fill in Track and Date above, then pull.
          </p>
          <div className="ingest-actions">
            <button
              className="btn btn--primary"
              disabled={busy || !track.trim() || !date}
              onClick={handleApifyPull}
            >
              {busy ? 'Calling Apify…' : 'Pull entries from Apify'}
            </button>
          </div>
        </div>
      )}

      {mode === 'single' && (
      <div className="ingest-inputs">
        <label className="pastebox">
          Paste Equibase Entries HTML
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Open the track's Equibase entries page, view source (or save it as HTML), and paste the markup here..."
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
            {busy ? 'Parsing…' : 'Parse pasted HTML'}
          </button>
        </div>
      </div>
      )}

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
                    : parsed.entriesSource === 'equibase_apify' ? 'Apify (live pull)'
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
            something, fix the source (re-save the page, or paste it again)
            and parse again.
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
