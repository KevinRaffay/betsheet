import React, { useState } from 'react';
import { previewEntriesZip, saveEntriesZip } from '../api.js';

// Bulk mode: one zip of saved Equibase entries pages -> every race day it
// holds. The single-track path (D116) is unchanged and is still how one day
// gets made; this is for the shape that path is bad at, which is a full race
// day - 8 to 23 tracks, and that many separate uploads.
//
// The zip is posted TWICE, once to preview and once to save, and that is
// deliberate rather than lazy: the save re-reads and re-parses the archive
// server-side instead of trusting a client-shaped payload of parsed races, the
// same rule the human, LLM and OTR writers follow. Two megabytes over loopback
// is cheaper than a server-side staging area and the "did the archive change
// between preview and confirm?" problem that comes with one.
//
// The File object is held in state, never its contents: the browser reads it
// once, on submit, so a 23-track board does not sit decoded in memory.
export default function BulkEntriesUpload({ onSaved, bankroll, perRaceMin }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState(null);

  const pick = async (f) => {
    if (!f) return;
    setFile(f); setPreview(null); setResult(null); setError(null); setBusy(true);
    try {
      setPreview(await previewEntriesZip(f));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const out = await saveEntriesZip(file, {
        replace,
        bankrollCents: Math.round(Number(bankroll || 0) * 100),
        perRaceMinCents: Math.round(Number(perRaceMin || 0) * 100),
      });
      setResult(out);
      setPreview(null);
      onSaved?.();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const willSave = preview
    ? preview.files.filter((f) => f.disposition === 'create' || (f.disposition === 'replace' && replace)).length
    : 0;
  const existing = preview ? preview.files.filter((f) => f.disposition === 'replace').length : 0;

  return (
    <div className="ingest-inputs">
      <div className="ingest-actions">
        <label className="btn btn--primary">
          {busy && !preview ? 'Reading…' : 'Upload a day’s entries (zip)'}
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </label>
        {file && <span className="dim">{file.name} · {(file.size / 1e6).toFixed(1)} MB</span>}
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {result && (
        <div className="notice notice--ok">
          <p>
            Saved {result.saved.length} race day{result.saved.length === 1 ? '' : 's'}
            {result.skipped.length ? `, skipped ${result.skipped.length}` : ''}.
          </p>
          {result.skipped.length > 0 && (
            <ul className="dim">
              {result.skipped.map((s) => (
                <li key={s.file}>{s.file} — {DISPOSITION[s.disposition] ?? s.disposition}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <>
          {preview.spansMultipleDates && (
            <p className="notice notice--warn">
              This archive spans {preview.dates.length} dates ({preview.dates.join(', ')}). That works,
              but a day&rsquo;s board is the intended shape — check it is the zip you meant.
            </p>
          )}
          {existing > 0 && (
            <label className="notice notice--warn" style={{ display: 'block' }}>
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              {' '}Replace the {existing} day{existing === 1 ? '' : 's'} already stored.
              {' '}<span className="dim">
                Replacing a day deletes it and everything on it, cards included, and writes the entries fresh.
              </span>
            </label>
          )}

          <div className="pagehead">
            <h3>
              Preview — {preview.files.length} file{preview.files.length === 1 ? '' : 's'}
              {' '}<span className="dim">· {willSave} will be saved</span>
            </h3>
            <button className="btn btn--primary" disabled={busy || willSave === 0} onClick={save}>
              {busy ? 'Saving…' : `Save ${willSave} race day${willSave === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="dim">
            Read-only preview of exactly what Save will store. Nothing has been written yet.
          </p>

          <table className="grid">
            <thead>
              <tr>
                <th>Track</th><th>Date</th><th>Races</th><th>Entries</th><th>Entries saved</th><th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {preview.files.map((f) => {
                const skipped = String(f.disposition).startsWith('skip');
                const held = f.disposition === 'replace' && !replace;
                return (
                  <tr key={f.file} className={skipped ? 'row--scratched' : ''}>
                    <td>{f.track ?? <span className="dim">{f.file}</span>}</td>
                    <td>{f.date ?? '—'}</td>
                    <td>{f.races || '—'}</td>
                    <td>{f.entries || '—'}</td>
                    <td className="dim">{f.oddsCapturedAt ? f.oddsCapturedAt.replace('T', ' ').replace('Z', '') : '—'}</td>
                    <td>
                      {skipped ? <span className="tag tag--red">{DISPOSITION[f.disposition] ?? f.disposition}</span>
                        : held ? <span className="dim">already stored — tick Replace to overwrite</span>
                          : f.disposition === 'replace' ? <span className="tag tag--gold">replaces #{f.existingId}</span>
                            : <span className="tag">create</span>}
                      {f.warnings.length > 0 && (
                        <div className="dim">
                          {f.warnings.length} warning{f.warnings.length === 1 ? '' : 's'}: {f.warnings[0].message}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// The server's disposition codes, said in words. Kept here rather than sent
// down as prose so the API stays a data contract.
const DISPOSITION = {
  skip_not_entries_page: 'not an entries page (this is the race-card index)',
  skip_blocking_warnings: 'blocking parse warnings',
  skip_no_track_or_date: 'no track or date on the page',
  skip_exists: 'already stored',
  skip_save_failed: 'save failed',
};
