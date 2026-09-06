import React, { useEffect, useState } from 'react';
import { getResults, parseResultsHtml, parseResultsPdf, parseResultsText, saveResults } from '../api.js';

const money = (cents) => (cents == null ? '' : `$${(cents / 100).toFixed(2)}`);

// The results section of a stored race day: paste the Equibase chart text
// or upload the chart PDF, review the READ-ONLY preview (invariant 9 -
// corrections happen in the source, then re-parse), save. Saved results
// replace the day's prior results; the chart provenance log appends.
export default function ResultsPanel({ dayId }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reload = () => getResults(dayId).then(setData).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  const applyParse = (parsed) => {
    setPreview(parsed);
    setCorrelationId(parsed.correlationId);
    setError(null);
  };

  const handleParseText = async () => {
    setBusy(true);
    try {
      applyParse({ ...(await parseResultsText(text, correlationId)), sourceKind: 'paste' });
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };
  const handlePdf = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      applyParse({ ...(await parseResultsPdf(file, correlationId)), sourceKind: 'pdf' });
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };
  // dmtc.com results page (D42): the second results source of record.
  const handleHtml = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      applyParse({ ...(await parseResultsHtml(await file.text(), correlationId)), sourceKind: 'dmtc_html' });
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };
  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveResults(dayId, {
        track: preview.track,
        date: preview.date,
        sourceKind: preview.sourceKind,
        races: preview.races,
      }, correlationId);
      setPreview(null);
      setText('');
      await reload();
    } catch (e) { setError(String(e.message)); } finally { setBusy(false); }
  };

  const hasResults = (data?.results?.length ?? 0) > 0;
  const byRace = new Map();
  for (const r of data?.results ?? []) {
    if (!byRace.has(r.race_number)) byRace.set(r.race_number, { results: [], exotics: [], scratches: [] });
    byRace.get(r.race_number).results.push(r);
  }
  for (const x of data?.exotics ?? []) byRace.get(x.race_number)?.exotics.push(x);
  for (const s of data?.scratches ?? []) byRace.get(s.race_number)?.scratches.push(s);

  return (
    <section className="consensus">
      {/* One collapsible card holds both the ingest controls and the saved
          results view (moved below the controls) so the whole thing can be
          tucked away once a day is done - open by default only while there's
          nothing saved yet or a just-parsed preview needs review; a save
          collapses it again. */}
      <details className="race" open={!hasResults || !!preview}>
        <summary>
          Results
          {hasResults && (
            <span className="dim">
              {' '}· {data.results.length} finishers · {data.exotics.length} payoffs ·
              chart ingested {data.charts[0]?.ingested_at} ({data.charts[0]?.source_kind})
            </span>
          )}
        </summary>
        {error && <p className="notice notice--error">{error}</p>}

        <p className="dim">
          {hasResults ? 'Replace results' : 'Ingest results'} — paste the Equibase chart, upload the chart PDF, or load the dmtc results page.
        </p>
        <label className="pastebox">
          Paste the Equibase chart text
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full chart text here..." />
        </label>
        <div className="formrow formrow--tight">
          <button className="btn btn--primary" disabled={busy || !text.trim()} onClick={handleParseText}>
            {busy ? 'Parsing…' : 'Parse pasted chart'}
          </button>
          <label className="btn">
            {busy ? 'Parsing…' : 'Upload chart PDF'}
            <input type="file" accept="application/pdf" style={{ display: 'none' }}
              disabled={busy} onChange={(e) => handlePdf(e.target.files?.[0])} />
          </label>
          <label className="btn">
            {busy ? 'Parsing…' : 'Upload dmtc results page (HTML)'}
            <input type="file" accept=".html,.htm,text/html" style={{ display: 'none' }}
              disabled={busy} onChange={(e) => handleHtml(e.target.files?.[0])} />
          </label>
        </div>

        {preview && (
          <>
            <div className="pagehead">
              <h3>
                Preview — {preview.track} {preview.date} · {preview.races.length} races,
                {' '}{preview.races.reduce((a, r) => a + r.results.length, 0)} finishers,
                {' '}{preview.races.reduce((a, r) => a + r.exotics.length, 0)} payoffs
              </h3>
              <button className="btn btn--primary" disabled={busy || preview.races.length === 0} onClick={handleSave}>
                Save results
              </button>
            </div>
            <p className="dim">
              Read-only preview of exactly what Save will store{hasResults ? ' (replacing the current results)' : ''}.
              To correct something, fix the chart text and parse again.
            </p>
            {preview.warnings.length > 0 && (
              <div className="notice notice--warn">
                <strong>{preview.warnings.length} parse warning{preview.warnings.length === 1 ? '' : 's'}:</strong>
                <ul>{preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
              </div>
            )}
            {preview.races.map((race) => (
              <details className="race" key={race.number} open>
                <summary>
                  <strong>Race {race.number}</strong>
                  {' '}· {race.surface ?? '?'} · {race.distance ?? '?'}
                  {' '}· {race.results.length} finishers · {race.exotics.length} payoffs
                  {race.scratches.length > 0 ? ` · ${race.scratches.length} scratched` : ''}
                </summary>
                <table className="grid">
                  <thead>
                    <tr><th>Fin</th><th>#</th><th>Horse</th><th>Win</th><th>Place</th><th>Show</th></tr>
                  </thead>
                  <tbody>
                    {race.results.map((r, i) => (
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
                {race.exotics.length > 0 && (
                  <p className="dim">
                    {race.exotics.map((x) => `${x.betType.replace(/_/g, ' ')} ${x.combination} → ${money(x.payoutCents)}`).join(' · ')}
                  </p>
                )}
                {race.scratches.length > 0 && (
                  <p className="dim">
                    Scratched: {race.scratches.map((s) => `${s.horseName}${s.reason ? ` (${s.reason})` : ''}`).join(', ')}
                  </p>
                )}
              </details>
            ))}
          </>
        )}

        {hasResults && !preview && (
          <table className="grid">
            <thead>
              <tr><th>Race</th><th>Finish (win — place — show)</th><th>Exotics</th><th>Scratches</th></tr>
            </thead>
            <tbody>
              {[...byRace.entries()].sort((a, b) => a[0] - b[0]).map(([race, d]) => (
                <tr key={race}>
                  <td className="dim">{race}</td>
                  <td>
                    {d.results.slice(0, 3).map((r, i) => (
                      <div key={i}>
                        {i + 1}. #{r.program_number} {r.horse_name}
                        <span className="dim">
                          {' '}{[r.win_cents, r.place_cents, r.show_cents].filter((c) => c != null).map(money).join(' — ')}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {d.exotics.map((x, i) => (
                      <div key={i} className="dim">
                        {x.bet_type.replace(/_/g, ' ')} {x.combination} {money(x.payout_cents)}
                      </div>
                    ))}
                  </td>
                  <td className="dim">
                    {d.scratches.map((s) => `${s.program_number != null ? `#${s.program_number} ` : ''}${s.horse_name}`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </section>
  );
}
