// A stand-in for Roblox Studio's MCP server (StudioMCP), speaking MCP over stdio: the tools glitchless-playtest's
// Roblox runner calls, and a small race that, while a play test runs, sends a player's session and the server's own
// to a Glitchless server, shaped by the Workspace attributes the runner set (mode: ok, slow, error, menu).
//   FAKE_STUDIO_INTAKE   the Glitchless server the game sends to
//   FAKE_STUDIO_LIST     the open Studios, as JSON (default: FakeRace.rbxl and Starlift)
//   FAKE_STUDIO_SERVICE  the service in the place's Glitchless.init, which the probe finds (empty: none found)
//   FAKE_STUDIO_HTTP=0   Allow HTTP Requests off;  FAKE_STUDIO_SEND=0  the game sends nothing
//   FAKE_STUDIO_MODE     the mode when the scenario sets none;  FAKE_STUDIO_PLAYING=1  Studio starts in a play test
//   FAKE_STUDIO_LOG      a file this appends every call to, as JSON lines
import fs from 'node:fs';
import { Sketch } from '../../../sdk/src/sketch.js';

const env = process.env;
const studios = JSON.parse(env.FAKE_STUDIO_LIST || '[{"id":"s1","name":"FakeRace.rbxl"},{"id":"s2","name":"Starlift (placeId: 136658534041053)"}]');
const service = env.FAKE_STUDIO_SERVICE ?? 'fake-race';
const attrs = { Theme: 'desert' }; // one of the place's own, which must survive
let mode = env.FAKE_STUDIO_PLAYING === '1' ? 'Play' : 'Edit';
let play = null;

const id = () => Math.random().toString(36).slice(2, 14);
const mark = (v) => `GLP<${JSON.stringify(v)}>GLP`;
const log = (entry) => env.FAKE_STUDIO_LOG && fs.appendFileSync(env.FAKE_STUDIO_LOG, `${JSON.stringify(entry)}\n`);

async function send(envelope) {
  if (env.FAKE_STUDIO_SEND === '0') return;
  await fetch(`${env.FAKE_STUDIO_INTAKE}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify(envelope) });
}

function window(ts, frameMs) {
  const sk = new Sketch();
  for (let k = 0; k < 300; k++) sk.add(frameMs + (k % 5) * 0.1);
  return { type: 'frame_window', ts, level: play.level, duration_s: 5, frames: 300, fps: Math.round(1000 / frameMs), budget_ms: 16.67, ft: sk.toJSON(), ft_p50: frameMs, ft_p95: frameMs + 0.4, ft_max: frameMs + 1, hitches: 0, render_ms: 2.1 };
}

async function startPlay() {
  const how = attrs.mode || env.FAKE_STUDIO_MODE || 'ok';
  const t = Date.now();
  const type = attrs.autoplay ? 'synthetic' : 'tester';
  play = { how, t, level: how === 'menu' ? null : 'desert_loop', player: `s_${id()}`, server: `s_${id()}` };
  const common = { service, env: 'dev', version: '0.2.0-studio', sdk: 'glitchless-roblox/0.3.0' };
  play.envelope = { ...common, session_id: play.player, player_id: null };
  play.serverEnvelope = { ...common, role: 'server', session_id: play.server, player_id: null };
  await send({ ...play.serverEnvelope, events: [{ type: 'session_start', ts: t, session_type: type, device: { browser: 'Roblox', os: 'Roblox' }, server: { build: 'studio', tick_hz: 60 } }] });
  await send({ ...play.envelope, events: [{ type: 'session_start', ts: t + 50, session_type: type, device: { browser: 'Roblox', os: 'Computer', gpu: 'Apple M3 Max' } }, ...(play.level ? [{ type: 'level_start', ts: t + 60, level: play.level }] : [])] });
}

async function stopPlay() {
  const t = Date.now();
  const frameMs = play.how === 'slow' ? 31 : 16.7;
  const events = [window(t - 200, frameMs), window(t - 100, frameMs)];
  if (play.how === 'error') events.push({ type: 'error', ts: t - 50, level: play.level, kind: 'script', message: "attempt to index nil with 'Speed'", fingerprint: 'f_speed', location: 'Players.<player>.PlayerScripts.Car:12' });
  if (play.level) events.push({ type: 'level_complete', ts: t - 20, level: play.level, duration_s: 1 });
  events.push({ type: 'session_end', ts: t, reason: 'quit' });
  await send({ ...play.envelope, events });
  await send({ ...play.serverEnvelope, events: [{ type: 'error', ts: t - 30, kind: 'server_script', message: "<player>'s trophy is missing", fingerprint: 'f_trophy', location: 'ServerScriptService.Race:131' }, { type: 'session_end', ts: t + 10, reason: 'close' }] });
  play = null;
}

// The long strings of the runner's attributes code: the attributes to set, then the ones to clear.
const longStrings = (code) => [...code.matchAll(/JSONDecode\(\[(=+)\[([\s\S]*?)\]\1\]\)/g)].map((m) => JSON.parse(m[2]));

async function call(name, args) {
  log({ name, studio_id: args.studio_id, first: args.code?.split('\n')[0], datamodel: args.datamodel_type, is_start: args.is_start });
  if (name === 'list_roblox_studios') return JSON.stringify({ studios });
  if (args.studio_id !== 's1' && name !== 'execute_luau') throw new Error('only the fake race place plays');
  if (name === 'get_studio_state') return `Studio State: running\nMode: ${mode}`;
  if (name === 'start_stop_play') {
    if (args.is_start) {
      mode = 'Play';
      await startPlay();
    } else if (play) {
      await stopPlay();
      mode = 'Edit';
    }
    return 'ok';
  }
  if (name === 'get_console_output') return env.FAKE_STUDIO_SEND === '0' ? '[glitchless] the intake answered HTTP 401: check clientToken\nother output' : 'race over';
  if (name === 'execute_luau') {
    const code = args.code;
    if (code.startsWith('-- glitchless-playtest: probe')) return mark({ module: true, http: env.FAKE_STUDIO_HTTP !== '0', ...(service ? { service } : {}) });
    if (code.startsWith('-- glitchless-playtest: attributes')) {
      const [set, clear] = longStrings(code);
      const before = {};
      for (const [k, v] of Object.entries(set)) {
        if (k in attrs) before[k] = attrs[k];
        attrs[k] = v;
      }
      for (const k of clear) {
        if (k in attrs) before[k] = attrs[k];
        delete attrs[k];
      }
      log({ attrs: { ...attrs } });
      return mark(before);
    }
    if (code.startsWith('-- glitchless-playtest: done_when')) {
      if (args.datamodel_type !== 'Server' || mode !== 'Play') throw new Error('no server datamodel');
      return mark(attrs.mode !== 'endless' && Date.now() - play.t > 300);
    }
    return 'nil';
  }
  throw new Error(`unknown tool ${name}`);
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id == null) continue;
    const reply = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\n`);
    if (msg.method === 'initialize') reply({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-studio', version: '0' } } });
    else if (msg.method === 'tools/call')
      call(msg.params.name, msg.params.arguments || {}).then(
        (text) => reply({ result: { content: [{ type: 'text', text }] } }),
        (err) => reply({ result: { content: [{ type: 'text', text: err.message }], isError: true } }),
      );
    else reply({ error: { code: -32601, message: 'no such method' } });
  }
});
