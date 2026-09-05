// Replay (D55): a human plays a stored race day blind, race by race, and
// is compared against lean on the same day. Builds entirely on D54's
// human-cards mechanics (server/human-cards.js) - this router adds the
// day picker, the blind per-race read view, reveal, close, and the
// cross-day standing table. It never constructs or persists a human
// ticket itself: the paste/lock/pass flow calls D54's existing
// POST /human-cards/preview and POST /human-cards directly.

import express from 'express';
import { buildConsensusTable, classifyRace, contrarianFlags } from '../shared/classification.js';
import { gradeCard } from '../shared/grading.js';
import { computeBlindness, isCardClosed, maxDrawdown, pickerAgreement } from '../shared/replay.js';
import { getDb } from './db.js';
import { loadDayResultsFor } from './grading.js';
import { getLogger, newCorrelationId } from './logging.js';
import { scratchedProgramNumbersFor } from './human-cards.js';

const traceLog = getLogger('decision-trace');

export const replayRouter = express.Router();

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function humanCards(db, { meet } = {}) {
  const rows = db.prepare(`
    SELECT c.*, rd.meet, rd.date, rd.track, rd.deleted_at
    FROM cards c
    JOIN strategy_templates st ON st.id = c.strategy_template_id
    JOIN race_days rd ON rd.id = c.race_day_id
    WHERE st.name = 'human' AND rd.deleted_at IS NULL
    ORDER BY c.card_number
  `).all();
  return meet && meet !== 'all' ? rows.filter((r) => r.meet === meet) : rows;
}

function raceNumbersFor(db, raceDayId) {
  return db.prepare('SELECT number FROM races WHERE race_day_id = ? ORDER BY number').all(raceDayId).map((r) => r.number);
}

function stateRows(db, cardId) {
  return db.prepare('SELECT race_number, picks_locked_at, results_revealed_at, passed FROM human_race_state WHERE card_id = ?').all(cardId);
}

function latestLeanCard(db, raceDayId) {
  return db.prepare(`
    SELECT c.* FROM cards c JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.race_day_id = ? AND st.name = 'lean' ORDER BY c.card_number DESC LIMIT 1
  `).get(raceDayId);
}

function cardTotals(db, cardId) {
  return db.prepare(`
    SELECT COALESCE(SUM(t.cost_cents), 0) AS cost, COALESCE(SUM(gt.returned_cents), 0) AS returned,
           COALESCE(SUM(gt.pl_cents), 0) AS pl, COALESCE(SUM(CASE WHEN gt.outcome = 'win' THEN 1 ELSE 0 END), 0) AS wins,
           COUNT(gt.ticket_id) AS tickets
    FROM tickets t LEFT JOIN graded_tickets_latest gt ON gt.ticket_id = t.id
    WHERE t.card_id = ?
  `).get(cardId);
}

const roiOf = (plCents, denomCents) => (denomCents > 0 ? plCents / denomCents : null);

/** Blindness + closed + human/lean totals for one human card. Read-only. */
function buildSummary(db, card) {
  const raceNumbers = raceNumbersFor(db, card.race_day_id);
  const states = stateRows(db, card.id);
  const closed = isCardClosed({
    raceNumbers,
    raceStates: states.map((s) => ({ raceNumber: s.race_number, passed: s.passed, resultsRevealedAt: s.results_revealed_at })),
  });
  const firstHumanCardNumber = db.prepare(`
    SELECT MIN(c.card_number) AS n FROM cards c JOIN strategy_templates st ON st.id = c.strategy_template_id
    WHERE c.race_day_id = ? AND st.name = 'human'
  `).get(card.race_day_id).n;
  const blindness = computeBlindness({
    locks: states.map((s) => s.picks_locked_at),
    reveals: states.filter((s) => s.results_revealed_at).map((s) => s.results_revealed_at),
    isFirstHumanCardOfDay: card.card_number === firstHumanCardNumber,
  });

  const humanTotals = cardTotals(db, card.id);
  const leanCard = latestLeanCard(db, card.race_day_id);
  const leanTotals = leanCard ? cardTotals(db, leanCard.id) : null;

  return {
    cardId: card.id, raceDayId: card.race_day_id, closed, blindness, sawClassification: Boolean(card.saw_classification),
    // D86: whether ANY race on this card has been revealed. The builder's
    // edit affordance keys on it - re-locking re-stamps picks_locked_at, and
    // computeBlindness compares max-lock vs min-reveal, so an edit after any
    // reveal silently flips the card PRE_COMMIT -> SEQUENTIAL and re-buckets it
    // in the standing table. Invariant 15 says blindness is derived, never
    // hand-set; a UI click should not be able to quietly degrade it. Leaks
    // nothing about outcomes - only that a reveal happened.
    anyRevealed: states.some((s) => s.results_revealed_at != null),
    human: {
      wageredCents: humanTotals.cost, returnedCents: humanTotals.returned, plCents: humanTotals.pl,
      roiOnWageredPct: roiOf(humanTotals.pl, humanTotals.cost), roiOnBankrollPct: roiOf(humanTotals.pl, card.bankroll_cents),
      hits: humanTotals.wins, tickets: humanTotals.tickets,
    },
    lean: leanCard ? {
      cardId: leanCard.id, wageredCents: leanTotals.cost, returnedCents: leanTotals.returned, plCents: leanTotals.pl,
      roiOnWageredPct: roiOf(leanTotals.pl, leanTotals.cost), hits: leanTotals.wins, tickets: leanTotals.tickets,
    } : null,
  };
}

// ---------- day picker ----------

replayRouter.get('/replay/days', (req, res) => {
  const db = getDb();
  const days = db.prepare(`
    SELECT rd.id, rd.track, rd.date, rd.meet, rd.replayed_at AS replayedAt,
           (SELECT COUNT(*) FROM races r WHERE r.race_day_id = rd.id) AS raceCount
    FROM race_days rd
    WHERE rd.deleted_at IS NULL AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_day_id = rd.id)
    ORDER BY rd.date DESC, rd.track
  `).all();
  res.json({ days });
});

replayRouter.get('/replay/random', (req, res) => {
  const db = getDb();
  const candidates = db.prepare(`
    SELECT rd.id, rd.track, rd.date, rd.meet,
           (SELECT COUNT(*) FROM races r WHERE r.race_day_id = rd.id) AS raceCount
    FROM race_days rd
    WHERE rd.deleted_at IS NULL AND rd.replayed_at IS NULL
      AND EXISTS (SELECT 1 FROM race_results rr WHERE rr.race_day_id = rd.id)
  `).all();
  if (!candidates.length) return res.status(404).json({ error: 'No unplayed days.' });
  res.json(candidates[Math.floor(Math.random() * candidates.length)]);
});

/** The results-revealed payload for one race on one card: finish order,
 * payoffs, both sides graded and allocated. Shared by the reveal POST and
 * the blind GET view once a race's results_revealed_at is already set -
 * navigating back to a revealed race must not hide what reveal showed. */
function revealedPayload(db, card, race, raceNumber) {
  const finishOrder = db.prepare('SELECT * FROM race_results WHERE race_day_id = ? AND race_number = ? ORDER BY finish_position').all(card.race_day_id, raceNumber);
  const payoffs = db.prepare('SELECT * FROM exotic_payoffs WHERE race_day_id = ? AND race_number = ?').all(card.race_day_id, raceNumber);
  const dayResults = loadDayResultsFor(db, card.race_day_id);
  const gradeRaceFor = (targetCardId) => {
    const rows = db.prepare('SELECT * FROM tickets WHERE card_id = ? AND race_id = ? ORDER BY sequence').all(targetCardId, race.id);
    const tickets = rows.map((t) => {
      const sel = JSON.parse(t.selections);
      // gradeCard/gradeTicket only read betType/races/legs/stakeCents/costCents;
      // the display fields ride along untouched into each grade's `ticket`,
      // so the client can render the actual card (teller call, rationale)
      // beside its outcome without a second round trip.
      return {
        id: t.id, betType: t.bet_type, races: sel.races, legs: sel.legs, stakeCents: t.stake_cents, costCents: t.cost_cents,
        tellerCall: t.teller_call, rationaleText: t.rationale_text, oddsAtBet: t.odds_at_bet,
      };
    });
    return gradeCard(tickets, dayResults);
  };
  const allocationFor = (targetCardId) =>
    db.prepare('SELECT amount_cents FROM allocations WHERE card_id = ? AND race_id = ?').get(targetCardId, race.id)?.amount_cents ?? null;

  const human = gradeRaceFor(card.id);
  const leanCard = latestLeanCard(db, card.race_day_id);
  const lean = leanCard ? gradeRaceFor(leanCard.id) : null;

  return {
    finishOrder, payoffs,
    humanGraded: human.grades, humanRacePl: human.summary.plCents, humanAllocatedCents: allocationFor(card.id),
    leanGraded: lean ? lean.grades : null, leanRacePl: lean ? lean.summary.plCents : null,
    leanAllocatedCents: leanCard ? allocationFor(leanCard.id) : null,
  };
}

// ---------- day landing (D62): every race at a glance, PL once revealed ----------

replayRouter.get('/replay/days/:id/races', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });

  const races = db.prepare('SELECT * FROM races WHERE race_day_id = ? ORDER BY number').all(day.id);
  const cardId = req.query.cardId ? Number(req.query.cardId) : null;
  const card = cardId ? db.prepare('SELECT * FROM cards WHERE id = ? AND race_day_id = ?').get(cardId, day.id) : null;
  const states = card ? stateRows(db, card.id) : [];

  const out = races.map((race) => {
    const state = states.find((s) => s.race_number === race.number);
    const row = {
      raceNumber: race.number, distance: race.distance, surface: race.surface, raceType: race.race_type,
      locked: Boolean(state), pass: Boolean(state?.passed), revealed: Boolean(state?.results_revealed_at),
      humanRacePl: null, humanAllocatedCents: null, leanRacePl: null, leanAllocatedCents: null,
    };
    if (state?.results_revealed_at) {
      const revealed = revealedPayload(db, card, race, race.number);
      row.humanRacePl = revealed.humanRacePl;
      row.humanAllocatedCents = revealed.humanAllocatedCents;
      row.leanRacePl = revealed.leanRacePl;
      row.leanAllocatedCents = revealed.leanAllocatedCents;
    }
    return row;
  });

  res.json({ bankrollCents: day.bankroll_cents, perRaceMinCents: day.per_race_min_cents, races: out });
});

// ---------- the blind race view ----------

replayRouter.get('/replay/days/:id/races/:number', (req, res) => {
  const db = getDb();
  const day = db.prepare('SELECT * FROM race_days WHERE id = ?').get(Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  const raceNumber = Number(req.params.number);
  const race = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(day.id, raceNumber);
  if (!race) return res.status(404).json({ error: 'No such race.' });

  const entries = db.prepare('SELECT * FROM entries WHERE race_id = ? ORDER BY post_position, program_number').all(race.id);
  const scratchedPgms = scratchedProgramNumbersFor(db, day.id, race, entries);
  const picks = db.prepare(`
    SELECT cp.*, s.name AS source_name, s.kind AS source_kind
    FROM consensus_picks cp JOIN sources s ON s.id = cp.source_id
    WHERE cp.race_id = ?
  `).all(race.id);
  // Raw per-source picks only - NEVER classifyRace's derived call/flags,
  // which is the engine's own D09 read of the race and most of what lean
  // allocates on (unless this card opted into seeing it, below).
  const table = buildConsensusTable(entries, picks);

  const out = {
    raceNumber,
    entries: entries.map((e) => ({
      programNumber: e.program_number, horseName: e.horse_name, jockey: e.jockey, trainer: e.trainer,
      morningLine: e.morning_line, programRank: e.program_rank, bestBet: Boolean(e.best_bet),
      // D86: the SAME set shared/parsers/human-picks.js blocks on - program-time
      // scratches UNION the chart's - not just entries.scratched. A scratch is
      // known at the window, so this is not results information (no finish
      // order, no payoff), and withholding it made the ticket builder offer
      // horses the server would always refuse. Replay is only ever played on a
      // day that HAS results, so before this every chart scratch was invisible.
      scratched: scratchedPgms.has(e.program_number),
      scratchedOnProgram: Boolean(e.scratched),
    })),
    wagerMenu: race.wager_menu, postTime: race.post_time, distance: race.distance, surface: race.surface,
    raceType: race.race_type, conditions: race.conditions, bottomLineText: race.bottom_line ?? null,
    consensus: { table },
    bankrollCents: day.bankroll_cents, perRaceMinCents: day.per_race_min_cents,
    humanCardId: null, locked: false,
  };

  const cardId = req.query.cardId ? Number(req.query.cardId) : null;
  const card = cardId ? db.prepare('SELECT * FROM cards WHERE id = ? AND race_day_id = ?').get(cardId, day.id) : null;
  if (card) {
    out.humanCardId = card.id;
    out.runningCardCostCents = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) AS n FROM tickets WHERE card_id = ?').get(card.id).n;
    const state = db.prepare('SELECT * FROM human_race_state WHERE card_id = ? AND race_number = ?').get(card.id, raceNumber);
    out.locked = Boolean(state);
    if (state?.passed) out.pass = true;
    if (state && !state.passed) {
      out.tickets = db.prepare('SELECT * FROM tickets WHERE card_id = ? AND race_id = ? ORDER BY sequence').all(card.id, race.id)
        .map((t) => ({
          betType: t.bet_type, legs: JSON.parse(t.selections).legs, stakeCents: t.stake_cents, costCents: t.cost_cents,
          tellerCall: t.teller_call, rationaleText: t.rationale_text, oddsAtBet: t.odds_at_bet,
        }));
    }
    // Once revealed, re-navigating to this race must not hide what reveal
    // showed - the same payload, recomputed live (never stored/stale).
    if (state?.results_revealed_at) Object.assign(out, revealedPayload(db, card, race, raceNumber));
    if (card.saw_classification) {
      const cls = classifyRace(table);
      out.consensus.classification = cls.classification;
      out.consensus.topVotes = cls.topVotes;
      out.consensus.contrarianFlags = contrarianFlags(entries, picks);
    }
  }

  res.json(out);
});

replayRouter.post('/replay/cards/:cardId/reveal-classification', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  db.prepare('UPDATE cards SET saw_classification = 1 WHERE id = ?').run(card.id);
  res.json({ ok: true, sawClassification: true });
});

// ---------- reveal ----------

replayRouter.post('/replay/cards/:cardId/races/:number/reveal', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const raceNumber = Number(req.params.number);
  const race = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(card.race_day_id, raceNumber);
  if (!race) return res.status(404).json({ error: 'No such race.' });
  const state = db.prepare('SELECT * FROM human_race_state WHERE card_id = ? AND race_number = ?').get(card.id, raceNumber);
  if (!state) return res.status(409).json({ error: `Race ${raceNumber} has not been locked on this card yet.` });
  if (state.results_revealed_at) return res.status(409).json({ error: `Race ${raceNumber} was already revealed on this card.` });

  const ts = now();
  db.prepare('UPDATE human_race_state SET results_revealed_at = ? WHERE card_id = ? AND race_number = ?').run(ts, card.id, raceNumber);
  traceLog.info('human_race_revealed', { correlationId, cardId: card.id, raceDayId: card.race_day_id, race: raceNumber });

  res.json(revealedPayload(db, card, race, raceNumber));
});

// ---------- close ----------

replayRouter.post('/replay/cards/:cardId/close', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  const raceNumbers = raceNumbersFor(db, card.race_day_id);
  const ts = now(); // ONE timestamp for the whole call - a genuinely
  // pre-committed day (every real lock before any real reveal) must still
  // compute PRE_COMMIT after this cleanup, not SEQUENTIAL from its own
  // synthetic writes racing each other.
  const close = db.transaction(() => {
    for (const n of raceNumbers) {
      const state = db.prepare('SELECT * FROM human_race_state WHERE card_id = ? AND race_number = ?').get(card.id, n);
      if (!state) {
        db.prepare('INSERT INTO human_race_state (card_id, race_number, picks_locked_at, passed) VALUES (?, ?, ?, 1)').run(card.id, n, ts);
      } else if (!state.results_revealed_at) {
        db.prepare('UPDATE human_race_state SET results_revealed_at = ? WHERE card_id = ? AND race_number = ?').run(ts, card.id, n);
      }
    }
  });
  close();
  traceLog.info('human_card_closed', { correlationId: card.correlation_id, cardId: card.id, raceDayId: card.race_day_id });
  res.json(buildSummary(db, db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id)));
});

replayRouter.get('/replay/cards/:id/summary', (req, res) => {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(req.params.id));
  if (!card) return res.status(404).json({ error: 'No such card.' });
  res.json(buildSummary(db, card));
});

// ---------- standing ----------

replayRouter.get('/replay/standing', (req, res) => {
  const db = getDb();
  const meets = [...new Set(humanCards(db).map((c) => c.meet).filter(Boolean))].sort();
  const requestedMeet = String(req.query.meet ?? '').trim();
  const selectedMeet = requestedMeet && meets.includes(requestedMeet) ? requestedMeet : 'all';

  const rows = humanCards(db, { meet: selectedMeet })
    .map((card) => ({ card, date: card.date, ...buildSummary(db, card) }))
    .filter((r) => r.closed);

  const groupKey = (r) => `${r.blindness}::${r.sawClassification}`;
  const byGroup = new Map();
  for (const r of rows) {
    const key = groupKey(r);
    if (!byGroup.has(key)) byGroup.set(key, { blindness: r.blindness, sawClassification: r.sawClassification, rows: [] });
    byGroup.get(key).rows.push(r);
  }

  const groups = [...byGroup.values()].map((g) => {
    const ordered = [...g.rows].sort((a, b) => a.date.localeCompare(b.date));
    const sum = (side, key) => ordered.reduce((a, r) => a + (r[side] ? r[side][key] : 0), 0);
    const withLean = ordered.filter((r) => r.lean);
    const paired = { better: 0, worse: 0, tied: 0, days: withLean.length };
    for (const r of withLean) {
      const d = r.human.plCents - r.lean.plCents;
      if (d > 0) paired.better++; else if (d < 0) paired.worse++; else paired.tied++;
    }
    const series = ordered.map((r) => ({ date: r.date, plCents: r.human.plCents }));
    return {
      blindness: g.blindness, sawClassification: g.sawClassification, days: ordered.length,
      human: {
        wageredCents: sum('human', 'wageredCents'), returnedCents: sum('human', 'returnedCents'), plCents: sum('human', 'plCents'),
        roiOnWageredPct: roiOf(sum('human', 'plCents'), sum('human', 'wageredCents')),
        roiOnBankrollPct: roiOf(sum('human', 'plCents'), ordered.reduce((a, r) => a + r.card.bankroll_cents, 0)),
        hits: sum('human', 'hits'), maxDrawdown: maxDrawdown(series),
      },
      lean: withLean.length ? {
        wageredCents: sum('lean', 'wageredCents'), returnedCents: sum('lean', 'returnedCents'), plCents: sum('lean', 'plCents'),
        roiOnWageredPct: roiOf(sum('lean', 'plCents'), sum('lean', 'wageredCents')), hits: sum('lean', 'hits'),
      } : null,
      paired,
    };
  }).sort((a, b) => (a.blindness ?? '').localeCompare(b.blindness ?? '') || Number(a.sawClassification) - Number(b.sawClassification));

  // Picker agreement across every played race in the closed, in-scope cards.
  const pickerRows = [];
  for (const r of rows) {
    const raceNumbers = raceNumbersFor(db, r.card.race_day_id);
    const dayResults = loadDayResultsFor(db, r.card.race_day_id);
    const states = stateRows(db, r.card.id);
    for (const n of raceNumbers) {
      const state = states.find((s) => s.race_number === n);
      if (!state || state.passed || !dayResults) continue;
      const race = db.prepare('SELECT * FROM races WHERE race_day_id = ? AND number = ?').get(r.card.race_day_id, n);
      const winTickets = db.prepare(`SELECT selections, stake_cents FROM tickets WHERE card_id = ? AND race_id = ? AND bet_type = 'win'`)
        .all(r.card.id, race.id).map((t) => ({ programNumber: JSON.parse(t.selections).legs[0][0], stakeCents: t.stake_cents }));
      const rank1 = db.prepare('SELECT program_number FROM entries WHERE race_id = ? AND program_rank = 1 AND scratched = 0').get(race.id);
      // The external consensus the human is measured against. Was pinned to
      // one source by name (SFTB, removed in D82); now it is whichever
      // EXTERNAL source the day actually has a top pick from - At The Races,
      // Equibase OTR, or a manual paste. Program-kind sources are excluded:
      // the program is already the other side of this comparison, via
      // program_rank 1, and counting it twice would inflate agreement.
      // Lowest source id wins when a race has several, so the answer is
      // stable across runs rather than depending on row order.
      const externalTop = db.prepare(`
        SELECT cp.program_number FROM consensus_picks cp JOIN sources s ON s.id = cp.source_id
        WHERE cp.race_id = ? AND cp.pick_type = 'top' AND s.kind != 'program'
        ORDER BY s.id LIMIT 1
      `).get(race.id);
      const grade1 = (pgm) => {
        if (!pgm) return null;
        const { grades } = gradeCard([{ id: -1, betType: 'win', races: [n], legs: [[pgm]], stakeCents: 200, costCents: 200 }], dayResults);
        return { outcome: grades[0].outcome, returnedCents: grades[0].returnedCents };
      };
      const maxStake = winTickets.length ? Math.max(...winTickets.map((w) => w.stakeCents)) : null;
      const top = winTickets.filter((w) => w.stakeCents === maxStake);
      pickerRows.push({
        race: n, humanWinTickets: winTickets,
        programRank1Pgm: rank1?.program_number ?? null, externalTopPgm: externalTop?.program_number ?? null,
        humanTopGraded: top.length === 1 ? grade1(top[0].programNumber) : null,
        programTopGraded: grade1(rank1?.program_number ?? null),
      });
    }
  }

  res.json({ meets, selectedMeet, groups, pickerAgreement: pickerAgreement(pickerRows) });
});
