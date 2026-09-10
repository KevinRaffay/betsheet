# BetSheet — commands

Moved out of `CLAUDE.md` by D219 - the list itself is unchanged, only its
location. It is a reference read one line at a time when you need a command,
which is not a reason to load 15k of it into every session.

**A PR that adds, renames, retires or changes the meaning of a command updates
this file in the same commit**, exactly as it updated the block in `CLAUDE.md`
before. A command whose behaviour a reader could get wrong says so here, in
the same one-line style the rest of the file uses.

```bash
npm start              # build + serve on 127.0.0.1:8788
npm run dev            # vite :5175 + api :8788 (api restarts via scripts/dev-watch.js)
npm run dev:clean [-- --yes]  # find (and stop) stale dev stacks holding :8788 / :5175
npm run dev:restart    # D97: dev:clean --yes then dev, in one command - the two-step is why a stale stack stayed in the way
npm run dev:preview    # D97: the AGENT's dev stack, api :8795 / vite :5185, never the human's ports (.claude/launch.json runs this)
npm run gh -- pr 133 | pr list | pr create --title T --body-file f | pr merge N | pr close N | checks [ref] | raw GET <path>  # D101: GitHub API via the git credential; D217 added pr close
npm run check-gh-api   # D217+D218: gh-api.js's ALLOWLIST and how it STOPS - offline and credential-free - what PATCH may reach and (mostly) what it must not, that the only PATCH body in the file is the literal {state:'closed'}, and that DELETE is permitted nowhere
npm run install-hooks  # D101: point core.hooksPath at the tracked hooks (pre-push refuses a direct push to main)
npm run allocate-deliverable -- --title "Short title" [--branch b] [--who name]  # D203: atomically claim the next D number - run this BEFORE naming a branch or writing a ledger row; also --list, --status <n>, --release <n> [--reason "..."]
npm run check-deliverable-numbers  # D203: the allocator's own verification, incl. 25 real concurrent processes claiming 25 distinct numbers
npm run check-logging  # logging: rotation, sweep, retention, torn lines
npm run check-schema   # schema: constraints, cascades, migrations, tamper guard
npm run check-staleness # D117: entries freshness - the exact part (capture age) and the parts it refuses to guess (has a race run, without the track's timezone)
npm run check-track-codes # D123: the track registry's silent-failure properties - no shared codes, no ambiguous spellings, no alias the lookup can never match; every display and alias round-trips; D209: every tz is a real IANA zone, an unrecognized track carries no guessed timezone
npm run check-race-calendar # D209+D210: the race-day calendar's pure timezone math (a known winter/summer offset for two zones, the real 2026 spring-forward boundary not just a two-season pair, the 10am-Pacific hour grid, formatPacific's PST/PDT label, every registered track's zone actually converting) AND the GET /api/calendar endpoint on a seeded temp DB (three tracks/zones on one date, a null post time and an unregistered track both landing in unplaceable, a deleted day and a different date both excluded, the 400 refusals)
npm run check-graded-card-fixtures # D108 + D120 (P-6.1): the 9 fixtures are present and self-consistent, AND the real grader re-run over them reproduces every archived summary to the cent and all 386 per-ticket outcomes - with a negative control proving the check can fail
npm run check-equibase-entries # D104: Equibase entries HTML parser vs. the real Del Mar page (golden + hand counts; the 12-column claiming-race regression)
npm run check-equibase-apify-parseforge # D190: the second registered parser vs. a real two-track Apify dataset (golden + hand counts; the morning-line-decimal recomputation; multi-track refusal; toPayload's deliberate throw)
npm run check-equibase-apify-results # D193/D196: the second RESULTS source vs. a real 11-race single-track Apify dataset (golden + hand counts; the two finalTime-less races; exotics-on-winner's-row-only; scratch derivation from a supplied entries context; output already matches saveResults's shape)
npm run check-apify-equibase-ingest # D196: the real entries -> results flow end to end over HTTP, using the two real fixtures that happen to be the same real day (Del Mar 2026-09-07) - entries save with equibase_apify provenance, results preview derives the 4 genuine race-11 scratches, both bogus-provenance refusals hold for real
npm run check-apify-equibase-client # D197: the live Apify client's input shaping, includeWagers default, run-status handling and raw-item round trip through the real parsers - all against a FAKE client, never a real billed call
npm run check-equibase-apify-entries-preview # D202/D204: the UI-triggered live entries pull's previewApifyEntries() against a fake client (never a real billed call), plus the real Express route's request validation and its no-APIFY_TOKEN refusal path over a real temp server; the returned apifyRunId
npm run check-equibase-apify-results-pull # D206: the /day UI's live results pull, pullApifyResults() against a fake client (never a real billed call) - the day's own track/date feeding the call, scratch derivation against a seeded entriesByRace - plus the real route over a real temp server seeded with the real D192/D193 Del Mar fixture: 404 on an unknown day, the no-APIFY_TOKEN refusal before any network call, 410 on a soft-deleted day
npm run check-zip-read # D127: the zip reader's refusals - bombs stopped during inflation, encrypted/zip64/truncated/bad-CRC named, and no filesystem access at all
npm run check-entries-zip # D127: the bulk path end to end on a temp DB - preview writes nothing, policy A skips a bad file without losing the good ones, replace only when asked
npm run batch-equibase -- <dir> [--write-report f.json] [--parser id]  # D121: every saved Equibase page in a folder through the real parser AND the real writer, into a throwaway DB that is deleted on exit. D188: --parser selects a registered parser (shared/parsers/registry.js), default equibase-html; an unknown id is a hard error
npm run pull-race-day -- <date> --dir <dir> [--tracks C1,C2] [--parser id] [--per-track-parser C=id,...] [--write-report f.json]  # D189: a full day's slate from a directory of already-saved pages, no live fetch; appends one row per track to data/ingest_runs.jsonl
npm run pull-apify-entries -- <date> [--tracks C1,C2] [--yes] [--replace] [--bankroll-cents N] [--per-race-min-cents N] [--write-report f.json] [--fixture f.json]  # D198: live, on-demand entries pull through the real running server - COSTS REAL MONEY without --fixture, even without --yes; --yes governs the save only
npm run pull-apify-results -- <date> [--tracks C1,C2] [--yes] [--write-report f.json] [--fixture f.json]  # D198: the results sibling - requires entries already saved for the day, day looked up by track+date, never assumed
npm run check-pull-apify-cli  # D198: both CLI scripts run as real child processes against a real temp server, using --fixture on the same real Del Mar 2026-09-07 pair D196 verified - never a real billed call
npm run compare-parsers -- <date> <TRACK_CODE> --dir <dir> [--parsers id1,id2,...] [--write-report f.json]  # D191: diffs a challenger parser against the registry default for one real track/date, from files only; appends one row per comparison to data/parser_comparisons.jsonl
npm run check-compare-parsers  # D191: the diff logic (shared/parsers/compare.js) vs. hand-built synthetic parses - field-coverage classification, type-tolerant value comparison, the generalised data-quality checks
npm run check-ingest   # boots the real server on a temp DB; full API flow (~30s)
npm run check-charts    # results-chart parser vs. the real Equibase chart
npm run check-grading   # ticket grading vs. hand-computed + real-day payoffs
npm run check-human-picks # D103: delete a locked ticket (allocation recomputed, last ticket retires the race, revealed 409, graded 409, 404s); D98: the LIVE race-day path - lock with no results on file, estimates still filled from the M/L, replayed_at stamped, blindness undetermined until a reveal, and the results save grading the already-locked card (plus the D99 bug pinned); D91: payout estimator pure (incl. identity for unsupported types), preview==saved estimate (invariant 9); D54: human ticket parser, lock/save/grade, D28 refusal, bucket isolation; D84: teller grammar (pure), the inverse proof, structural + wps_split rules
npm run check-replay    # D55: blindness/close pure units, blind-view key-set discipline, standing; D62: day landing per-race PL
npm run check-llm-cards # D92: notes-free prompt byte-identical, sanitizer, trailingText, notes report, draft/snapshot immutability, prompt-injection containment, batch 409; D63: prompt builder + ticket-block extraction, stubbed preview/save round trip, per-race bankroll math, bucket isolation; D64: box-bet prompt fix; D67: "If it hits" estimate math; D68: consensus picks reach the prompt; D75: GET /api/llm-models shape, an unknown model refused 400, a requested model recorded on the request row without a real API key; D76: llm_model recorded at card creation, a mismatched-model save refused 409, the LLM_GENERATED P/L bucket's byModel breakdown
npm run check-llm-input-capture # D149: correlation id / prompt hashes / template id-version / request params / notes snapshot all independently recomputable; llm_request_sent/llm_response_received bracket a call; export at schemaVersion 3 with a populated llmInputs entry; --omit-llm-inputs redaction; a non-LLM card and a simulated pre-migration row both export llmInputs: null; a regeneration writes a new request row (original untouched) plus a race_regenerated event naming both correlation ids
npm run check-equibase-otr # D71+D72+D74: OTR PDF parser vs. all 16 real archived files, synthetic wrap/mismatch/trailing-token edge cases, upload/confirm round trip, per-ticket blocking, D07 mismatch refusal, bucket isolation, archive re-parse, batch CLI (ingest + idempotent re-run + --consensus-only); D74: exact consensus mapping, re-upload replaces not duplicates, the real favorite/box4 fade rule, the LLM prompt's OTR block present/absent
npm run ingest-otr -- [dir]  # D72: batch-ingest every Equibase OTR PDF in a folder (default data/archive/equibase-otr/DMR), policy A, idempotent by sha256
npm run check-pl        # P/L views: bucket isolation, per-race sums, delete/restore
npm run check-export    # trace export: rotation/gzip read-through, loss flagging
npm run check-routing   # browser routes, SPA deep links, and API JSON boundary
npm run check-dmtc-results # dmtc results page vs. Equibase chart: identical cents per ticket on 08-28/29/30
npm run check-distribution  # distributions: losing days, drawdown, single-ticket dependence gross vs net, bucket isolation
npm run reformat-teller-calls [-- --yes]  # D85: re-derive every stored tickets.teller_call into the D84 grammar (dry run by default)
npm run backfill-payout-estimates [-- --yes]  # D96: fill tickets.est_payout_* on human/llm/equibase-otr cards saved before D67/D73/D91 (dry run by default; never touches an engine card, never overwrites)
npm run archive-corpus [-- --force]  # D107: freeze the pre-pivot corpus to archive/ (snapshot + one export per card); refuses to clobber
npm run fix-grade-set-versions [-- --yes]  # D99: re-stamp grade sets written under the wrong engine version (regrade then drop the stale set; dry run by default)
npm run export-trace -- --card N [--out f]  # the LLM feed for one card
npm run reset -- --yes  # FACTORY RESET: wipe every record AND every log file

# The static Pages target (D150-D155) - the at-the-track card builder
npm run build-static-payload -- <raceDayId> [--out f] [--reference-cards]  # D150: one race day -> static/public/payload.json (read-only; --reference-cards embeds the day's LLM/OTR cards, which the deploy then publishes PUBLICLY)
npm run dev:static      # D151: the static app on vite :5186 (needs a payload built first)
npm run preview:static  # D155: serves the BUILT dist-static on :5187 - the only way to exercise the service worker (it registers in production builds only)
npm run build:static    # D151: build dist-static (BETSHEET_STATIC_BASE sets the deploy sub-path)
npm run check-static-payload  # D150: canonicalization, the 13 validation refusals, a real day, hash stability incl. a negative control
npm run check-static-app      # NOT RUNNABLE IN A WORKTREE - out of scope there by house rule (D168, see Gotchas); run it from the primary checkout. D151+D154+D155: payload rows and DB rows parse IDENTICALLY, the built bundle ships no LLM/OTR/grading/API code (with a positive control), the Pages base, the service-worker strategies
npm run import-static-cards -- <path> [--yes]  # D153: import phone-built cards (dry run by default; a directory of rolling backups is one safe import)
npm run check-static-import   # D153: migration 027, the same file imported three times producing ONE card, all four refusals, invariant 15's lock times
npm run check-module-bindings # D172: no module uses a name it only re-exports - the blank-page class that build and every server-side check structurally miss
npm run dedupe-tip-cards [-- --yes]  # D174: fold D171 duplicate TIPSHEET card sets to one per (day, source, variant); keeps the NEWEST (the one a later stake reuses) and REFUSES to delete a graded card. Dry run by default
npm run check-tip-staking     # D171 + D174 (re-staking reuses the same three cards; a third race re-prices the whole card; a second SOURCE gets its own three; migration 031 backfill; a graded card warned then regraded cleanly): the three variants, the 8/1 place-money threshold (and that 7/1 does not fire), refusals instead of unpayable stakes, migration 030's cards REBUILD keeping every child row and both indexes, preview writing nothing, three cards appended not edited, and a TIPSHEET card grading through the ORDINARY grader into its own P/L bucket
npm run check-entry-flags   # D216: the two entries-table highlights (shared/entry-flags.js) - all three real Baffert spellings, the LIVE-runner field count in both directions, a scratched horse keeping BAFFERT but never taking FAV, co-favorites, and the no-stored-decimal input shape; two negative controls
npm run check-tip-scoring     # D170: a scratched top pick promotes the next live one, an unplaced also-ran is a loss but an unknown program number is surfaced, NULL not zero when unscorable, rates NULL at n=0, sources never pooled, a soft-deleted day leaving every figure and coming back on restore
npm run check-tip-picks       # D166 shape + D176 manual entry (D177 removed the vision phases): migration 028, the hyphen->slash odds conversion re-checked through morningLineToDecimal, absent odds omitted not fabricated, a broken ranking blocking, the reset naming tip_picks, and the manual round trip - the same horse ranked differently in two sheets, names from the day, an empty sheet clearing a source
```

Further verification commands (simulator runs, distribution reports) are
added by their PRs and listed here as they land.
