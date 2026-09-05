// Equibase "Off to the Races" PDF ingest (D71): the free at-track sheet
// becomes a card of its own - printed tickets taken VERBATIM, no
// interpretation, no re-sizing, in the new EQB_OTR bucket. This is a
// picker source only; it writes nothing to consensus_picks (that's a
// separate later PR, gated on a D09 three-source classification
// decision - see the DELIVERABLES.md ledger row for the intended
// mapping).
//
// D07 stands: no Equibase fetcher. The PDF is a manual download
// (equibase.com/EntriesPlus2/downloadOffToRaces.cfm), uploaded here as a
// raw `application/pdf` body - same convention as every other PDF upload
// in this codebase (server/ingest.js, server/consensus.js's atr-pdf
// route; the user's spec named "multipart", which doesn't exist anywhere
// in this codebase - substituted the real established equivalent, same
// deviation D69 made for the same reason). Archived under the D41
// manifest pattern (data/archive/equibase-otr/<TRK>/<date>.pdf, one
// manifest.json per track keyed by date) so the parser can always be
// re-run from the archive, never the network.
//
// Preview-then-confirm (invariant 9): the initial upload archives the
// file and parses it (unavoidable - the preview IS the parse), but
// PERSISTS NOTHING. It returns a `parseToken` = the archived file's own
// sha256. Confirm takes that token, re-reads the archived bytes (never
// trusts a client-shaped payload, same rule D54/D69 follow), verifies
// the hash still matches what's on disk (guards against a newer upload
// for the same day overwriting the archive between preview and confirm),
// re-parses fresh, and persists the three cards in one transaction.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { canonicalizeTrack } from '../shared/track-codes.js';
import { parseEquibaseOtrTsv } from '../shared/parsers/equibase-otr.js';
import { tellerCall, estimateTicketPayouts } from '../shared/betmath.js';
import { getDb } from './db.js';
import { loadRace } from './human-cards.js';
import { gradeAndPersist } from './grading.js';
import { templateIdFor } from './templates.js';
import { getLogger, newCorrelationId } from './logging.js';
import { upsertSource, resolvePicks, storePicks, classifyAndPersist, recordAttempt } from './consensus.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Overridable the same way BETSHEET_DB/BETSHEET_LOG_DIR are, so check
// scripts (and the QA/-alt instance) archive into an isolated directory
// rather than the real committed data/archive/equibase-otr/ tree - same
// isolation convention server/dmtc-crawler.js's rawDir parameter follows.
const ARCHIVE_DIR = process.env.BETSHEET_OTR_ARCHIVE_DIR || path.join(ROOT, 'data', 'archive', 'equibase-otr');
const TRACK_CODE = 'DMR'; // the only track this codebase ingests (CLAUDE.md architecture map)

const traceLog = getLogger('decision-trace');
const appLog = getLogger('app');

export const equibaseOtrRouter = express.Router();

class EquibaseOtrError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- pdftotext -tsv ----------

/**
 * The machine's default `pdftotext` may be xpdf (no -tsv support) rather
 * than Poppler - found live on this development machine, where `pdftotext`
 * on PATH resolves to xpdf 4.06 while Poppler 25.07 sits unlinked under a
 * winget package directory. `BETSHEET_PDFTOTEXT` overrides explicitly;
 * otherwise the winget install location is checked before falling back to
 * bare `pdftotext` on PATH.
 */
let cachedCommand;
export function resolvePdftotextCommand() {
  if (cachedCommand !== undefined) return cachedCommand;
  if (process.env.BETSHEET_PDFTOTEXT) { cachedCommand = process.env.BETSHEET_PDFTOTEXT; return cachedCommand; }
  const wingetBase = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : null;
  if (wingetBase && fs.existsSync(wingetBase)) {
    const pkgDir = fs.readdirSync(wingetBase).find((d) => d.startsWith('oschwartz10612.Poppler_'));
    if (pkgDir) {
      const pkgPath = path.join(wingetBase, pkgDir);
      const versionDir = fs.readdirSync(pkgPath).find((d) => d.startsWith('poppler-'));
      if (versionDir) {
        const exe = path.join(pkgPath, versionDir, 'Library', 'bin', 'pdftotext.exe');
        if (fs.existsSync(exe)) { cachedCommand = exe; return cachedCommand; }
      }
    }
  }
  cachedCommand = 'pdftotext';
  return cachedCommand;
}

/** Run `pdftotext -tsv` against a PDF file on disk; returns the TSV text. Throws with a clear message if the resolved binary isn't Poppler (no -tsv support, e.g. xpdf). */
export function runPdftotextTsv(pdfPath) {
  const command = resolvePdftotextCommand();
  let out;
  try {
    out = execFileSync(command, ['-tsv', pdfPath, '-'], { maxBuffer: 50 * 1024 * 1024 }).toString('utf8');
  } catch (err) {
    throw new Error(`pdftotext -tsv failed (${command}): ${err?.message ?? err}. Poppler is required (not xpdf) - set BETSHEET_PDFTOTEXT to its pdftotext.exe if it isn't on PATH.`);
  }
  if (!/^level\tpage_num/.test(out)) {
    throw new Error(`"${command}" did not produce TSV output - it is likely xpdf, not Poppler. Install Poppler (winget install oschwartz10612.Poppler) or set BETSHEET_PDFTOTEXT to its pdftotext.exe.`);
  }
  return out;
}

// ---------- archive (D41 manifest pattern) ----------

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function archiveDir(trackCode) { return path.join(ARCHIVE_DIR, trackCode); }
function archivePdfPath(trackCode, date) { return path.join(archiveDir(trackCode), `${date}.pdf`); }
function manifestPath(trackCode) { return path.join(archiveDir(trackCode), 'manifest.json'); }

function readManifest(trackCode) {
  const p = manifestPath(trackCode);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function writeManifest(trackCode, manifest) {
  fs.mkdirSync(archiveDir(trackCode), { recursive: true });
  fs.writeFileSync(manifestPath(trackCode), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Archive the uploaded PDF bytes for (trackCode, date), overwriting any prior upload for the same date; returns { archivePath, sha256, bytes }. */
export function archiveOtrPdf(trackCode, date, bytes) {
  const hash = sha256(bytes);
  const filePath = archivePdfPath(trackCode, date);
  fs.mkdirSync(archiveDir(trackCode), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  const manifest = readManifest(trackCode);
  manifest[date] = { ...(manifest[date] ?? {}), sha256: hash, uploaded_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), bytes: bytes.length };
  writeManifest(trackCode, manifest);
  return { archivePath: filePath, sha256: hash, bytes: bytes.length };
}

/** The sha256 of the file that last had cards persisted from it for (trackCode, date), or null if none yet (D71 follow-up batch CLI's idempotency key). */
export function otrConfirmedSha256(trackCode, date) {
  return readManifest(trackCode)[date]?.confirmed_sha256 ?? null;
}

/** Record that `sha256` has had cards persisted for (trackCode, date) - the manifest row already exists from archiveOtrPdf, this only adds the confirmation marker. */
export function markOtrConfirmed(trackCode, date, hash) {
  const manifest = readManifest(trackCode);
  manifest[date] = { ...(manifest[date] ?? {}), confirmed_sha256: hash };
  writeManifest(trackCode, manifest);
}

// ---------- ticket construction (verbatim, no interpretation) ----------

const TIER = {
  someReward: { key: 'some-reward', label: 'Some Reward Opportunity' },
  higherReward: { key: 'higher-reward', label: 'Higher Reward Opportunity' },
};

/**
 * Build the four verbatim tickets for one parsed race: show ($2, 1
 * combo) + $1 exacta box on box4 (SOME-REWARD); win ($2, 1 combo) + $2
 * exacta box on box3 (HIGHER-REWARD). Returns { someReward: [tickets],
 * higherReward: [tickets], warnings }. Ticket shape matches every other
 * picker in this codebase (bet_type/legs/stakeCents/costCents/tellerCall).
 * `entries` (optional) fills in "If it hits" estimates from the day's
 * morning line; omitted, every ticket's estimate stays null.
 */
function buildRaceTickets(parsedRace, raceNumber, entries = []) {
  const warnings = [];
  const blocked = new Set(parsedRace.blockedTickets ?? []);
  const someReward = [];
  const higherReward = [];

  // The DB-shape boundary for shared/betmath.js's estimateTicketPayouts (D91):
  // it takes a lookup, not entry rows, so it can stay browser-safe.
  const mlOf = (pgm) => entries.find((e) => e.program_number === pgm)?.morning_line_decimal ?? null;

  const mkTicket = (betType, legs, stakeCents, combos, tierKey, tierLabel) => ({
    raceNumbers: [raceNumber], betType, legs,
    stakeCents, costCents: stakeCents * combos,
    estMinCents: null, estMaxCents: null, estIsRange: false,
    tellerCall: tellerCall(betType, [raceNumber], stakeCents, legs),
    rationale: tierLabel, rationale_text: tierLabel, odds_at_bet: null,
    ruleTags: ['equibase_otr', tierKey],
  });

  // Each of the four printed tickets is blocked independently - an unknown
  // program number in one ticket (e.g. the box) never drops its tier-mate
  // (e.g. the show bet), same "blocking decides which TICKET gets built"
  // contract as shared/parsers/human-picks.js.
  if (!blocked.has('show')) {
    someReward.push(mkTicket('show', [[parsedRace.showPick]], 200, 1, TIER.someReward.key, TIER.someReward.label));
  }
  if (!blocked.has('exacta_box_4')) {
    // 4-horse exacta box: 4x3 = 12 ordered combos, $1 each = $12.
    someReward.push(mkTicket('exacta_box', [parsedRace.box4], 100, 12, TIER.someReward.key, TIER.someReward.label));
  }
  if (!blocked.has('win')) {
    higherReward.push(mkTicket('win', [[parsedRace.winPick]], 200, 1, TIER.higherReward.key, TIER.higherReward.label));
  }
  if (!blocked.has('exacta_box_3')) {
    // 3-horse exacta box: 3x2 = 6 ordered combos, $2 each = $12.
    higherReward.push(mkTicket('exacta_box', [parsedRace.box3], 200, 6, TIER.higherReward.key, TIER.higherReward.label));
  }

  return {
    someReward: estimateTicketPayouts(someReward, mlOf),
    higherReward: estimateTicketPayouts(higherReward, mlOf),
    warnings,
  };
}

// ---------- preview ----------

function loadDay(db, id) {
  return db.prepare('SELECT * FROM race_days WHERE id = ?').get(id) ?? null;
}

/** Parse the archived bytes fresh against the day's current entries; never persists. */
function parseAgainstDay(db, day, pdfBytes, tmpPath) {
  fs.writeFileSync(tmpPath, pdfBytes);
  let tsv;
  try {
    tsv = runPdftotextTsv(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  const raceNumbers = db.prepare('SELECT number FROM races WHERE race_day_id = ? ORDER BY number').all(day.id).map((r) => r.number);
  const entriesByRace = {};
  for (const n of raceNumbers) {
    entriesByRace[n] = loadRace(db, day.id, n).entries;
  }

  const parsed = parseEquibaseOtrTsv(tsv, { entriesByRace });

  const trackMismatch = parsed.parsedTrack && canonicalizeTrack(parsed.parsedTrack).code !== day.track_code;
  const dateMismatch = parsed.parsedDate && parsed.parsedDate !== day.date;
  if (trackMismatch || dateMismatch) {
    throw new EquibaseOtrError(422,
      `This sheet is for ${parsed.parsedTrack ?? '?'} ${parsed.parsedDate ?? '?'}; the race day is ${day.track} ${day.date}. Wrong sheet - nothing saved.`);
  }

  const perRace = parsed.races.map((r) => {
    const { someReward, higherReward, warnings } = buildRaceTickets(r, r.race, entriesByRace[r.race] ?? []);
    return { race: r.race, showPick: r.showPick, winPick: r.winPick, box4: r.box4, box3: r.box3, names: r.names, someReward, higherReward, warnings };
  });

  const warnings = [...parsed.warnings, ...perRace.flatMap((r) => r.warnings)];
  return { parsedTrack: parsed.parsedTrack, parsedDate: parsed.parsedDate, perRace, warnings };
}

export function previewEquibaseOtr(db, day, pdfBytes) {
  const trackCode = day.track_code ?? TRACK_CODE;
  const { archivePath, sha256: hash, bytes } = archiveOtrPdf(trackCode, day.date, pdfBytes);
  const tmpPath = path.join(archiveDir(trackCode), `.preview-${Date.now()}.pdf`);
  const parsed = parseAgainstDay(db, day, pdfBytes, tmpPath);

  const variantTotals = {
    'some-reward': perRaceCost(parsed.perRace, 'someReward'),
    'higher-reward': perRaceCost(parsed.perRace, 'higherReward'),
    both: perRaceCost(parsed.perRace, 'someReward') + perRaceCost(parsed.perRace, 'higherReward'),
  };

  return {
    parseToken: hash, archivePath, bytes, parsedTrack: parsed.parsedTrack, parsedDate: parsed.parsedDate,
    races: parsed.perRace, warnings: parsed.warnings, variantTotals,
  };
}

function perRaceCost(perRace, side) {
  return perRace.reduce((sum, r) => sum + r[side].reduce((a, t) => a + t.costCents, 0), 0);
}

// ---------- consensus (D74) ----------
//
// The sheet becomes a third, independent consensus source (D07 stands - no
// fetcher, this reads the parse the confirm path already did): its show
// pick maps to pick_type 'top', its win pick to 'second', and its other two
// box-4 members - never ranked by the sheet - to the new 'also' type
// (migration 021). Writes through the SAME resolvePicks/storePicks/
// classifyAndPersist every other source uses (server/consensus.js), not a
// parallel implementation, so entry resolution, the refresh-on-reupload
// idempotency (storePicks deletes-then-inserts per source+race) and the
// classification re-run behave identically to a manual paste or the ATR
// upload.

const OTR_SOURCE_NAME = 'Equibase Off to the Races';

/** Adapts one confirm's parsed races into resolvePicks' {race, picks:[{programNumber, horseName, pickType, note}]} shape. */
function otrPicksToRaces(perRace) {
  return perRace.map((r) => {
    const picks = [
      { programNumber: r.showPick, horseName: r.names?.[r.showPick] ?? null, pickType: 'top', note: 'show-tier' },
      { programNumber: r.winPick, horseName: r.names?.[r.winPick] ?? null, pickType: 'second', note: 'win-tier' },
    ];
    for (const pgm of r.box4 ?? []) {
      if (pgm === r.showPick || pgm === r.winPick) continue;
      picks.push({ programNumber: pgm, horseName: r.names?.[pgm] ?? null, pickType: 'also', note: 'box-only' });
    }
    return { race: r.race, picks };
  });
}

/**
 * Writes consensus_picks for the OTR source from a fresh parse, replacing
 * (never duplicating) that source's rows for the day, re-classifies every
 * race so the chips update, and audits the write (fetch_attempts + the
 * decision-trace stream). Plain statements, not its own transaction, so it
 * composes into confirmEquibaseOtr's existing one (better-sqlite3 nests
 * transactions via savepoints, but there is no need to when the caller
 * already holds one open).
 */
function writeOtrConsensus(db, day, parsed, { correlationId, sha256: fileHash }) {
  const sourceId = upsertSource(db, { name: OTR_SOURCE_NAME, kind: 'algorithmic' });
  const racesForResolve = parsed.perRace.map((r) => {
    const { race, entries } = loadRace(db, day.id, r.race);
    return { id: race.id, number: r.race, entries };
  });
  const resolveWarnings = [];
  const resolved = resolvePicks(racesForResolve, otrPicksToRaces(parsed.perRace), resolveWarnings, OTR_SOURCE_NAME);
  const picksStored = storePicks(db, sourceId, resolved);
  recordAttempt(db, {
    raceDayId: day.id, sourceId, correlationId,
    outcome: 'manual_upload', parseOk: 1, picksExtracted: picksStored,
  });
  classifyAndPersist(db, { id: day.id, races: racesForResolve }, correlationId);
  if (resolveWarnings.length) {
    appLog.warn('otr_consensus_unmatched_picks', { correlationId, raceDayId: day.id, warnings: resolveWarnings });
  }
  traceLog.info('consensus_source_ingested', {
    correlationId, raceDayId: day.id, source: 'equibase-otr', races: parsed.perRace.length, sha256: fileHash, picksStored,
  });
  return { picksStored, warnings: resolveWarnings };
}

/**
 * Consensus-only re-ingest (D71/D72 follow-up batch flag `--consensus-
 * only`): writes OTR's consensus_picks for a day that already has EQB_OTR
 * cards from an earlier confirm, WITHOUT creating any new cards - lets the
 * 16 archived days gain the third source without an append-only pile of
 * duplicate pickers. Re-reads the ARCHIVED file (never trusts anything
 * else), same as confirm.
 */
export function writeOtrConsensusOnly(db, day, { correlationId } = {}) {
  const trackCode = day.track_code ?? TRACK_CODE;
  const filePath = archivePdfPath(trackCode, day.date);
  if (!fs.existsSync(filePath)) {
    throw new EquibaseOtrError(404, 'No archived Off to the Races sheet for this day.');
  }
  const bytes = fs.readFileSync(filePath);
  const hash = sha256(bytes);
  const tmpPath = path.join(archiveDir(trackCode), `.consensus-${Date.now()}.pdf`);
  const parsed = parseAgainstDay(db, day, bytes, tmpPath);
  const cid = correlationId ?? newCorrelationId();
  return db.transaction(() => writeOtrConsensus(db, day, parsed, { correlationId: cid, sha256: hash }))();
}

// ---------- confirm ----------

/**
 * Re-reads the ARCHIVED file for this day (never the client-supplied
 * bytes from preview), verifies `parseToken` still matches what's on
 * disk, re-parses, and persists THREE cards (some-reward, higher-reward,
 * both) in one transaction, consecutive card_numbers, append-only.
 */
export function confirmEquibaseOtr(db, day, { parseToken, correlationId }) {
  const trackCode = day.track_code ?? TRACK_CODE;
  const filePath = archivePdfPath(trackCode, day.date);
  if (!fs.existsSync(filePath)) {
    throw new EquibaseOtrError(404, 'No archived Off to the Races sheet for this day - upload it again.');
  }
  const bytes = fs.readFileSync(filePath);
  const actualHash = sha256(bytes);
  if (!parseToken || parseToken !== actualHash) {
    throw new EquibaseOtrError(409, 'The archived sheet has changed since preview (a newer upload replaced it) - preview again before confirming.');
  }

  const tmpPath = path.join(archiveDir(trackCode), `.confirm-${Date.now()}.pdf`);
  const parsed = parseAgainstDay(db, day, bytes, tmpPath);
  const blocking = parsed.warnings.filter((w) => w.blocking);
  // Blocking warnings are per-ticket (unknown program number), never
  // whole-day - the affected ticket is simply omitted (see buildRaceTickets).

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const raceIdByNumber = {};
  for (const r of db.prepare('SELECT id, number FROM races WHERE race_day_id = ?').all(day.id)) {
    raceIdByNumber[r.number] = r.id;
  }

  const VARIANTS = [
    { variant: 'some-reward', sides: ['someReward'] },
    { variant: 'higher-reward', sides: ['higherReward'] },
    { variant: 'both', sides: ['someReward', 'higherReward'] },
  ];

  const result = db.transaction(() => {
    const cardIds = [];
    let nextCardNumber = db.prepare(
      'SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM cards WHERE race_day_id = ?',
    ).get(day.id).n;

    for (const { variant, sides } of VARIANTS) {
      const totalCents = perRaceCost(parsed.perRace, sides[0]) + (sides[1] ? perRaceCost(parsed.perRace, sides[1]) : 0);
      const cardId = db.prepare(`INSERT INTO cards
          (race_day_id, card_number, variant, strategy_template_id, bankroll_cents,
           per_race_min_cents, status, correlation_id, consensus_completeness, engine_version)
          VALUES (?, ?, ?, ?, ?, NULL, 'final', ?, 'EQB_OTR', 'equibase-otr')`)
        .run(day.id, nextCardNumber, variant, templateIdFor(db, 'equibase-otr'), totalCents, correlationId).lastInsertRowid;
      nextCardNumber += 1;
      cardIds.push({ cardId, variant, sides });

      const insTicket = db.prepare(`INSERT INTO tickets
          (card_id, race_id, sequence, bet_type, selections, stake_cents, cost_cents,
           est_payout_min_cents, est_payout_max_cents, est_is_range, teller_call, rationale,
           rule_tags, rationale_text, odds_at_bet)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insAlloc = db.prepare(`INSERT INTO allocations
          (card_id, race_id, amount_cents, confidence, rule, thesis)
          VALUES (?, ?, ?, 'EQB_OTR', 'equibase_otr', NULL)`);

      let seq = 0;
      for (const r of parsed.perRace) {
        const raceId = raceIdByNumber[r.race];
        const tickets = sides.flatMap((s) => r[s]);
        if (!tickets.length) continue;
        let raceCost = 0;
        for (const t of tickets) {
          seq += 1;
          insTicket.run(
            cardId, raceId, seq, t.betType,
            JSON.stringify({ races: t.raceNumbers, legs: t.legs }),
            t.stakeCents, t.costCents, t.estMinCents, t.estMaxCents, t.estIsRange ? 1 : 0,
            t.tellerCall, t.rationale, JSON.stringify(t.ruleTags), t.rationale_text, t.odds_at_bet,
          );
          raceCost += t.costCents;
        }
        insAlloc.run(cardId, raceId, raceCost);
      }
    }

    // D74: the sheet is also a consensus source - write it in the same
    // transaction as the three cards it's taken verbatim into, so a card
    // and its consensus rows are never out of step.
    writeOtrConsensus(db, day, parsed, { correlationId, sha256: actualHash });

    return cardIds;
  })();

  for (const { cardId, variant, sides } of result) {
    appLog.info('card_generated', {
      correlationId, cardId, raceDayId: day.id, engineVersion: 'equibase-otr', template: 'equibase-otr', variant,
    });
    traceLog.info('card_generated', {
      correlationId, cardId, raceDayId: day.id, engineVersion: 'equibase-otr', variant,
    });
    for (const r of parsed.perRace) {
      const tickets = sides.flatMap((s) => r[s]);
      for (const t of tickets) {
        traceLog.info('ticket_added', {
          correlationId, cardId, raceDayId: day.id,
          race: r.race, betType: t.betType, selections: t.legs,
          stakeCents: t.stakeCents, costCents: t.costCents, rationaleText: t.rationale_text,
        });
      }
    }
  }

  traceLog.info('equibase_otr_ingested', {
    correlationId, raceDayId: day.id, archivePath: filePath, sha256: actualHash,
    races: parsed.perRace.length, warnings: parsed.warnings.length,
  });
  appLog.info('equibase_otr_ingested', {
    correlationId, raceDayId: day.id, cards: result.length, races: parsed.perRace.length,
    warnings: parsed.warnings.length, ts: now,
  });

  const graded = [];
  const hasResults = db.prepare('SELECT 1 FROM race_results WHERE race_day_id = ? LIMIT 1').get(day.id);
  if (hasResults) {
    for (const { cardId } of result) graded.push(gradeAndPersist(db, cardId, correlationId, { engineVersion: 'equibase-otr' }));
  }

  return {
    cards: result.map(({ cardId, variant }) => ({ cardId, variant })),
    warnings: parsed.warnings, blockingCount: blocking.length, graded,
  };
}

// ---------- batch CLI (D71 follow-up) ----------

/** Read just far enough to learn the sheet's own printed track/date - used to find the matching race day before its entries can be loaded. */
function peekOtrHeader(pdfBytes) {
  const tmpPath = path.join(os.tmpdir(), `otr-peek-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(tmpPath, pdfBytes);
  let tsv;
  try {
    tsv = runPdftotextTsv(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  const parsed = parseEquibaseOtrTsv(tsv);
  return { parsedTrack: parsed.parsedTrack, parsedDate: parsed.parsedDate };
}

/**
 * Batch-ingest every PDF in `dir` (default the real committed DMR
 * archive) through the SAME archive -> parse -> confirm path
 * POST /equibase-otr and its /confirm route take - one file at a time,
 * sorted by filename for a stable, reproducible run order.
 *
 * Policy A (D43's rule, applied here): a file whose preview carries zero
 * BLOCKING warnings is auto-confirmed; any blocking warning (an unknown
 * program number - see shared/parsers/equibase-otr.js) leaves the day
 * QUEUED - unconfirmed, printed with why, for a human to finish through
 * the normal upload panel rather than silently persisting a card with a
 * dropped ticket. Idempotent by sha256: a file already recorded (in the
 * per-track manifest.json's `confirmed_sha256`) as having had cards
 * persisted for its date is SKIPPED without re-parsing - a re-run never
 * appends duplicate cards for the same source file.
 *
 * `consensusOnly` (D74, `--consensus-only`): skips card creation entirely
 * and instead writes the OTR consensus rows for days that ALREADY have
 * EQB_OTR cards from an earlier (non-consensus-only) run - the way the 16
 * already-archived days gain the third source without an append-only pile
 * of duplicate pickers. A file not yet confirmed is left alone (skipped,
 * not confirmed) in this mode - run the normal batch first.
 *
 * Returns { files: [{file, status: 'ingested'|'consensus_written'|
 * 'queued'|'skipped', reason?, cards?}], seen, ingested, consensusWritten,
 * queued, skipped, cardsWritten }.
 */
export function batchIngestEquibaseOtr(db, { dir, correlationId, log = () => {}, consensusOnly = false } = {}) {
  const sourceDir = dir ?? archiveDir(TRACK_CODE);
  const files = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
    : [];

  const results = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(sourceDir, file));
    const hash = sha256(bytes);
    let header;
    try {
      header = peekOtrHeader(bytes);
    } catch (err) {
      const r = { file, status: 'skipped', reason: `could not read the PDF: ${err?.message ?? err}` };
      results.push(r); log(r); continue;
    }
    if (!header.parsedTrack || !header.parsedDate) {
      const r = { file, status: 'skipped', reason: 'could not read a track/date header from this sheet' };
      results.push(r); log(r); continue;
    }

    const trackCode = canonicalizeTrack(header.parsedTrack).code;
    const day = db.prepare(
      'SELECT * FROM race_days WHERE track_code = ? AND date = ? AND deleted_at IS NULL',
    ).get(trackCode, header.parsedDate);
    if (!day) {
      const r = { file, status: 'skipped', reason: `no race day on file for ${header.parsedTrack} ${header.parsedDate}` };
      results.push(r); log(r); continue;
    }

    const alreadyConfirmed = otrConfirmedSha256(trackCode, day.date) === hash;

    if (consensusOnly) {
      if (!alreadyConfirmed) {
        const r = { file, status: 'skipped', reason: 'not yet confirmed - run the batch without --consensus-only first to create its cards' };
        results.push(r); log(r); continue;
      }
      const cid = correlationId ?? newCorrelationId();
      const written = writeOtrConsensusOnly(db, day, { correlationId: cid });
      const r = { file, status: 'consensus_written', raceDayId: day.id, picksStored: written.picksStored };
      results.push(r); log(r); continue;
    }

    if (alreadyConfirmed) {
      const r = { file, status: 'skipped', reason: 'already ingested (identical file already confirmed for this date)' };
      results.push(r); log(r); continue;
    }

    const preview = previewEquibaseOtr(db, day, bytes);
    const blocking = preview.warnings.filter((w) => w.blocking);
    if (blocking.length) {
      const r = {
        file, status: 'queued', raceDayId: day.id,
        reason: `${blocking.length} blocking warning(s) - upload through the panel to review and confirm`,
        blocking,
      };
      results.push(r); log(r); continue;
    }

    const confirmCid = correlationId ?? newCorrelationId();
    const confirmed = confirmEquibaseOtr(db, day, { parseToken: preview.parseToken, correlationId: confirmCid });
    markOtrConfirmed(trackCode, day.date, hash);
    const r = { file, status: 'ingested', raceDayId: day.id, cards: confirmed.cards };
    results.push(r); log(r);
  }

  return {
    files: results,
    seen: results.length,
    ingested: results.filter((r) => r.status === 'ingested').length,
    consensusWritten: results.filter((r) => r.status === 'consensus_written').length,
    queued: results.filter((r) => r.status === 'queued').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    cardsWritten: results.reduce((a, r) => a + (r.cards?.length ?? 0), 0),
  };
}

// ---------- routes ----------

equibaseOtrRouter.post(
  '/race-days/:id/equibase-otr',
  express.raw({ type: 'application/pdf', limit: '30mb' }),
  (req, res) => {
    const db = getDb();
    const day = loadDay(db, Number(req.params.id));
    if (!day) return res.status(404).json({ error: 'No such race day.' });
    if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted. Restore it before uploading the Off to the Races sheet.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the Off to the Races PDF as a raw application/pdf body.' });
    }
    try {
      const preview = previewEquibaseOtr(db, day, req.body);
      res.json(preview);
    } catch (err) {
      if (err instanceof EquibaseOtrError) return res.status(err.status).json({ error: err.message });
      res.status(422).json({ error: `Could not read that PDF: ${err?.message ?? err}` });
    }
  },
);

equibaseOtrRouter.post('/race-days/:id/equibase-otr/confirm', (req, res) => {
  const correlationId = req.get('x-correlation-id') || newCorrelationId();
  const db = getDb();
  const day = loadDay(db, Number(req.params.id));
  if (!day) return res.status(404).json({ error: 'No such race day.' });
  if (day.deleted_at) return res.status(410).json({ error: 'This race day is deleted. Restore it before uploading the Off to the Races sheet.' });
  const parseToken = req.body?.parseToken;
  if (!parseToken) return res.status(400).json({ error: 'parseToken (from the preview) is required.' });
  try {
    const result = confirmEquibaseOtr(db, day, { parseToken, correlationId });
    res.status(201).json({ correlationId, ...result });
  } catch (err) {
    if (err instanceof EquibaseOtrError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
