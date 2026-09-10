# Race day calendar: a day's races, one matrix, close to post

**Status: SPECIFIED, NOT SCHEDULED.** No deliverable ID is claimed here — one
gets claimed (`npm run allocate-deliverable`) when a phase below is picked up,
per phase, the same way `multi-parser-entries-ingest.md` and
`zip-entries-upload.md` are worked. Written 2026-09-10 from a user request,
checked against the schema, the ingest/parse code, and the existing UI
conventions rather than assumed.

## The workflow this serves

Race days already land in the corpus one at a time, each independently dated
and tracked (`race_days`, one row per track+date — the user has confirmed
**one race day per track is a safe assumption for this feature**). What does
not exist today is a single screen answering "what is racing, and when,
across every track, right now" — `RaceDayList.jsx` is a flat table sorted by
date/track with no time-of-day dimension at all. The goal stated by the user:
**get to a track's race day as close to its next post as possible**, so a
card can be built shortly before the window opens rather than hours ahead
(when the field can still change) or after it closes.

The requested shape: a button from the race-day list opens a calendar view,
defaulting to today, showing a matrix — tracks as rows, hourly columns
starting 10:00 AM ET, 24 of them — where a populated cell reads `Race N -
H:MM <zone>` and is a hyperlink straight to that track's stored race day
(`/day/:id`). **Navigating to a specific race within that day is explicitly
out of scope** — there is no per-race route in this codebase to link to
anyway (`client/src/routes.js` only ever parses `day/:id` and `card/:id`),
so the calendar's job stops at the race day.

## What was checked against the code

### The post time exists, but with no zone attached — the one real problem here

- `races.post_time` (`server/migrations/001-initial.sql:30`) is `TEXT`, and no
  later migration adds a zone column to `races` or `race_days`.
- `shared/parsers/equibase-entries.js` parses the page's own printed header
  (`POST Time - 2:00 PM PT`) into two separate values — a bare time string
  and, only when the page prints one, a zone abbreviation — but
  `server/ingest.js`'s `insertRaceDay` (`server/ingest.js:167-179`) only
  writes `race.postTime` into `races.post_time`; the parsed zone is read and
  then **thrown away**, never persisted anywhere.
- `shared/staleness.js` (lines 18-34) already documents the consequence for a
  different feature (has-this-race-run) and refuses to guess: *"`races.
  post_time` is a printed local string ("2:00PM") with no zone... Comparing
  that to a viewer's clock silently assumes the viewer sits in the track's
  timezone, which is wrong for a Californian card read from the east coast."*
  It also already ships a reusable pure helper, `postTimeMinutes(printed)`
  (`shared/staleness.js:49-58`), that parses exactly this stored format
  (`"2:00 PM"` → minutes past local midnight) — the calendar should call
  this, not write a second copy of the same regex.
- `shared/track-codes.js`'s `REGISTRY` (39 tracks) carries `{code, display,
  aliases}` and **nothing about timezone**, confirmed by reading the whole
  file — there is no track→zone mapping anywhere in `shared/`, `server/`, or
  `client/`.

**This is the one design question that decides how correct the matrix can
be**, addressed under "Decisions" below — a shared 10am-ET-anchored column
grid, by construction, needs every track's local post time converted to
Eastern before it can be placed in a column, and that conversion needs a
timezone, which today does not exist anywhere in this codebase.

### What already exists to build on

- `GET /api/race-days` (`server/ingest.js:317-333`) lists non-deleted days
  with counts, but no per-race post times and no `?date=` filter — a new,
  separate read endpoint is cleaner than overloading this one, matching how
  `server/distribution.js` and `server/pl.js` are already separate
  read-only reporting modules layered over the same tables rather than
  extensions of `ingest.js`.
- `GET /api/race-days/:id` (`server/cards.js`) already returns each day's
  `races` rows (including `post_time`) — the calendar's query is the same
  shape, just across every day for one date instead of one day's own races.
- **A matrix table already exists as UI precedent**: `PLView.jsx`'s
  `RaceMatrix` (`client/src/components/PLView.jsx:271-313`) is rows × columns
  built dynamically from data, rendered as `<table className="grid
  grid--matrix">`, with `—` for an empty cell (`.grid--matrix` styling
  already in `client/src/styles.css`). The calendar's grid is the same
  pattern with tracks as rows and fixed hour labels as columns instead of a
  dynamic card list.
- Routing is a plain string parser with no library
  (`client/src/routes.js:3-36`) and view switching in `App.jsx` is a flat
  sequence of `{view.name === 'x' && <Component/>}` blocks
  (`client/src/App.jsx:63-122`), each wired from `RaceDayList`'s own nav
  buttons (`onPL`, `onDistribution`, `onReplay`). Adding `calendar` follows
  the exact same three-line pattern as `distribution` did.
- Invariant 12 (soft delete) and invariant 6 (no live fetch, ever) both apply
  unchanged: the calendar reads only already-ingested `race_days`/`races`
  rows with `deleted_at IS NULL`, and triggers no network call of its own.

## The deliverable shape

Three phases, each independently reviewable and independently useful even if
the ones after it are never picked up.

### C-1 — per-track timezone data + a pure hour-bucketing helper

Add an IANA zone to every entry in `shared/track-codes.js`'s `REGISTRY`
(a static data fact about each track's real-world location — not a live
fetch, so invariant 6 is untouched) and export it from `canonicalizeTrack`'s
result (a new `timezone` field, `null` for an unrecognized/derived-code
track — never guessed). New pure module `shared/race-calendar.js`:

- `localWallClockToUtc(dateStr, timeStr, ianaZone)` — converts a track's
  printed local post time on a given calendar date into a real UTC instant,
  correctly crossing DST, using the standard `Intl.DateTimeFormat`
  round-trip technique (format a UTC guess in the target zone, diff against
  the guess, correct) — no new dependency, matching this codebase's existing
  preference for hand-rolled conversions over a library (the same call made
  for the zip reader in D127).
- `hourBucket(utcInstant)` — the column index 0-23 in the 10:00 AM ET
  anchored grid (`Intl.DateTimeFormat` with `timeZone: 'America/New_York'` to
  read the ET hour, then `(etHour - 10 + 24) % 24`).
- Both take `postTimeMinutes` from `shared/staleness.js` as their time-string
  parser rather than re-implementing it.

**Done when:** unit tests cover every registry zone at least once, a
same-track-different-season pair proving DST is handled (e.g. a July post
time and a January post time landing in the same ET column), a post time
with no parseable format returning `null` rather than throwing, and an
unrecognized track (`timezone: null`) returning `null` rather than a guessed
bucket.

### C-2 — `GET /api/calendar?date=YYYY-MM-DD`

New `server/race-calendar.js` (mirroring `server/distribution.js`'s shape: a
small standalone read-only router over existing tables, mounted in
`server/index.js` next to the other `app.use('/api', ...Router)` lines).
Query: every `race_days` row for the date with `deleted_at IS NULL`, joined
to its `races` (`number`, `post_time`), returning per track: `{raceDayId,
track, trackCode, timezone, races: [{number, postTime, postTimeZone:
<printed, if any>, hourBucket}], unplaceable: [<race numbers with no
parseable post time>]}`. A race with no parseable post time or an
unrecognized track's races are **never silently dropped** — they come back
under `unplaceable`/a distinguished bucket so the count is visible
(invariant 11's spirit, generalized from "a failing source" to "data this
report can't place").

**Done when:** a seeded temp database with race days across at least three
different timezones on one date returns the correct hour bucket for each
(hand-computed against the real UTC offset for that date), a deleted day is
excluded, a day with a null post time is excluded from `races` but counted
in `unplaceable`, and an empty date returns an empty list rather than an
error.

### C-3 — the client view

New `client/src/components/RaceDayCalendar.jsx`: a date input defaulting to
the browser's own local today (`new Date()`, formatted `YYYY-MM-DD` — this
is a client-only concept, there is no server clock to defer to), fetching
`getCalendar(date)` (new `client/src/api.js` export, same `fetch`+`asJson`
convention as every other read there) on mount and on date change, guarded
against a stale response the same way `RaceDayList.jsx` already is
(`client/src/components/RaceDayList.jsx:35-41`'s `cancelled` pattern —
D118's own documented gotcha). Renders a `grid grid--matrix` table: one row
per track (sorted by earliest post that day), 24 `<th>` columns labelled
`10:00 AM ET` … `9:00 AM ET`, each populated cell a clickable element
(matching this codebase's existing row/cell click convention rather than a
literal `<a href>`, since navigation is client-side view state, not a URL
load) reading `Race N - H:MM <zone>` — the race's **own local time and
printed zone**, not the ET-converted time; only the column position is
ET-normalized. Multiple races from one track landing in the same hour render
stacked in the same cell. A footer line reports the `unplaceable` count when
non-zero, never hiding it. New route `calendar` in `routes.js` (`/calendar`)
and a `calendar` view block in `App.jsx`, wired from a new button on
`RaceDayList.jsx` beside the existing `onPL`/`onDistribution`/`onReplay`
buttons.

**Done when:** browser-verified against a seeded day spanning tracks in at
least two zones — the matrix renders with each race in the visually correct
column, clicking a populated cell opens that track's `/day/:id`, an empty
day shows a placeholder message, and the date input moves between days
without a page reload.

## Decisions the operator owns

1. **Building a 39-track timezone table vs. a cheaper, less correct
   alternative.** The user's own framing — "hour blocks... starting at 10
   am EST" as one shared timeline across every track — only means something
   if every track's post time is actually converted to Eastern; the
   alternative (bucket every track by its own printed hour, ignoring zone
   entirely) is far cheaper to build but makes the grid's column position
   meaningless the moment two tracks in different zones appear side by
   side, which is the normal case on any real race day. **Recommend:**
   build the table (C-1) — it is a bounded, one-time, static-data addition
   (city/track geography, not anything fetched), and every track already in
   the registry has a well-known, easily-verified home timezone.
2. **What "today" means.** Recommend the browser's own local date — this
   app has no server-side session or "the user's day" concept anywhere else
   (`RaceDayList`'s own date filter is client-derived), and a person opening
   the calendar cares about their own clock, not the server process's.
3. **Whether to allow navigating to an adjacent date at all.** The user's
   spec says "default to current day"; a single date input is close to free
   once C-2 already takes `?date=` as a parameter, and lets the same screen
   answer "what's racing tomorrow" without a second feature. Recommend
   including it, defaulting to today.
4. **Whether a race the calendar cannot place (no post time, or a track with
   no known zone) should be silently absent from the grid, or surfaced by
   count.** Recommend surfaced — CLAUDE.md's invariant 11 ("a failing source
   must be visible") and D117's own staleness module both establish this
   codebase's standing preference for a visible count over a silent gap.

## What this does not cover

Navigating to an individual race within a day (no such route exists to link
to); building or editing a betting card from the calendar itself (that stays
`/day/:id`'s job); anything about a day carrying more than one race day per
track (explicitly assumed away by the user for this feature — if that
assumption is ever revisited, `GET /api/calendar` would need a documented
answer for a track appearing twice on one date, which today's `race_days`
schema already allows via a different date, but not via two rows for the
*same* track+date — `UNIQUE (track, date)` forbids it); and any change to
how post time or its zone is captured or persisted at ingest — persisting
the parser's already-discarded zone is a separate, small, ingest-side
question (a real gap this doc found, not created) worth its own decision
about whether it should ever override or merely cross-check the registry
zone from C-1, and is left unscheduled here since the registry approach
alone is sufficient to build the calendar.
