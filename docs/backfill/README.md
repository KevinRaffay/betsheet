# Backfill reports

**History.** The batch backfill runner, the dmtc.com crawler and the raw
archive they read were deleted by D111 and D113 in the 2026-09-05 pivot.
Nothing here can be regenerated, and nothing reads these files.

They are kept because they are the **provenance of the frozen corpus**. The
70-day Del Mar corpus in `archive/` (D107) was produced by the runs these
reports describe: which days were ingested, which were queued for review and
why, which were confirmed or dropped, and what each meet graded to. A snapshot
whose contents nobody can account for is a much weaker artifact than one whose
construction is written down, which is the whole argument for keeping them.

| file | run |
| --- | --- |
| `DMR-2026-summer.md` / `.json` | D44 — 27 days, 2026-07-17 to 2026-08-30 |
| `DMR-2025-summer.md` / `.json` | D45 — 31 days, indexed from a bounded probe because dmtc renders past seasons' calendars dark |
| `DMR-2025-fall.md` / `.json` | D46 — 12 days saved, 2 confirmed then dropped (the Breeders' Cup days, whose program URL serves a foreign document) |

Every card these runs produced is PROGRAM_ONLY by construction — no consensus
source ever ran on an archived day — so their P/L figures measure Bottom Line
plus morning line and nothing else. Never read one as the live methodology's.
