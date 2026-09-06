import React, { useMemo, useState } from 'react';
import { tellerCall, parseWagerMenu, wagerMenuOffered } from '@shared/betmath.js';
import { wagerLimitsFor, comboCountFor } from '@shared/parsers/human-picks.js';

// The ticket builder (D86). Deliberately a CONTROLLED TEXT PRODUCER: it owns
// no server state and posts nothing. It composes the D84 teller grammar and
// hands the string up, so the parent still posts TEXT to the endpoints that
// already exist and the server still re-parses it independently (invariant 9,
// server/human-cards.js's "never trust a client-shaped payload" rule).
//
// Every number it shows comes from the SAME code the server validates with -
// shared/betmath.js's tellerCall/parseWagerMenu and human-picks.js's
// wagerLimitsFor/comboCountFor - so the preview can never disagree with the
// builder about what a ticket costs or whether a stake is legal.
//
// Deliberately NOT bidirectional in v1: it starts empty and never parses
// existing text back into rows.

const BET_TYPES = [
  { value: 'win', label: 'Win', positions: 1, menuKey: 'win' },
  { value: 'place', label: 'Place', positions: 1, menuKey: 'win' },
  { value: 'show', label: 'Show', positions: 1, menuKey: 'win' },
  { value: 'exacta', label: 'Exacta', positions: 2, menuKey: 'exacta' },
  { value: 'exacta_box', label: 'Exacta box', positions: 1, box: 2, menuKey: 'exacta' },
  { value: 'trifecta', label: 'Trifecta', positions: 3, menuKey: 'trifecta' },
  { value: 'trifecta_box', label: 'Trifecta box', positions: 1, box: 3, menuKey: 'trifecta' },
  { value: 'superfecta', label: 'Superfecta', positions: 4, menuKey: 'superfecta' },
  { value: 'superfecta_box', label: 'Superfecta box', positions: 1, box: 4, menuKey: 'superfecta' },
];
const SPEC = Object.fromEntries(BET_TYPES.map((b) => [b.value, b]));
const ORDINAL = ['1st', '2nd', '3rd', '4th'];

const money = (cents) => (cents == null ? '—' : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const toCents = (s) => {
  const n = Number(String(s ?? '').replace(/[$,]/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

let seq = 0;
const emptyDraft = (betType = 'win', stake = '') => ({
  id: `d${++seq}`, betType, positions: [[]], stake, odds: '', rationale: '',
});

/** Reshape a draft's positions when its bet type changes, keeping what fits. */
function reshape(draft, betType) {
  const want = SPEC[betType].positions;
  const kept = draft.positions.slice(0, want);
  while (kept.length < want) kept.push([]);
  return { ...draft, betType, positions: kept };
}

function HorseStrip({ entries, selected, onToggle, onAll, onClear, single }) {
  return (
    <div className="tb-strip">
      <div className="tb-chips">
        {entries.map((e) => {
          const on = selected.includes(e.programNumber);
          return (
            <button
              key={e.programNumber}
              type="button"
              className={`pgm-chip${on ? ' pgm-chip--on' : ''}${e.scratched ? ' pgm-chip--scr' : ''}`}
              disabled={e.scratched}
              title={e.scratched ? `${e.horseName} — scratched` : e.horseName}
              onClick={() => onToggle(e.programNumber)}
            >
              <span className="pgm-chip__num">{e.programNumber}</span>
              <span className="pgm-chip__name">{e.horseName}</span>
              {e.morningLine && <span className="pgm-chip__ml">{e.morningLine}</span>}
            </button>
          );
        })}
      </div>
      {!single && (
        <div className="tb-strip__actions">
          <button type="button" className="linkish" onClick={onAll}>ALL</button>
          <button type="button" className="linkish" onClick={onClear}>clear</button>
        </div>
      )}
    </div>
  );
}

export default function TicketBuilder({ raceNumber, entries = [], wagerMenu = null, disabled = false, onChange }) {
  const [drafts, setDrafts] = useState([emptyDraft()]);
  const [saved, setSaved] = useState([]);

  const live = useMemo(() => entries.filter((e) => !e.scratched), [entries]);
  const menu = useMemo(() => parseWagerMenu(wagerMenu), [wagerMenu]);
  const offered = useMemo(() => wagerMenuOffered(wagerMenu), [wagerMenu]);

  // One derivation per draft: combination count, cost, the composed teller
  // string, and whatever is stopping it from being a real ticket.
  const derived = useMemo(() => drafts.map((d) => {
    const spec = SPEC[d.betType];
    const stakeCents = toCents(d.stake);
    const legs = spec.box ? [d.positions[0]] : d.positions;
    const filled = legs.every((l) => l.length > 0);
    const combos = filled ? comboCountFor(d.betType, legs) : 0;
    const { minCents, stepCents } = wagerLimitsFor(d.betType, menu);

    const problems = [];
    if (!filled) {
      problems.push(spec.box
        ? `Pick at least ${spec.box} horses.`
        : `Pick a horse for every position (${spec.positions}).`);
    } else if (combos === 0) {
      problems.push(`A ${spec.label.toLowerCase()} needs at least ${spec.box} horses.`);
    }
    if (stakeCents == null) problems.push('Enter a stake.');
    else if (stakeCents < minCents) problems.push(`Below the ${money(minCents)} minimum.`);
    else if (stakeCents % stepCents !== 0) problems.push(`Must be a multiple of ${money(stepCents)}.`);

    const ready = problems.length === 0;
    const costCents = ready ? stakeCents * combos : null;
    let call = null;
    if (ready) {
      const base = tellerCall(d.betType, [raceNumber], stakeCents, legs);
      const paren = [d.odds.trim(), d.rationale.trim()].filter(Boolean).join(' ');
      call = paren ? `${base} (${paren})` : base;
    }
    // The repeat-drop is the arithmetic people get wrong at the window, so
    // name it rather than just showing a smaller number.
    const raw = filled && !spec.box ? legs.reduce((a, l) => a * l.length, 1) : combos;
    const dropped = raw - combos;
    return { combos, costCents, call, problems, ready, minCents, stepCents, dropped, raw };
  }), [drafts, menu, raceNumber]);

  const draftCalls = derived.filter((x) => x.ready).map((x) => x.call);
  const savedCalls = saved.map((s) => s.call);
  const allCalls = [...savedCalls, ...draftCalls];
  const text = allCalls.join(' / ');
  const totalCents = derived.filter((x) => x.ready).reduce((a, x) => a + x.costCents, 0) +
    saved.reduce((a, s) => a + s.costCents, 0);

  // Push the composed string up whenever it changes. The parent owns it.
  const lastSent = React.useRef(null);
  React.useEffect(() => {
    if (lastSent.current !== text) { lastSent.current = text; onChange(text); }
  }, [text, onChange]);

  const update = (id, patch) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const togglePgm = (id, posIndex, pgm, single) => setDrafts((ds) => ds.map((d) => {
    if (d.id !== id) return d;
    const positions = d.positions.map((p, i) => {
      if (i !== posIndex) return p;
      if (single) return p.includes(pgm) ? [] : [pgm];
      return p.includes(pgm) ? p.filter((x) => x !== pgm) : [...p, pgm];
    });
    return { ...d, positions };
  }));
  const setPosition = (id, posIndex, next) => setDrafts((ds) => ds.map((d) => (
    d.id === id ? { ...d, positions: d.positions.map((p, i) => (i === posIndex ? next : p)) } : d
  )));

  const handleSaveTicket = (id) => {
    const draftIndex = drafts.findIndex((d) => d.id === id);
    if (draftIndex === -1) return;
    const draft = drafts[draftIndex];
    const x = derived[draftIndex];
    if (!x.ready) return;

    setSaved((ss) => [...ss, { ...draft, call: x.call, costCents: x.costCents }]);
    setDrafts((ds) => [emptyDraft()]);
  };

  return (
    <div className="tb">
      {drafts.map((d, di) => {
        const spec = SPEC[d.betType];
        const x = derived[di];
        const single = spec.positions === 1 && !spec.box;
        const assumed = spec.menuKey !== 'win' && !offered.has(spec.menuKey);
        return (
          <div className="tb-row" key={d.id}>
            <div className="tb-row__head">
              <label>
                Bet type
                <select className="in in--sm" value={d.betType} disabled={disabled}
                  onChange={(e) => setDrafts((ds) => ds.map((y) => (y.id === d.id ? reshape(y, e.target.value) : y)))}>
                  {BET_TYPES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </select>
              </label>
              <label>
                {spec.box || spec.positions > 1 ? '$ per combo' : 'Stake'}
                <input className="in in--xs" value={d.stake} disabled={disabled} placeholder={money(x.minCents)}
                  onChange={(e) => update(d.id, { stake: e.target.value })} />
              </label>
              <span className="dim tb-min">
                min {money(x.minCents)}{x.stepCents !== x.minCents ? `, in ${money(x.stepCents)} steps` : ''}
                {assumed ? ' (assumed — not on this race’s menu)' : ''}
              </span>
              <label>
                Odds
                <input className="in in--xs" value={d.odds} disabled={disabled} placeholder="9/2"
                  onChange={(e) => update(d.id, { odds: e.target.value })} />
              </label>
              <label className="tb-why">
                Why
                <input className="in in--sm" value={d.rationale} disabled={disabled} placeholder="optional"
                  onChange={(e) => update(d.id, { rationale: e.target.value })} />
              </label>
              <button type="button" className="btn btn--sm btn--primary" disabled={disabled || !x.ready}
                onClick={() => handleSaveTicket(d.id)}>Save</button>
              <button type="button" className="btn btn--sm btn--danger" disabled={disabled || drafts.length === 1}
                onClick={() => setDrafts((ds) => ds.filter((y) => y.id !== d.id))}>Remove</button>
            </div>

            {spec.box ? (
              <div className="tb-pos">
                <div className="tb-pos__label">Box — any order</div>
                <HorseStrip entries={entries} selected={d.positions[0]}
                  onToggle={(p) => togglePgm(d.id, 0, p, false)}
                  onAll={() => setPosition(d.id, 0, live.map((e) => e.programNumber))}
                  onClear={() => setPosition(d.id, 0, [])} />
              </div>
            ) : d.positions.map((sel, pi) => (
              <div className="tb-pos" key={pi}>
                <div className="tb-pos__label">{single ? 'Horse' : ORDINAL[pi]}</div>
                <HorseStrip entries={entries} selected={sel} single={single}
                  onToggle={(p) => togglePgm(d.id, pi, p, single)}
                  onAll={() => setPosition(d.id, pi, live.map((e) => e.programNumber))}
                  onClear={() => setPosition(d.id, pi, [])} />
              </div>
            ))}

            <div className="tb-derive">
              {x.ready ? (
                <>
                  <code className="teller">{x.call}</code>
                  <span className="dim">
                    {' '}— {x.combos} combo{x.combos === 1 ? '' : 's'}
                    {x.dropped > 0 && ` (${x.raw} − ${x.dropped} impossible repeat${x.dropped === 1 ? '' : 's'})`}
                    {' '}× {money(toCents(d.stake))} = <strong>{money(x.costCents)}</strong>
                  </span>
                </>
              ) : (
                <span className="dim">{x.problems.join(' ')}</span>
              )}
            </div>
          </div>
        );
      })}

      <div className="formrow formrow--tight">
        <button type="button" className="btn btn--sm" disabled={disabled}
          onClick={() => setDrafts((ds) => [...ds, emptyDraft()])}>+ Add ticket</button>
        <span className="dim">
          {allCalls.length} ticket{allCalls.length === 1 ? '' : 's'} · race total <strong>{money(totalCents)}</strong>
        </span>
      </div>

      {saved.length > 0 && (
        <div className="tb-saved">
          <div className="dim">Saved tickets:</div>
          {saved.map((s, i) => (
            <div key={i} className="tb-saved-item">
              <code className="teller">{s.call}</code>
              <span className="dim"> · {money(s.costCents)}</span>
              <button type="button" className="linkish" disabled={disabled}
                onClick={() => setSaved((ss) => ss.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
