import { formatPacific } from '@shared/time-format.js';
import React, { useEffect, useState } from 'react';
import { getLiveOddsCaptures, saveRaceLiveOdds } from '../api.js';

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
  const [captures, setCaptures] = useState([]);    // every save on this day, newest first

  const key = (race, pgm) => `${race}:${pgm}`;
  const valueFor = (race, entry) => {
    const k = key(race, entry.program_number);
    return draft.has(k) ? draft.get(k) : (entry.live_odds ?? '');
  };
  const setValue = (race, pgm, v) => setDraft((m) => new Map(m).set(key(race, pgm), v));

  // Block body (D90, CLAUDE.md Gotchas): an expression-bodied loader returns a
  // promise, which React would store and call as the effect's own cleanup.
  const loadCaptures = () => getLiveOddsCaptures(dayId)
    .then((r) => setCaptures(r.captures ?? []))
    .catch(() => {}); // supplementary display only - a fetch failure here shouldn't block the page
  useEffect(() => { loadCaptures(); }, [dayId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every capture whose `races` list names this race - a per-race typed save
  // names only itself, a whole-day upload (LiveOddsModal, D228) names every
  // race it covered.
  const historyFor = (raceNumber) => captures.filter(
    (c) => (c.races ?? '').split(',').includes(String(raceNumber)),
  );

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
        text: `${r.counts.priced} price(s) saved at ${formatPacific(r.capturedAt)}`
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
      await loadCaptures();
    } catch (e) {
      setResult((m) => new Map(m).set(race.number, { ok: false, text: String(e.message), warnings: [] }));
    } finally {
      setBusy(null);
    }
  };

  return { valueFor, setValue, save, busy, result, historyFor };
}

/** The cell that goes beside a horse's M/L. A scratch cannot be priced. */
export function LiveOddsCell({ race, entry, ctl }) {
  if (entry.scratched) return <td className="dim">—</td>;
  // D235: the placeholder is NOT the morning line. Now that a field looks
  // like a field, a greyed "20/1" sitting in it reads as a value already
  // entered rather than as a hint - and the M/L is in the very next column,
  // so the hint duplicated the thing it sat beside.
  return (
    <td>
      <input
        className="in in--odds"
        value={ctl.valueFor(race.number, entry)}
        onChange={(ev) => ctl.setValue(race.number, entry.program_number, ev.target.value)}
        placeholder="odds"
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

/** Every past save of this race's board, newest first. Collapsed by default -
 * a race checked several times before post can accumulate a long list, and
 * the current board is already on screen above. */
export function LiveOddsHistory({ race, ctl }) {
  const history = ctl.historyFor(race.number);
  if (history.length === 0) return null;
  return (
    <details className="race-odds-history">
      <summary>Odds history ({history.length})</summary>
      <ul>
        {history.map((c) => {
          const wholeDay = (c.races ?? '').split(',').length > 1;
          return (
            <li key={`cap-${c.id}`}>
              {formatPacific(c.captured_at) ?? `(time unknown — saved ${formatPacific(c.ingested_at)})`}
              {' — '}
              {wholeDay ? `full-board upload, ${c.prices} price(s) across the day` : `${c.prices} price(s)`}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
