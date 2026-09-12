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

  const handleUpload = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setConfirmed(null);
    try {
      const previewData = await equibaseOtrPreview(dayId, file);
      setPreview(previewData);

      // Auto-confirm and generate cards if there are no blocking errors
      // (warnings are shown but don't block generation)
      const result = await equibaseOtrConfirm(dayId, previewData.parseToken);
      setConfirmed(result);
      setFile(null);
      onSaved?.();
    } catch (e) {
      setError(String(e.message));
      setPreview(null);
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

      {hadPriorCards && !confirmed && (
        <p className="notice notice--warn">
          This day already has Equibase OTR cards - uploading ADDS three more (append-only), it never replaces them.
        </p>
      )}

      {preview && preview.warnings.length > 0 && (
        <div className="notice notice--warn">
          <strong>{preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'}:</strong>
          <ul>{preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </div>
      )}

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
        <button className="btn btn--primary" disabled={busy || !file} onClick={handleUpload}>
          {busy ? 'Generating cards…' : 'Upload & generate cards'}
        </button>
      </div>
    </details>
  );
}
