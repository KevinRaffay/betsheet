import React, { useEffect, useState } from 'react';
import { equibaseOtrPreview, equibaseOtrConfirm, listCards } from '../api.js';

const VARIANT_LABEL = { 'some-reward': 'Some Reward', 'higher-reward': 'Higher Reward', both: 'Both' };
const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// Equibase "Off to the Races" PDF upload (D71 follow-up): the free
// at-track sheet's own printed tickets, verbatim, into three cards
// (some-reward / higher-reward / both) in the EQB_OTR bucket. The
// preview-then-confirm shape it was styled against was ConsensusPanel's
// At The Races PDF upload (D69), removed in D110 - a picker source, not a
// consensus source, so it lives on the day view itself rather than inside
// Consensus.
export default function EquibaseOtrPanel({ dayId, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(null);
  const [hadPriorCards, setHadPriorCards] = useState(false);

  useEffect(() => {
    listCards(dayId)
      .then((cards) => setHadPriorCards(cards.some((c) => c.template === 'equibase-otr')))
      .catch(() => {});
  }, [dayId, confirmed]);

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    setConfirmed(null);
    try {
      setPreview(await equibaseOtrPreview(dayId, file));
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
      const result = await equibaseOtrConfirm(dayId, preview.parseToken);
      setConfirmed(result);
      setPreview(null);
      setFile(null);
      // The three new cards land in CardsPanel's own table, a sibling this
      // panel has no reference to - without this it only reappeared after a
      // full page reload remounted everything.
      onSaved?.();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const rows = (preview?.races ?? []).flatMap((r) => [
    ...r.someReward.map((t) => ({ race: r.race, tier: 'some-reward', ...t })),
    ...r.higherReward.map((t) => ({ race: r.race, tier: 'higher-reward', ...t })),
  ]);

  return (
    <details className="race">
      <summary>Equibase "Off to the Races" (PDF)</summary>
      <p className="dim">
        Download the whole day's sheet from <code>equibase.com</code> ("Off to the Races") and upload it
        here. Its four printed tickets per race (show + $1 exacta box, win + $2 exacta box) are taken
        verbatim into three cards - some-reward, higher-reward, and both together - never re-sized or
        interpreted.
      </p>

      {error && <p className="notice notice--error">{error}</p>}

      {confirmed && (
        <p className="notice">
          Saved {confirmed.cards.length} card{confirmed.cards.length === 1 ? '' : 's'}
          {' '}({confirmed.cards.map((c) => VARIANT_LABEL[c.variant] ?? c.variant).join(', ')}).
        </p>
      )}

      <div className="formrow">
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="formrow">
        <button className="btn" disabled={busy || !file} onClick={handlePreview}>
          {busy ? 'Working…' : 'Preview'}
        </button>
      </div>

      {preview && (
        <>
          <p className="dim">
            Read-only preview. To correct something, fix the PDF and preview again.
            {' '}Header read as <strong>{preview.parsedTrack ?? '?'}</strong>, <strong>{preview.parsedDate ?? '?'}</strong>.
          </p>
          {hadPriorCards && (
            <p className="notice notice--warn">
              This day already has Equibase OTR cards - confirming ADDS three more (append-only), it never replaces them.
            </p>
          )}
          {preview.warnings.length > 0 && (
            <div className="notice notice--warn">
              <ul>{preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
            </div>
          )}
          <p className="dim">
            Totals: some-reward {dollars(preview.variantTotals['some-reward'])}
            {' '}· higher-reward {dollars(preview.variantTotals['higher-reward'])}
            {' '}· both {dollars(preview.variantTotals.both)}
          </p>
          <table className="grid">
            <thead><tr><th>Race</th><th>Tier</th><th>Bet</th><th>Say to the teller</th><th>Cost</th></tr></thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={i}>
                  <td className="dim">{t.race}</td>
                  <td>{VARIANT_LABEL[t.tier]}</td>
                  <td className="dim">{t.betType.replace(/_/g, ' ')}</td>
                  <td>{t.tellerCall}</td>
                  <td className="dim">{dollars(t.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn--primary" disabled={busy || preview.races.length === 0} onClick={handleConfirm}>
            Confirm &amp; save three cards
          </button>
        </>
      )}
    </details>
  );
}
