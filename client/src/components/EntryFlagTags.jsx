import React from 'react';

// D216: the two entry-flag tags, in ONE place, because four different entries
// tables render them (the ingest preview, the day view, the shared entries
// dropdown and the card sheet) and a second hand-rolled copy is how the
// wording and the colour drift apart - the same reason `RaceNotes.jsx` (D165)
// and `EntriesTable.jsx` (D135) exist at all.
//
// D236 added the two BOARD tags - a price move and a new favorite - to the
// same one place for the same reason. They render only where a live price
// exists, so the ingest preview and the static at-track builder (neither of
// which has ever seen a board) are untouched without needing a prop.
//
// Presentation only. `shared/entry-flags.js` decides WHICH entries are
// flagged; this decides nothing and only says so on screen.

// The ratio, not the points: the Δ% column already prints the points and a
// second, differently-normalised points figure on the same row would read as
// a contradiction. `2.2x` says "the crowd backed this 2.2 times harder than
// the line predicted", which no column says.
const ratioLabel = (move) => {
  const strength = move.ratio > 1 ? move.ratio : 1 / move.ratio;
  return `${strength.toFixed(1)}x`;
};

const moveTitle = (move) => {
  const pts = move.delta * 100;
  const verb = move.direction === 'steam'
    ? 'Bet DOWN - shorter than the morning line predicted'
    : 'Let go - longer than the morning line predicted';
  return `${verb}. ${ratioLabel(move)} the share of the book the line gave it `
    + `(${pts > 0 ? '+' : ''}${pts.toFixed(1)} points, both books normalised over the runners priced in each). `
    + 'A label, not a recommendation: a steamer can be informed money and a drifter can be the value, '
    + 'and which one pays on this corpus is not yet measured.';
};

export default function EntryFlagTags({ flag }) {
  if (!flag) return null;
  return (
    <>
      {flag.baffert
        ? <span className="tag tag--blue" title="Trainer name contains &quot;Baffert&quot;.">BAFFERT</span>
        : null}
      {flag.favorite
        ? <span className="tag tag--green" title="Shortest morning line in a five-horse field.">FAV 5</span>
        : null}
      {flag.move
        ? (
          <span
            className={`tag tag--${flag.move.direction}${flag.move.magnitude === 'big' ? ' tag--move-big' : ''}`}
            title={moveTitle(flag.move)}
          >
            {flag.move.direction === 'steam' ? 'STEAM' : 'DRIFT'} {ratioLabel(flag.move)}
          </span>
        )
        : null}
      {flag.newFavorite
        ? (
          <span
            className="tag tag--newfav"
            title="Favorite on the live board, but not on the morning line - the crowd made a different favorite than the linemaker did."
          >NEW FAV</span>
        )
        : null}
    </>
  );
}
