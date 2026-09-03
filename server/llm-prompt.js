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
  e.g. "$20".
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
  if (!consensusTable?.length) {
    lines.push('No external consensus on file for this race - program analysis and morning line only.');
  } else {
    for (const s of consensusTable) {
      const top = s.top ? `#${s.top.programNumber} ${s.top.horseName}` : '—';
      const second = s.second ? `#${s.second.programNumber} ${s.second.horseName}` : '—';
      const third = s.third ? `#${s.third.programNumber} ${s.third.horseName}` : '—';
      const flagged = s.flagged?.length ? `, watch/contrarian: ${s.flagged.map((f) => `#${f.programNumber} ${f.horseName}`).join(', ')}` : '';
      lines.push(`${s.name}: top ${top}, 2nd ${second}, 3rd ${third}${flagged}`);
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
