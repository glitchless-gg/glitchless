// "Set up Glitchless for my game in this folder", in an agent that has this MCP server and no Glitchless skill:
// glitchless_create_game with engine (or the files the agent found) makes the game, or finds the one already in the
// workspace, and answers with the instrument skill's steps for that engine, with where the game sends in them.
// glitchless_dashboard's guide is the dashboard skill. Called over an in-memory MCP connection against a fake
// Glitchless Cloud, as a workspace that may create games, one that may only read, and a server on this computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-setup-'));
delete process.env.GLITCHLESS_API_KEY;
delete process.env.GLITCHLESS_URL;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let scopes = ['read', 'dashboard', 'manage'];
const games = [
  { id: 'p_demo', name: 'Zoomies (demo)', demo: true, client_token: 'gl_pub_demo', services: [] },
  { id: 'p_sky', name: 'Skyward', client_token: 'gl_pub_skyward', services: [], dashboard: 'https://app.example.test/?game=p_sky' },
];
const made = [];
// Whether the workspace's plan has room for another game (the Free plan has room for one).
let full = false;
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const send = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/v1/agent/games' && req.method === 'POST' && full) return res.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The Free plan has room for one game.' }));
  if (url.pathname === '/v1/agent/games' && req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => (raw += d));
    return req.on('end', () => {
      const { name } = JSON.parse(raw);
      const game = { id: `p_${made.length}`, name, client_token: `gl_pub_new${made.length}`, services: [] };
      made.push(name);
      games.push(game);
      send({ game: { id: game.id, name }, client_token: game.client_token, intake: 'https://api.example.test', dashboard: 'https://app.example.test' });
    });
  }
  if (url.pathname === '/v1/agent/games') return send({ games, intake: 'https://api.example.test' });
  if (url.pathname === '/v1/agent/whoami') return send({ workspace: { id: 'w1', name: "Olive's games" }, scopes, intake: 'https://api.example.test', dashboard: 'https://app.example.test' });
  send({});
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const { createServer, connection } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { engineFrom, ENGINES } = await import('../src/setup-guide.js');
const { TEXTS } = await import('../src/skills.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const KEY = `gl_ws_${'k'.repeat(43)}`;
async function connect(c = null, shown = null) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ remote: !!c, connection: c, scopes: shown }).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}
const cloud = () => connection({ base: `http://127.0.0.1:${api.address().port}`, apiKey: KEY });
const workspace = await connect(cloud());
const readOnly = await connect(cloud(), ['read']);
const local = await connect();
const call = (client, name, args) => client.callTool({ name, arguments: args });
const steps = async (client, args) => {
  const r = await call(client, 'glitchless_create_game', args);
  assert.ok(!r.isError, r.content[0].text);
  return r.content[0].text;
};
const nameOf = (id) => ENGINES.find((e) => e.id === id).name;

test.after(async () => {
  await workspace.close();
  await readOnly.close();
  await local.close();
  api.close();
});

test('the files an agent finds in a project name its engine, a native project file before a package.json', () => {
  const cases = [
    [['project.godot', 'package.json', 'addons'], 'godot'],
    [['Assets', 'ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json'], 'unity'],
    [['Starseam.uproject', 'package.json', 'three'], 'unreal'],
    [['Game.yyp', 'objects'], 'gamemaker'],
    [['default.project.json', 'wally.toml', 'src'], 'roblox'],
    [['Nardo.rbxlx'], 'roblox'],
    [['src/server/init.server.luau'], 'roblox'],
    [['package.json', 'three@0.170.0', 'vite'], 'threejs'],
    [['"@react-three/fiber": "^9.0.0"'], 'threejs'],
    [['package.json', 'phaser'], 'phaser'],
    [['index.html', 'lib/phaser.min.js'], 'phaser'],
    [['@babylonjs/core'], 'babylon'],
    [['playcanvas-stable.min.js'], 'playcanvas'],
  ];
  for (const [files, engine] of cases) assert.equal(engineFrom(files).engine, engine, files.join(', '));
  assert.deepEqual(engineFrom(['package.json', 'phaser', 'three']), { engine: 'threejs', sign: 'three', also: ['phaser'] });
  assert.equal(engineFrom(['Cargo.toml', 'bevy']).engine, null);
  assert.equal(engineFrom(['manifest.json']).engine, null, "a web app's manifest.json isn't Unity's");
  assert.equal(engineFrom(['tsconfig.project.json.bak', 'project.json']).engine, null, "a project.json isn't Rojo's");
  // A game in a Reddit post: Reddit first, whatever else names the engine of the game in the post.
  assert.deepEqual(engineFrom(['devvit.json', 'package.json', 'phaser', '@devvit/web', 'hono']), { engine: 'reddit', sign: 'devvit.json', also: ['phaser'] });
  assert.deepEqual(engineFrom(['package.json', '@devvit/web', 'three']), { engine: 'reddit', sign: '@devvit/web', also: ['threejs'] });
  assert.deepEqual(engineFrom(['devvit.json', 'src/client/public/Build/SampleGame.wasm.unityweb']).also, ['unity'], "Reddit's Unity template holds the build");
  assert.deepEqual(engineFrom(['devvit.json', 'src/client/public/index.pck']).also, ['godot']);
  assert.equal(engineFrom(['devvit-notes.json', 'devvit.config.ts']).engine, null);
  // Every reference the skill has is an engine, in the order of the skill's table.
  assert.deepEqual(ENGINES.map((e) => e.id), ['unity', 'godot', 'unreal', 'threejs', 'roblox', 'phaser', 'babylon', 'playcanvas', 'gamemaker', 'reddit']);
  assert.deepEqual(ENGINES.map((e) => `${e.id}.md`).sort(), fs.readdirSync(path.join(ROOT, 'plugin/glitchless/skills/instrument/references')).sort());
});

test("each engine gets its own steps, with the cloud's intake and the game's client token in them", async () => {
  const kits = { godot: 'godot/addons/glitchless', unreal: 'unreal/Plugins/Glitchless', roblox: 'roblox', gamemaker: 'gamemaker' };
  const limit = Number((await workspace.listTools()).tools.find((t) => t.name === 'glitchless_create_game').description.match(/up to ([\d,]+) characters/)[1].replace(/,/g, ''));
  for (const [files, id, heading] of [
    [['project.godot'], 'godot', '# Godot'],
    [['ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json'], 'unity', '# Unity'],
    [['Starseam.uproject'], 'unreal', '# Unreal'],
    [['package.json', 'three', 'vite'], 'threejs', '# Three.js'],
    [['default.project.json'], 'roblox', '# Roblox'],
    [['package.json', 'phaser'], 'phaser', '# Phaser'],
    [['@babylonjs/core'], 'babylon', '# Babylon.js'],
    [['playcanvas'], 'playcanvas', '# PlayCanvas'],
    [['Game.yyp'], 'gamemaker', '# GameMaker'],
  ]) {
    const text = await steps(workspace, { files, game: 'skyward' });
    assert.match(text, new RegExp(`^# Add Glitchless to this ${nameOf(id).replace('.', '\\.')} game`));
    assert.ok(text.includes(`\n${heading}\n`), `${id}: its reference`);
    for (const other of ENGINES.filter((e) => e.id !== id)) assert.ok(!text.includes(`\n# ${other.name}\n`), `${id} leaves out ${other.name}`);
    assert.ok(text.includes("- intake URL: https://api.example.test\n- client token: gl_pub_skyward (Skyward's)."), `${id}: where it sends`);
    assert.ok(text.includes('name the game: game: "Skyward"'), `${id}: the game in later calls`);
    assert.match(text, /## 0\. Find the engine, and the settings[\s\S]*\*\*Privacy\.\*\*/, 'the settings');
    assert.match(text, /## Every engine: the game's own metrics, and its board[\s\S]*## Report/);
    assert.match(text, /follow the `dashboard` skill, call glitchless_dashboard with guide: true/);
    assert.ok(!/^\| `three` or/m.test(text), "the engine table is cut to this game's");
    assert.ok(text.includes(`This game: ${nameOf(id)} (${engineFrom(files).sign}).`), `${id}: what named it`);
    // The kit is cloned only where the steps copy from it, and it holds what they copy.
    assert.equal(text.includes('git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless\n```'), id in kits, `${id}: the agent kit`);
    if (kits[id]) assert.ok(text.includes(`~/.glitchless/${kits[id]}`) && fs.existsSync(path.join(ROOT, kits[id])), kits[id]);
    // No link the agent can't follow: relative ones go to GitHub or say they're here.
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) assert.match(href, /^https:\/\//, `${id}: ${href}`);
    assert.ok(!text.includes(KEY), 'never the workspace key');
    assert.ok(text.length <= limit, `${id}: ${text.length} characters, over the ${limit} the tool's description promises`);
  }
  assert.equal(made.length, 0, 'a game already here is set up, not made again');
});

test("a game in a Reddit post gets Reddit's steps (the relay), then its client's engine's, in one answer", async () => {
  const limit = Number((await workspace.listTools()).tools.find((t) => t.name === 'glitchless_create_game').description.match(/up to ([\d,]+) characters/)[1].replace(/,/g, ''));
  for (const [args, client] of [
    [{ files: ['devvit.json', 'package.json', 'phaser', '@devvit/web'] }, 'phaser'],
    [{ files: ['devvit.json', 'three'] }, 'threejs'],
    [{ engine: 'unity', files: ['devvit.json'] }, 'unity'],
    [{ engine: 'godot', files: ['devvit.json'] }, 'godot'],
    [{ files: ['devvit.json', 'package.json', '@devvit/web', 'hono'] }, null],
    [{ engine: 'reddit' }, null],
  ]) {
    const text = await steps(workspace, { ...args, game: 'Skyward' });
    const label = JSON.stringify(args);
    assert.match(text, new RegExp(`^# Add Glitchless to this Reddit${client ? ` \\(${nameOf(client).replace('.', '\\.')}\\)` : ''} game`), label);
    assert.ok(text.includes('\n# Reddit\n') && text.includes('"domains": ["api.glitchless.gg"]') && text.includes("glitchlessRelay({ clientToken: '<the game client token>', context })"), `${label}: the relay`);
    assert.ok(text.includes('## Fetch Domains'), `${label}: the README part Reddit asks for`);
    assert.ok(text.includes("- client token: gl_pub_skyward (Skyward's)."), `${label}: where it sends`);
    if (client) assert.ok(text.indexOf(`\n# ${nameOf(client)}\n`) > text.indexOf('\n# Reddit\n'), `${label}: the client's steps after Reddit's`);
    for (const other of ENGINES.filter((e) => e.id !== client && e.id !== 'reddit')) assert.ok(!text.includes(`\n# ${other.name}\n`), `${label} leaves out ${other.name}`);
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) assert.match(href, /^https:\/\//, `${label}: ${href}`);
    assert.ok(text.length <= limit, `${label}: ${text.length} characters, over ${limit}`);
  }
  const godot = await steps(workspace, { engine: 'godot', files: ['devvit.json'], game: 'Skyward' });
  assert.ok(godot.includes('git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless') && godot.includes('\n## Install\n'), "a Godot client's addon README parts come too");
  // Without a game yet, the call to make one keeps Reddit and the client.
  assert.match(await steps(workspace, { engine: 'godot', files: ['devvit.json'] }), /Call glitchless_create_game again with name \(the game's name, as players know it\) and engine: "godot" and files: \["devvit\.json"\]/);
  assert.match(await steps(workspace, { files: ['devvit.json'] }), /and engine: "reddit": it makes the game/);
});

test('the sections an engine borrows from another come along, and the Godot README parts its steps send it to', async () => {
  for (const e of ENGINES) {
    const text = await steps(workspace, { engine: e.id, game: 'Skyward' });
    for (const [, file, hash] of TEXTS[e.ref].matchAll(/\]\((\w+\.md)#([^)]+)\)/g)) {
      const from = TEXTS[`plugin/glitchless/skills/instrument/references/${file}`];
      const title = from.split('\n').find((l) => /^#+ /.test(l) && l.replace(/^#+ /, '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-') === hash);
      assert.ok(title, `${e.id} points to ${file}#${hash}, a section that exists`);
      assert.ok(text.includes(`\n${title}\n`), `${e.id} carries ${file}#${hash}`);
    }
  }
  const godot = await steps(workspace, { engine: 'godot', game: 'Skyward' });
  for (const part of ['## Install', '## Use', '### Off in debug builds', "### The player's off switch", '## For agents: `--glitchless-measure`']) assert.ok(godot.includes(`\n${part}\n`), part);
  assert.ok(!godot.includes('\n## Limits\n') && !godot.includes('\n### Steam\n'), 'not the whole README');
  assert.match(godot, /# From the Three\.js steps\n\nThe Godot steps above point here\.\n\n## 4b\. Bug reports from players/);
  assert.match(godot, /As for Three\.js, and the same question/);
  // What a developer with no players needs: their own runs from the editor send.
  assert.match(godot, /## Runs from the editor[\s\S]*--glitchless/);
});

test('with a name it makes the game and hands over its steps in one call; a name already here is found, not made twice', async () => {
  const text = await steps(workspace, { name: 'Moonhop', engine: 'godot' });
  assert.deepEqual(made, ['Moonhop']);
  assert.match(text, /^Created Moonhop\.\n\n# Add Glitchless to this Godot game/);
  assert.ok(text.includes("- client token: gl_pub_new0 (Moonhop's)."), text.slice(0, 900));
  // The person named Skyward on the connect page: the agent's call finds it, whatever the capitals.
  const again = await steps(workspace, { name: 'skyward', files: ['package.json', 'three'] });
  assert.match(again, /^Skyward is already in this workspace, so nothing was made: these steps use its client token\.\n\n# Add Glitchless to this Three\.js game/);
  assert.ok(again.includes("- client token: gl_pub_skyward (Skyward's)."));
  // And without an engine: its client token, not a second Skyward.
  const plain = await call(workspace, 'glitchless_create_game', { name: 'Skyward' });
  assert.match(plain.content[0].text, /^Skyward is already in this workspace, so nothing was made\./);
  assert.equal(JSON.parse(plain.content[0].text.slice(plain.content[0].text.indexOf('\n{') + 1)).client_token, 'gl_pub_skyward');
  assert.deepEqual(made, ['Moonhop']);
  // A new name without an engine makes the game as before, and says how to get its steps.
  const fresh = await call(workspace, 'glitchless_create_game', { name: 'Tidepool' });
  assert.match(fresh.content[0].text, /^Created Tidepool\. .*call again with game: "Tidepool" and engine, or files/);
  assert.deepEqual(made, ['Moonhop', 'Tidepool']);
});

test('nothing is made until the engine is known, and a game in two engines is told so', async () => {
  const before = made.length;
  const find = await steps(workspace, { name: 'Rustling', files: ['Cargo.toml', 'bevy'] });
  assert.match(find, /^None of these names an engine Glitchless has an SDK for: Cargo\.toml, bevy\. Nothing was made\./);
  for (const e of ENGINES) assert.ok(find.includes(`| \`${e.id}\` |`), e.id);
  assert.match(find, /Then call glitchless_create_game again with engine, or with files/);
  assert.equal(made.length, before);
  assert.match(await steps(workspace, { game: 'Skyward', files: ['package.json', 'phaser', 'three'] }), /The files also name Phaser\. If this game is made with that instead, call glitchless_create_game again with engine: "phaser"/);
});

test('with no game named, the steps say how to get a client token; the demo game has no code to set up', async () => {
  const text = await steps(workspace, { engine: 'unity' });
  assert.match(text, /client token: none yet\. Call glitchless_create_game again with name \(the game's name, as players know it\) and engine: "unity"/);
  assert.match(text, /Games already here: Skyward, Moonhop, Tidepool; to set one of those up, pass game with its name instead/);
  for (const args of [{ game: 'Zoomies (demo)', engine: 'unity' }, { name: 'zoomies (demo)', engine: 'unity' }, { demo: true, engine: 'unity' }]) {
    const r = await call(workspace, 'glitchless_create_game', args);
    assert.ok(r.isError && /demo game/.test(r.content[0].text), r.content[0].text);
  }
  const r = await call(workspace, 'glitchless_create_game', { game: 'Skyward', rename: 'Skyward 2', engine: 'unity' });
  assert.ok(r.isError && /leave out name, demo, engine and files/.test(r.content[0].text), r.content[0].text);
});

test("a plan with no room for another game: the steps still come, saying why and which games are here", async () => {
  full = true;
  const text = await steps(workspace, { name: 'Another Name', engine: 'godot' });
  const plain = await call(workspace, 'glitchless_create_game', { name: 'Another Name' });
  full = false;
  assert.match(text, /^Another Name wasn't made: The Free plan has room for one game\.\n\n# Add Glitchless to this Godot game/);
  assert.match(text, /- client token: none yet: the game wasn't made \(The Free plan has room for one game\)\. If this game is one already here \(Skyward, Moonhop, Tidepool\), call glitchless_create_game again with game set to its name and engine: "godot"/);
  assert.ok(plain.isError && /The Free plan has room for one game\. Games already here: Skyward, Moonhop, Tidepool\. To add Glitchless to one of them/.test(plain.content[0].text), plain.content[0].text);
});

test('a key that may only read sets up a game already here, and says who can make a new one', async () => {
  scopes = ['read'];
  const before = made.length;
  const here = await steps(workspace, { game: 'Skyward', engine: 'phaser' });
  assert.ok(here.includes("- client token: gl_pub_skyward (Skyward's)."));
  const text = await steps(workspace, { name: 'Brand New', engine: 'phaser' });
  scopes = ['read', 'dashboard', 'manage'];
  assert.match(text, /client token: none yet, and this connection may only read, so it can't make the game: ask the person to add it in Glitchless \(https:\/\/app\.example\.test\)/);
  assert.equal(made.length, before);
});

test('on this computer: the local server, or sign in to Glitchless Cloud first', async () => {
  const text = await steps(local, { name: 'Skyward', engine: 'babylon' });
  assert.match(text, /^# Add Glitchless to this Babylon\.js game/);
  assert.match(text, /intake URL http:\/\/localhost:7777, client token gl_pub_dev/);
  assert.match(text, /glitchless_sign_in/);
  assert.match(text, /docker run -d --name glitchless/);
  // The longest answer there is, Godot's on a local server, keeps to what the tool's description promises.
  const limit = Number((await local.listTools()).tools.find((t) => t.name === 'glitchless_create_game').description.match(/up to ([\d,]+) characters/)[1].replace(/,/g, ''));
  const longest = await steps(local, { engine: 'godot' });
  assert.ok(longest.length <= limit, `${longest.length} characters, over ${limit}`);
  // Making a game with no engine still needs a workspace.
  const r = await call(local, 'glitchless_create_game', { name: 'Skyward' });
  assert.ok(r.isError && /This needs a workspace/.test(r.content[0].text), r.content[0].text);
});

test("glitchless_dashboard's guide is the dashboard skill with its references, before any data", async () => {
  const r = await call(workspace, 'glitchless_dashboard', { guide: true });
  assert.ok(!r.isError, r.content[0].text);
  const board = r.content[0].text;
  for (const heading of ["# Build a game's own dashboard", '# Example dashboards', '# Panels for each kind of game']) assert.ok(board.includes(`\n${heading}\n`), heading);
  assert.match(board, /read the "Panels for each kind of game" part of this guide/);
  for (const [, href] of board.matchAll(/\]\(([^)\s]+)\)/g)) assert.match(href, /^https:\/\//, href);
  const limit = Number((await workspace.listTools()).tools.find((t) => t.name === 'glitchless_dashboard').description.match(/up to ([\d,]+) characters/)[1].replace(/,/g, ''));
  assert.ok(board.length <= limit, `${board.length} characters, over ${limit}`);
});

test("the server's copy of the skills is the skills, and every connection is told where the steps are", async () => {
  for (const [file, text] of Object.entries(TEXTS)) assert.equal(text, fs.readFileSync(path.join(ROOT, file), 'utf8'), `${file}: run node scripts/sync-agent-plugin.mjs`);
  for (const client of [workspace, local]) assert.match(client.getInstructions(), /To add Glitchless to a game .*call glitchless_create_game first, before changing the game's code, with the game's name and its engine, or files/);
  const game = (await workspace.listTools()).tools.find((t) => t.name === 'glitchless_create_game');
  assert.match(game.description, /^Create a game in the signed-in workspace, or set one up: call this first when asked to set up, add or install Glitchless/);
  assert.deepEqual(game.inputSchema.properties.engine.enum, ENGINES.map((e) => e.id));
  // A game with no data: the steps come from the tool, with the game named.
  const list = (await call(workspace, 'glitchless_list_games', {})).content[0].text;
  assert.match(list, /call glitchless_create_game with game: \\"Skyward\\" and engine \(or files: what's in its folder\), which returns the steps for its engine with client_token gl_pub_skyward and intake https:\/\/api\.example\.test in them/);
  // A connection that shows only the read tools has no glitchless_create_game: it gets the setup prompt's address.
  assert.ok(!(await readOnly.listTools()).tools.some((t) => t.name === 'glitchless_create_game'));
  assert.match(readOnly.getInstructions(), /follow the setup steps at https:\/\/raw\.githubusercontent\.com\/glitchless-gg\/glitchless\/main\/docs\/agent-setup-prompt\.md: this connection may only read/);
  assert.ok(!/call glitchless_create_game first/.test(readOnly.getInstructions()));
  const read = (await call(readOnly, 'glitchless_list_games', {})).content[0].text;
  assert.match(read, /follow the setup steps at https:\/\/raw\.githubusercontent\.com\/[^ ]+ with client_token gl_pub_skyward/);
  assert.ok(!/call glitchless_create_game with game/.test(read));
});
