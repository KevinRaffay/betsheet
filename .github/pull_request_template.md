<!--
The layout a BetSheet PR description already had (D227) - CLAUDE.md's delivery
workflow asks for what it delivers, how it was tested with evidence, and any
deviations from plan, and the definition of done asks for three more things.
This file just writes that shape down so it does not have to be rebuilt from
memory each time, and so the PR-template lookup stops coming up empty.

Headings are a starting point, not a form to satisfy. Delete a section that
does not apply rather than writing "N/A" under it, and add your own where the
change needs them. Prose beats bullet-filling: the point is that a reader can
tell what landed and what proves it.
-->

## What this delivers

<!-- The change and the reason for it. Lead with the decision, the defect or
     the user request behind it - the file list is visible in the diff. -->

## How it was tested

<!-- Evidence, not assurances. The check scripts that ran, assertions added,
     negative controls run (and restored), anything driven in a browser and
     against which data. A number without its n, or a claim without the
     command that produced it, is not evidence. -->

## Deviations from plan

<!-- Anything built differently from what was asked or planned, and why -
     including scope deliberately left out. "None" is a complete answer. -->

## Definition of done

- [ ] `DELIVERABLES.md` row updated in this same PR (ID, phase, PR #/branch, status, notes)
- [ ] The right reference file updated in this same PR, if the change touched one:
  - `CLAUDE.md` - a changed invariant, workflow rule, house rule or gotcha
  - `docs/commands.md` - a command added, renamed, retired or changed in meaning
  - `docs/feature-status.md` - the feature's state and its one-paragraph row
  - `docs/architecture-map.md` - a file added, renamed or repurposed
- [ ] Verification scaled to what changed, with the category named above:
      presentation-only diffs need `npm run build` to exit 0; anything touching
      `shared/`, `server/`, parsers, the schema or an API contract needs the
      relevant check scripts to exit 0
- [ ] Any check script deliberately NOT run is named above with the reason
      (e.g. `check-static-app`, out of scope in a worktree per D168) - never
      left to read as though the whole suite ran clean
