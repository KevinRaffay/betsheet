import React, { useRef, useState } from 'react';
import { buildStaticExport, validateStaticExport, exportFileName } from '@shared/static-export.js';
import { navigate } from './app.jsx';
import { lockedRaces, cardCostCents, cardTickets } from './card.js';
import { isUnexported, putCard, getCard, deleteCard } from './storage.js';
import { downloadExport, markExported, exportable } from './exchange.js';

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// Export and restore (D152), which are a PAIR. Export alone is a dead end: a
// wiped browser would leave a pile of files that are only useful at home, and
// no way to keep building the day that produced them.
export default function CardsView({ payload, cards, deviceId, onReloadCards }) {
  const [note, setNote] = useState(null);
  const [problems, setProblems] = useState([]);
  const fileRef = useRef(null);

  const download = (docCards) => downloadExport({ cards: docCards, payload, deviceId });

  const stamp = async (docCards) => { await markExported(docCards); await onReloadCards(); };

  const exportAll = async () => {
    const withWork = exportable(cards);
    if (!withWork.length) { setNote('Nothing to export yet — no race is locked on any card.'); return; }
    const doc = download(withWork);
    await stamp(withWork);
    setNote(`Exported ${doc.cards.length} card(s) as ${exportFileName(doc)}.`);
  };

  const copyAll = async () => {
    const withWork = exportable(cards);
    if (!withWork.length) { setNote('Nothing to copy yet — no race is locked on any card.'); return; }
    const doc = buildStaticExport({ cards: withWork, payload, deviceId });
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      await stamp(withWork);
      setNote(`Copied ${doc.cards.length} card(s) to the clipboard. Paste it somewhere that syncs.`);
    } catch (err) {
      setNote(`Could not reach the clipboard (${err?.name ?? 'error'}). Use Export instead.`);
    }
  };

  // RESTORE. The mirror of export, and the reason export is not a dead end:
  // an export file can rebuild this browser's whole store.
  const restore = async (file) => {
    setProblems([]);
    setNote(null);
    let doc;
    try {
      doc = JSON.parse(await file.text());
    } catch (err) {
      setProblems([`That file is not JSON (${err.message}).`]);
      return;
    }
    const found = validateStaticExport(doc);
    if (found.length) { setProblems(found); return; }
    // Refused with the reason named, not silently ignored: restoring one race
    // day's cards into another day's app would produce tickets against races
    // that do not exist.
    if (doc.raceDayId !== payload.raceDay.raceDayId) {
      setProblems([
        `That file is for race day ${doc.raceDayId} (${doc.track ?? '?'} ${doc.date ?? '?'}), `
        + `but this page is deployed for race day ${payload.raceDay.raceDayId} `
        + `(${payload.raceDay.track} ${payload.raceDay.date}). Nothing was restored.`,
      ]);
      return;
    }

    let added = 0;
    let refreshed = 0;
    for (const c of doc.cards) {
      const existing = await getCard(c.cardId);
      // Newest wins, by the card's own updatedAt. The rolling backup means a
      // later file is a superset of an earlier one, so restoring an older file
      // over newer work would be the one genuinely destructive outcome here.
      if (existing && String(existing.updatedAt ?? '') >= String(c.updatedAt ?? c.createdAt)) continue;
      await putCard({
        cardId: c.cardId,
        deviceId: c.deviceId ?? doc.deviceId,
        raceDayId: doc.raceDayId,
        payloadHash: doc.payloadHash,
        name: c.name ?? null,
        bankrollCents: c.bankrollCents ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt ?? c.createdAt,
        sawReferenceCards: Boolean(c.sawReferenceCards),
        races: Object.fromEntries(c.races.map((r) => [r.number, {
          text: r.text ?? '', tickets: r.tickets ?? [], lockedAt: r.lockedAt, passed: r.passed,
        }])),
        // The restored card came FROM an export, so it is not unexported work
        // - and its own updatedAt is preserved so the counter can tell.
        exportedAt: doc.exportedAt,
      }, { preserveUpdatedAt: true });
      if (existing) refreshed += 1; else added += 1;
    }
    await onReloadCards();
    setNote(`Restored from ${file.name}: ${added} card(s) added, ${refreshed} updated, `
      + `${doc.cards.length - added - refreshed} already current.`);
  };

  const forget = async (cardId) => {
    await deleteCard(cardId);
    await onReloadCards();
    setNote('Card removed from this browser. Any export file you already saved still has it.');
  };

  return (
    <>
      <section className="panel">
        <div className="formrow formrow--tight">
          <button className="btn btn--sm" onClick={() => navigate('/')}>← All races</button>
          <h2>Cards on this device</h2>
        </div>

        {note && <div className="notice">{note}</div>}
        {problems.length > 0 && (
          <div className="notice notice--error">
            <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </div>
        )}

        <div className="formrow formrow--tight">
          <button className="btn btn--primary" onClick={exportAll}>Export every card</button>
          <button className="btn" onClick={copyAll}>Copy to clipboard</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restore from a file…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restore(f); }} />
        </div>
        <p className="dim">
          Exporting is free: importing at home keys on card id and skips anything already
          present, so ten backup files for one afternoon cost nothing and the newest one
          wins. Downloads survive storage eviction — this browser's store does not.
        </p>

        <table className="grid">
          <thead>
            {/* Same house rule as the races grid: Export and Forget are the
                actions this whole screen exists for, so the counts give way
                at mobile width rather than pushing them off the edge. */}
            <tr>
              <th>Card</th>
              <th className="col-detail">Races</th>
              <th className="col-detail">Tickets</th>
              <th>Cost</th><th>State</th><th /></tr>
          </thead>
          <tbody>
            {cards.length === 0 && (
              <tr><td colSpan={6} className="dim">No cards on this device yet.</td></tr>
            )}
            {cards.map((c) => (
              <tr key={c.cardId}>
                <td>
                  <code>{c.cardId}</code>
                  {c.name && <><br /><span className="dim">{c.name}</span></>}
                  {c.sawReferenceCards && <span className="tag tag--gold">saw reference cards</span>}
                </td>
                <td className="col-detail">{lockedRaces(c).length}</td>
                <td className="col-detail">{cardTickets(c).length}</td>
                <td>{money(cardCostCents(c))}</td>
                <td>
                  {isUnexported(c)
                    ? <span className="tag tag--gold">unexported</span>
                    : <span className="dim">exported {String(c.exportedAt).slice(0, 16).replace('T', ' ')}</span>}
                </td>
                <td>
                  <button className="btn btn--sm" onClick={() => download([c])}>Export</button>
                  <button className="btn btn--sm btn--danger" onClick={() => forget(c.cardId)}>Forget</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
