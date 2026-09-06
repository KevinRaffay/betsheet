# Day fixtures

Parsed race-day data for the fixture days the check suites build their
real-day scenarios on. These are DATA, not parser goldens: nothing here is
diffed against a parser's output any more.

`delmar-2026-08-30.entries.json` is the Del Mar card for 2026-08-30 — 10
races, 98 entries, with the program's `programRank` / `bestBet` annotations
still on it. It began life as `tests/fixtures/programs/delmar-2026-08-30.expected.json`,
the audited golden for the program-PDF parser, and D113 moved it here when
that parser and its 12MB source PDF were deleted with the rest of Del Mar
program ingestion.

It survives because four suites the pivot keeps need a real day's entries to
work on, and none of them cares where those entries came from:

| suite | what it needs the day for |
| --- | --- |
| `check-grading` | the entries the chart's scratches resolve against, and the day the frozen lean-1.1 card was built for |
| `check-dmtc-results` | the same, for the cross-source proof that both result sources grade to identical cents |
| `check-export` | a real day with enough races to make one card's trace span several rotated log files |
| `check-pl` | the graded day the bucket-isolation scenario is built on |

**Never regenerate it.** The parser that produced it is gone; this file is
now the source of record for that day's entries, and the same day's chart
(`tests/fixtures/charts/`) and Equibase OTR sheet
(`tests/fixtures/equibase-otr/DMR-2026-08-30.pdf`) are pinned to it.
