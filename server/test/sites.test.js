// Where a web game was played (sites.js, SPEC §3b `$site`): the browser SDK's session_start page kept as its two hosts,
// named by the sites table (itch.io's frame on itch.zone or its page as the referrer, CrazyGames, the portals known by
// their own address), localhost for the developer's own machine, else the game's own host; a `site` property the game
// sets comes first. Checked as a board breakdown and series, and through a session state stored, merged and read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHosts, siteOfHosts, siteOf, SITES } from '../src/sites.js';
import { buildContext } from '../src/analytics.js';
import { evaluateBoard, validateBoard } from '../src/board.js';
import { foldSessions, mergeSession, sessionToJSON, sessionFromJSON, newSession, addToSession } from '../src/session-state.js';

const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR;
const ITCH_FRAME = 'https://html-classic.itch.zone/html/14141414/index.html';

test('a page is kept as its hosts only, and the table names the site', () => {
  assert.deepEqual(pageHosts({ url: ITCH_FRAME, referrer: 'https://maker.itch.io' }), { host: 'html-classic.itch.zone', ref: 'maker.itch.io' });
  assert.deepEqual(pageHosts({ url: 'https://www.MyGame.com/play/level-1', referrer: null }), { host: 'mygame.com', ref: null });
  assert.deepEqual(pageHosts({ url: 'null/Users/ada/game/index.html' }), { host: 'file', ref: null }, 'a page opened from a file');
  assert.equal(pageHosts(null), null);
  assert.equal(pageHosts({ url: 'chrome-extension://abc/index.html' }), null);

  assert.equal(siteOfHosts('html-classic.itch.zone', null), 'itch.io');
  assert.equal(siteOfHosts('mygame.com', 'maker.itch.io'), 'itch.io', 'reached from an itch.io page');
  assert.equal(siteOfHosts('game-files.crazygames.com', 'www.crazygames.com'), 'CrazyGames');
  assert.equal(siteOfHosts('html-classic.itch.zone', 'www.crazygames.com'), 'itch.io', 'the frame’s own host comes first');
  assert.equal(siteOfHosts('cdn.example.net', 'poki.com'), 'Poki');
  assert.equal(siteOfHosts('notpoki.com', null), 'notpoki.com', 'a name is matched whole, or under it');
  for (const local of ['localhost', 'file', '127.0.0.1', '192.168.1.20', '10.0.0.4', '172.20.1.1', 'mac.local', 'game.localhost', '[::1]']) assert.equal(siteOfHosts(local, null), 'localhost', local);
  assert.equal(siteOfHosts('172.40.1.1', null), '172.40.1.1');
  assert.equal(siteOfHosts(null, null), '(none)');

  assert.equal(siteOf({ page: { host: 'html-classic.itch.zone', ref: null } }), 'itch.io');
  assert.equal(siteOf({ page: { host: 'html-classic.itch.zone' }, props: { site: ['Newgrounds', 1] } }), 'Newgrounds', "the game's own site property comes first");
  assert.equal(siteOf({ device: { browser: 'Godot' } }), '(none)', 'a native engine build sends no page');

  // Reddit: a post's web view on devvit.net, or, for a web build that sends no page, the subreddit the
  // Reddit relay (glitchless/devvit) always sets.
  assert.equal(siteOfHosts('my-game-abc123-0-0-0-webview.devvit.net', null), 'Reddit');
  assert.equal(siteOfHosts('cdn.example.net', 'www.reddit.com'), 'Reddit');
  assert.equal(siteOfHosts('devvit.network', null), 'devvit.network', 'a name is matched whole');
  assert.equal(siteOf({ device: { browser: 'Godot' }, props: { subreddit: ['my_game_dev', 1] } }), 'Reddit');
  assert.equal(siteOf({ page: { host: 'mygame.com' }, props: { subreddit: ['my_game_dev', 1] } }), 'mygame.com', 'a page says where first');
  assert.ok(SITES.every((s) => s.site && Array.isArray(s.hosts) && Array.isArray(s.referrers)));
});

function sessions(list) {
  const out = [];
  list.forEach(([page, n, props], j) => {
    for (let k = 0; k < n; k++) {
      const base = { service: 'g', env: 'prod', version: '1.0', session_id: `s_${j}_${k}`, player_id: `p_${j}`, sdk: 'glitchless/0.7.0', level: null };
      const ts = T0 + (j * 10 + k) * 60_000;
      out.push({ ...base, ts, type: 'session_start', session_type: 'user', privacy: 'install', device: { browser: 'Chrome', os: 'Windows' }, page, ...(props ? { props } : {}) });
      out.push({ ...base, ts: ts + 30_000, type: 'custom', name: 'play', attrs: {} });
      out.push({ ...base, ts: ts + 60_000, type: 'session_end' });
    }
  });
  return out;
}

const FLEET = [
  [{ url: ITCH_FRAME, referrer: 'https://maker.itch.io' }, 5],
  [{ url: 'https://mygame.com/', referrer: null }, 3],
  [{ url: 'http://localhost:5173/', referrer: null }, 2],
  [null, 1],
  [{ url: 'https://mygame.com/', referrer: null }, 1, { site: 'Discord' }],
];

test('a breakdown by $site counts sessions and players on each site; a series by $site splits an event over time', () => {
  const ctx = buildContext(sessions(FLEET), { service: 'g', from: T0 - HOUR, to: T0 + 5 * HOUR, type: 'all' });
  const [breakdown, series] = evaluateBoard(ctx, validateBoard({ panels: [{ type: 'breakdown', by: '$site' }, { type: 'series', event: 'play', by: '$site' }] }));
  assert.deepEqual([breakdown.title, breakdown.split], ['Sessions by site', 'site']);
  assert.deepEqual(breakdown.rows.map((r) => [r.value, r.sessions, r.players]), [['itch.io', 5, 1], ['mygame.com', 3, 1], ['localhost', 2, 1], ['(none)', 1, 1], ['Discord', 1, 1]]);
  assert.deepEqual(series.series.map((s) => s.label).sort(), ['(none)', 'Discord', 'itch.io', 'localhost', 'mygame.com']);
});

test("a session keeps its page's hosts through a stored state, a merge and an older state without them", () => {
  const events = sessions([[{ url: ITCH_FRAME, referrer: 'https://maker.itch.io' }, 1]]);
  const [s] = foldSessions(events).values();
  assert.deepEqual(s.page, { host: 'html-classic.itch.zone', ref: 'maker.itch.io' });
  const back = sessionFromJSON(JSON.parse(JSON.stringify(sessionToJSON(s))));
  assert.equal(siteOf(back), 'itch.io');

  // Two parts of one session: the later session_start's page wins, as its device does.
  const a = newSession(events[0]);
  addToSession(a, events[0]);
  const b = newSession(events[0]);
  addToSession(b, { ...events[0], ts: events[0].ts + 1000, page: { url: 'https://mygame.com/', referrer: null } });
  mergeSession(a, b);
  assert.equal(siteOf(a), 'mygame.com');

  // A session stored before pages were kept has none.
  const { page, ...old } = sessionToJSON(s);
  assert.equal(siteOf(sessionFromJSON(old)), '(none)');
});
