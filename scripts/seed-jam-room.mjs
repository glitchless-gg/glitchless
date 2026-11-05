// Seeds a jam room on a running open-source Glitchless server (SPEC §3j), to look at the room's pages in a browser:
// a room, four games that join and publish a tiny built game each (an index.html with a canvas and a relative
// ./main.js), a fifth that joins but is still being made, and a few players' plays of each game through the intake,
// some on phones, some that stutter. The room's survey comes from a "Meetup" survey template the script saves (its own
// heading and intro over five of the default questions), so the survey page and the templates have something to show.
//   GLITCHLESS_URL=http://localhost:7871 node scripts/seed-jam-room.mjs [--end [--no-answers]]
// GLITCHLESS_URL defaults to http://localhost:7777; GLITCHLESS_API_KEY is sent if the server needs one. --end goes on
// to the end of the jam: Neon Dash publishes a fix that plays clean, a few browsers vote, the organiser ends the jam, and
// two people answer the survey, so the awards, the snapshot and the survey's answers have something to show (and the
// survey can't change any more). --no-answers leaves the survey unanswered, so it can still be edited after the end.
import crypto from 'node:crypto';
import { Sketch } from '../packages/sdk/src/sketch.js';

const BASE = (process.env.GLITCHLESS_URL || 'http://localhost:7777').replace(/\/$/, '');
const KEY = process.env.GLITCHLESS_API_KEY || '';
const TOKEN = process.env.GLITCHLESS_CLIENT_TOKEN || 'gl_pub_dev';
const END = process.argv.includes('--end');
const ANSWERS = !process.argv.includes('--no-answers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The games: who makes them, the agent that publishes them, and the plays they get (phones, stutter, an error).
const GAMES = [
  { title: 'Neon Dash', by: 'Ana', service: 'neon-dash', agent: 'claude-code', hue: 160, plays: [{ phone: true, stutter: true }, { phone: true, stutter: true }, { phone: true, error: true }, {}, {}, {}] },
  { title: 'Tap Tower', by: 'Bo', service: 'tap-tower', agent: 'cursor-vscode', hue: 10, plays: [{ phone: true }, { phone: true }, { phone: true }] },
  { title: 'Snack Snake', by: 'Cy and Di', service: 'snack-snake', agent: 'codex', hue: 45, plays: [{}] },
  { title: 'Orbit Hop', by: null, service: 'orbit-hop', agent: 'goose', hue: 220, plays: [] },
  { title: 'Moon Mower', by: 'Ed', service: 'moon-mower', agent: 'claude-code', hue: 280, plays: null }, // joins, never publishes
];

async function call(method, path, { body, headers = {}, raw = false } = {}) {
  for (let tries = 0; ; tries++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(KEY ? { 'x-glitchless-api-key': KEY } : {}), ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && tries < 10) {
      await sleep(1000 * Number(res.headers.get('retry-after') || 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
}

// A tiny built game: a page with a canvas, and a script it loads by a relative path, as `vite build --base ./` makes.
function builtGame(g, version) {
  return {
    'index.html': `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${g.title}</title><style>html,body{margin:0;height:100%;background:#0e182e;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body><canvas id="c"></canvas><script src="./main.js"></script></body></html>`,
    'main.js': `// ${g.title} ${version}: Glitchless.init({ service: "${g.service}", version: "${version}" })
const c = document.getElementById('c'), x = c.getContext('2d');
const dots = Array.from({ length: 40 }, (_, i) => ({ a: i * 0.7, r: 30 + i * 6 }));
function frame(t) {
  c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  x.fillStyle = '#0e182e'; x.fillRect(0, 0, c.width, c.height);
  for (const d of dots) {
    const a = d.a + t / 900;
    x.fillStyle = 'hsl(' + (${g.hue} + d.r / 4) + ' 85% 62%)';
    x.beginPath(); x.arc(c.width / 2 + Math.cos(a) * d.r * devicePixelRatio, c.height / 2 + Math.sin(a * 1.3) * d.r * devicePixelRatio, 6 * devicePixelRatio, 0, 7); x.fill();
  }
  x.fillStyle = '#fff'; x.font = 'bold ' + 28 * devicePixelRatio + 'px system-ui'; x.textAlign = 'center';
  x.fillText(${JSON.stringify(g.title)} + ' ' + ${JSON.stringify(version)}, c.width / 2, 60 * devicePixelRatio);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
`,
  };
}

async function publish(code, slug, g, version) {
  const files = builtGame(g, version);
  const list = Object.entries(files).map(([p, c]) => ({ path: p, bytes: Buffer.byteLength(c), sha256: sha(c) }));
  const headers = { 'x-glitchless-client': g.agent };
  const up = await call('POST', `/v1/rooms/${code}/games/${slug}/uploads`, { body: { version, files: list }, headers });
  for (const [p, c] of Object.entries(files)) await call('PUT', `/v1/rooms/${code}/games/${slug}/uploads/${up.n}/files/${p}`, { body: Buffer.from(c), raw: true, headers: { ...headers, 'content-type': 'application/octet-stream' } });
  return call('POST', `/v1/rooms/${code}/games/${slug}/uploads/${up.n}/publish`, { headers });
}

// One player's play: five one-second windows of frames, on a phone or a laptop, with stutter (10 of every 60 frames
// late) or an error if asked. It starts `start` ms from now, after the game's publish, so it counts.
let plays = 0;
async function play(g, version, opts, start) {
  const n = ++plays;
  const id = `seed_${g.service}_${version}_${n}_${Date.now().toString(36)}`;
  const device = opts.phone ? { browser: 'Safari', os: 'iOS', mobile: true } : { browser: 'Chrome', os: 'macOS', mobile: false };
  const events = [{ type: 'session_start', ts: start, level: null, session_type: 'user', device }, { type: 'level_start', ts: start + 100, level: 'one' }];
  for (let w = 0; w < 5; w++) {
    const sk = new Sketch();
    for (let f = 0; f < 60; f++) sk.add(opts.stutter && f < 10 ? 40 : 16.6);
    events.push({ type: 'frame_window', ts: start + 1000 + w * 1000, level: 'one', duration_s: 1, frames: 60, fps: 60, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0 });
  }
  if (opts.error) events.push({ type: 'error', ts: start + 2500, level: 'one', kind: 'js', message: 'player is undefined', fingerprint: `seed-${g.service}` });
  events.push({ type: 'session_end', ts: start + 6000, level: 'one', reason: 'quit', duration_s: 6 });
  await call('POST', `/v1/intake?token=${TOKEN}`, { body: { service: g.service, env: 'prod', version, session_id: id, player_id: id, sdk: 'glitchless-browser/0.7.0', events } });
}

const voter = () => ({ 'x-glitchless-voter': crypto.randomBytes(18).toString('base64url') });

// The organiser's survey template (saving it again replaces it).
await call('PUT', '/v1/rooms/templates/meetup', {
  body: {
    name: 'Meetup',
    heading: 'How was {room}?',
    intro: 'Five quick questions while the awards sink in. They help us plan the next one.',
    questions: [
      { id: 'rating', kind: 'scale', text: 'How was the jam?' },
      { id: 'liked', kind: 'text', text: 'What did you like most?' },
      { id: 'hard', kind: 'text', text: 'What got in the way?' },
      { id: 'make_more', kind: 'choice', text: 'Do you want to make a game after this?', options: ["Yes, I'll keep building this one", 'Yes, a new one', 'Maybe', 'No'] },
      { id: 'agent', kind: 'choice', text: 'Which coding agent did you use?', options: ['Claude Code', 'Codex', 'Cursor', 'goose', 'Another'] },
    ],
  },
});

const room = await call('POST', '/v1/rooms', { body: { title: 'Generative AI DC mini jam', about: 'Make a small game with your agent in 90 minutes, publish it here, then play everyone else\'s on your phone.', hours: 3, template: 'meetup' } }).catch((err) => {
  if (/429/.test(err.message)) throw new Error('This server already has 3 jam rooms on. End or delete one on the Jam rooms page first.');
  throw err;
});
const code = room.code;
console.log(`Room ${code}: ${room.title}`);
// The open-source server tells games apart by the service they send, so each room's games get services of their own.
for (const g of GAMES) g.service = `${g.service}-${code.toLowerCase()}`;

const slugs = {};
for (const g of GAMES) {
  const joined = await call('POST', `/v1/rooms/${code}/games`, { body: { title: g.title, by: g.by, service: g.service }, headers: { 'x-glitchless-client': g.agent } });
  slugs[g.service] = joined.slug;
  if (g.plays == null) {
    console.log(`  ${g.title}: joined, still being made`);
    continue;
  }
  const done = await publish(code, joined.slug, g, '1.0.0');
  console.log(`  ${g.title}: ${done.url}`);
  for (const [i, p] of g.plays.entries()) await play(g, '1.0.0', p, Date.now() + 200 + i * 50);
}

// A play counts once it has started; wait until every one has, and has ended, so the numbers settle.
await sleep(7000);

if (END) {
  // Neon Dash fixes its stutter in 1.0.1: three clean plays on phones.
  const neon = GAMES[0];
  await publish(code, slugs[neon.service], neon, '1.0.1');
  for (let i = 0; i < 3; i++) await play(neon, '1.0.1', { phone: true }, Date.now() + 200 + i * 50);
  // Four browsers vote: three for Neon Dash, one for Tap Tower.
  for (const slug of [slugs[GAMES[0].service], slugs[GAMES[0].service], slugs[GAMES[0].service], slugs[GAMES[1].service]]) await call('PUT', `/v1/rooms/${code}/vote`, { body: { slug }, headers: voter() });
  await sleep(7000);
  await call('PATCH', `/v1/rooms/${code}`, { body: { end: true } });
  if (ANSWERS) {
    await call('PUT', `/v1/rooms/${code}/survey`, { body: { answers: { rating: 5, liked: 'Playing everyone\'s games on my phone a minute after they were made.', make_more: "Yes, I'll keep building this one", agent: 'Claude Code' } }, headers: voter() });
    await call('PUT', `/v1/rooms/${code}/survey`, { body: { answers: { rating: 4, hard: 'Publishing failed until the build used relative paths.', make_more: 'Maybe', agent: 'Cursor' } }, headers: voter() });
  }
  console.log(`Ended the jam: the awards are on the big screen and the arcade, and the survey is open${ANSWERS ? ' with two answers' : ', with no answers yet'}.`);
}

const live = await call('GET', `/v1/rooms/${code}/live`);
console.log(`\n${live.totals.games} games published, ${live.totals.building} still being made, ${live.totals.plays} plays (${live.totals.phone_pct ?? 0}% on phones)`);
for (const g of live.games) console.log(`  ${g.title}: ${g.plays} play${g.plays === 1 ? '' : 's'}`);
console.log(`\nArcade      ${room.links.arcade}\nBig screen  ${room.links.live}\nJoin page   ${room.links.join}${END ? `\nSurvey      ${room.links.survey}` : ''}`);
