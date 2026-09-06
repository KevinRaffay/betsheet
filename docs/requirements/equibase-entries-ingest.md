# Equibase entries ingest, from a manually saved page

**Status: specified, not scheduled.** No deliverable IDs assigned — they get claimed when
the work is picked up, not before. Written 2026-09-05 from a real sample; every structural
claim below was verified against that file rather than read off the rendered page.

## Purpose

Enable live card generation at tracks with **no automated entries feed** — first target
Kentucky Downs — from a copy of Equibase's entries page saved by hand, as close to first
post as practical. Built against Equibase's page template rather than any one track, so a
new track on the same template needs no code.

**Explicit non-goal**: this is not a backtest or edge-detection feature. No corpus, no
blindness derivation, no pre-registered hypotheses. It exists for live practice with LLM
assistance. Grading and labelling hygiene still apply (invariant 13) so these cards never
blend into the Del Mar engine corpus.

## Invariant 6 is not bent

CLAUDE.md and `server/consensus.js` forbid scraping Equibase, and Equibase actively blocks
scripted fetching. The parser takes an **HTML string** and never fetches anything. The file
arrives because a person opened the page and saved it — the same manual-upload posture as
the Equibase OTR sheet (D71) and the At The Races racecard (D69).

---

## The PDF path was tried and rejected, with evidence

The original proposal was to upload the entries page as a PDF. The first sample,
`kd090526usa-eqb.pdf`, **cannot be parsed at all**. It was produced by "Microsoft: Print To
PDF", which draws page text as vector outlines rather than text:

| check | result |
| --- | --- |
| `pdffonts` | zero embedded fonts |
| `pdftotext -layout` (Poppler 25.07) | 14 bytes total |
| this repo's own `extractPdfLines` (pdfjs, `server/pdf-text.js`) | 0 characters |
| `pdfimages -list` | only small logos, so not a scan either |

A browser's own "Save as PDF" destination would embed fonts and fix that — but it is moot.
**The HTML source is better than any PDF**, because every field arrives as a discrete table
cell: no column-alignment guesswork, no `-layout` whitespace heuristics, no page-break
bleed, and no OCR anywhere near odds, weights or program numbers.

Recorded so nobody re-opens the PDF route without knowing it was measured.

---

## What the HTML contains — verified against the sample

Sample, committed at `tests/fixtures/equibase-entries/DMR090626USA-EQB.view-source.html`:
Equibase entries page, **Del Mar, 6 September 2026, 11 races, 116 entry rows**.

| needed | present as |
| --- | --- |
| race delimiters | `id="RACE1"`…`id="RACE11"`, one `<table class="fullwidth">` per race |
| post time | `POST Time - 1:30 PM PT` — 11 distinct, 1:30 through 6:44 |
| track + date | `Del Mar / September 6, 2026 / All Races` |
| class, purse, distance, surface | header block before each table: `Del Mar STARTER OPTIONAL CLAIMING $50,000`, `Purse $41,000.`, `Five Furlongs.`, `(Turf)` |
| wager menu | same block: `Rolling Pick 3 / $1 Superfecta (10c min) 50c Early Pick 5 / $2 WPS Parlay` |
| conditions | same block, full paragraph |
| entries | header row `P#, PP, Horse, VS, A/S, Med, Jockey, Wgt, Trainer, M/L, LiveOdds` — **but see rule 1: a claiming race adds a `Claim $` column** |
| horse + state suffix | a single cell — `Broheim (KY)`, `Prime Artist (FR)`. The split-on-parenthetical risk the PDF spec worried about does not arise |
| live odds | the `LiveOdds` column exists on every race and is **empty in all 116 rows** of this capture — an entries page saved before wagering opened. See the correction under Open questions |
| scratches | 3 in this card (races 3, 5, 7) |
| also-eligibles | a 1-cell `Also Eligibles:` separator row in races 3, 10 and 11; entries after it are AEs |

### Five parsing rules the sample forces

1. **The column count is NOT fixed — map columns from each race's own header row.**
   A claiming race inserts a `Claim $` column, giving **12 instead of 11**:
   `["P#","PP","Horse","VS","A/S","Med","Claim $","Jockey","Wgt","Trainer","M/L","LiveOdds"]`
   against race 1's 11-column form. Races 3, 6 and 7 are 12-column here; the rest are 11.
   Reading a fixed index shifts jockey, weight, trainer, M/L and live odds by one on every
   claiming race — which is precisely the mistake made while first analysing this file,
   where a 12-column row's `M/L` was misread as its live odds.
2. **A scratched row has 6 cells, whatever the race's column count.**
   `[" SCR", "King of Clubs (KY)", "", "----Scratched----", "", ""]` — the dashed bar spans
   the rest by colspan. Detect a scratch **by row shape, never by column index**.
3. **Entities need two unescape passes** when the file is a saved *view-source* page: the
   markup is escaped twice, so `&amp;nbsp;` → `&nbsp;` → space. After a single pass,
   `&#44; &amp; &ndash; &nbsp; &copy;` all survive into the output.
4. **The UI artifact is `See More See Less`** — 22 of them, two per race, trailing each
   conditions paragraph. Strip via a small appendable pattern list; assume more turn up on
   other tracks' pages. It is only visible once tags are stripped — in raw markup the
   phrase is split across elements.
5. **`Also Eligibles:` is a 1-cell separator row**, not an entry. Rows after it are
   also-eligibles, which `shared/entries-parser.js` already has a convention for.

### Capture method — accept both forms

The sample is Chrome's **view-source page** saved to disk: 18,647 `<tr>` line rows wrapping
the escaped original. It reconstructs deterministically into ~1.1MB of clean HTML (11
tables), so it is usable as-is. Saving the page normally (Ctrl+S → "Webpage, HTML Only")
yields the original directly with no reconstruction step.

**The parser should accept both** — detect and unwrap the view-source form, else parse the
HTML as given — so nobody has to remember which way a file was captured.

---

## Corrections to the original scope, from reading the code

1. **`track` is already first-class.** `race_days.track` + `race_days.track_code` (D35),
   canonicalized by `shared/track-codes.js`. Nothing is Del-Mar-implicit. Kentucky Downs
   wants a registry entry there; an unknown track already gets a derived code, so that is
   tidiness, not a blocker.
2. **`entries_source` already exists and is constrained twice**: the schema has
   `CHECK (entries_source IN ('program','ml_sheet','both'))` *and* `server/ingest.js` filters
   through a hardcoded allowlist of the same three. Adding `EQB_MANUAL_UPLOAD` needs a
   CHECK-rebuild migration (the `-- betsheet:schema-rebuild` pattern used by 016/018/020)
   **and** that line. Missing either leaves the value silently coerced to `program`.
3. **`is_scratched` and `ml_odds` already exist** as `entries.scratched` and
   `entries.morning_line` / `morning_line_decimal`. Do not add duplicates. Genuinely new:
   **`live_odds`** and **`medication`** (`age` exists; `equipment` is blinkers-and-such, not
   Lasix).
4. **Entries are not seeded per race in the LLM modal** — the original spec assumed they
   were. They are ingested **once at day creation** (`NewRaceDay` → a parse route →
   `POST /api/race-days`), and the LLM modal, ticket builder, card sheet and Replay all read
   entries off the day. So this belongs in the day-creation path and every race populates
   from one upload. This *removes* work from the original scope.
5. **Node/ESM, not Python**: `parseEquibaseEntriesHtml(html) -> { track, date, races, warnings }`.
6. **"Engine impact: none" holds only while `live_odds` stays out of the engine.**
   `morning_line_decimal` is what `shared/card-engine.js` and `shared/betmath.js`'s
   `estimateTicketPayouts` read. Storing live odds beside it is inert; *feeding* them in
   changes generation and is an `ENGINE_VERSION` bump (invariant 14).

---

## Suggested shape when scheduled — four deliverables

1. **Parser.** `shared/parsers/equibase-entries.js`, pure and **browser-safe** (no `node:`
   imports, like `shared/entries-parser.js`) so the ingest preview can run it client-side.
   Emits the entry shape `entries-parser.js` already produces — `programNumber`,
   `postPosition`, `horseName`, `morningLine`, `morningLineDecimal`, `jockey`, `trainer`,
   `weight`, `age` — plus `liveOdds`, `medication`, `scratched`, so `insertRaceDay` needs no
   change for entries. `effectiveOdds` = live odds when present and not a dash, else M/L;
   both raw fields always kept; `null` for a scratch. Scratched horses are retained and
   flagged, excluded from the active count. Never throws; problems land in `warnings` with a
   per-item `blocking` flag, the convention `human-picks.js` and `equibase-otr.js` share.
   Fixture + audited golden + `npm run check-equibase-entries`, following
   `check-parsers.js`'s rule of golden diff **plus** independent hand-counted assertions, so
   regenerating a golden cannot bless a regression. **`data/raw/` is gitignored**, so the
   sample must be copied to `tests/fixtures/` to be committed.
2. **Schema.** CHECK-rebuild migration admitting `EQB_MANUAL_UPLOAD`; ordinary ALTERs for
   `race_days.odds_captured_at`, `entries.live_odds`, `entries.medication`; the
   `server/ingest.js` allowlist; a Kentucky Downs entry in `shared/track-codes.js`.
   Track/source tagging then falls out of columns every card view already reads — no
   report-code special-casing, which was the original spec's stated goal.
3. **Ingest UI.** A control in `NewRaceDay.jsx` beside the program-PDF upload, accepting the
   saved `.html` or pasted markup, rendering the existing warnings-first read-only preview
   before anything is written (invariant 9). Additive; Del Mar's automated flow untouched.
4. **Staleness indicator.** Per race, "Entries as of {odds_captured_at}, post {post_time}",
   with fresh / aging / past-post states from one exported threshold constant (default
   75 minutes, configurable). Non-blocking — visible, not obstructive.

---

## Open questions for whoever schedules this

1. **"Track-agnostic" is a claim, not a finding.** The verified sample is Del Mar; the actual
   target is Kentucky Downs. Capturing the KD page and parsing it is the first real test, and
   should happen before the parser is described as generic anywhere.
2. **Live odds were empty in the entire sample** — all 116 rows. This capture predates
   wagering, so the M/L fallback is not merely the common path, it is the ONLY path this
   fixture exercises. A second capture taken close to post is needed before the live-odds
   branch can be tested at all, and blank live odds must never be read as a parser fault.
   *(Correction, same day: an earlier reading of this file claimed live odds were present
   on races 3, 6 and 7. That was wrong — it read column index 10, which is `M/L` in a
   12-column claiming race. That error is what produced rule 1 above.)*
3. **One `odds_captured_at` per card** means later races are staler than earlier ones by
   construction. That is the design — it is what the staleness indicator exists to surface —
   not a defect to fix later.
4. **Committing Equibase HTML as a fixture** carries the same copyright posture as the
   already-committed OTR sheets and program PDFs: private repo, test data, never
   republished. See the D101 ledger row for why the repo stays private.
