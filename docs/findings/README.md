# Findings

One file per **(engine version, bucket, corpus)**, written from run IDs, with
every number citing the run it came from.

## Status after the pivot

The 2026-09-05 simulator pivot relaxed the discipline these files were written
under, from *"a hypothesis before any engine change"* to **"label everything,
conclude nothing until n is stated"**. That is a deliberate loosening, not an
abandonment: the old rule guarded an engine that has since been deleted (D111),
while the new one guards the analyzer replacing it.

| file | status |
| --- | --- |
| `lean-1.1-program-only.md` | **HISTORY.** The engine it describes is deleted, not superseded by a newer version, so no `lean-1.2` file will ever follow it. Never edited. |
| `llm-analyst-notes-v1.md` | **LIVE, with an amendment.** A pre-registration; its corpus is now split by a prompt change (D112). See the amendment in the file. |

## The rules, still in force for anything written here next

- Written from run or card IDs, never from memory, and every number cites its
  source.
- It states what is **not** concluded, and the exact question the next corpus
  must answer.
- **No P&L figure without its `n`.** This is the rule the pivot kept most
  deliberately: the pivot's own motivating anecdote ("Haiku cards are
  observably useless") turned out to rest on 1 card and 3 graded tickets, with
  Opus looking worse on more data. That is exactly the kind of impression the
  analyzer exists to replace, and it is recorded in the decision doc rather
  than quietly dropped.
- A file is never edited after the thing it describes is superseded. A
  correction to a *live* file is fine, with the date. An amendment that records
  a change in the world around the file - a deleted engine, a changed prompt -
  is not a revision of a finding and is allowed.
