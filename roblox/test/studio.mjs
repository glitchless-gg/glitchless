// The Roblox SDK in real Roblox Studio, driven through Studio's own MCP server
// (https://create.roblox.com/docs/studio/mcp), against a Glitchless server on a port of its own.
//   node --test roblox/test/studio.mjs        (npm run test:roblox:studio)
//
// Needs Roblox Studio on this Mac with Assistant → … → Manage MCP Servers → Enable Studio as MCP server turned on. It
// uses the Glitchless test place (roblox/place.project.json): an open Studio whose place is that one (an unpublished
// place with ServerScriptService.GlitchlessDemo and ReplicatedStorage.Glitchless), or, with none open, it builds the
// place with Rojo and opens it. It never touches another place.
//
// Then, over MCP: it copies roblox/src and the demo's scripts into the open place (so a run always tests the code on
// disk, with no rebuild or reopen), points the demo at its server (the Intake attribute), starts a play test (a server
// and one player), waits for the demo's race to end, stops it (which closes the server: BindToClose sends everything),
// and checks what the Glitchless server received and what Studio's Output said: the race, the extras the demo turns
// on (a ProximityPrompt, a seat, joined_with_friend, friends_in_server), calls made before Glitchless started, and
// the map the server drew of the track (decoded with macOS's sips).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STUDIO_MCP = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
const STUDIO = '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
const PLACE = path.join(REPO, 'roblox/.build/GlitchlessTest.rbxl');
const SERVICE = 'roblox-studio-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-roblox-studio-'));
const dataDir = path.join(tmp, 'data');
let server;
let mcp;
let port;
let run; // what the run saw: { player, console, events }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ───────────────────────────── a small MCP client over stdio ─────────────────────────────

function connect() {
  const child = spawn(STUDIO_MCP, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let buf = '';
  let seq = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
    }
  });
  const request = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`Studio MCP: ${method} timed out`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  // A tool's text, or an error naming the tool.
  const tool = async (name, args = {}) => {
    const msg = await request('tools/call', { name, arguments: args });
    const text = (msg.result?.content || []).map((c) => c.text ?? '').join('\n');
    if (msg.error || msg.result?.isError) throw new Error(`Studio MCP ${name}: ${msg.error ? JSON.stringify(msg.error) : text}`);
    return text;
  };
  return {
    child,
    tool,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'glitchless-roblox-test', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    close: () => child.kill(),
  };
}

// The Luau a long string needs to hold `text` as it is: a [==[ … ]==] level no line in it closes.
function longString(text) {
  let eq = '=';
  while (text.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[\n${text}]${eq}]`;
}

// The open Studios whose place is the Glitchless test place.
async function testPlaces() {
  const { studios = [] } = JSON.parse(await mcp.tool('list_roblox_studios'));
  const found = [];
  for (const s of studios) {
    const out = await mcp
      .tool('execute_luau', {
        studio_id: s.id,
        datamodel_type: 'Edit',
        code: 'return game.PlaceId == 0 and game.ServerScriptService:FindFirstChild("GlitchlessDemo") ~= nil and game.ReplicatedStorage:FindFirstChild("Glitchless") ~= nil',
      })
      .catch(() => '');
    if (/true/.test(out)) found.push(s.id);
  }
  return found;
}

async function studioMode(id) {
  return (await mcp.tool('get_studio_state', { studio_id: id })).match(/Mode:\s*(\w+)/)?.[1];
}

// roblox/src (init.luau is the module itself, *.client.luau a LocalScript) and the demo's two scripts, written into the
// open place's Source, created where missing, so the play test runs the code on disk.
function luauSync() {
  const src = path.join(REPO, 'roblox/src');
  const files = [];
  for (const f of fs.readdirSync(src)) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    if (f === 'init.luau') files.push({ parent: 'game.ReplicatedStorage', name: 'Glitchless', cls: 'ModuleScript', text });
    else if (f.endsWith('.client.luau')) files.push({ parent: 'game.ReplicatedStorage.Glitchless', name: f.replace(/\.client\.luau$/, ''), cls: 'LocalScript', text });
    else files.push({ parent: 'game.ReplicatedStorage.Glitchless', name: f.replace(/\.luau$/, ''), cls: 'ModuleScript', text });
  }
  files.push({ parent: 'game.ServerScriptService', name: 'GlitchlessDemo', cls: 'Script', text: fs.readFileSync(path.join(REPO, 'roblox/demo/server.server.luau'), 'utf8') });
  files.push({ parent: 'game.StarterPlayer.StarterPlayerScripts', name: 'GlitchlessDemoClient', cls: 'LocalScript', text: fs.readFileSync(path.join(REPO, 'roblox/demo/client.client.luau'), 'utf8') });
  // The module first, so its children have a parent.
  files.sort((a, b) => (a.name === 'Glitchless') - (b.name === 'Glitchless')).reverse();
  return files.map(
    (f) => `local parent = ${f.parent}
local s = parent:FindFirstChild(${JSON.stringify(f.name)})
if not s or s.ClassName ~= ${JSON.stringify(f.cls)} then
	if s then s:Destroy() end
	s = Instance.new(${JSON.stringify(f.cls)})
	s.Name = ${JSON.stringify(f.name)}
	s.Parent = parent
end
s.Source = ${longString(f.text)}
return ${JSON.stringify(f.name)}`,
  );
}

// The maps the server kept (the file store keeps them apart from events).
function maps() {
  const file = path.join(dataDir, 'maps.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function events() {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('events-'))
    .flatMap((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

before(async () => {
  assert.ok(fs.existsSync(STUDIO_MCP), `Roblox Studio isn't installed (${STUDIO_MCP})`);
  port = await freePort();
  server = spawn(process.execPath, [path.join(REPO, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_PLAY_PORT: String(await freePort()), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '', GLITCHLESS_CLIENT_TOKENS: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) break;
    } catch {}
    await sleep(100);
  }

  mcp = connect();
  await mcp.init();
  // The proxy finds the open Studios a moment after it starts.
  let ids = [];
  for (let i = 0; i < 15 && !ids.length; i++) {
    ids = await testPlaces();
    if (!ids.length) await sleep(1000);
  }
  if (!ids.length) {
    fs.mkdirSync(path.dirname(PLACE), { recursive: true }); // a fresh checkout has no roblox/.build
    execFileSync('rojo', ['build', 'roblox/place.project.json', '-o', PLACE], { cwd: REPO, stdio: 'ignore' });
    spawn(STUDIO, ['-task', 'EditFile', '-localPlaceFile', PLACE], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 120 && !ids.length; i++) {
      await sleep(1000);
      ids = await testPlaces();
    }
  }
  assert.ok(ids.length, 'no Studio with the Glitchless test place answered over MCP: turn on Assistant → … → Manage MCP Servers → Enable Studio as MCP server');
  const studio = ids[0];
  if ((await studioMode(studio)) !== 'Edit') {
    await mcp.tool('start_stop_play', { studio_id: studio, is_start: false });
    for (let i = 0; i < 30 && (await studioMode(studio)) !== 'Edit'; i++) await sleep(1000);
  }

  for (const code of luauSync()) await mcp.tool('execute_luau', { studio_id: studio, datamodel_type: 'Edit', code });
  await mcp.tool('execute_luau', {
    studio_id: studio,
    datamodel_type: 'Edit',
    code: `game.ServerScriptService.GlitchlessDemo:SetAttribute("Intake", "http://localhost:${port}")
game:GetService("HttpService").HttpEnabled = true`,
  });

  await mcp.tool('start_stop_play', { studio_id: studio, is_start: true });
  let consoleText = '';
  let player = null;
  // From the start of a play test, the console holds that test's output only (and keeps it after Stop).
  const runLog = () => mcp.tool('get_console_output', { studio_id: studio });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (!player) player = (await mcp.tool('execute_luau', { studio_id: studio, datamodel_type: 'Server', code: 'local p = game.Players:GetPlayers()[1]; return p and (p.Name .. "|" .. p.UserId) or ""' }).catch(() => '')).match(/([\w]+)\|(\d+)/);
    consoleText = await runLog();
    if (consoleText.includes('trophy is missing')) break;
  }
  await mcp.tool('start_stop_play', { studio_id: studio, is_start: false });
  for (let i = 0; i < 30 && (await studioMode(studio)) !== 'Edit'; i++) await sleep(1000);
  consoleText = await runLog(); // with what BindToClose said
  // BindToClose sends the last batches as the server closes.
  for (let i = 0; i < 30 && events().filter((e) => e.type === 'session_end').length < 2; i++) await sleep(1000);
  run = { player: player && { name: player[1], userId: player[2] }, console: consoleText, events: events(), maps: maps() };
});

after(() => {
  mcp?.close();
  server?.kill(); // this test's own server, by its handle
  fs.rmSync(tmp, { recursive: true, force: true });
});

const of = (service, type) => run.events.filter((e) => e.service === service && (!type || e.type === type));

test('Studio said nothing is wrong: the demo ran, no Glitchless warning but the unpublished place\'s DataStore', () => {
  assert.match(run.console, /trophy is missing/, 'the demo race ended');
  const warnings = run.console.split('\n').filter((l) => l.includes('[glitchless]') && !l.includes('[glitchless] map of'));
  assert.ok(warnings.every((l) => /DataStore/.test(l)), warnings.join('\n'));
});

test("a player's session: its device, frames, loading time, stutters and an error from a LocalScript", () => {
  const [start] = of(SERVICE, 'session_start');
  assert.ok(start, `services: ${[...new Set(run.events.map((e) => e.service))]}`);
  assert.equal(start.sdk, 'glitchless-roblox/0.3.0');
  assert.equal(start.session_type, 'tester', 'a Studio session is a tester\'s');
  assert.equal(start.device.os, 'Computer');
  assert.ok(start.device.screen[0] > 1 && start.device.screen[1] > 1, `the camera's real size: ${start.device.screen}`);
  const fw = of(SERVICE, 'frame_window');
  assert.ok(fw.length >= 2 && fw.every((w) => w.ft.a === 0.02 && w.frames > 0), JSON.stringify(fw[0]));
  assert.ok(fw.some((w) => w.render_ms > 0 && w.render_ms < 100), `render_ms in milliseconds: ${fw.map((w) => w.render_ms)}`);
  assert.ok(of(SERVICE, 'load')[0]?.ttff_ms >= 0);
  const [err] = of(SERVICE, 'error');
  assert.equal(err?.kind, 'script');
  assert.equal(err.message, "attempt to index nil with 'Text'");
  assert.equal(err.source, 'Players.<player>.PlayerScripts.GlitchlessDemoClient');
  assert.equal(of(SERVICE, 'session_end')[0]?.reason, 'quit');
});

test("the server's own session: its frames, its error (never a crash), and the end when Studio stopped", () => {
  const server = `${SERVICE}.server`;
  assert.ok(of(server, 'session_start')[0]?.server, 'session_start.server');
  const sw = of(server, 'server_window');
  assert.ok(sw.length >= 2 && sw.every((w) => w.tick.a === 0.02 && w.ticks > 0), JSON.stringify(sw[0]));
  const [err] = of(server, 'error');
  assert.equal(err?.kind, 'server_script');
  assert.equal(err.message, "<player>'s trophy is missing");
  assert.equal(of(server, 'level_abandon').length, 0, "a server's map is never abandoned");
  assert.equal(of(server, 'session_end')[0]?.reason, 'close');
});

test("nothing names the player, and every sketch bucket is written as JavaScript writes it", () => {
  assert.ok(run.player, 'read the play test\'s player over MCP');
  const text = JSON.stringify(run.events);
  assert.ok(!text.includes(run.player.name), `${run.player.name} is not sent`);
  assert.ok(!text.includes(run.player.userId), 'the user ID is not sent');
  for (const e of run.events) for (const sk of [e.ft, e.net?.rtt, e.tick]) if (sk) assert.ok(!('-0' in sk.b), JSON.stringify(sk.b));
});

test('the extras the demo turns on: a ProximityPrompt and a seat counted, joined_with_friend, friends_in_server', () => {
  const [start] = of(SERVICE, 'session_start');
  assert.equal(start.props?.joined_with_friend, false, `props: ${JSON.stringify(start.props)}`);
  const counted = (name) => of(SERVICE, 'counts').flatMap((e) => e.counts).filter((c) => c.name === name);
  const prompt = counted('prompt');
  const demo = run.console.split('\n').filter((l) => l.includes('[demo]')).join('\n');
  assert.ok(prompt.some((c) => c.attrs.action === 'Open' && c.attrs.object === 'Garage'), `${JSON.stringify(prompt)}\n${demo}`);
  const sit = counted('sit');
  assert.ok(sit.some((c) => c.attrs.seat === 'Bench' && c.attrs.vehicle === false), JSON.stringify(sit));
  const fw = of(SERVICE, 'frame_window');
  assert.ok(fw.every((w) => w.ctx.friends_in_server === 0), JSON.stringify(fw.map((w) => w.ctx)));
});

test('calls made before Glitchless started arrive: the server\'s before init, the LocalScript\'s first', () => {
  assert.ok(of(`${SERVICE}.server`, 'custom').some((e) => e.name === 'before_init'), 'the server Script\'s call before init');
  assert.ok(of(SERVICE, 'custom').some((e) => e.name === 'client_ready'), 'the LocalScript\'s first call');
});

test("the server drew the track's map and sent it under the race's level: a JPEG macOS can open", () => {
  const map = run.maps.find((m) => m.service === SERVICE && m.level === 'desert_loop');
  assert.ok(map, `maps: ${run.maps.map((m) => `${m.service}/${m.level}`)}`);
  assert.equal(map.axis, 'xz');
  assert.deepEqual(map.bounds, { min: [-60, -42], max: [60, 42] }, 'the track folder\'s parts');
  assert.ok(map.image.startsWith('data:image/jpeg;base64,') && map.image.length <= 60_000, `${map.image.length} characters`);
  const jpg = path.join(tmp, 'map.jpg');
  fs.writeFileSync(jpg, Buffer.from(map.image.slice(map.image.indexOf(',') + 1), 'base64'));
  const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', jpg], { encoding: 'utf8' });
  assert.match(info, new RegExp(`pixelWidth: ${map.size[0]}`), info);
  assert.match(info, new RegExp(`pixelHeight: ${map.size[1]}`), info);
  if (process.env.GLITCHLESS_MAP_OUT) fs.copyFileSync(jpg, process.env.GLITCHLESS_MAP_OUT);
});
