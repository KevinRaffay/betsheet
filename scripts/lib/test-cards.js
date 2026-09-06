// Card creation for check scripts, after D111 removed the engine.
//
// Every server-side check script used to make its cards the same way:
// POST /api/race-days/:id/cards, the engine's generate route. That route is
// gone with the engine, and the three producers that remain (Equibase OTR
// upload, LLM generation, human entry) each need something the engine did
// not - a PDF, a model call, or pasted text.
//
// Human entry is the cheap one: no file, no API key, no stub, and it is a
// real production write path rather than a test-only shim, so a card made
// here is row-for-row a card a person makes. That is why every script now
// routes through this helper instead of each growing its own copy.
//
// The tickets are deliberately DULL - a win bet, sometimes an exacta box -
// because no script here is testing ticket construction. They are testing
// what happens to a card once it exists: grading, export, P/L bucketing,
// the delete guards. Anything that needs a specific ticket shape builds its
// own text and passes it in.

/** One `$<amount> W <pgm>` line - the simplest ticket the parser accepts. */
export const winText = (pgm, dollars = 20) => `$${dollars} W ${pgm}`;

/** A win plus an exacta box, for a card that should carry more than one row. */
export const winAndBoxText = (pgms, dollars = 10) =>
  `$${dollars} W ${pgms[0]} / $2 EX BOX ${pgms.slice(0, 3).join('-')}`;

/**
 * Lock one or more races as a HUMAN card and return its id.
 *
 * `post(path, body)` is the script's own JSON POST (it must return the
 * fetch Response). `races` is [{ race, text }] or [{ race, pass: true }];
 * the first save mints the card, the rest append to it - the same threading
 * ReplayDayBuilderModal does, and the reason cardId is carried through the
 * loop rather than passed in.
 *
 * Throws on the first refusal, with the server's own message, so a script
 * fails where the card could not be made rather than three assertions later
 * on an undefined.
 */
export async function makeHumanCard(post, dayId, races, { cardId = null } = {}) {
  let id = cardId;
  for (const r of races) {
    const res = await post(`/api/race-days/${dayId}/human-cards`, { ...r, cardId: id });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`human-cards refused race ${r.race} on day ${dayId}: `
        + `${res.status} ${body.error ?? JSON.stringify(body)}`);
    }
    id = body.cardId ?? body.id ?? id;
  }
  return id;
}

/** Program numbers of the day's unscratched entries, per race, from GET /race-days/:id. */
export function livePgms(day) {
  return Object.fromEntries((day.races ?? []).map((r) => [
    r.number,
    (r.entries ?? []).filter((e) => !e.scratched).map((e) => e.program_number),
  ]));
}
