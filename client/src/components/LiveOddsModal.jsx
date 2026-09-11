import React, { useEffect, useState } from 'react';
import { getLiveOddsCaptures, previewLiveOdds, saveLiveOdds } from '../api.js';

// Live odds capture (D228): upload a freshly-saved Equibase entries page for a
// day that ALREADY EXISTS, and write nothing but prices.
//
// Why this is its own dialog rather than a re-run of the entries ingest: the
// ingest path's only way to touch an existing day is `?replace=1`, which
// HARD-DELETES it and cascades away every card and ticket on it (the D204
// gotcha). Everything that keeps this additive lives in `shared/live-odds.js`;
// this component only shows what that reconciler decided, read-only, and asks
// for a confirmation (invariant 9).
//
// HOUSE RULE: `.modal-backdrop` carries NO click handler. An accidental click
// outside must never dismiss a dialog in this app - here it would throw away a
// preview of a board that has since moved, which cannot be re-taken.
export default function LiveOddsModal({ dayId, onClose, onSaved }) {
  const [html, setHtml] = useState('');
  const [capturedAt, setCapturedAt] = useState(null);
  const [preview, setPreview] = useState(null);
  const [captures, setCaptures] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  const loadCaptures = () => getLiveOddsCaptures(dayId)
    .then((r) => setCaptures(r.captures ?? []))
    .catch((e) => setError(String(e.message)));

  // Block body, never `useEffect(loadCaptures, deps)`: an expression-bodied
  // loader returns a promise and React calls it as the effect's own cleanup,
  // which unmounts the whole root (D90, CLAUDE.md Gotchas).
  useEffect(() => { loadCaptures(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPreview = async (markup, mtime) => {
    setBusy(true); setError(null); setSaved(null);
    try {
      const p = await previewLiveOdds(dayId, markup);
      setHtml(markup);
      setCapturedAt(mtime ?? null);
      setPreview(p);
    } catch (e) { setError(String(e.message)); setPreview(null); } finally { setBusy(false); }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // The file's own mtime is when the person saved the page, which is the one
    // staleness fact this source can supply - the page prints none. Absent
    // reads as "unknown", never as fresh (D117).
    await runPreview(await file.text(), new Date(file.lastModified).toISOString().replace(/\.\d+Z$/, 'Z'));
  };

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await saveLiveOdds(dayId, html, { oddsCapturedAt: capturedAt });
      setSaved(r);
      setPreview(null);
      await loadCaptures();
      onSaved?.();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const blocking = (preview?.warnings ?? []).filter((w) => w.blocking);
  const advisory = (preview?.warnings ?? []).filter((w) => !w.blocking);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="pagehead">
          <h2>Capture live odds</h2>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Close</button>
        </div>

        <div className="notice notice--warn">
          <p>
            <strong>Equibase&apos;s saved page does not carry live odds.</strong> Its
            {' '}<code>LiveOdds</code> column is empty in the HTML the server sends — the values are
            written in your browser by a script, refreshed every 60 seconds — so a page saved with
            {' '}<em>view-source</em> or Ctrl+S &ldquo;HTML Only&rdquo; has empty cells whatever the
            hour. The Apify pull has no live-odds field either.
          </p>
          <p>
            <strong>Type the board into each race instead</strong>, in the Live column beside the
            morning line on the day view. No browser save method reaches these values —
            {' '}<em>view-source</em>, &ldquo;HTML Only&rdquo; and &ldquo;Webpage, Complete&rdquo;
            were all tried and all come back empty — so this upload is kept only for a source that
            genuinely carries prices, and it will refuse an empty board rather than store one.
          </p>
        </div>
        <p className="dim">
          Whatever the source, this only ever writes <strong>prices</strong> — never the morning
          line, never the entry list, never a scratch, and never a card. Every capture is kept, so
          an earlier board is still readable after a later one lands.
        </p>

        <label className="btn">
          {busy ? 'Reading…' : 'Upload Equibase entries page'}
          <input type="file" accept=".html,.htm" hidden disabled={busy} onChange={onFile} />
        </label>

        {error && <div className="notice notice--error"><p>{error}</p></div>}

        {saved && (
          <div className="notice"><p>
            Saved: {saved.counts.priced} price(s) across {saved.counts.racesMatched} race(s)
            {' '}({saved.counts.changed} moved, {saved.counts.firstPrice} new, {saved.counts.unchanged} unchanged).
            This day now has {saved.capturesOnDay} capture(s).
          </p></div>
        )}

        {preview && (
          <>
            <h3>
              {preview.track} · {preview.date} — {preview.counts.priced} price(s),
              {' '}{preview.counts.changed} moved, {preview.counts.firstPrice} new
            </h3>

            {blocking.length > 0 && (
              <div className="notice notice--error">
                <ul>{blocking.map((w, i) => <li key={`b-${i}`}>{w.message}</li>)}</ul>
              </div>
            )}
            {advisory.length > 0 && (
              <div className="notice notice--warn">
                <ul>{advisory.map((w, i) => <li key={`a-${i}`}>{w.message}</li>)}</ul>
              </div>
            )}

            {preview.races.map((r) => (
              <section key={`race-${r.number}`}>
                <h4>Race {r.number}</h4>
                <div className="grid--wide-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th className="dim">Horse</th>
                        <th>M/L</th>
                        <th className="dim">Was</th>
                        <th>Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.entries.map((e) => (
                        <tr key={`${r.number}-${e.programNumber}`}>
                          <td>{e.programNumber}</td>
                          <td className="dim">{e.horseName ?? '—'}</td>
                          <td>{e.morningLine ?? '—'}</td>
                          <td className="dim">{e.previousOdds ?? '—'}</td>
                          <td>{e.newOdds ?? '—'}{e.state === 'changed' ? ' ▲' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

            <div className="modal__footer">
              <button className="btn btn--primary" disabled={busy || !preview.ok} onClick={confirm}>
                {busy ? 'Saving…' : 'Save these prices'}
              </button>
              <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Discard</button>
            </div>
          </>
        )}

        {captures.length > 0 && (
          <section>
            <h3>Boards captured on this day</h3>
            <ul>
              {captures.map((c) => (
                <li key={`cap-${c.id}`}>
                  {c.captured_at ?? `(capture time unknown — saved ${c.ingested_at})`} — {c.prices} price(s)
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
