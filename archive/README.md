# Frozen pre-pivot corpus

**This is not a live corpus. Nothing in the application reads from this directory.**

Frozen 2026-09-06T04:53:19Z, before the simulator/analyzer pivot began removing the
consensus engine, program ingestion and eventually the database itself
(see `docs/decisions/2026-09-05-simulator-pivot.md`).

## Why it exists

Most of what is here cannot be rebuilt from source files at any price:

- the blind-play timestamps invariant 15 derives blindness FROM, in `human_race_state`
- the LLM request log - paid, nondeterministic answers that would come back different
- consensus picks for past dates that are no longer fetchable from any source
- the 50 simulation runs `docs/findings/lean-1.1-program-only.md` cites by id

## What is here

| | |
| --- | --- |
| `betsheet-pre-pivot-2026-09-06.db` | 23.9 MB, `VACUUM INTO` snapshot with the WAL folded in |
| sha256 | `90204a10875a78c0a4a548b0cee389ee6a945326b22de676ff99d2bc398af7b7` |
| `exports/` | 106 card trace exports, the same document `GET /api/cards/:id/export` serves |
| `MANIFEST.json` | machine-readable index: per-card P&L, outcomes, trace status, and every refusal with its reason |

108 cards exist; **106 exported, 2 refused**.
The refusals are cards on soft-deleted race days, which the exporter excludes by
design (invariant 12) - they remain in the database snapshot, which is the point of keeping
both artifacts:

- card 100 (Del Mar 2025-10-31)
- card 101 (Del Mar 2025-11-01)

105 of the exported cards are graded. 23 carry a `traceStatus` other than
`complete`, meaning their decision-trace log files were rotated away or lost to an earlier
factory reset - the export flags that honestly rather than exporting silence, and it is a
property of the history, not of this archive.

## The exports are NOT a substitute for the snapshot

A card export carries recipe, races, entries, consensus picks, sources, allocations, tickets
with their grades, the day's results and the decision trace. It does **not** carry:

- `llm_card_requests` - the raw model prompts and responses, paid for and nondeterministic
- `human_race_state` - the lock/reveal timestamps invariant 15 derives blindness FROM
- `simulation_runs` - the 50 runs the findings doc cites by id
- `llm_notes` - the analyst notes fed to the generator

Those exist **only** in the `.db` snapshot. That is why both artifacts are committed rather
than just the readable one: a factory reset plus one disk failure would otherwise lose them
permanently, and none of them can be regenerated at any price.

## Rules

- **Never migrated forward.** If a later schema change makes the `.db` unreadable, that is
  expected; the JSON exports are the durable form.
- **Never read by the app**, in tests or at runtime. Fixtures promoted for regression testing
  are copied into `tests/fixtures/`, not referenced from here.
- **Never edited.** Regenerating it after removals had begun would freeze the wrong thing,
  which is why the script refuses to clobber an existing archive without `--force`.
