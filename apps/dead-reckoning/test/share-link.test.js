// The share-link marker source, against a fixture of the board answer (one positions panel per level).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareTokenOf, boardUrl, parseBoard, createShareMarkers } from '../src/markers/share-link.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/share-board.json', import.meta.url), 'utf8'));
const TOKEN = 'gl_share_' + 'A'.repeat(32);
const LINK = `https://app.glitchless.gg/#/share/${TOKEN}`;

test('a share link, a bare token or nothing', () => {
  assert.equal(shareTokenOf(LINK), TOKEN);
  assert.equal(shareTokenOf(TOKEN), TOKEN);
  assert.equal(shareTokenOf('https://app.glitchless.gg/#/overview'), null);
  assert.equal(shareTokenOf(''), null);
});

test('every player polls one URL: the token as ?share= and the last 30 days', () => {
  const u = new URL(boardUrl(LINK, { api: 'https://api.glitchless.gg/' }));
  assert.equal(u.origin + u.pathname, 'https://api.glitchless.gg/v1/query/board');
  assert.equal(u.searchParams.get('share'), TOKEN);
  assert.equal(u.searchParams.get('days'), '30');
  // No times, service, page or filters: the link decides those, and the URL stays one cache key.
  assert.deepEqual([...u.searchParams.keys()].sort(), ['days', 'share']);
  assert.equal(boardUrl(LINK), boardUrl(TOKEN));
  // A JSON copy of the board (a CDN snapshot) is fetched as it is.
  assert.equal(boardUrl('https://cdn.example.com/dead-reckoning/board.json'), 'https://cdn.example.com/dead-reckoning/board.json');
  assert.equal(boardUrl('not a link'), null);
});

test('parseBoard reads each positions panel by level', () => {
  const levels = parseBoard(fixture);
  assert.deepEqual([...levels.keys()], ['1', '2', '3', '4', '5']);
  const l3 = levels.get('3');
  assert.equal(l3.bin, 0.5);
  assert.equal(l3.total, 312);
  assert.ok(l3.deaths.length > 3);
  for (const [a, b, n] of l3.deaths) assert.ok(Number.isFinite(a) && Number.isFinite(b) && n > 0);
  assert.deepEqual(levels.get('5').deaths, []);
  assert.equal(levels.get('5').total, 0);
});

test('parseBoard drops malformed bins and refuses what is not a positions board', () => {
  const body = { board: { panels: [{ type: 'positions', level: 2, deaths: [[1, 2, 3], ['x', 2, 1], [1, 2], [4, 5, -1], [6, 7, 2]], bin: 1 }] } };
  const l = parseBoard(body).get('2');
  assert.deepEqual(l.deaths, [[1, 2, 3], [6, 7, 2]]);
  assert.equal(l.total, 5); // no total: the sum of the bins
  assert.throws(() => parseBoard({ error: 'this share link was revoked or has expired' }), /revoked/);
  assert.throws(() => parseBoard({ board: { panels: [{ type: 'stat', value: 1 }] } }), /no positions panels/);
  assert.throws(() => parseBoard(null));
});

// A clock and timers the test drives by hand.
function harness(responses) {
  const calls = [];
  const timers = [];
  const src = createShareMarkers({
    link: LINK,
    intervalMs: 60_000,
    random: () => 0.5,
    hidden: () => false,
    now: () => Date.UTC(2026, 9, 24, 12),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { ok: r.status === 200, status: r.status, headers: { get: (k) => r.headers?.[k] ?? null }, json: async () => r.body };
    },
  });
  const nextTick = async () => {
    const t = timers.shift();
    await t.fn();
    return t.ms;
  };
  return { src, calls, timers, nextTick };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('polls, then keeps the last markers (marked stale) when a fetch fails', async () => {
  const { src, calls, timers, nextTick } = harness([
    { status: 200, body: fixture },
    { status: 500, body: { error: 'boom' } },
    new Error('network down'),
    { status: 200, body: fixture },
  ]);
  let updates = 0;
  src.subscribe(() => updates++);
  assert.equal(src.get('3'), null, 'nothing before the first answer');
  src.start();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(src.get('3').total, 312);
  assert.equal(src.get('3').stale, false);
  assert.equal(timers[0].ms, 60_000, 'about once a minute');

  await nextTick();
  assert.equal(src.get('3').total, 312, 'kept after a 500');
  assert.equal(src.get('3').stale, true);
  assert.match(src.get('3').error, /boom/);

  await nextTick();
  assert.equal(src.get('3').total, 312, 'kept after a network error');
  assert.match(src.status().error, /network down/);

  await nextTick();
  assert.equal(src.get('3').stale, false, 'fresh again');
  assert.equal(updates, 4);
  // A level the board has no panel for answers empty, not null, once something has arrived.
  assert.deepEqual(src.get('9').deaths, []);
  src.stop();
});

test('a 429 waits for its Retry-After', async () => {
  const { src, timers, nextTick } = harness([{ status: 200, body: fixture }, { status: 429, headers: { 'retry-after': '300' }, body: { error: 'rate limit exceeded' } }]);
  src.start();
  await settle();
  await nextTick();
  assert.equal(timers.at(-1).ms, 300_000);
  assert.equal(src.get('1').stale, true);
  assert.equal(src.get('1').total, 261);
  src.stop();
});
