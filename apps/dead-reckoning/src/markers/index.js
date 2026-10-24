// Where everyone else's death markers come from. Every source has the same shape:
//
//   start() / stop()        begin or end polling (or simulating)
//   get(level)              { level, deaths: [[x, y, n], …], total, bin, bounds, truncated, fetchedAt, stale }
//                           for that level, or null while nothing has arrived yet
//   subscribe(fn)           fn() whenever something new arrived; returns an unsubscribe
//   refresh()               fetch now
//   status()                { kind, fake, fetchedAt, error }
//   kind, fake              'mock' (fake: true, always labelled as such), 'share' or 'none'
//
// createMockMarkers (./mock.js) simulates seeded bot players, for development. createShareMarkers
// (./share-link.js) reads a Glitchless share link to a board with one positions panel per level.
import { createMockMarkers } from './mock.js';
import { createShareMarkers } from './share-link.js';

function createNoMarkers() {
  return {
    kind: 'none',
    fake: false,
    start() {},
    stop() {},
    async refresh() {},
    get: () => null,
    status: () => ({ kind: 'none', fake: false, fetchedAt: 0, error: null }),
    subscribe: () => () => {},
  };
}

/** `source` is 'mock', 'none', a share link (or its token), or the URL of a JSON copy of the board. */
export function createMarkerSource({ source, levels, api, seed }) {
  if (source === 'mock') return createMockMarkers({ levels, seed });
  if (!source || source === 'none') return createNoMarkers();
  return createShareMarkers({ link: source, api });
}
