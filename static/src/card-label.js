// Who made a card, as a short label (D364).
//
// emubets.com labels every selection with its TIPSTER ("Top Pick", "Form
// Pick", "Emu Pick") and shows the three side by side for each race. This
// app's equivalent of a tipster is a card's PRODUCER: a human, an LLM (by
// model), Equibase's Off to the Races sheet, or a tip sheet - which is
// exactly what invariant 13's completeness buckets already separate. The
// label is derived from the fields the payload already carries; nothing is
// added to the payload for it.
//
// `chip` is the modifier `client/src/styles.css`'s `.chip--*` rules already
// define for these same producers (CardSheet.jsx picks them the same way).

export function producerOf(card) {
  const template = card.template ?? '';
  const variant = card.variant && card.variant !== 'default' ? card.variant : null;
  if (template === 'human') {
    return { kind: 'human', chip: 'human', label: 'Human', detail: variant };
  }
  if (template === 'llm') {
    const model = card.llm_model_label ?? card.llm_model ?? 'model';
    return { kind: 'llm', chip: 'llm', label: `LLM · ${model}`, detail: variant };
  }
  if (template === 'equibase-otr') {
    return { kind: 'equibase-otr', chip: 'equibase-otr', label: 'Equibase OTR', detail: variant };
  }
  if (template === 'tipsheet') {
    // A tip-sheet card's name is "<source> — <variant description>"
    // (server/tip-picks.js); the source is the tipster, the rest the play.
    const [source, play] = String(card.name ?? '').split(' — ');
    return { kind: 'tipsheet', chip: 'tipsheet', label: source ? `Tip sheet · ${source}` : 'Tip sheet', detail: play ?? variant };
  }
  return { kind: 'engine', chip: 'guess', label: card.engine_version ?? 'engine', detail: card.consensus_completeness ?? null };
}

/** "Human · card #1", "LLM · Sonnet 5 · card #3 (higher-reward)". */
export function cardTitle(card) {
  const p = producerOf(card);
  return `${p.label} · card #${card.card_number}${p.detail ? ` (${p.detail})` : ''}`;
}
