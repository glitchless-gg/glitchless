// The game check's parts that need no browser: finding an itch.io page's game, robots.txt, refusals, the screen-change
// reading, and what the report and dashboard say. The whole check plays a real page in check.e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { itchFrame, itchPage, robotsAllow, refusal, siteOf } from '../src/check-site.js';
import { decodePng, screenChange, aiPlayer, AI_MODEL } from '../src/check-bot.js';
import { checkReport, checkDm, checkDashboard, headlines, engineWords, profileNumbers, whatTheBotSaw } from '../src/check-report.js';
import { checkDestination } from '../src/check.js';
import { validateDashboard } from '../../../server/src/board.js';

test('an itch.io page: its embedded frame, size and title', () => {
  const html = `<title>Moon Hop by someone</title><h1 itemprop="name" class="game_title">Moon Hop</h1>
    <div data-height="540" class="game_frame game_loaded" style="width: 960px; height: 540px" data-width="960"><button class="fullscreen_btn"></button>
    <iframe allow="autoplay" frameborder="0" src="https://html-classic.itch.zone/html/12345/index.html?v=1794588958" scrolling="no"></iframe></div>
    <iframe src="//www.youtube.com/embed/abc"></iframe>`;
  assert.deepEqual(itchFrame(html, 'https://someone.itch.io/moon-hop'), { frame_url: 'https://html-classic.itch.zone/html/12345/index.html?v=1794588958', width: 960, height: 540, title: 'Moon Hop' });
});

test('an itch.io page behind a "Run game" button, and one that is a download or password-protected', () => {
  const click = `<title>Cave &amp; Co by x</title><div class="game_frame" data-width="640" data-height="360"><div class="iframe_placeholder" data-iframe="&lt;iframe src=&quot;//html.itch.zone/html/777/game/index.html&quot; allowfullscreen&gt;&lt;/iframe&gt;"><button class="load_iframe_btn">Run game</button></div></div>`;
  assert.deepEqual(itchFrame(click, 'https://x.itch.io/cave'), { frame_url: 'https://html.itch.zone/html/777/game/index.html', width: 640, height: 360, title: 'Cave & Co' });
  const popup = `<script>new I.ViewHtmlGame("#x", {"url":"https:\\/\\/html-classic.itch.zone\\/html\\/42\\/index.html","width":800,"height":600})</script>`;
  assert.equal(itchFrame(popup, 'https://x.itch.io/pop').frame_url, 'https://html-classic.itch.zone/html/42/index.html');
  assert.match(itchFrame('<title>Big Game by y</title><a class="button download_btn">Download</a>', 'https://y.itch.io/big').error, /a download/);
  assert.match(itchFrame('<form class="password_form"></form>', 'https://y.itch.io/secret').error, /password-protected/);
  assert.ok(itchPage('https://someone.itch.io/moon-hop'));
  assert.ok(itchPage('https://someone.itch.io/moon-hop?secret=abc'));
  assert.equal(itchPage('https://itch.io/games'), null);
  assert.equal(itchPage('https://html-classic.itch.zone/html/1/index.html'), null);
});

test('robots.txt: our own group first, else *, the longest rule wins, Allow wins a tie', () => {
  const itch = 'User-agent: *\nDisallow: /embed/\nDisallow: /game/download/\n\nSitemap: https://itch.io/sitemap.xml';
  assert.equal(robotsAllow(itch, 'GlitchlessCheck', '/moon-hop'), true);
  assert.equal(robotsAllow(itch, 'GlitchlessCheck', '/embed/123'), false);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /', 'GlitchlessCheck', '/game'), false);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /\n\nUser-agent: GlitchlessCheck\nAllow: /', 'GlitchlessCheck', '/game'), true);
  assert.equal(robotsAllow('User-agent: GlitchlessCheck\nDisallow: /games/\nAllow: /games/free', 'GlitchlessCheck', '/games/free/1'), true);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /*.wasm$', 'GlitchlessCheck', '/build/game.wasm'), false);
  assert.equal(robotsAllow('User-agent: *\nDisallow: /*.wasm$', 'GlitchlessCheck', '/build/game.wasm.gz'), true);
  assert.equal(robotsAllow('', 'GlitchlessCheck', '/'), true);
  // Two agents above one group share it.
  assert.equal(robotsAllow('User-agent: GPTBot\nUser-agent: GlitchlessCheck\nDisallow: /', 'GlitchlessCheck', '/x'), false);
});

test('a site that refuses bots is told apart from one that answers', () => {
  assert.match(refusal({ status: 403 }), /403/);
  assert.match(refusal({ status: 429 }), /429/);
  assert.match(refusal({ status: 200, headers: { 'cf-mitigated': 'challenge' } }), /human/);
  assert.match(refusal({ status: 200, title: 'Just a moment...' }), /human/);
  assert.match(refusal({ status: 200, body: 'Please verify you are human to continue' }), /human/);
  assert.equal(refusal({ status: 200, title: 'Moon Hop', body: 'Press Start' }), null);
  assert.equal(siteOf('someone.github.io'), 'GitHub Pages');
  assert.equal(siteOf('html-classic.itch.zone'), 'itch.io');
  assert.equal(siteOf('my-game.vercel.app'), 'Vercel');
  assert.equal(siteOf('localhost'), 'this computer');
});

// A PNG encoder for the test: 8-bit RGBA rows, each with the filter given.
function png(width, height, pixel, filters = []) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const raw = [];
  let prev = Buffer.alloc(width * 4);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) line.set(pixel(x, y), x * 4);
    const f = filters[y] || 0;
    const out = Buffer.alloc(width * 4);
    for (let i = 0; i < line.length; i++) out[i] = (line[i] - (f === 1 ? (i >= 4 ? line[i - 4] : 0) : f === 2 ? prev[i] : 0)) & 255;
    raw.push(Buffer.from([f]), out);
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))]);
}

test('screen change: PNGs decoded (filters too) and compared pixel by pixel', () => {
  const black = decodePng(png(4, 3, () => [0, 0, 0, 255], [0, 1, 2]));
  const white = decodePng(png(4, 3, () => [255, 255, 255, 255], [2, 1, 0]));
  const half = decodePng(png(4, 3, (x) => (x < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), [1, 2, 1]));
  assert.deepEqual([black.width, black.height, black.gray[0], white.gray[11]], [4, 3, 0, 255]);
  assert.equal(screenChange(black, black), 0);
  assert.equal(screenChange(black, white), 1);
  assert.equal(screenChange(black, half), 0.5);
  assert.equal(screenChange(black, decodePng(png(2, 2, () => [0, 0, 0, 255]))), null);
  assert.equal(decodePng(Buffer.from('not a png')), null);
});

// A check's result as gameCheck returns it, for the report: a WebGL game that errors on the desktop, stutters on the
// phone and grows its memory.
function sample() {
  const steps = (late, heap) => Array.from({ length: 9 }, (_, i) => ({ t: i * 5, input: 'arrows', words: 'the arrow keys and Space', change: 0.05, frames: { n: 300, late: late ? 90 : 0, p50: late ? 33 : 16.7, p95: late ? 66 : 17, max: i === 6 ? 140 : 20, draws: 120 }, heap_mb: heap(i), level: null, label: `Wave ${1 + Math.floor(i / 3)}` }));
  return {
    checked_at: '2026-11-13T12:00:00.000Z',
    url: 'https://someone.itch.io/moon-hop',
    target: { page_url: 'https://someone.itch.io/moon-hop', play_url: 'https://html-classic.itch.zone/html/1/index.html', title: 'Moon Hop', site: 'itch.io', size: { width: 960, height: 540 } },
    game: { name: 'Moon Hop', id: 'p_abc', service: 'moon-hop', cloud: true, version: 'check-2026-11-13' },
    machine: { os: 'Darwin', cpu: 'Apple M3 Max', browser: 'Chrome 157' },
    ai: null,
    profiles: [
      { profile: 'desktop', words: 'desktop Chrome', session_id: 's_d', seconds_played: 45, load: { ready_s: 4, bytes: 12 * 1048576, requests: 30, missing: [{ url: 'x.itch.zone/sfx/boom.ogg', status: 404 }], failed: [] }, steps: steps(false, (i) => 40 + i * 6), inputs: { tried: ['the arrow keys and Space', 'moving the mouse and clicking'], worked: ['the arrow keys and Space'] }, notes: ['To start, the bot pressed "Play".'], errors: ['TypeError: boom is undefined'], page: { engines: [{ name: 'phaser', version: '3.90.0' }], contexts: ['webgl2'], adapters: ['phaser'], labels: { 'Wave 1': 3, 'Wave 3': 1 }, buttons: { Play: 1, Endless: 1, Story: 1 } } },
      { profile: 'phone', words: 'a throttled phone', session_id: 's_p', seconds_played: 30, load: { ready_s: 22, bytes: 12 * 1048576, requests: 30, missing: [], failed: [] }, steps: steps(true, () => 50), inputs: { tried: ['tapping around the screen'], worked: [] }, notes: [], errors: [], page: { engines: [{ name: 'phaser', version: '3.90.0' }], contexts: ['webgl2'], adapters: ['phaser'], labels: {}, buttons: {} } },
    ],
    summary: {
      runs: [
        { session_id: 's_d', pct_over_budget: 0.4, budget_ms: 16.67, p50: 16.7, p95: 17.2, hitches: 3, errors: 2, gpu: 'Apple M3 Max' },
        { session_id: 's_p', pct_over_budget: 31, budget_ms: 16.67, p50: 33.1, p95: 66.5, hitches: 1, errors: 0, gpu: 'Apple M3 Max' },
      ],
      errors: [{ message: 'TypeError: boom is undefined', location: 'fire (game.js:120)', count: 2, sessions: 1 }],
      levels: {},
    },
    findings: [{ id: 'error-abc', severity: 'high', title: 'TypeError: boom is undefined' }],
    notes: [],
    share: { url: 'https://app.glitchless.gg/s/gl_share_x' },
    dashboard_url: 'https://app.glitchless.gg/?ws=w&game=p_abc#/check',
  };
}

test('the report leads with what players would hit, in plain words, and says where the numbers come from', () => {
  const r = sample();
  const lead = headlines(r);
  assert.match(lead[0], /^1 of 2 runs hit an error in fire \(game\.js:120\) \("TypeError: boom is undefined"\), so players may hit it too$/);
  assert.ok(lead.some((h) => /phone-speed CPU the game can't keep up: 1 in 3 frames came late, against fewer than 1 in 200 frames on a desktop/.test(h)), lead.join('\n'));
  assert.ok(lead.some((h) => /a player on a phone over 4G waits about 22 seconds before it's ready, while it downloads 12 MB/.test(h)));
  assert.ok(lead.some((h) => /memory kept climbing on the desktop, from 40 to 88 MB/.test(h)));
  const report = checkReport(r);
  assert.match(report, /^# Game check: Moon Hop/);
  assert.match(report, /made with Phaser 3\.90\.0 on WebGL/);
  assert.match(report, /not from the game's players/);
  assert.match(report, /the bot saw Wave 1, Wave 2 and Wave 3/);
  assert.match(report, /Which modes keep players: Endless and Story/);
  assert.match(report, /\[high\] TypeError: boom is undefined \(`error-abc`\)/);
  assert.match(report, /On the desktop, the longest freeze came 30 seconds in, on Wave 3: one frame took 140 ms/);
  assert.doesNotMatch(report, /\b(sees|watches|watching) (players|your players)/i);
  const dm = checkDm(r);
  assert.equal(dm.split('\n\n').length, 2);
  assert.match(dm, /https:\/\/app\.glitchless\.gg\/s\/gl_share_x/);
  assert.match(dm, /not your players/);
  assert.doesNotMatch(dm, /\b(sees|watches)\b/);
});

test('numbers and words for a run with no summary, and for a game that ran well', () => {
  const r = sample();
  r.summary = null;
  const n = profileNumbers(r.profiles[1], null);
  assert.equal(n.late_pct, 30); // 90 of 300 frames, from the bot's own clock
  assert.equal(n.p50, 33);
  const fine = sample();
  fine.summary.runs[1].pct_over_budget = 1;
  fine.summary.errors = [];
  fine.profiles[0].errors = [];
  fine.profiles[0].load.missing = [];
  fine.profiles[0].steps.forEach((s) => ((s.heap_mb = 40), (s.frames.max = 20)));
  fine.profiles[1].load.ready_s = 6;
  fine.summary.runs[0].hitches = 0;
  assert.match(headlines(fine)[0], /^good news: it ran smoothly on a desktop/);
  assert.equal(engineWords({ engines: [], contexts: ['2d'] }), 'a 2D canvas, with no engine Glitchless recognises');
  assert.equal(engineWords({ engines: [{ name: 'unity', version: null }], contexts: ['webgl2'] }), 'Unity');
  assert.equal(engineWords({ engines: [{ name: 'three', version: '170' }], contexts: ['webgl2'] }), 'Three.js r170 on WebGL');
  assert.deepEqual(whatTheBotSaw(sample()).modes, ['Endless', 'Story']);
});

test("the check's dashboard is valid, opens on the check, and names the pages that need Glitchless installed", () => {
  const pages = checkDashboard(sample());
  const saved = validateDashboard({ pages });
  assert.equal(saved.pages[0].id, 'check');
  assert.ok(saved.pages.filter((p) => /with Glitchless/.test(p.title)).length >= 2);
  for (const p of pages) for (const panel of p.panels || []) assert.ok(!panel.note || panel.note.length <= 200, panel.note);
  const levels = pages[0].panels.find((p) => p.type === 'levels');
  assert.match(levels.note, /The bots saw Wave 1, Wave 2 and Wave 3/);
  assert.equal(pages[0].panels.find((p) => p.type === 'versions').by, '$profile');
});

// A fake Glitchless API for checkDestination: games by name with their services, saved dashboards by service.
function fakeApi({ games = [], dashboards = {}, services = [] }) {
  const made = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.pathname === '/v1/agent/games' && init.method === 'POST') {
      const { name } = JSON.parse(init.body);
      made.push(name);
      return json({ game: { id: `p_${made.length}`, name }, client_token: 'gl_pub_new', dashboard: 'https://app/?game=new' });
    }
    if (u.pathname === '/v1/agent/games') return json({ games, intake: 'https://api' });
    if (u.pathname === '/v1/dashboard') {
      const d = dashboards[u.searchParams.get('service')];
      return d ? json({ dashboard: d }) : json({ dashboard: null });
    }
    if (u.pathname === '/v1/query/services') return json({ services: services.map((service) => ({ service })) });
    return json({}, 404);
  };
  return { fetchImpl, made };
}

test("a check reuses only a game an earlier check made, never a real game's board", async () => {
  const check = { pages: [{ id: 'check', title: 'Game check' }] };
  const real = { pages: [{ id: 'overview', title: 'Overview' }] };
  const earlier = fakeApi({ games: [{ id: 'p_old', name: 'Moon Hop', client_token: 'gl_pub_old', services: [{ service: 'moon-hop' }] }], dashboards: { 'moon-hop': check } });
  const again = await checkDestination({ base: 'https://api', apiKey: 'gl_ws_x', name: 'moon hop', fetchImpl: earlier.fetchImpl });
  assert.deepEqual([again.game_id, again.service, again.client_token, earlier.made], ['p_old', 'moon-hop', 'gl_pub_old', []]);

  const theirs = fakeApi({ games: [{ id: 'p_real', name: 'Moon Hop', client_token: 'gl_pub_real', services: [{ service: 'moon-hop' }] }], dashboards: { 'moon-hop': real } });
  const apart = await checkDestination({ base: 'https://api', apiKey: 'gl_ws_x', name: 'Moon Hop', fetchImpl: theirs.fetchImpl });
  assert.deepEqual([apart.game_id, apart.name, apart.service, theirs.made], ['p_1', 'Moon Hop (game check)', 'moon-hop-game-check', ['Moon Hop (game check)']]);

  const sending = fakeApi({ games: [{ id: 'p_real', name: 'Moon Hop', services: [{ service: 'moon-hop' }] }] });
  assert.equal((await checkDestination({ base: 'https://api', apiKey: 'gl_ws_x', name: 'Moon Hop', fetchImpl: sending.fetchImpl })).name, 'Moon Hop (game check)', 'data and no dashboard of its own: a real game too');

  const open = fakeApi({ services: ['moon-hop'] });
  const local = await checkDestination({ base: 'http://localhost:7777', apiKey: '', name: 'Moon Hop', fetchImpl: open.fetchImpl });
  assert.deepEqual([local.cloud, local.service, local.client_token], [false, 'moon-hop-check', 'gl_pub_dev']);
  assert.equal((await checkDestination({ base: 'http://localhost:7777', apiKey: '', name: 'Moon Hop', fetchImpl: fakeApi({}).fetchImpl })).service, 'moon-hop');
});

test('the AI player asks Haiku about a screenshot for structured inputs, and plays only safe ones', async () => {
  const asked = [];
  const answer = { screen: 'Title screen with a Play button', kind: 'title', label: 'Wave 1', actions: [
    { do: 'click', key: '', ms: 0, x: 0.5, y: 0.6, x2: 0, y2: 0 },
    { do: 'hold', key: 'right', ms: 5000, x: 0, y: 0, x2: 0, y2: 0 },
    { do: 'press', key: 'F5', ms: 0, x: 0, y: 0, x2: 0, y2: 0 },
    { do: 'press', key: 'space', ms: 0, x: 0, y: 0, x2: 0, y2: 0 },
  ] };
  const client = { messages: { create: async (req) => (asked.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }) } };
  const ai = await aiPlayer({ client, maxCalls: 1 });
  const did = [];
  const page = {
    screenshot: async () => Buffer.from('jpeg'),
    keyboard: { press: async (k) => did.push(`press ${k}`), down: async (k) => did.push(`down ${k}`), up: async (k) => did.push(`up ${k}`) },
    mouse: { click: async (x, y) => did.push(`click ${x},${y}`) },
    waitForTimeout: async (ms) => ms >= 400 && did.push(`wait ${ms}`),
  };
  const choice = await ai.choose(page, { area: { x: 0, y: 0, width: 1000, height: 500 }, touch: false, recent: [] });
  const req = asked[0];
  assert.equal(req.model, AI_MODEL);
  assert.equal(AI_MODEL, 'claude-haiku-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(req.system, /Never buy anything, sign in/);
  assert.deepEqual([choice.screen, choice.kind, choice.label, choice.actions.length], ['Title screen with a Play button', 'title', 'Wave 1', 3], 'F5 is not a key it may press');
  await ai.act(page, choice, { point: async (fx, fy) => ({ x: fx * 1000, y: fy * 500 }), touch: false });
  assert.deepEqual(did, ['click 500,300', 'down ArrowRight', 'wait 2000', 'up ArrowRight', 'press Space'], 'a hold lasts 2 s at most');
  assert.equal(await ai.choose(page, { area: { x: 0, y: 0, width: 1000, height: 500 }, touch: false, recent: [] }), null, 'out of calls: the explorer plays on');
});
