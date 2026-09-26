import React, { useEffect, useState } from 'react';
import { previewCombinedParlays, saveCombinedParlay, plMoney, plClass } from '../api.js';

// Build a WPS parlay from the combined per-race model (D438, DD of the
// combined-parlay plan; the server is D436, the model D434).
//
// PREVIEW, THEN SAVE (invariant 9). "Preview candidates" writes nothing; each
// candidate row has its own Save, which asks the server to rebuild the
// candidates from the OPTIONS THE PREVIEW RAN WITH and save that one - never a
// ticket this component constructed. So the options are snapshotted at preview
// time (`ran`), and editing the form afterwards marks the preview stale rather
// than silently saving under different options than the ones on screen.
//
// BOTH SELECTIONS, SIDE BY SIDE, and both probabilities on every row. The D434
// backtest (docs/findings/combined-parlay-v1.md) found the market alone at
// least as good as the combined model on this corpus, and the combined model's
// show probabilities 3-7 points high above 50%. Showing only the combined
// column would show only the flattering number; the market's own read of the
// same legs sits next to it on every row.
//
// A CANDIDATE IS A LABEL, NOT A RECOMMENDATION (the D240 rule). The copy says
// so and says why - the take is paid once per leg - rather than presenting a
// percentage as a reason to bet.
//
// House rules honoured here: the backdrop has NO click handler (D131-D133),
// only × / Close / Escape dismiss; every field is a real bordered control
// (D235); the one correlation id the preview returns rides on every save, so a
// card's whole session traces as one (invariant 8).
//
// D442 adds a second MODE, Pick N / Daily Double: the same preview/save loop
// over D442's pool builder. A pool leg covers several horses, so its row shows
// each leg's horses and coverage instead of one horse, a Cost column (a spread
// ticket costs base x combinations), and an "assumed base" tag wherever the
// menu named the pool without printing its minimum.

const KINDS = [
  { key: 'win', label: 'Win' },
  { key: 'place', label: 'Place' },
  { key: 'show', label: 'Show' },
];
const POOLS = [
  { key: 'daily_double', label: 'Daily Double' },
  { key: 'pick3', label: 'Pick 3' },
  { key: 'pick4', label: 'Pick 4' },
  { key: 'pick5', label: 'Pick 5' },
];
const pct = (p) => (typeof p === 'number' ? `${(p * 100).toFixed(1)}%` : '—');
const dollars = (c) => (typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : '—');
const estimate = (c) => (c.estMinCents === null ? '—'
  : c.estIsRange ? `${dollars(c.estMinCents)}–${dollars(c.estMaxCents)}` : dollars(c.estMinCents));

/** The sources that moved a leg, as short tags - read off the trace's own vote counts. */
function voteTags(v) {
  if (!v) return [];
  const out = [];
  if (v.tipTop) out.push(`${v.tipTop} tip top`);
  if (v.tipNamed) out.push(`${v.tipNamed} tip 2-3`);
  if (v.llmPrimary) out.push(`LLM ×${v.llmPrimary}`);
  if (v.llmBacked) out.push(`LLM backed ×${v.llmBacked}`);
  if (v.otrWin) out.push('OTR win');
  if (v.otrShow) out.push('OTR show');
  return out;
}

const keyOf = (c) => `${c.betType}|${c.raceNumbers.join(',')}|${c.legs.map((l) => l.join('/')).join(',')}`;

function CandidateTable({ title, selection, rows, saved, busyKey, onSave, disabled, pool }) {
  return (
    <div className="combined-parlay__section">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="dim">
          {pool
            ? 'No pool ticket meets these options - try a bigger budget, another pool, or a lower payout floor.'
            : 'No parlay meets these options - try fewer legs, another bet kind, or a lower payout floor.'}
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Say to the teller</th>
              <th>Legs</th>
              <th title="The combined model's chance that every leg hits - uncalibrated">P(hit) combined</th>
              <th title="The market's own chance for the same legs, from the odds alone">P(hit) market</th>
              {pool && <th title="Base x the number of combinations the spread covers">Cost</th>}
              <th title="Estimated return if every leg hits; place, show and pools are a band">If it hits (est.)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const k = `${selection}|${keyOf(c)}`;
              const done = saved.get(k);
              return (
                <tr key={k}>
                  <td>
                    <code>{c.tellerCall}</code>
                    {c.baseSource === 'assumed' && (
                      <span className="tag tag--gold" title="The menu names this pool but prints no minimum; the base is BetSheet's fallback - check it at the window">
                        base assumed
                      </span>
                    )}
                  </td>
                  <td>
                    <ul className="combined-parlay__legs">
                      {c.legDetail.map((l) => (Array.isArray(l.programNumbers) ? (
                        <li key={l.race}>
                          <span className="combined-parlay__leg">
                            R{l.race} {l.programNumbers.map((n) => '#' + n).join(', ')}
                            <span className="dim"> {pct(l.combinedPHit)} / {pct(l.marketPHit)}</span>
                          </span>
                        </li>
                      ) : (
                        <li key={l.race}>
                          <span className="combined-parlay__leg">
                            R{l.race} #{l.programNumber}
                            <span className="dim"> {pct(l.combinedPHit)} / {pct(l.marketPHit)}</span>
                          </span>
                          {voteTags(l.votes).map((t) => <span key={t} className="tag">{t}</span>)}
                        </li>
                      )))}
                    </ul>
                  </td>
                  <td>{pct(c.combinedPHit)}</td>
                  <td>{pct(c.marketPHit)}</td>
                  {pool && <td>{dollars(c.costCents)}</td>}
                  <td>{estimate(c)}</td>
                  <td>
                    {done ? (
                      <span className="dim">Saved as card #{done.cardNumber}</span>
                    ) : (
                      <button className="btn btn--sm" disabled={disabled || busyKey === k} onClick={() => onSave(selection, c, k)}>
                        {busyKey === k ? 'Saving…' : 'Save'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function CombinedParlayModal({ dayId, onCardChanged, onClose }) {
  const [mode, setMode] = useState('wps');
  const [pools, setPools] = useState(() => new Set(['daily_double', 'pick3', 'pick4', 'pick5']));
  const [budget, setBudget] = useState('12');
  const [kinds, setKinds] = useState(() => new Set(['win', 'place', 'show']));
  const [legsMin, setLegsMin] = useState(2);
  const [legsMax, setLegsMax] = useState(3);
  const [floor, setFloor] = useState('');
  const [stake, setStake] = useState('2');
  const [name, setName] = useState('');

  const [preview, setPreview] = useState(null);
  const [ran, setRan] = useState(null);           // the options the preview ran with
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [saved, setSaved] = useState(() => new Map());

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const payoutFloor = floor.trim() === '' ? null : Number(floor);
  const options = () => (mode === 'pool'
    ? {
      mode: 'pool',
      pools: POOLS.map((x) => x.key).filter((k) => pools.has(k)),
      budgetCents: Math.round(Number(budget) * 100),
      payoutFloor,
      limit: 5,
    }
    : {
      mode: 'wps',
      kinds: KINDS.map((k) => k.key).filter((k) => kinds.has(k)),
      legsMin: Number(legsMin),
      legsMax: Number(legsMax),
      payoutFloor,
      stakeCents: Math.round(Number(stake) * 100),
      limit: 5,
    });
  const stale = ran !== null && JSON.stringify(ran) !== JSON.stringify(options());

  const toggleIn = (setter) => (k) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleKind = toggleIn(setKinds);
  const togglePool = toggleIn(setPools);
  const poolMode = mode === 'pool';
  // Which table shape the CANDIDATES on screen have - the mode they were
  // built in, not the radio's current value (a switched radio is just stale).
  const shownPool = ran?.mode === 'pool';

  const runPreview = async () => {
    const opts = options();
    setBusy(true);
    setError(null);
    try {
      const res = await previewCombinedParlays(dayId, opts, preview?.correlationId);
      setPreview(res);
      setRan(opts);
      setSaved(new Map());
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const save = async (selection, c, k) => {
    setBusyKey(k);
    setError(null);
    try {
      const res = await saveCombinedParlay(dayId, {
        options: ran,
        choice: { selection, betType: c.betType, raceNumbers: c.raceNumbers, legs: c.legs },
        name: name.trim() || undefined,
      }, preview.correlationId);
      const grade = res.graded?.summary ?? null;
      setSaved((prev) => new Map(prev).set(k, { cardId: res.cardId, cardNumber: res.cardNumber, grade }));
      onCardChanged?.();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusyKey(null);
    }
  };

  const races = preview?.races ?? [];
  const modelled = races.filter((r) => r.modelled);
  const coverage = {
    board: modelled.filter((r) => r.basis === 'live').length,
    tips: modelled.filter((r) => r.tipSheets.length).length,
    llm: modelled.filter((r) => r.llmModels.length).length,
    otr: modelled.filter((r) => r.otr).length,
  };
  const savedList = [...saved.values()];

  return (
    // House rule (D131-D133): no onClick on the backdrop, ever.
    <div className="modal-backdrop">
      <div className="modal combined-parlay" role="dialog" aria-modal="true" aria-label="Build a parlay from the combined model">
        <div className="modal__header">
          <h3>Build a parlay — combined model</h3>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          <p className="dim">
            Picks the bet with the highest chance that <em>every</em> leg hits, from the market odds nudged by
            this day&apos;s tip sheets, LLM cards and OTR picks: a win, place or show parlay, or a Daily Double /
            Pick 3-5 spread across as many horses as the budget buys. The payout floor is checked against
            the <em>pessimistic</em> estimate. A candidate is a reading of the model, not a recommendation: the
            track&apos;s take is paid on every leg, and in the backtest every show-parlay setup lost money even
            while cashing often.
          </p>

          <div className="formrow formrow--tight combined-parlay__kinds">
            <span className="dim">Build</span>
            <label className="combined-parlay__kind">
              <input type="radio" name="combined-parlay-mode" checked={!poolMode} onChange={() => setMode('wps')} /> WPS parlay
            </label>
            <label className="combined-parlay__kind">
              <input type="radio" name="combined-parlay-mode" checked={poolMode} onChange={() => setMode('pool')} /> Pick N / Daily Double
            </label>
          </div>

          {poolMode ? (
            <div className="formrow formrow--tight combined-parlay__kinds">
              <span className="dim">Pools</span>
              {POOLS.map((x) => (
                <label key={x.key} className="combined-parlay__kind">
                  <input type="checkbox" checked={pools.has(x.key)} onChange={() => togglePool(x.key)} /> {x.label}
                </label>
              ))}
            </div>
          ) : (
            <div className="formrow formrow--tight combined-parlay__kinds">
              <span className="dim">Bet kind</span>
              {KINDS.map((k) => (
                <label key={k.key} className="combined-parlay__kind">
                  <input type="checkbox" checked={kinds.has(k.key)} onChange={() => toggleKind(k.key)} /> {k.label}
                </label>
              ))}
            </div>
          )}
          <div className="formrow formrow--tight">
            {poolMode ? (
              <label title="The most one ticket may cost - base x combinations">
                Budget $
                <input type="number" min="1" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 70 }} />
              </label>
            ) : (
              <>
                <label>
                  Legs from
                  <select value={legsMin} onChange={(e) => setLegsMin(Number(e.target.value))}>
                    {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label>
                  to
                  <select value={legsMax} onChange={(e) => setLegsMax(Number(e.target.value))}>
                    {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label>
                  Stake $
                  <input type="number" min="2" step="1" value={stake} onChange={(e) => setStake(e.target.value)} style={{ width: 70 }} />
                </label>
              </>
            )}
            <label title={poolMode
              ? 'Blank for no floor. 2 means the pessimistic estimate at least doubles what the ticket COSTS.'
              : 'Blank for no floor. 2 means the pessimistic estimate at least doubles the stake.'}>
              Pays at least
              <input type="number" min="1" step="0.5" value={floor} placeholder="any" onChange={(e) => setFloor(e.target.value)} style={{ width: 70 }} />
              {poolMode ? '× cost' : '× stake'}
            </label>
            <button className="btn btn--primary" disabled={busy || (poolMode ? pools.size === 0 : kinds.size === 0)} onClick={runPreview}>
              {busy ? 'Building…' : preview ? 'Preview again' : 'Preview candidates'}
            </button>
          </div>

          {error && <p className="notice notice--error">{error}</p>}

          {preview && (
            <>
              {stale && (
                <p className="notice notice--warn">
                  The options have changed since this preview. Preview again before saving - a save always uses the options
                  the candidates below were built with.
                </p>
              )}
              {preview.resultsOnFile && (
                <p className="notice notice--warn">
                  This day&apos;s results are already on file. The model never reads them, but a parlay saved now is not a
                  blind pick - it is graded the moment it is saved.
                </p>
              )}
              <p className="dim">
                {modelled.length} of {races.length} races modelled · live board on {coverage.board} · tip sheets on {coverage.tips}
                {' '}· LLM cards on {coverage.llm} · OTR on {coverage.otr}
                {preview.excluded?.llmPostResult ? ` · ${preview.excluded.llmPostResult} LLM card-race(s) left out as written after results` : ''}
                {' '}· model <code>{preview.modelVersion}</code>
              </p>
              <div className="formrow formrow--tight">
                <label>
                  Card name (optional)
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Saturday show parlay" />
                </label>
              </div>

              <CandidateTable
                title="Legs chosen by the combined model"
                selection="combined"
                rows={preview.candidates.combined}
                saved={saved}
                busyKey={busyKey}
                onSave={save}
                disabled={stale}
                pool={shownPool}
              />
              <CandidateTable
                title="Legs chosen by the market alone"
                selection="market"
                rows={preview.candidates.market}
                saved={saved}
                busyKey={busyKey}
                onSave={save}
                disabled={stale}
                pool={shownPool}
              />
              {shownPool && preview.skipped?.length > 0 && (
                <details className="dim">
                  <summary>{preview.skipped.length} offered pool{preview.skipped.length === 1 ? '' : 's'} could not be built</summary>
                  <ul>
                    {preview.skipped.map((x) => (
                      <li key={x.pool + x.startRace}>{x.pool} from race {x.startRace}: {x.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="dim">
                {shownPool
                  ? 'Per leg: the covered horses, then combined % / market % that one of them wins that leg. '
                  : 'Per leg: combined % / market % for that leg alone, then the sources that backed the horse. '}
                P(hit) is a {preview.calibration}.
                {shownPool && ' Pool estimates chain the covered winners\' odds and apply the measured pool-payout band (BET.estimates.poolFactor).'}
              </p>

              {savedList.some((s) => s.grade) && (
                <p className="notice">
                  Graded on save:{' '}
                  {savedList.filter((s) => s.grade).map((s) => (
                    <span key={s.cardId} className={plClass(s.grade.plCents)}>
                      card #{s.cardNumber} {plMoney(s.grade.plCents)}{' '}
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>
        <div className="modal__footer">
          <span className="dim">{savedList.length ? `${savedList.length} parlay card(s) saved` : 'Nothing saved yet'}</span>
          <div className="modal__footer-actions">
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
