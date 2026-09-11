import React, { useState } from 'react';
import { saveRaceLiveOdds } from '../api.js';

// Live odds for ONE race, typed (D232).
//
// WHY TYPED. Equibase's entries page has a LiveOdds column, and it is EMPTY in
// the HTML the server sends - 123 of 123 cells in this repo's own fixture. The
// values are written in the browser by `/js/liveOdds.js`, "refreshed every 60
// seconds" per the page's own tooltip, so both capture shapes this codebase
// supports (view-source, Ctrl+S "HTML Only") are empty by construction. The
// Apify actor scrapes that same page server-side and carries no live-odds
// field at all. Typing is the only route that exists, not a fallback.
//
// WHY IN THE RACE PANEL, AND PER RACE. The house rule (D182/D184): a
// race-specific input belongs in the Race UI component. It is also the only
// shape that matches a real race day - you price race 3 as it nears post and
// race 4 forty minutes later, and a board typed at 12:30 for a 5pm race is not
// the same fact as one typed at 4:58. Each save carries its OWN capture time,
// which is why this never touches `race_days.odds_captured_at` (one per day by
// construction, D116/D117) - writing a per-race time there would make the
// day-level staleness indicator claim a freshness no race has.
//
// The inputs themselves live in the entries table, beside each horse's M/L
// (user decision 2026-09-11). This component owns the draft state and the save
// bar; `RaceDayView` renders `oddsInput(...)` into the table's own cells.
export function useRaceLiveOdds(dayId, onSaved) {
  const [draft, setDraft] = useState(new Map());   // `${race}:${pgm}` -> string
  const [busy, setBusy] = useState(null);          // race number mid-save
  const [result, setResult] = useState(new Map()); // race number -> {ok, text}

  const key = (race, pgm) => `${race}:${pgm}`;
  const valueFor = (race, entry) => {
    const k = key(race, entry.program_number);
    return draft.has(k) ? draft.get(k) : (entry.live_odds ?? '');
  };
  const setValue = (race, pgm, v) => setDraft((m) => new Map(m).set(key(race, pgm), v));

  const save = async (race, entries) => {
    setBusy(race.number);
    setResult((m) => new Map(m).set(race.number, null));
    try {
      const odds = entries
        .filter((e) => !e.scratched)
        .map((e) => ({ programNumber: e.program_number, liveOdds: valueFor(race.number, e) }))
        .filter((o) => String(o.liveOdds ?? '').trim() !== '');
      const r = await saveRaceLiveOdds(dayId, race.number, odds);
      setResult((m) => new Map(m).set(race.number, {
        ok: true,
        text: `${r.counts.priced} price(s) saved at ${r.capturedAt}`
          + `${r.counts.changed ? ` — ${r.counts.changed} moved` : ''}`
          + `${r.warnings.length ? ` · ${r.warnings.length} note(s)` : ''}`,
        warnings: r.warnings,
      }));
      // Drop the drafts for this race so the saved values flow back down as
      // props rather than being shadowed by stale local text.
      setDraft((m) => {
        const next = new Map(m);
        for (const k of [...next.keys()]) if (k.startsWith(`${race.number}:`)) next.delete(k);
        return next;
      });
      onSaved?.();
    } catch (e) {
      setResult((m) => new Map(m).set(race.number, { ok: false, text: String(e.message), warnings: [] }));
    } finally {
      setBusy(null);
    }
  };

  return { valueFor, setValue, save, busy, result };
}

/** The cell that goes beside a horse's M/L. A scratch cannot be priced. */
export function LiveOddsCell({ race, entry, ctl }) {
  if (entry.scratched) return <td className="dim">—</td>;
  return (
    <td>
      <input
        className="in in--odds"
        value={ctl.valueFor(race.number, entry)}
        onChange={(ev) => ctl.setValue(race.number, entry.program_number, ev.target.value)}
        placeholder={entry.morning_line ?? ''}
        aria-label={`Live odds for #${entry.program_number}`}
        disabled={ctl.busy === race.number}
      />
    </td>
  );
}

/** Save bar under the race's table. */
export function LiveOddsBar({ race, ctl }) {
  const r = ctl.result.get(race.number);
  return (
    <div className="btnrow">
      <button
        type="button"
        className="btn"
        disabled={ctl.busy === race.number}
        onClick={() => ctl.save(race, race.entries)}
      >
        {ctl.busy === race.number ? 'Saving…' : 'Save live odds'}
      </button>
      <span className="dim">Typed at post time — only prices are stored.</span>
      {r && (
        <div className={r.ok ? 'notice' : 'notice notice--error'}>
          <p>{r.text}</p>
          {r.warnings?.length ? <ul>{r.warnings.map((w, i) => <li key={`w-${i}`}>{w.message}</li>)}</ul> : null}
        </div>
      )}
    </div>
  );
}
