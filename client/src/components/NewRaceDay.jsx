import React, { useState } from 'react';
import { fetchMlSheet, mergeParses, parseEntriesText, parseMlPdf, parseProgramPdf, saveRaceDay } from '../api.js';
import ParsePreview from './ParsePreview.jsx';

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
  // D40: the ML sheet is the entries source of record; the program is
  // analysis-only. Both parses are kept so either upload can come first;
  // the preview always shows the MERGED result when both are present.
  const [mlParse, setMlParse] = useState(null);
  const [programParse, setProgramParse] = useState(null);

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

  // Combine whatever is on hand: ML + program -> merged (server-side,
  // logged); ML alone -> the sheet; program alone -> the program.
  const combine = async (ml, program) => {
    if (ml && program) return { ...(await mergeParses(ml, program, correlationId)), entriesSource: 'both' };
    if (ml) return { ...ml, entriesSource: 'ml_sheet' };
    return { ...program, entriesSource: 'program' };
  };

  const handlePdf = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const program = await parseProgramPdf(file, { track, date, correlationId });
      setProgramParse(program);
      applyParse(await combine(mlParse, program));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleMlPdf = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const ml = await parseMlPdf(file, { track, date, correlationId });
      setMlParse(ml);
      applyParse(await combine(ml, programParse));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleFetchMl = async () => {
    setBusy(true);
    setError(null);
    try {
      const ml = await fetchMlSheet(track.trim(), date, correlationId);
      setMlParse(ml);
      applyParse(await combine(ml, programParse));
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
          <label className="btn btn--primary">
            {busy ? 'Parsing…' : 'Upload ML sheet PDF'}
            <input
              type="file"
              accept="application/pdf"
              style={{ display: 'none' }}
              disabled={busy}
              onChange={(e) => handleMlPdf(e.target.files?.[0])}
            />
          </label>
          <button className="btn" disabled={busy || !track.trim() || !date} onClick={handleFetchMl}
            title="Fetch the track's morning-line sheet for this track and date">
            {busy ? 'Fetching…' : 'Fetch ML sheet'}
          </button>
          <label className="btn">
            {busy ? 'Parsing…' : 'Upload program PDF (analysis)'}
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
