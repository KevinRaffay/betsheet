import React, { useCallback, useEffect, useState } from 'react';
import { probeStorage, getMeta, setMeta, listCards, putCard, isUnexported } from './storage.js';
import { newDeviceId } from './card.js';
import { validateStaticPayload } from '@shared/static-payload.js';
import DayView from './DayView.jsx';
import RaceView from './RaceView.jsx';
import CardsView from './CardsView.jsx';
import { rollingBackup } from './exchange.js';

// The static ticket builder's shell (D151).
//
// This app is a CARD CONSTRUCTION SURFACE, not an instance of BetSheet. It has
// no corpus, no grading, no generation and no database - it reads one payload
// file and writes HUMAN cards into this browser. Everything it knows about the
// race day arrived pre-parsed (D150); everything it produces leaves as a file.
//
// HASH ROUTING, deliberately (D154): GitHub Pages serves static files and
// answers an unknown path with its own 404, so a History-API deep link would
// break on refresh. A fragment never reaches the server, so `#/race/3`
// survives a reload, a bookmark and a share with no SPA fallback to configure.
//
// The two things this shell owns that no view may bypass:
//
//  1. THE STORAGE GATE. Nothing buildable renders until `probeStorage` proves
//     a write survives a read. Refusing to start is the correct behavior in a
//     private window: an afternoon of cards built into a store that evaporates
//     at tab close is a strictly worse outcome than an app that would not open.
//
//  2. THE UNEXPORTED COUNTER. A card exists only in this browser until it is
//     exported, so the count of un-exported cards is the single most important
//     number on the screen and rides in the header on every route.

function useHashRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const m = /^\/race\/(\d+)$/.exec(raw);
    if (m) return { name: 'race', number: Number(m[1]) };
    if (raw === '/cards') return { name: 'cards' };
    return { name: 'day' };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (to) => { window.location.hash = to; };

/** The payload is a static asset beside index.html, so it moves with the deploy. */
async function loadPayload() {
  const url = new URL('payload.json', document.baseURI);
  // cache: 'no-cache' revalidates rather than serving a stale race day from
  // the HTTP cache after a redeploy. The service worker (D155) has its own,
  // stronger rule for the same problem.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`payload.json came back ${res.status}. No race day is deployed here yet.`);
  const payload = await res.json();
  const problems = validateStaticPayload(payload);
  if (problems.length) throw new Error(`The deployed payload is not valid:\n- ${problems.join('\n- ')}`);
  return payload;
}

export default function App() {
  const [storage, setStorage] = useState(null);
  const [payload, setPayload] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [cards, setCards] = useState([]);
  const [activeCardId, setActiveCardId] = useState(null);
  const [error, setError] = useState(null);
  const route = useHashRoute();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const probe = await probeStorage();
      if (cancelled) return;
      setStorage(probe);
      if (!probe.usable) return;
      try {
        let id = await getMeta('deviceId');
        if (!id) { id = newDeviceId(); await setMeta('deviceId', id); }
        const loaded = await loadPayload();
        if (cancelled) return;
        const held = await listCards(loaded.raceDay.raceDayId);
        // Which card is being built is itself durable state, not view state.
        // It looks like a UI preference right up until a refresh on
        // `#/race/3` comes back with no card selected and the race reading
        // "not played" - the draft is safe in IndexedDB, but the user has no
        // way to tell that from lost. Restored here, and only if that card
        // still exists.
        const remembered = await getMeta(`activeCard:${loaded.raceDay.raceDayId}`);
        if (cancelled) return;
        setDeviceId(id);
        setPayload(loaded);
        setCards(held);
        if (remembered && held.some((c) => c.cardId === remembered)) setActiveCardId(remembered);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    // An effect that fetches must guard against its own stale response
    // (CLAUDE.md, Gotchas) - and the cleanup must be a FUNCTION, never a
    // returned promise, or React unmounts the whole root on teardown.
    return () => { cancelled = true; };
  }, []);

  const reloadCards = useCallback(async () => {
    if (!payload) return;
    setCards(await listCards(payload.raceDay.raceDayId));
  }, [payload]);

  const saveCard = useCallback(async (card) => {
    const written = await putCard(card);
    await reloadCards();
    return written;
  }, [reloadCards]);

  const selectCard = useCallback((cardId) => {
    setActiveCardId(cardId);
    if (payload) setMeta(`activeCard:${payload.raceDay.raceDayId}`, cardId).catch(() => { /* a lost selection is recoverable; a thrown one is not */ });
  }, [payload]);

  // The rolling backup (D152), fired by RaceView after every lock or PASS.
  // Re-read from storage first so the file carries the write that just
  // happened rather than the card object the caller was holding.
  const backup = useCallback(async (cardId) => {
    if (!payload) return;
    const fresh = (await listCards(payload.raceDay.raceDayId)).find((c) => c.cardId === cardId);
    if (!fresh) return;
    await rollingBackup({ card: fresh, payload, deviceId });
    await reloadCards();
  }, [payload, deviceId, reloadCards]);

  const unexported = cards.filter(isUnexported).length;

  // The last line of defence, not the main one: drafts are already on disk
  // after every mutation, so this warns about cards that exist ONLY in this
  // browser and have never left it - which a closed tab does not destroy, but
  // a cleared site data does.
  useEffect(() => {
    if (unexported === 0) return undefined;
    const on = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [unexported]);

  if (storage && !storage.usable) {
    return (
      <div className="app">
        <header className="pagehead"><h1>BetSheet — at the track</h1></header>
        <div className="notice notice--error">
          <p><strong>This browser cannot keep your cards.</strong></p>
          <p>{storage.reason}</p>
          <p>
            Open this page in a normal (not private) window, and allow site data for it.
            Nothing is buildable until then — building a card that silently disappears
            would be worse than not starting.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <header className="pagehead"><h1>BetSheet — at the track</h1></header>
        <div className="notice notice--error"><pre className="wrap">{error}</pre></div>
      </div>
    );
  }

  if (!storage || !payload) {
    return <div className="app"><p className="dim">Loading the race day…</p></div>;
  }

  const active = cards.find((c) => c.cardId === activeCardId) ?? null;
  const day = payload.raceDay;

  return (
    <div className="app">
      <header className="pagehead pagehead--static">
        <div>
          <h1>{day.track} — {day.date}</h1>
          <p className="dim">
            {payload.races.length} races · building on device <code>{deviceId}</code>
            {!storage.persisted && (
              <> · <span className="tag tag--red">storage not persistent</span></>
            )}
          </p>
        </div>
        <div className="static-counter">
          <span className={unexported > 0 ? 'tag tag--gold' : 'tag'}>unexported: {unexported}</span>
          {' '}
          <button className="btn btn--sm" onClick={() => { window.location.hash = '/cards'; }}>Cards &amp; export</button>
        </div>
      </header>

      {!storage.persisted && (
        <div className="notice notice--warn">
          <p>
            This browser refused durable storage, so it may evict your cards to reclaim space.
            Nothing is wrong yet and nothing is lost — but export after every card rather than
            at the end of the day.
          </p>
        </div>
      )}

      {route.name === 'cards' ? (
        <CardsView
          payload={payload}
          cards={cards}
          deviceId={deviceId}
          onReloadCards={reloadCards}
        />
      ) : route.name === 'race' ? (
        <RaceView
          payload={payload}
          raceNumber={route.number}
          card={active}
          cards={cards}
          deviceId={deviceId}
          onSaveCard={saveCard}
          onSelectCard={selectCard}
          onBackup={backup}
        />
      ) : (
        <DayView
          payload={payload}
          cards={cards}
          activeCardId={activeCardId}
          deviceId={deviceId}
          onSelectCard={selectCard}
          onSaveCard={saveCard}
          onReloadCards={reloadCards}
        />
      )}
    </div>
  );
}
