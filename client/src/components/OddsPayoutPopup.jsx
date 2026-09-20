import React, { useRef, useState } from 'react';
import { oddsPayoutRows } from '@shared/odds-payout-table.js';

const DEFAULT_POS = { top: 56, right: 16 };

/**
 * Non-modal, draggable reference panel: $2 win payout + ROI for the
 * standard odds board. Deliberately NOT `.modal-backdrop` (that pattern
 * is reserved for real modals per CLAUDE.md's house rule) - there is no
 * backdrop at all, so the page behind it stays fully interactive.
 */
export default function OddsPayoutPopup({ onClose }) {
  const [pos, setPos] = useState(DEFAULT_POS);
  const dragRef = useRef(null);

  const onDragStart = (e) => {
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, top: rect.top, left: rect.left };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  };

  const onDragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ top: d.top + (e.clientY - d.startY), left: d.left + (e.clientX - d.startX) });
  };

  const onDragEnd = () => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  };

  return (
    <div className="odds-popup" style={pos}>
      <div className="odds-popup__header" onPointerDown={onDragStart}>
        <span className="odds-popup__title">$2 win payouts</span>
        <button className="odds-popup__close" onClick={onClose} title="Close" aria-label="Close">×</button>
      </div>
      <table className="grid">
        <thead>
          <tr><th>Odds</th><th>$2 payout</th><th>ROI</th></tr>
        </thead>
        <tbody>
          {oddsPayoutRows().map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>${r.payout}</td>
              <td>{r.roi}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
