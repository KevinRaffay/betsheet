import React, { useEffect, useState } from 'react';
import { FAILURE_MODE_WARNINGS } from '@shared/card-notices.js';
import { deleteCard, getCard, getGrades, getLlmNotes, gradeCardApi, modelLabel } from '../api.js';
import RaceNotes from './RaceNotes.jsx';
import EntryFlagTags from './EntryFlagTags.jsx';
import { flagRaceEntries } from '@shared/entry-flags.js';

const RESPONSIBLE_LINE =
  'Entertainment wagering with a pre-committed budget. No mid-card increases.';

const money = (cents) => (cents == null ? '—'
  : cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// D224: the win probability a morning line implies, 0-1 -> a percent string.
const pct = (p) => (p == null ? '—' : `${(p * 100).toFixed(0)}%`);

const estDisplay = (t) => {
  if (t.est_payout_min_cents == null) return '—';
  if (!t.est_is_range) return money(t.est_payout_min_cents);
  return `${money(t.est_payout_min_cents)}–${money(t.est_payout_max_cents)} (est.)`;
};

const splitThesis = (text) => {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  return {
    thesis: lines.filter((l) => !l.startsWith('TRIGGER:')).join(' '),
    triggers: lines.filter((l) => l.startsWith('TRIGGER:')).map((l) => l.slice(8).trim()),
  };
};

// The betting card - the sheet itself. One table per race:
// Bet Type | Selections / Rationale | Say to the teller | If it hits | Cost.
//
// `embedded` (D95) drops the pagehead - the title line and the Export /
// Grade / Delete / Back row - so the sheet can be mounted inside another
// view that owns its own header and navigation. Nothing else changes: the
// embedded sheet is the same component reading the same two endpoints, which
// is the point (a second renderer would be a second copy of the money,
// subtotal and grade-join logic, free to drift from the real card page).
// Delete in particular has no business firing from a page whose subject is a
// race day rather than this card.
export default function CardView({ cardId, onBack, onDeleted, embedded = false }) {
  const [card, setCard] = useState(null);
  const [gradeData, setGradeData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Which races are collapsed. Open is the default: the sheet is read for its
  // tickets, so a race hides only when the reader asks. Held as the collapsed
  // set rather than the open one so a race that appears later (a reload after
  // a regrade) is open without having to be added anywhere.
  const [collapsedRaces, setCollapsedRaces] = useState(() => new Set());
  // Read-only, same data RaceDayView.jsx's per-race panel shows (D164) - the
  // analyst notes entered via "Enter Analyst Notes" or the LLM generator's
  // own notes fields (same `llm_notes` draft, D92), keyed by race number.
  const [notesByRace, setNotesByRace] = useState(new Map());

  useEffect(() => {
    getCard(cardId).then(setCard).catch((e) => setError(String(e.message)));
    getGrades(cardId).then(setGradeData).catch(() => setGradeData(null));
  }, [cardId]);

  useEffect(() => {
    if (card?.race_day_id == null) return;
    getLlmNotes(card.race_day_id)
      .then((n) => setNotesByRace(new Map(Object.entries(n.byRace ?? {}).map(([k, v]) => [Number(k), v]))))
      .catch(() => {}); // supplementary display only - a fetch failure here shouldn't block the sheet
  }, [card?.race_day_id]);

  const handleGrade = async () => {
    setBusy(true);
    setError(null);
    try {
      await gradeCardApi(cardId);
      setGradeData(await getGrades(cardId));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Permanently delete this card and all of its tickets, grades, and related records?')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCard(cardId);
      onDeleted();
    } catch (e) {
      setError(String(e.message));
      setBusy(false);
    }
  };

  if (error && !card) return <p className="notice notice--error">{error}</p>;
  if (!card) return <p className="placeholder">Loading…</p>;

  const gradeByTicket = new Map((gradeData?.grades ?? []).map((g) => [g.ticket_id, g]));
  const graded = gradeByTicket.size > 0;

  const summary = graded ? gradeData.summary : null;

  const singles = card.tickets.filter((t) => t.race_id != null);
  const multis = card.tickets.filter((t) => t.race_id == null);
  const total = card.tickets.reduce((a, t) => a + t.cost_cents, 0);
  const remaining = card.bankroll_cents - total;
  const allTriggers = card.allocations.flatMap((a) => {
    const { triggers } = splitThesis(a.thesis);
    return triggers.map((t) => ({ race: a.race_number, text: t }));
  });

  // Results grouped per race, keyed only where a finisher landed - a race with
  // no result gets no entry, so the sheet shows the panel exactly on the races
  // that have one. Same grouping ResultsPanel.jsx does for the day view.
  const resultsByRace = new Map();
  for (const r of card.results?.finishers ?? []) {
    if (!resultsByRace.has(r.race_number)) {
      resultsByRace.set(r.race_number, { finishers: [], exotics: [], scratches: [] });
    }
    resultsByRace.get(r.race_number).finishers.push(r);
  }
  for (const x of card.results?.exotics ?? []) resultsByRace.get(x.race_number)?.exotics.push(x);
  for (const s of card.results?.scratches ?? []) resultsByRace.get(s.race_number)?.scratches.push(s);

  return (
    <section className="card-sheet">
      {!embedded && (
        <div className="pagehead">
          <h2>
            {card.track} — {card.date} · card #{card.card_number}
            {card.variant !== 'default' ? ` (${card.variant})` : ''}
            {card.name ? ` — “${card.name}”` : ''}
          </h2>
          <div className="btnrow">
            <a className="btn" href={`/api/cards/${cardId}/export`}>Export JSON</a>
            <button className="btn" onClick={handleGrade} disabled={busy}>
              {graded ? 'Regrade vs results' : 'Grade vs results'}
            </button>
            <button className="btn btn--danger" onClick={handleDelete} disabled={busy}>
              Delete card
            </button>
            <button className="btn" onClick={onBack}>Back</button>
          </div>
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      <p className="dim">
        <span className={`chip chip--${card.consensus_completeness === 'FULL' ? 'unanimous' : card.consensus_completeness === 'PARTIAL' ? 'split' : card.consensus_completeness === 'HUMAN' ? 'human' : card.consensus_completeness === 'LLM_GENERATED' ? 'llm' : 'chaos'}`}>
          {card.consensus_completeness}
        </span>
        {' '}· template {card.template ?? '—'} · engine <code>{card.engine_version ?? 'lean-0'}</code>
        {card.llm_model && <> · model <code>{modelLabel(card.llm_model)}</code></>}{card.notes_present ? <> · <span className="tag tag--gold">analyst notes</span></> : null} · bankroll {money(card.bankroll_cents)}
        {' '}· per-race min {money(card.per_race_min_cents)} · generated {card.created_at}
      </p>

      {remaining < 0 && (
        <p className="notice notice--warn">
          Tickets exceed the bankroll by {money(-remaining)}. The card stands — but that is house money you have not won yet.
        </p>
      )}

      <div className="race race--sheet card-footer">
        <p>
          <strong>Day total {money(total)}</strong> · {card.tickets.length} tickets
          · bankroll {money(card.bankroll_cents)}
          · {remaining >= 0 ? `${money(remaining)} unspent` : `${money(-remaining)} OVER`}
        </p>
        {summary && (
          <p>
            <strong>Graded:</strong> returned {money(summary.returnedCents)} on {money(summary.costCents)} wagered
            {' '}· <strong className={summary.plCents >= 0 ? 'pl--pos' : 'pl--neg'}>
              {summary.plCents >= 0 ? '+' : '−'}{money(Math.abs(summary.plCents))}
            </strong>
          </p>
        )}
        <p className="dim">
          Sources used: {card.sources.used.length
            ? card.sources.used.map((s) => `${s.name} (${s.ts?.slice(0, 10) ?? '—'})`).join(', ')
            : 'program analysis and morning lines only'}
          {card.sources.unavailable.length > 0 && (
            <> · Unavailable: {card.sources.unavailable.map((s) => s.name).join(', ')}</>
          )}
        </p>
        {card.scratches.length > 0 && (
          <p className="dim">
            Scratches: {card.scratches.map((s) => `R${s.race_number} #${s.program_number ?? '?'} ${s.horse_name}`).join(' · ')}
          </p>
        )}
        {allTriggers.length > 0 && (
          <>
            <p><strong>Board watch</strong></p>
            {allTriggers.map((t, i) => <p className="trigger" key={i}>• R{t.race}: {t.text}</p>)}
          </>
        )}
      </div>

      {card.allocations.length > 1 && (
        <div className="btnrow btnrow--collapse">
          <button className="btn btn--sm" onClick={() => setCollapsedRaces(new Set())}>
            Expand all races
          </button>
          <button
            className="btn btn--sm"
            onClick={() => setCollapsedRaces(new Set(card.allocations.map((x) => x.race_number)))}
          >
            Collapse all races
          </button>
        </div>
      )}

      {card.allocations.map((a) => {
        const race = (card.races ?? []).find((r) => r.number === a.race_number);
        const entries = race?.entries ?? [];
        // D216: the card sheet is a RECORD, not an authoring surface (D184),
        // so this is decoration only - but it is decoration that answers "why
        // is this ticket here?" when reviewing a card weeks later, and it is
        // derived from the same stored entries the flags were read off at the
        // time. Leaving it off here would make the same horse look flagged on
        // one screen and unflagged on another.
        const { flags: entryFlags } = flagRaceEntries(entries);
        const raceResults = resultsByRace.get(a.race_number);
        const raceTickets = singles.filter((t) => {
          const races = t.selections.races ?? [];
          return races.length === 1 && races[0] === a.race_number;
        });
        const subtotal = raceTickets.reduce((s, t) => s + t.cost_cents, 0);
        const { thesis, triggers } = splitThesis(a.thesis);
        const flags = a.contrarian_flags ? JSON.parse(a.contrarian_flags) : [];
        return (
          <details
            className="race race--sheet"
            key={a.race_number}
            open={!collapsedRaces.has(a.race_number)}
            onToggle={(e) => {
              // `toggle` does not bubble, but a nested <details> (Entries,
              // Bottom Line, Results) must never be mistaken for this one.
              if (e.target !== e.currentTarget) return;
              const isOpen = e.currentTarget.open;
              setCollapsedRaces((prev) => {
                const next = new Set(prev);
                if (isOpen) next.delete(a.race_number);
                else next.add(a.race_number);
                return next;
              });
            }}
          >
            <summary>
              <span className="race-sheet-head">
                <strong>Race {a.race_number}</strong>
                {/* The D09 classification chip. Nothing writes races.classification
                    since D112 removed consensus, so this renders for HISTORICAL
                    races only - a stored value stays visible on the card it was
                    computed for, and a race that never had one shows no chip
                    rather than an em dash styled as if it were a CHAOS call. */}
                {a.classification && (
                  <span className={`chip chip--${a.classification.toLowerCase()}`}>{a.classification}</span>
                )}
                <span className="dim">
                  post {a.post_time ?? '?'} · {a.surface ?? '?'} · {a.distance ?? '?'} · {a.race_type ?? '?'}
                </span>
                <span className="race-alloc">
                  {money(a.amount_cents)} allocated · {money(subtotal)} spent
                  {raceTickets.length > 0 && <span className="dim"> · {raceTickets.length} tickets</span>}
                </span>
              </span>
            </summary>
            {thesis && <p className="thesis">{thesis}</p>}
            {triggers.map((t, i) => <p className="trigger" key={i}>• {t}</p>)}
            {flags.map((f, i) => (
              <p className="trigger" key={`f${i}`}>
                • {f.type === 'algo_fades_favorite' ? 'FADE' : 'LONGSHOT×2'}: #{f.programNumber} {f.horseName} — {f.detail}
              </p>
            ))}
            {race?.bottom_line && (
              <details className="race-bottom-line">
                <summary>Del Mar Bottom Line</summary>
                <p>{race.bottom_line}</p>
              </details>
            )}
            <details className="race-entries">
              <summary>Entries ({entries.length})</summary>
              <table className="grid grid--entries">
                <thead>
                  <tr><th>#</th><th>Horse</th><th>Jockey</th><th>Trainer</th><th>M/L</th>
                    <th title="What $2-to-win pays if this horse wins - the printed line as a forecast, not the actual tote price">$2 win</th>
                    <th title="The win probability the morning line implies (1 / (odds + 1)); a full field sums well over 100% because of the track's own take">Win %</th>
                    <th title="Predicted order of finish from the morning line (1 = shortest line; ties share a rank)">ML rank</th></tr>
                </thead>
                <tbody>
                  {entries.map((entry, ei) => (
                    <tr
                      key={entry.id}
                      className={[entry.scratched ? 'row--scratched' : '',
                        (entryFlags[ei]?.baffert || entryFlags[ei]?.favorite) ? 'row--entry-flag' : ''].filter(Boolean).join(' ')}
                    >
                      <td>{entry.program_number ?? '—'}</td>
                      <td>{entry.horse_name}<EntryFlagTags flag={entryFlags[ei]} /></td>
                      <td>{entry.jockey ?? '—'}</td>
                      <td>{entry.trainer ?? '—'}</td>
                      <td>{entry.morning_line ?? '—'}</td>
                      <td className="dim">{entryFlags[ei]?.mlPayoutCents != null ? money(entryFlags[ei].mlPayoutCents) : '—'}</td>
                      <td className="dim">{pct(entryFlags[ei]?.mlWinProbability)}</td>
                      <td>{entryFlags[ei]?.mlRank ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <RaceNotes note={notesByRace.get(a.race_number) ?? null} />
            {raceResults && <RaceResults d={raceResults} />}
            {raceTickets.length === 0
              ? <p className="dim">No tickets this race.</p>
              : (
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Bet type</th><th>Selections / rationale</th>
                      <th>Say to the teller</th><th>If it hits</th><th>Cost</th>
                      {graded && <><th>Result</th><th>P/L</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {raceTickets.map((t) => (
                      <TicketRow key={t.id} t={t} g={gradeByTicket.get(t.id)} graded={graded} />
                    ))}
                    <tr className="row--subtotal">
                      <td colSpan={4}>Race {a.race_number} subtotal</td>
                      <td>{money(subtotal)}</td>
                      {graded && <GradeSubtotal tickets={raceTickets} gradeByTicket={gradeByTicket} />}
                    </tr>
                  </tbody>
                </table>
              )}
          </details>
        );
      })}

      {multis.length > 0 && (
        <div className="race race--sheet">
          <div className="race-sheet-head"><strong>Multi-race tickets</strong></div>
          <table className="grid">
            <thead>
              <tr>
                <th>Bet type</th><th>Selections / rationale</th>
                <th>Say to the teller</th><th>If it hits</th><th>Cost</th>
                {graded && <><th>Result</th><th>P/L</th></>}
              </tr>
            </thead>
            <tbody>
              {multis.map((t) => (
                <TicketRow key={t.id} t={t} g={gradeByTicket.get(t.id)} graded={graded} />
              ))}
              <tr className="row--subtotal">
                <td colSpan={4}>Multi-race subtotal</td>
                <td>{money(multis.reduce((s, t) => s + t.cost_cents, 0))}</td>
                {graded && <GradeSubtotal tickets={multis} gradeByTicket={gradeByTicket} />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="notice notice--warn">
        <ul>{FAILURE_MODE_WARNINGS.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </div>
      <p className="responsible">{RESPONSIBLE_LINE}</p>
    </section>
  );
}

/**
 * One race's official result, below its entries. Collapsed by default, like
 * the Entries and Bottom Line panels it sits with - the sheet is read for the
 * tickets, and an expanded result on every race would bury them.
 *
 * The full finish order, not just the top three: the day view already shows
 * the WPS placings, and what the sheet is read for afterwards is why a ticket
 * missed, which usually means finding a horse that ran 4th or 6th.
 */
function RaceResults({ d }) {
  const winner = d.finishers.find((f) => f.finish_position === 1) ?? d.finishers[0];
  return (
    <details className="race-results">
      <summary>
        Results ({d.finishers.length} finishers)
        {winner && (
          <span className="dim">
            {' '}· won by {winner.program_number != null ? `#${winner.program_number} ` : ''}{winner.horse_name}
          </span>
        )}
      </summary>
      <table className="grid grid--results">
        <thead>
          <tr><th>Fin</th><th>#</th><th>Horse</th><th>Win</th><th>Place</th><th>Show</th></tr>
        </thead>
        <tbody>
          {d.finishers.map((f) => (
            <tr key={f.id}>
              <td>{f.finish_position}</td>
              <td>{f.program_number ?? '—'}</td>
              <td>{f.horse_name}</td>
              {/* A price is only printed for a horse that finished in the
                  money, and only for pools that actually paid - an unhit or
                  absent pool is a dash, never a zero. */}
              <td>{f.win_cents != null ? money(f.win_cents) : '—'}</td>
              <td>{f.place_cents != null ? money(f.place_cents) : '—'}</td>
              <td>{f.show_cents != null ? money(f.show_cents) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.exotics.length > 0 && (
        <p className="dim result-payoffs">
          {d.exotics.map((x) => `${x.bet_type.replace(/_/g, ' ')} ${x.combination} ${money(x.payout_cents)}`).join(' · ')}
        </p>
      )}
      {d.scratches.length > 0 && (
        <p className="dim result-payoffs">
          Scratched: {d.scratches.map((s) => `${s.program_number != null ? `#${s.program_number} ` : ''}${s.horse_name}`).join(', ')}
        </p>
      )}
    </details>
  );
}

function TicketRow({ t, g, graded }) {
  return (
    <tr>
      <td className="bt">{t.bet_type.replace(/_/g, ' ')}</td>
      <td>
        {t.selections.legs.map((l) => l.join(',')).join(' / ')}
        {t.rationale ? <span className="dim"> — {t.rationale}</span> : null}
      </td>
      <td className="teller">{t.teller_call}</td>
      <td>{estDisplay(t)}</td>
      <td>{money(t.cost_cents)}</td>
      {graded && (g
        ? (
          <>
            <td>
              <span className={`outcome outcome--${g.outcome}`}>{g.outcome.toUpperCase()}</span>
              {g.outcome !== 'loss' && <span className="dim"> {money(g.returned_cents)}</span>}
              {g.details?.note ? <span className="dim"> — {g.details.note}</span> : null}
            </td>
            <td className={g.pl_cents >= 0 ? 'pl--pos' : 'pl--neg'}>
              {g.pl_cents >= 0 ? '+' : '−'}{money(Math.abs(g.pl_cents))}
            </td>
          </>
        )
        : <><td className="dim">—</td><td className="dim">—</td></>)}
    </tr>
  );
}

function GradeSubtotal({ tickets, gradeByTicket }) {
  const gs = tickets.map((t) => gradeByTicket.get(t.id)).filter(Boolean);
  const returned = gs.reduce((a, g) => a + g.returned_cents, 0);
  const pl = gs.reduce((a, g) => a + g.pl_cents, 0);
  return (
    <>
      <td>{money(returned)} back</td>
      <td className={pl >= 0 ? 'pl--pos' : 'pl--neg'}>{pl >= 0 ? '+' : '−'}{money(Math.abs(pl))}</td>
    </>
  );
}
