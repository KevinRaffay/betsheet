import { useState } from 'react';
import { saveManualTipPicks } from '../api.js';
import { TIP_SOURCE_LABELS } from '@shared/source-labels.js';

// Manual tip-pick entry for ONE race (D176).
//
// The grid is horse ROWS by tipsheet COLUMNS, each cell three toggle buttons
// (D185; it was a rank dropdown until then). That shape is not cosmetic: a
// horse routinely appears in several sheets at different ranks - in the two
// real screenshots this project extracted, two of the three horses did
// (Karazest was TrackMaster 1 and NumberFire 2). A single tipsheet dropdown
// per horse row could not express that at all.
//
// Ranks are 1-3 per sheet and each rank is used at most once per sheet, which
// the UI enforces by MOVING a rank off whichever horse held it in that column -
// the server validates it again regardless, through the same validateTipPicks
// a model's output passes. D185 kept that rule exactly and changed only the
// control: clicking a lit button clears it, clicking any other takes the rank.
//
// HOUSE RULE: `.modal-backdrop` carries NO click handler. An accidental click
// outside must never discard typed picks.

const RANKS = [1, 2, 3];

export default function TipPicksEntryModal({ dayId, race, entries = [], existing = [], onClose, onSaved }) {
  // One column per tipsheet, seeded from whatever this race already has so
  // opening the dialog again EDITS rather than starting blank.
  const [columns, setColumns] = useState(() => {
    const seeded = existing.map((r) => r.sourceLabel);
    return seeded.length ? [...new Set(seeded)] : [TIP_SOURCE_LABELS[0]];
  });
  // `${source}::${programNumber}` -> rank
  const [ranks, setRanks] = useState(() => {
    const m = new Map();
    for (const row of existing) {
      for (const p of row.picks) m.set(`${row.sourceLabel}::${p.horse_no}`, p.rank);
    }
    return m;
  });
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const live = entries.filter((e) => !e.scratched);
  const rankOf = (source, pgm) => ranks.get(`${source}::${pgm}`) ?? '';

  const setRank = (source, pgm, value) => {
    setRanks((prev) => {
      const next = new Map(prev);
      const key = `${source}::${pgm}`;
      if (!value) next.delete(key);
      else {
        // A rank belongs to one horse per sheet: assigning it moves it.
        for (const [k, v] of next) if (k.startsWith(`${source}::`) && v === Number(value)) next.delete(k);
        next.set(key, Number(value));
      }
      return next;
    });
  };

  const picksFor = (source) => live
    .map((e) => ({ horse_no: e.program_number, rank: rankOf(source, e.program_number) }))
    .filter((p) => p.rank !== '')
    .sort((a, b) => a.rank - b.rank);

  const addColumn = () => {
    const name = adding.trim();
    if (!name || columns.includes(name)) return;
    setColumns((c) => [...c, name]);
    setAdding('');
  };

  const removeColumn = (source) => {
    setColumns((c) => c.filter((x) => x !== source));
    setRanks((prev) => {
      const next = new Map(prev);
      for (const k of [...next.keys()]) if (k.startsWith(`${source}::`)) next.delete(k);
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      // EVERY column is sent, including empty ones - an empty sheet is how a
      // column is CLEARED, and omitting it would silently leave stale picks.
      await saveManualTipPicks(dayId, {
        race: race.number,
        sheets: columns.map((source) => ({ sourceLabel: source, picks: picksFor(source) })),
      });
      onSaved?.();
      onClose?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const total = columns.reduce((n, s) => n + picksFor(s).length, 0);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="pagehead">
          <h2>Tip sheet picks — race {race.number}</h2>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Close</button>
        </div>

        {error && <p className="notice notice--error">{error}</p>}
        <p className="dim">
          Click 1, 2 or 3 to rank a horse for a tip sheet; click the same button again to clear it.
          A horse can appear in several sheets at different ranks. Clearing every rank in a column
          removes that sheet from this race.
        </p>

        <div className="formrow">
          <input
            className="in in--sm" list="tip-source-options" placeholder="add a tip sheet"
            value={adding} onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addColumn(); } }}
          />
          <datalist id="tip-source-options">
            {TIP_SOURCE_LABELS.filter((s) => !columns.includes(s)).map((s) => <option key={s} value={s} />)}
          </datalist>
          <button type="button" className="btn btn--sm" onClick={addColumn} disabled={!adding.trim()}>Add tip sheet</button>
        </div>

        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Horse</th>
              <th className="col-detail">M/L</th>
              {columns.map((s) => (
                <th key={s}>
                  {s}{' '}
                  <button type="button" className="btn btn--sm" title={`Remove ${s}`}
                    onClick={() => removeColumn(s)}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {live.map((e) => (
              <tr key={e.program_number}>
                <td><strong>{e.program_number}</strong></td>
                <td>{e.horse_name}</td>
                <td className="col-detail dim">{e.morning_line || '—'}</td>
                {columns.map((s) => (
                  <td key={s}>
                    {/* D185: three toggle buttons, not a dropdown. Every rank
                        is one click from anywhere, and the whole column can be
                        read at a glance - a <select> hid the current value
                        behind a control that had to be opened to be trusted.
                        `aria-pressed` carries the on/off state, so the button
                        reports the same thing to a screen reader that the fill
                        reports to the eye. */}
                    <div className="rankpick" role="group" aria-label={`${s} rank for ${e.horse_name}`}>
                      {RANKS.map((r) => {
                        const on = rankOf(s, e.program_number) === r;
                        return (
                          <button
                            key={r} type="button"
                            className={on ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
                            aria-pressed={on}
                            title={on ? `Clear rank ${r} for ${e.horse_name}` : `${s} rank ${r} for ${e.horse_name}`}
                            // Clicking the ON button clears it; clicking any
                            // other MOVES that rank off whoever held it, which
                            // is `setRank`'s existing exclusion rule reused
                            // rather than a second copy of it.
                            onClick={() => setRank(s, e.program_number, on ? '' : r)}
                          >{r}</button>
                        );
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="formrow">
          <span className="dim">
            {total} pick{total === 1 ? '' : 's'} across {columns.length} sheet{columns.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="btn btn--primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save picks'}
          </button>
        </div>
      </div>
    </div>
  );
}
