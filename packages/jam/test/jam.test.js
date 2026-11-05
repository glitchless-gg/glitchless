// glitchless-jam against a real Glitchless server with jam rooms: an organiser makes a room from the CLI, a maker
// publishes a built folder (the version and service read from its JS, its source map sent to Glitchless instead of the
// room), the publish refuses what the room would refuse before sending anything, the tool joins, publishes, reads the
// room's plays and leaves through an MCP client, and the organiser ends the jam and reads its snapshot. Then the same
// on a server that wants a workspace key, signed in the way glitchless-mcp signs in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../server/src/app.js';
import { AuthError } from '../../../server/src/auth.js';
import { FileStore } from '../../../server/src/stores/file.js';
import { FileRoomStore, DirFiles } from '../../../server/src/stores/rooms-file.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `glitchless-jam-${name}-`));
process.env.XDG_CONFIG_HOME = tmp('config');
delete process.env.GLITCHLESS_API_KEY;
delete process.env.GLITCHLESS_ROOM;

const { cli } = await import('../src/cli.js');
const { connect, credentialsFile } = await import('../src/context.js');
const { findInit, readBuild } = await import('../src/publish.js');
const { createServer } = await import('../src/tool.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const quiet = { warn() {}, error() {}, info() {} };
const OPEN = { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'delete', 'dashboard', 'sourcemaps'] }) };

// A Glitchless server with jam rooms on a file store. extra(req, res): answers a request itself (true) before the app.
async function startServer({ auth = OPEN, requireService = true, extra = null } = {}) {
  let app;
  const server = http.createServer((req, res) => {
    if (!extra?.(req, res)) app(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = new DirFiles(tmp('files'));
  app = createApp({ store: new FileStore(tmp('events')), auth, rooms: { store: new FileRoomStore(tmp('rooms')), files, urls: { app: base, play: 'http://play.test/r/' }, requireService }, logger: quiet });
  return { base, files, close: () => server.close() };
}

// A built game in a temp folder: { 'path': contents }.
function build(files) {
  const dir = tmp('build');
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

const page = (title, script = './assets/index-3f2a.js') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><script type="module" crossorigin src="${script}"></script><link rel="stylesheet" href="./assets/index.css"></head><body><canvas></canvas></body></html>`;
// What vite build makes of a game that calls Glitchless.init: minified, its keys in any order and either quote.
const NEON = {
  'index.html': page('Neon Dash'),
  'assets/index-3f2a.js': `const Xe={init(o){return o}};function a(){}Xe.init({version:'1.0.0',"service":"neon-dash",intake:"http://localhost:7777",bugReports:{hotkey:"F8"}});\n//# sourceMappingURL=index-3f2a.js.map\n`,
  'assets/index-3f2a.js.map': JSON.stringify({ version: 3, file: 'index-3f2a.js', sources: ['../src/main.js'], sourcesContent: ['Glitchless.init({ service: "neon-dash", version: "1.0.0" });'], names: [], mappings: 'AAAA' }),
  'assets/index.css': 'body{margin:0;background:url(./bg.png)}',
  'assets/bg.png': '\x89PNG fake',
  '.DS_Store': 'not sent',
  'node_modules/left-out.js': 'not sent',
};

async function run(argv, env) {
  const out = [];
  const err = [];
  const code = await cli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const s = await startServer();
const env = { GLITCHLESS_URL: s.base };
let code;

test('the build is read on this computer: the service and version from Glitchless.init, in any order and quote, or from a constant the bundle sets', () => {
  assert.deepEqual(findInit('x.init({service:"a-game",version:"2.1.0"})'), { service: 'a-game', version: '2.1.0' });
  assert.deepEqual(findInit("Glitchless.init({\n  // don't forget the token\n  version: '3.0.0',\n  service: 'b-game',\n  tools: { x: () => {} },\n})"), { service: 'b-game', version: '3.0.0' });
  assert.deepEqual(findInit('var Ke="1.2.0";other.init({a:1});Q.init({service:`c-game`,version:Ke,overlay:!0})'), { service: 'c-game', version: '1.2.0' });
  assert.deepEqual(findInit('Q.init({service:"d",version:pkg.version})'), { service: 'd', version: null }, 'a version it cannot read is left to the caller');
  assert.deepEqual(findInit('Phaser.Game.init({width:800})'), { service: null, version: null });
  const b = readBuild(build(NEON));
  assert.equal(b.title, 'Neon Dash');
  assert.deepEqual(b.files.map((f) => f.path), ['assets/bg.png', 'assets/index-3f2a.js', 'assets/index.css', 'index.html'], 'no dotfiles, node_modules or source maps');
  assert.deepEqual(b.maps.map((m) => m.file), ['assets/index-3f2a.js']);
});

test('an organiser makes a room from the CLI and gets its arcade, big screen and join links', async () => {
  const made = await run(['host', 'create', 'Meetup jam', '--hours', '2', '--about', 'Make a game in 90 minutes'], env);
  assert.equal(made.code, 0, made.err);
  code = /Made room ([A-Z0-9]{5})/.exec(made.out)[1];
  const { links } = await (await fetch(`${s.base}/v1/rooms/${code}`)).json();
  assert.equal(links.arcade, `${s.base}/jam/${code}`, "the jam's own pages, which the package reads from the server's links");
  for (const link of [links.arcade, links.live, links.join]) assert.ok(made.out.includes(link), link);
  assert.match(made.out, /The arcade's QR code, for people to open it on their phones:\n\n█/);
  assert.match((await run(['host', 'list'], env)).out, new RegExp(`  ${code}  "Meetup jam": on until`));
});

test('publish from the CLI: the build goes to the room without its source map, which goes to Glitchless, and the link comes with a QR code', async () => {
  const dir = build(NEON);
  const done = await run(['publish', dir, '--room', code.toLowerCase(), '--by', 'Ana'], env);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Published "Neon Dash" 1\.0\.0 to room/);
  assert.ok(done.out.includes(`http://play.test/r/${code}/neon-dash/`));
  assert.match(done.out, /█/, 'the QR code, drawn in text');
  assert.ok(done.out.includes(`Everyone plays the room's games at ${(await (await fetch(`${s.base}/v1/rooms/${code}`)).json()).links.arcade}`));
  assert.equal(done.err, '', 'no warnings');

  assert.ok(await s.files.stat(`${code}/neon-dash/1/assets/index-3f2a.js`));
  assert.equal(await s.files.stat(`${code}/neon-dash/1/assets/index-3f2a.js.map`), null, 'the map stays out of the room');
  assert.equal(await s.files.stat(`${code}/neon-dash/1/.DS_Store`), null);
  const maps = await (await fetch(`${s.base}/v1/sourcemaps?service=neon-dash`)).json();
  assert.deepEqual(maps.sourcemaps.map((m) => [m.version, m.file]), [['1.0.0', 'assets/index-3f2a.js']]);
  const arcade = await (await fetch(`${s.base}/v1/rooms/${code}`)).json();
  assert.deepEqual(arcade.games.map((g) => [g.slug, g.title, g.by, g.version]), [['neon-dash', 'Neon Dash', 'Ana', '1.0.0']], 'the page title, not the service, names it');
});

test("publish refuses what the room would refuse, with a fix, before it sends anything", async () => {
  const before = (await (await fetch(`${s.base}/v1/rooms/${code}`)).json()).building;
  const refused = async (files, flags = []) => {
    const r = await run(['publish', build(files), '--room', code, ...flags], env);
    assert.equal(r.code, 1);
    return r.err;
  };
  assert.match(await refused({ 'game.html': page('X') }), /index\.html isn't at the root/);
  assert.match(await refused({ 'dist/index.html': page('X') }), /but dist\/index\.html is: publish .*dist instead/);
  assert.match(await refused({ ...NEON, 'index.html': page('Neon Dash', '/assets/index-3f2a.js') }), /rebuild with relative paths, `vite build --base \.\/`/);
  assert.match(await refused({ ...NEON, 'index.html': page('Neon Dash', '/src/main.ts') }), /source folder, not its build/);
  assert.match(await refused({ ...NEON, 'tools/setup.exe': 'MZ' }), /"tools\/setup\.exe": \.exe files aren't served/);
  assert.match(await refused({ ...NEON, 'login.html': '<form><input type="password"></form>' }), /password field/);
  assert.match(await refused({ ...NEON, 'assets/My Ship.png': 'x' }), /rename it/);
  assert.match(await refused({ 'index.html': page('Plain'), 'assets/index-3f2a.js': 'console.log(1)' }), /No version found in the build: pass version/);
  assert.equal((await (await fetch(`${s.base}/v1/rooms/${code}`)).json()).building, before, 'nothing joined the room');

  // The same version again: both uploads' players would count as one version.
  assert.match(await refused(NEON), /1\.0\.0 is already published in room .*: bump the version passed to Glitchless\.init/);
  assert.equal((await run(['publish', build(NEON), '--room', code, '--version', '1.0.1'], env)).code, 0, 'a new version publishes');
});

test('the organiser takes a game out of the room for good', async () => {
  assert.equal((await run(['publish', build({ ...NEON, 'assets/index-3f2a.js': 'G.init({service:"spam",version:"1"})' }), '--room', code, '--title', 'Spam'], env)).code, 0);
  assert.match((await run(['host', 'remove', code, 'spam'], env)).out, /Took "Spam" \(spam\) out of room .{5} for good/);
  assert.deepEqual((await (await fetch(`${s.base}/v1/rooms/${code}`)).json()).games.map((g) => g.slug), ['neon-dash']);
  assert.match((await run(['publish', build({ ...NEON, 'assets/index-3f2a.js': 'G.init({service:"spam",version:"2"})' }), '--room', code], env)).err, /the organiser took this game out of the room/);
});

test('the tool: join, publish, status with the plays by version, through an MCP client', async (t) => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ env }).connect(a);
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(b);
  t.after(() => client.close());
  const call = async (args) => {
    const r = await client.callTool({ name: 'glitchless_jam', arguments: args });
    return { text: r.content[0].text, isError: r.isError === true };
  };

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['glitchless_jam', 'glitchless_jam_host'], "the maker's tool and the organiser's");
  assert.deepEqual(tools[0].inputSchema.properties.action.enum, ['join', 'publish', 'status', 'leave'], "no organiser's actions in the maker's tool");

  assert.match((await call({ action: 'status', room: 'K7Q2' })).text, /Glitchless error: "K7Q2" isn't a room code/);
  const joined = await call({ action: 'join', room: code, title: 'Tap Tower', by: 'Bo', service: 'tap-tower' });
  assert.match(joined.text, new RegExp(`Joined room ${code} with "Tap Tower" \\(tap-tower\\)\\. Build the game with relative paths`));

  // A game whose version is a constant, published from a folder relative to the server's working directory.
  const dir = build({ 'index.html': page('Tap Tower', './main.js'), 'main.js': 'var Ve="2.0.0";G.init({service:"tap-tower",version:Ve})' });
  const pub = await call({ action: 'publish', dir: path.relative(process.cwd(), dir) });
  assert.equal(pub.isError, false, pub.text);
  assert.match(pub.text, /^Published "Tap Tower" 2\.0\.0 to room [A-Z0-9]{5}\. Show the person this link and the QR code below/);
  assert.ok(pub.text.includes(`http://play.test/r/${code}/tap-tower/`));
  assert.match(pub.text, /█/);
  assert.match(pub.text, /bump the version passed to Glitchless\.init/);
  assert.match((await call({ action: 'publish', dir })).text, /Glitchless error: 2\.0\.0 is already published/, 'errors come back with the reason');

  // A player plays it once and hits an error.
  const ts = Date.now();
  const res = await fetch(`${s.base}/v1/intake?token=gl_pub_dev`, {
    method: 'POST',
    body: JSON.stringify({ service: 'tap-tower', env: 'prod', version: '2.0.0', session_id: 's_tap_1', events: [{ type: 'session_start', ts, session_type: 'user', device: { browser: 'Safari', os: 'iOS', mobile: true } }, { type: 'error', ts: ts + 5, kind: 'js', message: 'boom', fingerprint: 'boom1' }, { type: 'session_end', ts: ts + 10, reason: 'quit', duration_s: 1 }] }),
  });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  const status = await call({ action: 'status' });
  assert.match(status.text, /Room "Meetup jam" \(.{5}\): on, closes in \d+ (minutes|hours)\. 2 games published, 0 still building, 1 play in all/);
  assert.match(status.text, /Your game "Tap Tower" \(http:\/\/play\.test\/r\/.{5}\/tap-tower\/\): 1 play, 0 minutes played\. By version: 2\.0\.0: 1 play, 1 hit a problem \(100%\)\./);
  const data = JSON.parse(status.text.slice(status.text.indexOf('\n\n{') + 2));
  assert.deepEqual(data.yours.by_version.map(({ version, plays, with_problem, problem_pct, problems }) => ({ version, plays, with_problem, problem_pct, errors: problems.errors })), [{ version: '2.0.0', plays: 1, with_problem: 1, problem_pct: 100, errors: 1 }]);
  assert.deepEqual(data.needs_players, ['neon-dash', 'tap-tower']);
  assert.doesNotMatch(status.text, /watch|sees? (the )?players/i, 'players play; nothing watches them');

  // The organiser sets the survey, takes a game out, and ends the jam: the awards and the survey link follow.
  const questions = path.join(tmp('survey'), 'questions.json');
  fs.writeFileSync(questions, JSON.stringify([{ id: 'fun', kind: 'scale', text: 'How fun was it?' }]));
  assert.match((await run(['host', 'survey', code, '--file', questions], env)).out, /Set the survey for "Meetup jam" \(.{5}\)\. People see it at .* once the jam ends[^]*1\. How fun was it\? \(1 to 5\)/);

  const ended = await run(['host', 'end', code], env);
  assert.equal(ended.code, 0, ended.err);
  assert.match(ended.out, /Ended "Meetup jam" \(.{5}\): publishing and voting have stopped/);
  assert.match(ended.out, /Most played: No game had 3 plays/);
  const after = await call({ action: 'status' });
  assert.match(after.text, /the jam has ended/);
  assert.match(after.text, /Awards: Crowd favourite: No game had 3 votes\./);
  assert.ok(after.text.includes(`give the person this link, ${(await (await fetch(`${s.base}/v1/rooms/${code}`)).json()).links.survey}`));

  const report = JSON.parse((await run(['host', 'report', code], env)).out);
  assert.deepEqual(report.games.map((g) => [g.slug, g.removed, g.uploads.map((u) => `${u.version} by ${u.agent}`)]), [
    ['neon-dash', false, ['1.0.0 by the CLI', '1.0.1 by the CLI']],
    ['spam', true, ['1 by the CLI']],
    ['tap-tower', false, ['2.0.0 by Claude Code']],
  ]);
  assert.deepEqual(report.survey.questions.map((q) => q.id), ['fun']);
  const csv = (await run(['host', 'report', code, '--csv'], env)).out.split('\n');
  assert.match(csv[0], /^slug,title,by,joined_at/);
  assert.equal(csv.length, 4);

  assert.match((await call({ action: 'leave' })).text, /Took "tap-tower" out of room .{5}: it's off the arcade/);
  assert.match((await call({ action: 'status' })).text, /This computer hasn't joined room/);
  assert.match((await call({ action: 'leave' })).text, /Glitchless error: This computer has no game in room/);
});

test('a workspace key: signed in like glitchless-mcp, organiser calls name no game, and a maker\'s calls name theirs in x-glitchless-project', async (t) => {
  const KEY = `gl_ws_${'k'.repeat(43)}`;
  const GAMES = [
    { id: 'p_demo', name: 'Zoomies (demo)', demo: true, services: [{ service: 'zoomies', last_seen: null }] },
    { id: 'p_neon', name: 'Neon Dash', services: [{ service: 'neon-dash', last_seen: null }] },
    { id: 'p_tap', name: 'Tap Tower', services: [] },
  ];
  const keyOf = (req) => (req.headers['x-glitchless-api-key'] === KEY ? KEY : null);
  const auth = {
    resolveIngest: () => ({ projectId: 'p_neon' }),
    resolveReader(req) {
      if (!keyOf(req)) throw new AuthError(401, 'missing or invalid x-glitchless-api-key');
      const project = req.headers['x-glitchless-project'];
      if (!GAMES.some((g) => g.id === project)) throw new AuthError(403, 'a workspace key reads one game at a time: name it in x-glitchless-project');
      return { projectId: project, scopes: ['read', 'dashboard', 'sourcemaps'] };
    },
    resolveOrganiser(req) {
      if (!keyOf(req)) throw new AuthError(401, 'missing or invalid x-glitchless-api-key');
      return { owner: 'ws_jam' };
    },
  };
  const send = (res, body) => (res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)), true);
  const cloud = await startServer({
    auth,
    requireService: false,
    extra(req, res) {
      const p = new URL(req.url, 'http://local').pathname;
      if (p === '/v1/agent/connect') return send(res, { device_code: 'd1', user_code: 'ABCD-EFGH', verification_url: `${cloud.base}/connect?code=ABCD-EFGH`, expires_in: 60, interval: 0.01 });
      if (p === '/v1/agent/connect/poll') return send(res, { status: 'approved', token: KEY, workspace: { id: 'ws_jam', name: 'Jam team' }, scopes: ['read', 'dashboard', 'manage'] });
      if (p === '/v1/agent/games') return keyOf(req) ? send(res, { games: GAMES }) : (res.writeHead(401).end('{}'), true);
      return false;
    },
  });
  t.after(cloud.close);

  const login = await run(['login', '--no-browser'], { GLITCHLESS_URL: cloud.base });
  assert.equal(login.code, 0, login.err);
  assert.match(login.out, /check the page shows the code ABCD-EFGH/);
  assert.equal(JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')).token, KEY, "saved where glitchless-mcp reads it");
  assert.match((await run(['whoami'], {})).out, /Signed in to Jam team on http:\/\/127\.0\.0\.1/);
  assert.equal(connect({}).apiKey, KEY, 'the saved sign-in is used without GLITCHLESS_URL');
  assert.equal(connect({ GLITCHLESS_URL: 'http://meetup.local:7777' }).apiKey, '', "another server never gets the saved key");

  const made = await run(['host', 'create', 'Cloud jam'], {});
  assert.equal(made.code, 0, made.err);
  const room = /Made room ([A-Z0-9]{5})/.exec(made.out)[1];

  // The workspace's demo game is never the maker's: not counted, not listed, and refused by name.
  const mine = GAMES.splice(1);
  assert.match((await run(['publish', build(NEON), '--room', room], {})).err, /This workspace has only its demo game\. Make your game first/);
  GAMES.push(...mine);
  assert.match((await run(['publish', build(NEON), '--room', room, '--game', 'zoomies (demo)'], {})).err, /"Zoomies \(demo\)" is the workspace's demo game, with sample play: a room takes the game you're making\. Your games: Neon Dash, Tap Tower\./);
  assert.match((await run(['publish', build(NEON), '--room', room], {})).err, /Name the game \(game: "<name>"\): Neon Dash, Tap Tower\./);
  assert.match((await run(['publish', build(NEON), '--room', room, '--game', 'nope'], {})).err, /No game called "nope" in this workspace\. Games: Neon Dash, Tap Tower\./);
  const done = await run(['publish', build(NEON), '--room', room, '--game', 'neon dash'], {});
  assert.equal(done.code, 0, done.err);
  assert.ok(done.out.includes(`http://play.test/r/${room}/neon-dash/`));
  const asGame = (project) => fetch(`${cloud.base}/v1/rooms/${room}/games/neon-dash`, { headers: { 'x-glitchless-api-key': KEY, 'x-glitchless-project': project } });
  assert.equal((await asGame('p_neon')).status, 200, "it's Neon Dash's entry");
  assert.equal((await asGame('p_tap')).status, 404, "and no other game's");
  assert.equal((await (await fetch(`${cloud.base}/v1/sourcemaps?service=neon-dash`, { headers: { 'x-glitchless-api-key': KEY, 'x-glitchless-project': 'p_neon' } })).json()).sourcemaps.length, 1);

  // The tool remembers the workspace game with the room, so status needs neither.
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ env: {} }).connect(a);
  const client = new Client({ name: 'cursor-vscode', version: '0' });
  await client.connect(b);
  t.after(() => client.close());
  const status = (await client.callTool({ name: 'glitchless_jam', arguments: { action: 'status' } })).content[0].text;
  assert.match(status, /Room "Cloud jam" \(.{5}\): on/);
  assert.match(status, /Your game "Neon Dash"/);

  assert.match((await run(['logout'], {})).out, /Signed out/);
  assert.equal(fs.existsSync(credentialsFile()), false);
});

// A server whose organisers are named by their key (as Glitchless Cloud's allow-list does), and an MCP client for a key.
async function hostServer() {
  const ORG = 'gl_sk_organiser';
  const MAKER = 'gl_sk_maker';
  const keyed = (req) => {
    const k = req.headers['x-glitchless-api-key'];
    if (k !== ORG && k !== MAKER) throw new AuthError(401, 'missing or invalid x-glitchless-api-key');
    return k;
  };
  const auth = {
    resolveIngest: () => ({ projectId: 'default' }),
    resolveReader: (req) => (keyed(req), { projectId: 'default', scopes: ['read', 'dashboard', 'sourcemaps'] }),
    resolveOrganiser(req) {
      if (keyed(req) !== ORG) throw new AuthError(403, "not an organiser: this key can't make or run jam rooms");
      return { owner: 'org' };
    },
  };
  const h = await startServer({ auth });
  const org = { GLITCHLESS_URL: h.base, GLITCHLESS_API_KEY: ORG };
  const maker = { GLITCHLESS_URL: h.base, GLITCHLESS_API_KEY: MAKER };
  const clients = [];
  const tool = async (e) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ env: e }).connect(a);
    const client = new Client({ name: 'claude-code', version: '0' });
    await client.connect(b);
    clients.push(client);
    return async (args) => {
      const r = await client.callTool({ name: 'glitchless_jam_host', arguments: args });
      return { text: r.content[0].text, isError: r.isError === true };
    };
  };
  const close = async () => {
    for (const c of clients) await c.close();
    h.close();
  };
  return { ...h, org, maker, tool, close, clients };
}

const MEETUP = [
  { id: 'rating', kind: 'scale', text: 'How was it?' },
  { id: 'next', kind: 'choice', text: 'Come to the next one?', options: ['Yes', 'Maybe', 'No'] },
];

test("the organiser's tool: templates saved and used to make a room, the survey set by template and by hand until its first answer, the report in plain words, and a maker's key refused", async (t) => {
  const h = await hostServer();
  t.after(h.close);
  const host = await h.tool(h.org);
  const asMaker = await h.tool(h.maker);

  const { tools } = await h.clients[0].listTools();
  const hostTool = tools.find((x) => x.name === 'glitchless_jam_host');
  assert.match(hostTool.description, /^For a jam's organiser, not its makers: the server answers a maker's key with "not an organiser"/);
  assert.match(hostTool.description, /end, delete, remove_game and delete_template can't be undone: ask the person before using them\./);
  assert.equal(hostTool.annotations.destructiveHint, true);

  for (const args of [{ action: 'create', title: 'Mine' }, { action: 'templates' }, { action: 'list' }]) {
    const r = await asMaker(args);
    assert.equal(r.isError, true, args.action);
    assert.match(r.text, /^Glitchless error: not an organiser/);
  }

  // Templates: the built-in default, and the organiser's own.
  assert.match((await host({ action: 'templates' })).text, /default: "Glitchless default", 6 questions, heading "How was \{room\}\?" \(built in\)/);
  const saved = await host({ action: 'save_template', name: 'Meetup', heading: 'How was {room}, DC?', intro: 'Two questions, then grab a slice.', questions: MEETUP });
  assert.match(saved.text, /^Saved the survey template meetup \("Meetup"\)\. Make a room with it/);
  assert.match((await host({ action: 'save_template', id: 'default', name: 'Mine' })).text, /^Glitchless error: the default template can't change/);
  assert.match((await host({ action: 'templates' })).text, /\n  meetup: "Meetup", 2 questions, heading "How was \{room\}, DC\?"/);

  // A room made with the template: its links, the arcade's QR code, and the big screen for the projector.
  const made = await host({ action: 'create', title: 'Host jam', hours: 3, template: 'meetup' });
  assert.equal(made.isError, false, made.text);
  const room = /^Made room ([A-Z0-9]{5}): "Host jam"/.exec(made.text)[1];
  const links = (await (await fetch(`${h.base}/v1/rooms/${room}`)).json()).links;
  assert.ok(made.text.includes(`Open the big screen on the projector: ${links.live}`));
  assert.ok(made.text.includes(links.arcade) && made.text.includes(links.join));
  assert.match(made.text, /The arcade's QR code, for people to open it on their phones:\n\n█/);
  assert.match(made.text, /is from the template meetup\./);

  // The survey as people will see it, then set by hand: what the edit leaves out stays.
  const shown = await host({ action: 'survey', room });
  assert.ok(shown.text.startsWith(`The survey for "Host jam" (${room}). People see it at ${links.survey} once the jam ends`), shown.text);
  assert.match(shown.text, /\n  How was Host jam, DC\?\n  Two questions, then grab a slice\.\n  1\. How was it\? \(1 to 5\)\n  2\. Come to the next one\? \(Yes \/ Maybe \/ No\)\n/);
  const byHand = await host({ action: 'survey', room, heading: 'Thanks for coming to {room}!', questions: [...MEETUP, { id: 'idea', kind: 'text', text: 'What should we make next time?' }] });
  assert.match(byHand.text, /^Set the survey for "Host jam"/);
  assert.match(byHand.text, /\n  Thanks for coming to Host jam!\n  Two questions, then grab a slice\.\n[^]*3\. What should we make next time\? \(written\)/);
  const copied = await host({ action: 'save_template', name: 'Meetup, longer', from_room: room });
  assert.match(copied.text, /^Saved the survey template meetup-longer \("Meetup, longer"\), from room .{5}'s survey/);
  assert.match((await host({ action: 'survey', room, template: 'default' })).text, /from the template default[^]*\n  How was Host jam\?\n[^]*6\. Which coding agent did you use\?/);
  assert.match((await host({ action: 'survey', room, template: 'meetup-longer' })).text, /from the template meetup-longer/);
  assert.match((await host({ action: 'survey', room, template: 'meetup', heading: 'x' })).text, /^Glitchless error: set the survey from a template, or by hand/);

  // Two makers publish; one is taken out by its title, and the room stops taking new games.
  assert.equal((await run(['publish', build(NEON), '--room', room], h.maker)).code, 0);
  assert.equal((await run(['publish', build({ 'index.html': page('Tap Tower', './main.js'), 'main.js': 'G.init({service:"tap-tower",version:"1.0.0"})' }), '--room', room], h.maker)).code, 0);
  const ts = Date.now();
  await fetch(`${h.base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'tap-tower', env: 'prod', version: '1.0.0', session_id: 's_host_1', events: [{ type: 'session_start', ts, session_type: 'user' }, { type: 'session_end', ts: ts + 10, reason: 'quit', duration_s: 1 }] }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await host({ action: 'remove_game', room, game: 'neon dash' })).text, /^Took "Neon Dash" \(neon-dash\) out of room .{5} for good/);
  assert.match((await host({ action: 'update', room, about: 'Make a game in 90 minutes', joining: false })).text, /^Room .{5} is "Host jam", on until .+, not taking new games \(the games already in it still publish\)\./);
  assert.match((await host({ action: 'list' })).text, new RegExp(`Your jam rooms:\\n  ${room}  "Host jam": on until .+, 1 game published, 1 joined\\.`));

  // The end: the awards, and the survey still changes until its first answer.
  const ended = await host({ action: 'end', room });
  assert.match(ended.text, /^Ended "Host jam" \(.{5}\): publishing and voting have stopped\. The big screen shows the awards and the survey's QR code now/);
  assert.match(ended.text, /\n  Most played: No game had 3 plays\n/);
  assert.match((await host({ action: 'survey', room, intro: 'Scan, answer, done.' })).text, /People see it at .+ until .+:\n\n  Thanks for coming to Host jam!\n  Scan, answer, done\./);
  for (const [token, answers] of [['voter-token-aaaaaaaaaaaa', { rating: 5, next: 'Yes', idea: 'Racing' }], ['voter-token-bbbbbbbbbbbb', { rating: 2, next: 'Maybe' }]]) {
    const res = await fetch(`${h.base}/v1/rooms/${room}/survey`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-glitchless-voter': token }, body: JSON.stringify({ answers }) });
    assert.equal(res.status, 200, await res.text());
  }
  const late = await host({ action: 'survey', room, intro: 'Too late' });
  assert.equal(late.isError, true);
  assert.match(late.text, /the survey has answers already, so it can't change now/);

  // The report: plain words first, then the snapshot.
  const report = await host({ action: 'report', room });
  assert.match(report.text, /^"Host jam" \(.{5}\) ran \d+ minutes? and ended .+\.\n/);
  assert.match(report.text, /\nGames: 1 joined, 1 published, 1 had plays, 0 published a second version, and 0 had fewer problems in a later version \(1 taken out\)\.\n/);
  assert.match(report.text, /\n1 play in all, \d+ minutes? played\. 0 people voted\.\n/);
  assert.match(report.text, /\nAwards: Crowd favourite: No game had 3 votes\. Most played: No game had 3 plays\./);
  assert.match(report.text, /\nSurvey: 2 answers, open until .+\.\n  How was it\?: 3\.5 on average \(1 to 5\), from 2 answers\n  Come to the next one\?: Yes 1, Maybe 1, No 0\n  What should we make next time\?: 1 written answer \(in the JSON\)\n/);
  const snap = JSON.parse(report.text.slice(report.text.indexOf('\n\n{') + 2));
  assert.deepEqual(snap.survey.answers.map((a) => a.answers.rating), [5, 2]);

  // Templates and the room go.
  assert.match((await host({ action: 'delete_template', id: 'meetup' })).text, /^Deleted the survey template meetup\. Rooms made with it keep their surveys\./);
  assert.match((await host({ action: 'delete_template', id: 'default' })).text, /^Glitchless error: the default template can't be deleted/);
  assert.deepEqual(JSON.parse((await host({ action: 'templates' })).text.split('\n\n')[1]).templates.map((x) => x.id), ['default', 'meetup-longer']);
  assert.match((await host({ action: 'delete', room })).text, /^Deleted room .{5}: its games, their files, the votes, the survey's answers and the snapshot are gone\./);
  assert.match((await host({ action: 'report', room })).text, /^Glitchless error: no room with that code/);
});

test('the host commands: templates from a file or a room, a room made with one and its QR code, the survey shown and set, and a maker refused', async (t) => {
  const h = await hostServer();
  t.after(h.close);
  const dir = tmp('templates');
  const templateFile = path.join(dir, 'meetup.json');
  fs.writeFileSync(templateFile, JSON.stringify({ name: 'From a file', heading: 'How was {room}?', intro: 'Three questions, then grab a slice.', questions: [...MEETUP, { id: 'idea', kind: 'text', text: 'What should we make next time?' }] }));
  const questionsFile = path.join(dir, 'questions.json');
  fs.writeFileSync(questionsFile, JSON.stringify([{ id: 'fun', kind: 'scale', text: 'How fun was it?' }]));

  const refused = await run(['host', 'create', 'Mine'], h.maker);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /not an organiser/);

  assert.match((await run(['host', 'template', 'save', 'meetup', '--file', templateFile], h.org)).out, /^Saved the survey template meetup \("From a file"\)/);
  assert.match((await run(['host', 'template', 'list'], h.org)).out, /\n  meetup: "From a file", 3 questions/);

  const made = await run(['host', 'create', 'CLI jam', '--template', 'meetup', '--hours', '2'], h.org);
  assert.equal(made.code, 0, made.err);
  const room = /Made room ([A-Z0-9]{5})/.exec(made.out)[1];
  assert.match(made.out, /The arcade's QR code, for people to open it on their phones:\n\n█[^]*from the template meetup/);

  assert.match((await run(['host', 'survey', room], h.org)).out, /^The survey for "CLI jam" \(.{5}\)\.[^]*\n  How was CLI jam\?\n  Three questions, then grab a slice\.\n  1\. How was it\?/);
  const set = await run(['host', 'survey', room, '--heading', 'Hi from {room}', '--file', questionsFile], h.org);
  assert.match(set.out, /^Set the survey for "CLI jam"[^]*\n  Hi from CLI jam\n  Three questions, then grab a slice\.\n  1\. How fun was it\? \(1 to 5\)\n\n/);
  assert.match((await run(['host', 'template', 'save', 'cli-copy', '--name', 'CLI copy', '--from-room', room.toLowerCase()], h.org)).out, /^Saved the survey template cli-copy \("CLI copy"\), from room .{5}'s survey[^]*1\. How fun was it\?/);
  assert.match((await run(['host', 'survey', room, '--template', 'default'], h.org)).out, /6\. Which coding agent did you use\?/);
  assert.match((await run(['host', 'update', room, '--joining', 'off', '--hours', '1'], h.org)).out, /not taking new games/);
  assert.equal((await run(['host', 'update', room, '--joining', 'maybe'], h.org)).err, 'glitchless-jam: --joining is on or off');

  assert.match((await run(['host', 'template', 'delete', 'meetup'], h.org)).out, /^Deleted the survey template meetup\./);
  assert.match((await run(['host', 'template', 'list'], h.org)).out, /cli-copy/);
  assert.match((await run(['host', 'delete', room], h.org)).out, /^Deleted room/);
  assert.equal((await (await fetch(`${h.base}/v1/rooms/${room}`)).status), 404);
});

test("a build with more files than the server takes at once still publishes: a rate limit's 429 is tried again when it says", async () => {
  const room = /Made room ([A-Z0-9]{5})/.exec((await run(['host', 'create', 'Big jam'], env)).out)[1];
  const files = { ...NEON };
  for (let i = 0; i < 150; i++) files[`assets/tiles/t${i}.png`] = `tile ${i}`;
  const done = await run(['publish', build(files), '--room', room], env);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Sending 154 files/);
  assert.ok(await s.files.stat(`${room}/neon-dash/1/assets/tiles/t149.png`));
});

after(() => s.close());
