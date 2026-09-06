# A day's entries as one zip upload

**Status: SPECIFIED, NOT SCHEDULED.** No deliverable IDs are claimed here — they get claimed
when the work is picked up. Written 2026-09-06 from a user request, and **every claim below
was checked against the code, against a real 91-file zip, and against the live database**
rather than assumed.

## The workflow this serves

On race day, an agent collects every track's Equibase entries page and zips them. One upload
into BetSheet then creates every race day for that date, so the LLM generator, the ticket
builder and the card sheet all have a full board to work from without 20-odd manual uploads.

The one-file path already works end to end (D116), and D122 proved the parser across 91 real
pages and 39 tracks. This is the ergonomics layer on top of it.

---

## Re-upload replaces the day, cards and all — decided, not a blocker

**User decision 2026-09-06.** Re-ingesting a race day deletes it and everything on it, cards
included, and that is the intended behaviour: entries are the record, and a card built on
entries that have since changed is not worth carrying forward.

This section previously called that a blocker and made fixing it a prerequisite (Z-0). It was
wrong about the intent, not about the mechanics — those are worth keeping, because anyone
reading this should know exactly what a re-upload costs. `server/ingest.js` does
`DELETE FROM race_days` before re-inserting, and `cards` cascades. Measured on a scratch
database:

| | before replace | after |
| --- | --- | --- |
| cards | 1 | **0** |
| tickets | 1 | **0** |
| human_race_state | 1 | **0** |

`llm_card_requests` (paid model responses) and `llm_notes` go the same way. None of it is
soft-deleted.

So the bulk path makes replacement **opt-in per upload** (`?replace=1`, a checkbox in the
preview that says what goes) rather than refusing it. A guard was built and then removed on
2026-09-06 when the decision was clarified; it is not coming back unless the decision changes.

## What was verified

### The zip itself, from the real artifact

The 91-file zip supplied 2026-09-06:

- **all 91 entries DEFLATE** (method 8), no zip64, no encryption, no streamed data descriptors
- 68.3 MB raw → 7.1 MB compressed, **ratio 0.10**

A single race day is 8–23 tracks (the corpus holds 21 on 2026-09-06, 23 on 09-07), so a
one-day zip is roughly **1.5–2 MB compressed, 15–17 MB raw**.

### That sizing decides where the unzip happens

`server/index.js` mounts `express.json({ limit: '10mb' })`. A day's **raw** HTML is 15–17 MB,
so the D116 approach — read the file in the browser and post the markup as JSON — **exceeds
the body limit** for a full board. Posting each file as its own request avoids that, at 23
round trips and 23 preview/save cycles to keep coherent.

The zip is 10× smaller than what it contains. Posting the **zip** is ~2 MB and one request.

**Recommendation: server-side unzip, raw `application/zip` body.** That is also the
established convention here — `express.raw({ type: 'application/pdf', limit: '30mb' })` in
both `server/ingest.js` and `server/equibase-otr.js`, chosen in D69/D71 because "multipart
exists nowhere in this codebase".

Note this reverses D116's "the server never opens a file" posture, and deliberately: the
server still never touches the filesystem or a path, it decompresses a byte buffer the client
sent. The property that mattered — no path traversal, no server-side file access — is kept.

### A zip reader is a new dependency, or ~100 lines

The project has **seven** runtime dependencies and no zip library; `zlib` is present but does
gzip streams, not zip archives.

Because every entry in the real artifact is DEFLATE with no zip64 and no encryption, a reader
is: parse the End of Central Directory record, walk the central directory, `inflateRawSync`
each entry. That is squarely in this codebase's character — the hand-rolled Anthropic client,
the raw-body PDF uploads, `no SDK` — and it avoids auditing a dependency that exists to parse
untrusted binary input.

**Recommendation: hand-rolled, in `server/zip-read.js`, refusing what it does not support**
(encrypted entries, zip64, unknown compression methods) with a clear message rather than
guessing. A zip the reader cannot read is a bad upload, not a silent partial import.

**It must be bounded, and this is the security-relevant part.** The archive is untrusted input
and decompression is an amplifier — the real sample is 10:1 and a hostile one can be
1000000:1. The reader needs a cap on entry count, on per-entry decompressed size, and on total
decompressed bytes, enforced *during* inflation rather than after. Path traversal ("zip slip")
is moot only as long as nothing is ever written to disk — which is the design, and worth
stating so it stays true.

### The agent, and where invariant 6 actually sits

Invariant 6 says never scrape Equibase, and D113 made it structural: there is no HTTP client
left in this codebase. **Accepting a zip does not change that** — BetSheet still receives only
a file a person or their tooling uploaded, exactly as with the OTR PDF (D71) and the single
entries page (D116). The invariant governs this codebase, and it holds.

What *is* a design requirement: **Equibase actively blocks scripted fetching**, so an agent
collecting 23 pages will sometimes capture a bot-challenge page, a rate-limit page or an error
page. Those are HTML, they will zip up looking like everything else, and the parser will
report zero races.

D121 already established the pattern for exactly this: an entries-page parse that finds
nothing should say *which* wrong thing it got. `index_page_not_entries` covers the race-card
index; a challenge or error capture needs the same treatment, so a batch of 23 says "4 of
these are not entries pages" rather than "4 days had no races".

### What already exists and should be reused, not reinvented

- **Batch policy A (D43):** zero blocking warnings saves without a click; any blocking warning
  leaves the day unsaved and listed for review. Already the batch-ingest convention here, and
  already the exception invariant 9 carves out for batch paths. `npm run ingest-otr` follows
  it for OTR PDFs, and it is the right shape for a zip too.
- **`scripts/batch-import-equibase-entries.js` (D121/D122)** already does parse → real writer
  → read-back verification over a directory. The zip route's server half is that loop with a
  zip reader in front and a real database behind, so the two should share the per-file logic
  rather than drift.
- **`insertRaceDay` is the one writer** and already handles every Equibase column, the
  provenance value and `odds_captured_at`.
- **Per-file capture time:** `odds_captured_at` currently comes from the browser's
  `file.lastModified`. A zip entry carries its own DOS timestamp, so each day can keep its own
  real capture time instead of one time for the whole upload — worth taking, since D117's
  staleness indicator reads exactly that field.

---

## The deliverable shape

Three. **Delivered as D127** (2026-09-06); the sequencing note that used to head this section is gone with the Z-0 prerequisite it described.

### Z-1 — `server/zip-read.js`: a bounded, refusing zip reader

Pure-ish (`node:zlib` only), no dependency. Reads the central directory, inflates entries,
enforces the caps above, refuses encrypted/zip64/unknown-method archives by name. Returns
`[{ name, bytes, modifiedAt }]`.

**Done when:** it reads the real 91-file archive entry for entry against Python's `zipfile`
as an independent oracle; a crafted bomb is refused at the cap rather than exhausting memory;
an encrypted and a truncated archive each produce a clear error, not a partial result.

### Z-2 — The batch ingest itself

`POST /api/parse/equibase-entries-zip` (raw `application/zip`): unzip, parse every `.html`,
return a **preview** — one row per file with track, date, races, entries, warnings and the
save disposition — writing nothing (invariant 9). Then a confirm that saves under policy A,
each day through `insertRaceDay`, each with its own entry timestamp, all in one transaction
per day so a bad file cannot half-write a good one.

Non-entries pages (index, challenge, error) are identified as such per D121's pattern.

**Done when:** the real 91-file zip previews 91 rows and saves 91 days with zero crashes and a
clean read-back; a zip containing one index page and one challenge page reports both by name
and saves neither; a day that would collide obeys whatever Z-0 decided.

### Z-3 — The UI

One "Upload a day's entries (zip)" control on the new-race-day screen, the preview table, and
a confirm. Existing days in the zip are shown with what will happen to them **before** the
click, not after.

**Done when:** a real zip goes from file picker to N saved days in the browser, and the
preview's disposition column matches what the save actually does, file for file.

---

## Decisions the operator owns

1. **Which re-upload behaviour** (Z-0's three options). This is the one that changes the shape
   of everything else, and it is a workflow question rather than a technical one: is the
   mid-afternoon refresh worth carrying cards across an entries change?
2. **One zip, one date — enforced or not?** The request says "for a day". The real archive
   held seven dates. Enforcing one date makes the preview simpler and catches a mis-built zip;
   allowing many makes the tool more useful and is already proven to work. Recommend
   **allowing many, warning when a zip spans dates**, since nothing breaks either way.
3. **The caps** — entry count, per-entry size, total decompressed. Suggest 500 / 20 MB / 200 MB,
   which clears the real archive by a wide margin (91 entries, 660 KB largest, 68 MB total).

---

## What this does not cover

Results ingestion (charts stay per-day), OTR sheets, and anything about *how* the zip is
produced — that is the agent's business, and BetSheet's contract is the file it is handed.
Nothing here changes grading, and nothing here bumps `ENGINE_VERSION`.
