/* eslint-env serviceworker */
// Offline shell for the at-the-track ticket builder (D155).
//
// Not a data-loss concern directly - cards live in IndexedDB and leave as
// files - but a dead zone at the track that stops the app LOADING costs the
// same afternoon as losing one. A phone on cellular in a concrete grandstand
// is the expected environment, not the edge case.
//
// Hand-written, no Workbox, no build plugin. Vite hashes asset filenames, so a
// precache manifest would have to be generated at build time; runtime caching
// gets to the same place - "loads fully offline after one online visit", which
// is exactly D155's done-when - with nothing to keep in sync.
//
// THE STALE-PAYLOAD RULE IS THE WHOLE DESIGN. A redeployed race day must never
// be served from cache, because a payload that is one day old is not a stale
// page, it is the WRONG RACES, and every ticket built against it would be
// refused on import (the payloadHash check, D153). So the three request kinds
// get three different strategies:
//
//   * payload.json  - NETWORK FIRST, cache only as a fallback. Online, you
//                     always get today's race day. Offline, you get the last
//                     one that reached this phone, which is the right answer
//                     when the alternative is no app at all.
//   * navigations   - NETWORK FIRST. index.html names the hashed asset files,
//                     so serving an old one would pin the app to old bundles
//                     that a new deploy may already have removed.
//   * /assets/*     - CACHE FIRST, and safely so: the filenames are content
//                     hashes, therefore immutable. A new build produces new
//                     names, never new contents under an old name.

const VERSION = 'v2';
const CACHE = `betsheet-static-${VERSION}`;

// The fixed part of the shell. The hashed bundles are added alongside it by
// shellAssets() below; anything else (a favicon, a font) arrives through the
// fetch handler.
const SHELL = ['./', './index.html', './payload.json'];

/**
 * The hashed bundle filenames, read out of index.html at install time.
 *
 * This exists because ONE online visit has to be enough (D155's done-when),
 * and on a first visit it is not: the page's own <script> and <link> requests
 * are issued before this worker has activated, so the fetch handler never sees
 * them and nothing caches them. Without this, offline would work only from the
 * SECOND visit - which at a racetrack means it does not work.
 *
 * Reading them from the shell rather than from a generated precache manifest
 * keeps the worker in step with whatever Vite just built, with nothing to
 * regenerate and nothing that can go stale.
 */
async function shellAssets() {
  try {
    const res = await fetch('./index.html', { cache: 'no-store' });
    if (!res.ok) return [];
    const html = await res.text();
    return [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)]
      .map((m) => new URL(m[1], self.registration.scope).href);
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = [...SHELL, ...await shellAssets()];
    // addAll is all-or-nothing; a single 404 would leave the install failed
    // and the app with no offline story at all. Each entry is added on its
    // own so a missing one degrades rather than breaks.
    await Promise.all(urls.map((url) => cache.add(url).catch(() => {})));
    // Take over immediately rather than waiting for every tab to close. Safe
    // here precisely because the shell and the payload are network-first: a
    // new worker cannot pin an old page.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const isPayload = (url) => url.pathname.endsWith('/payload.json');
const isHashedAsset = (url) => url.pathname.includes('/assets/');

/**
 * `ignoreVary` is REQUIRED here, not a loosening. Found live while testing the
 * offline load: Vite emits `<script crossorigin>` for its module bundle, so
 * the browser sends those requests with an `Origin` header - while the
 * install-time `cache.add()` fetches them without one. A server that answers
 * `Vary: Origin` (vite preview does; static hosts commonly do) therefore makes
 * every cache lookup MISS on exactly the requests the page needs, `cacheFirst`
 * falls through to the network, and the whole app fails to load offline while
 * the cache sits there full of the right files. The shell loads, the bundle
 * does not, and the screen is blank.
 *
 * Ignoring Vary is safe for what this worker caches: same-origin, content-
 * hashed, immutable files whose bytes cannot differ by request header.
 */
const MATCH = { ignoreVary: true };

async function networkFirst(request, cache) {
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    // Only a real success is worth keeping. A 404 or a captive-portal redirect
    // cached as the payload would be worse than having nothing cached.
    if (fresh && fresh.ok && fresh.type !== 'opaque') cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(request, { ...MATCH, ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline and not cached');
  }
}

async function cacheFirst(request, cache) {
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh && fresh.ok && fresh.type !== 'opaque') cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // GET only, same origin only. A cross-origin request has no business being
  // rewritten by this worker, and there are none in this app by design.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    if (request.mode === 'navigate') {
      try {
        return await networkFirst(request, cache);
      } catch {
        // Hash routing means every route is the same document, so the cached
        // shell answers `#/race/3` as correctly as it answers `#/`.
        return (await cache.match('./index.html', MATCH))
          ?? (await cache.match('./', MATCH))
          ?? new Response('This race day has not been loaded on this device yet, and you are offline.',
            { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    }

    if (isPayload(url)) return networkFirst(request, cache);
    if (isHashedAsset(url)) return cacheFirst(request, cache);

    // Anything else same-origin (the favicon, a font): try the network, fall
    // back to whatever is held.
    try {
      return await networkFirst(request, cache);
    } catch {
      return (await cache.match(request, MATCH)) ?? Response.error();
    }
  })());
});
