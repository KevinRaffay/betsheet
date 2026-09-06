import React, { useEffect, useState } from 'react';
import {
  fetchConsensus, getConsensus, manualPicksPreview, manualPicksSave,
} from '../api.js';

const TYPE_LABEL = { top: 'top', second: '2nd', third: '3rd', watch_out: 'watch', contrarian: 'contra' };
const OUTCOME_OK = new Set(['ok', 'manual_paste', 'manual_upload']);
// D53: a discovery miss is not a failure - the source has not posted yet.
const OUTCOME_NEUTRAL = new Set(['not_published']);
const urlPath = (u) => { try { return new URL(u).pathname; } catch { return u; } };

// D53: the discovery details on an audit row, so a miss is auditable from
// the table alone - which sitemap answered how, the slug looked for, how
// many entries were scanned and the nearest one (the near-miss).
function Discovery({ a }) {
  if (!a.candidate_slug && !a.sitemap_url) return null;
  return (
    <span className="dim">
      {a.sitemap_url ? <>sitemap {a.sitemap_status ?? '?'} <a href={a.sitemap_url} target="_blank" rel="noreferrer">{urlPath(a.sitemap_url)}</a> · </> : null}
      {a.entries_scanned != null ? `${a.entries_scanned} entries · ` : ''}
      {a.candidate_slug ? <>looked for <code>{a.candidate_slug}</code></> : null}
      {a.nearest_slug ? <> · nearest <code>{a.nearest_slug}</code></> : null}
    </span>
  );
}

// The consensus section of a stored race day: run/refresh the automated
// fetchers, see every attempt (a failing source is always visible -
// invariant 11), and the manual paste fallback with its read-only preview
// (invariant 9).
export default function ConsensusPanel({ dayId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runSummary, setRunSummary] = useState(null);
  const [error, setError] = useState(null);

  const [sourceName, setSourceName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState(null);


  const reload = () => getConsensus(dayId).then(setData).catch((e) => setError(String(e.message)));
  useEffect(() => { reload(); }, [dayId]);

  const handleFetch = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await fetchConsensus(dayId);
      setRunSummary(out);
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await manualPicksPreview(dayId, sourceName, pasteText));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await manualPicksSave(dayId, preview.sourceName || sourceName, preview.races);
      setPreview(null);
      setPasteText('');
      await reload();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };


  const byRace = new Map();
  for (const p of data?.picks ?? []) {
    if (!byRace.has(p.race_number)) byRace.set(p.race_number, new Map());
    const bySource = byRace.get(p.race_number);
    if (!bySource.has(p.source_name)) bySource.set(p.source_name, []);
    bySource.get(p.source_name).push(p);
  }

  return (
    <section className="consensus">
      <div className="pagehead">
        <h3>Consensus</h3>
        <button className="btn btn--primary" disabled={busy} onClick={handleFetch}>
          {busy ? 'Working…' : 'Fetch / refresh sources'}
        </button>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      {runSummary && (
        <div className="notice">
          {runSummary.registered === 0
            ? 'No automated fetchers are registered yet (source fetchers arrive in their own PRs). Use manual paste below.'
            : runSummary.results.length === 0
              ? 'No registered source covers this track/date. Use manual paste below.'
              : runSummary.results.map((r, i) => (
                <div key={i}>
                  {r.source}: <strong>{r.outcome}</strong>
                  {r.picksExtracted != null ? ` — ${r.picksExtracted} picks` : ''}
                  {r.fallbackReason ? ` — ${r.fallbackReason}` : ''}
                </div>
              ))}
        </div>
      )}

      {data?.races?.some((r) => r.classification) && (
        <table className="grid">
          <thead>
            <tr><th>Race</th><th>Class</th><th>Ext. sources</th><th>Contrarian flags</th></tr>
          </thead>
          <tbody>
            {data.races.map((r) => (
              <tr key={r.number}>
                <td className="dim">{r.number}</td>
                <td>
                  {r.classification
                    ? <span className={`chip chip--${r.classification.toLowerCase()}`}>{r.classification}</span>
                    : <span className="dim">—</span>}
                </td>
                <td className="dim">{r.externalSourceCount ?? ''}</td>
                <td>
                  {r.contrarianFlags.map((f, i) => (
                    <div key={i} className="flagline">
                      <span className="tag tag--gold">{f.type === 'algo_fades_favorite' ? 'FADE FAV' : 'LONGSHOT×2'}</span>
                      {' '}#{f.programNumber} {f.horseName} <span className="dim">— {f.detail}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {byRace.size > 0 && (
        <table className="grid">
          <thead>
            <tr><th>Race</th><th>Source</th><th>Picks</th></tr>
          </thead>
          <tbody>
            {[...byRace.entries()].sort((a, b) => a[0] - b[0]).flatMap(([race, bySource]) =>
              [...bySource.entries()].map(([source, picks], i) => (
                <tr key={`${race}-${source}`}>
                  <td className="dim">{i === 0 ? race : ''}</td>
                  <td>{source}</td>
                  <td>
                    {picks.map((p, j) => (
                      <span key={j} className="pick">
                        <span className="dim">{TYPE_LABEL[p.pick_type] ?? p.pick_type}</span>
                        {' '}#{p.program_number ?? '?'} {p.horse_name ?? ''}
                        {p.entry_id == null ? <span className="tag tag--red">unmatched</span> : null}
                      </span>
                    ))}
                  </td>
                </tr>
              )))}
          </tbody>
        </table>
      )}

      <details className="race">
        <summary>Manual picks paste (fallback for blocked or paywalled sources)</summary>
        <div className="formrow">
          <label>Source name
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)}
              placeholder="e.g. Today's Racing Digest" />
          </label>
        </div>
        <label className="pastebox">
          One race per line — "Race 1: 4, 2, 7 | watch: 9 | contrarian: Horse Name"
          <textarea rows={5} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
        </label>
        <div className="formrow">
          <button className="btn" disabled={busy || !pasteText.trim() || !sourceName.trim()} onClick={handlePreview}>
            Preview
          </button>
        </div>

        {preview && (
          <>
            <p className="dim">
              Read-only preview. To correct something, fix the pasted text and preview again.
            </p>
            {preview.warnings.length > 0 && (
              <div className="notice notice--warn">
                <ul>{preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
              </div>
            )}
            <table className="grid">
              <thead><tr><th>Race</th><th>Pick</th><th>Horse</th></tr></thead>
              <tbody>
                {preview.races.flatMap((r) => r.picks.map((p, i) => (
                  <tr key={`${r.race}-${i}`}>
                    <td className="dim">{i === 0 ? r.race : ''}</td>
                    <td>{TYPE_LABEL[p.pickType] ?? p.pickType}</td>
                    <td>
                      #{p.programNumber ?? '?'} {p.horseName ?? ''}
                      {p.entryId == null ? <span className="tag tag--red">unmatched</span> : null}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
            <button className="btn btn--primary" disabled={busy || preview.races.length === 0} onClick={handleConfirm}>
              Confirm &amp; save picks
            </button>
          </>
        )}
      </details>


      {data && data.attempts.length > 0 && (
        <details className="race">
          <summary>
            Fetch audit — {data.attempts.length} attempt{data.attempts.length === 1 ? '' : 's'}
            {data.attempts.some((a) => !OUTCOME_OK.has(a.outcome) && !OUTCOME_NEUTRAL.has(a.outcome)) ? ' (failures present)' : ''}
            {data.attempts.some((a) => OUTCOME_NEUTRAL.has(a.outcome)) ? ' (a source has not posted yet)' : ''}
          </summary>
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Source</th><th>Outcome</th><th>HTTP</th><th>URL</th><th>Picks</th><th>Reason</th><th>Discovery</th></tr>
            </thead>
            <tbody>
              {data.attempts.map((a) => (
                <tr key={a.id}>
                  <td className="dim">{a.ts}</td>
                  <td>{a.source_name}</td>
                  <td>{OUTCOME_OK.has(a.outcome) ? a.outcome
                    : OUTCOME_NEUTRAL.has(a.outcome) ? <span className="tag">{a.outcome}</span>
                      : <span className="tag tag--red">{a.outcome}</span>}</td>
                  <td className="dim">{a.http_status ?? ''}</td>
                  <td className="dim">{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{urlPath(a.url)}</a> : ''}</td>
                  <td>{a.picks_extracted ?? ''}</td>
                  <td className="dim">{a.fallback_reason ?? ''}</td>
                  <td><Discovery a={a} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
