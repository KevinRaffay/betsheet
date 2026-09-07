// Is this a phone? (D158)
//
// Some layout decisions cannot be made in CSS. `<details open>` is the case
// that forced this file into existence: a stylesheet can hide a panel, but it
// cannot make an OPEN one closed, because `open` is DOM state rather than
// presentation. So "entries start collapsed on a phone, expanded on a desktop"
// has to be decided in JS at render time.
//
// THE BREAKPOINT IS DUPLICATED, and that is the one thing to watch. 720px is
// also written in static/src/static.css, where the `.col-detail` rule and the
// touch-target sizes live. They must agree - a component collapsing at one
// width while the columns hide at another is a layout nobody designed. It is
// exported as a named constant here so a change is one edit and a search for
// the number finds both.
export const MOBILE_MAX_WIDTH = 720;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

import { useEffect, useState } from 'react';

/**
 * Tracks the media query rather than reading it once. A one-shot read at mount
 * is nearly right and wrong exactly when it matters at a racetrack: turning a
 * phone sideways to read a wide entries table would leave the layout in its
 * portrait shape until the next navigation.
 *
 * Guarded for the no-matchMedia case (and for a throw) so a missing API
 * degrades to the desktop layout instead of blanking the screen - the same
 * defensive posture as storage.js.
 */
export function useIsMobile() {
  const read = () => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
    } catch {
      return false;
    }
  };
  const [isMobile, setIsMobile] = useState(read);

  useEffect(() => {
    const sync = () => setIsMobile(read());
    let mql = null;
    try {
      mql = window.matchMedia(MOBILE_QUERY);
    } catch {
      mql = null;
    }
    if (mql) {
      // addEventListener is the modern spelling; addListener is kept for older
      // mobile Safari, which is exactly the browser this app is aimed at.
      if (mql.addEventListener) mql.addEventListener('change', sync);
      else mql.addListener(sync);
    }
    // BOTH listeners, deliberately, and neither could be exercised here.
    // `change` on a MediaQueryList is the correct event; `resize` is the
    // belt-and-braces one. UNVERIFIED IN THIS REPO'S BROWSER HARNESS: its
    // viewport emulation updates `innerWidth` and `matchMedia(...).matches`
    // but dispatches NEITHER event (measured: 0 of each across a
    // 375 <-> 1000 crossing), so a live breakpoint change cannot be observed
    // from a check or a driven browser. Real Safari and Chrome fire both on
    // rotation. What IS verified is the mount-time read, which is what
    // "collapsed by default on a phone" actually means; this listener only
    // re-applies that default without a reload.
    window.addEventListener('resize', sync);
    sync();
    return () => {
      if (mql) {
        if (mql.removeEventListener) mql.removeEventListener('change', sync);
        else mql.removeListener(sync);
      }
      window.removeEventListener('resize', sync);
    };
  }, []);

  return isMobile;
}
