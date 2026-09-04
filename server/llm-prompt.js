// LLM card prompt (D63): builds the exact per-race system/user prompt
// documented in docs/prompts/llm-card-v1.md, and extracts the ticket
// block back out of the model's response. Pure - no network, no DB.
// Keep this file and the doc in sync when the template changes.

const TICKET_BLOCK_START = '<<<TICKETS>>>';
const TICKET_BLOCK_END = '<<<END TICKETS>>>';

export const SYSTEM_PROMPT = `You are an expert horse racing handicapper. You will be given ONE race
from a printed program - the entries, the morning line, program
handicapper rankings, and (if available) the program's own Bottom Line
analysis - plus the consensus picks already gathered from external
sources for this race. Analyze the race and propose betting tickets
against a fixed bankroll for THIS RACE ONLY.

Rules:
- Only bet horses that appear in the entries below, by their exact
  program number. Never invent a horse or a program number.
- Never bet a scratched horse.
- Your total stakes for this race must not exceed the race bankroll
  given below.
- Include longshots where you see value, and same-race exotics
  (exacta / exacta box / trifecta / trifecta box / superfecta /
  superfecta box) where warranted - no multi-race wagers (Daily
  Double, Pick 3, etc.) in this version.
- Respond in two parts: your reasoning first (plain prose - explain
  which horses you like and why, referencing the entries, rankings and
  consensus given), then the ticket block, exactly as specified below.

Ticket block format - after your reasoning, output a line reading
exactly "${TICKET_BLOCK_START}", then one ticket per line in this exact
grammar, then a line reading exactly "${TICKET_BLOCK_END}":

  <bet type> | <selections> | <stake> | <rationale>

- <bet type>: one of win, place, show, exacta, exacta box, trifecta,
  trifecta box, superfecta, superfecta box (case-insensitive).
- <selections>: program numbers only, e.g. "#4". Straight bets
  (exacta/trifecta/superfecta, not boxed) separate finish positions
  with "/", e.g. "#4 / #2" (4 to win, 2 to place). Box types list
  every horse in the box separated by ",", e.g. "#4,#2,#7".
- <stake>: the TOTAL dollar amount for that ticket (not per-combo),
  e.g. "$20". For a BOX bet, the total must divide EXACTLY and EVENLY
  across every combination the box produces, with each combination's
  share a whole multiple of that wager type's base unit shown in the
  wager menu above. The number of combinations is:
    exacta box:     n x (n-1)
    trifecta box:   n x (n-1) x (n-2)
    superfecta box: n x (n-1) x (n-2) x (n-3)
  where n = how many horses you put in the box. Example: a $1 exacta
  box on 3 horses has 3 x 2 = 6 combinations, so a valid total is any
  multiple of 6 x $1 = $6 (e.g. $6, $12, $18) - NOT $16.50, which
  splits to $2.75 per combination, not a whole dollar. Compute
  combinations x base-unit FIRST, then pick your total as a multiple
  of that - never pick a total that merely "sounds right" and divide
  afterward. Prefer smaller boxes (3-4 horses) to keep this simple.
- <rationale>: one short sentence, required.

If you have no bet worth making on this race, output the block with
zero ticket lines between the markers - do not pad it with a bet you
don't believe in.`;

const dollars = (cents) => (cents / 100).toFixed(2);

/**
 * Builds the per-race user prompt. `race`: {number, surface, distance,
 * raceType, postTime, wagerMenu, bottomLineText}. `entries`:
 * [{programNumber, horseName, morningLine, programRank, bestBet,
 * scratched}]. `consensusTable`: shared/classification.js's
 * buildConsensusTable output ([{name, top, second, third, flagged}]).
 * `bankroll`: {perRaceCents, remainingCents, racesRemaining}.
 */
export function buildLlmRaceUserPrompt({
  raceNumber, totalRaces, track, date, race, entries, bottomLineText, consensusTable, bankroll,
}) {
  const lines = [];
  lines.push(`RACE ${raceNumber} of ${totalRaces} - ${track}, ${date}`);
  lines.push(`${race.surface ?? '?'} · ${race.distance ?? '?'} · ${race.raceType ?? '?'} · post ${race.postTime ?? '?'}`);
  lines.push(`Wager menu: ${race.wagerMenu ?? '?'}`);
  lines.push(`Race bankroll: $${dollars(bankroll.perRaceCents)} (${bankroll.racesRemaining} race(s) left of $${dollars(bankroll.remainingCents)} on this card)`);
  lines.push('');
  lines.push('ENTRIES');
  for (const e of entries) {
    const bits = [`ML ${e.morningLine ?? '?'}`];
    if (e.programRank != null) bits.push(`program rank ${e.programRank}`);
    if (e.bestBet) bits.push('BEST BET');
    lines.push(`#${e.programNumber} ${e.horseName}${e.scratched ? ' (SCRATCHED)' : ''} - ${bits.join(', ')}`);
  }
  if (bottomLineText) {
    lines.push('');
    lines.push('PROGRAM BOTTOM LINE');
    lines.push(bottomLineText);
  }
  lines.push('');
  lines.push('CONSENSUS');
  // D74: Equibase Off to the Races prints a show pick, a win pick and two
  // unranked box mentions - not a top/2nd/3rd order, so it gets its own
  // sentence in its own vocabulary rather than being forced through the
  // generic ranked line below (which would misrepresent an unranked box
  // mention as a "3rd" pick it never claimed to be).
  const OTR_SOURCE_NAME = 'Equibase Off to the Races';
  const otr = consensusTable?.find((s) => s.name === OTR_SOURCE_NAME);
  const others = (consensusTable ?? []).filter((s) => s.name !== OTR_SOURCE_NAME);
  if (!others.length && !otr) {
    lines.push('No external consensus on file for this race - program analysis and morning line only.');
  } else {
    for (const s of others) {
      const top = s.top ? `#${s.top.programNumber} ${s.top.horseName}` : '—';
      const second = s.second ? `#${s.second.programNumber} ${s.second.horseName}` : '—';
      const third = s.third ? `#${s.third.programNumber} ${s.third.horseName}` : '—';
      const flagged = s.flagged?.length ? `, watch/contrarian: ${s.flagged.map((f) => `#${f.programNumber} ${f.horseName}`).join(', ')}` : '';
      lines.push(`${s.name}: top ${top}, 2nd ${second}, 3rd ${third}${flagged}`);
    }
    if (otr) {
      const box = [otr.top, otr.second, ...(otr.flagged ?? [])].filter(Boolean);
      const boxText = box.map((p) => `#${p.programNumber}${p.horseName ? ` ${p.horseName}` : ''}`).join(', ');
      const show = otr.top ? `#${otr.top.programNumber} ${otr.top.horseName}` : '—';
      const win = otr.second ? `#${otr.second.programNumber} ${otr.second.horseName}` : '—';
      lines.push(
        `${OTR_SOURCE_NAME} (the free at-track sheet, algorithmic): `
        + `show pick ${show}; win pick ${win} (higher-reward tier); `
        + `${box.length}-horse exacta box ${boxText}.`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Splits a model response into the reasoning prose and the ticket-block
 * text (handed to shared/parsers/human-picks.js unmodified). Returns
 * null when the markers are missing entirely - a hard failure, nothing
 * safe to preview (see docs/prompts/llm-card-v1.md).
 */
export function extractTicketBlock(responseText) {
  const text = String(responseText ?? '');
  const startIdx = text.indexOf(TICKET_BLOCK_START);
  const endIdx = text.indexOf(TICKET_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return {
    reasoningText: text.slice(0, startIdx).trim(),
    ticketBlockText: text.slice(startIdx + TICKET_BLOCK_START.length, endIdx).trim(),
  };
}
