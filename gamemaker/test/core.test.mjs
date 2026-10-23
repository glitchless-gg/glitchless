// The GameMaker SDK's GML, run in Node (gml.mjs, runtime.mjs): no GameMaker needed.
//   node --test gamemaker/test/core.test.mjs        (npm run test:gamemaker:core)
//
// 1. Every GameMaker function, variable and constant the GML uses is a real one (gml-builtins.txt).
// 2. The sketch puts every frame time in the same bucket as packages/sdk/src/sketch.js, and fingerprints, normalized
//    messages, path scrubbing and URL encoding match the JavaScript SDK and the Godot SDK's patterns.
// 3. gzip made from buffer_compress unpacks as gzip.
// 4. Whole sessions against a real Glitchless server (server/src/local.js on a port of its own): offline and the
//    outbox, full and install mode, a crash sent on the next launch, hitches and their causes, rooms as levels, bug
//    reports, measure. They check what the server reads back, through the same /v1/query API the dashboard uses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';
import { builtins, tokenize } from './gml.mjs';
import { launch, ROOT, PNG_1PX } from './runtime.mjs';

const REPO = path.resolve(ROOT, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/js-fixture.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-gamemaker-'));
let saveCount = 0;
const newSave = () => path.join(tmp, `save-${++saveCount}`);
const tool = launch({ saveDir: newSave() }); // a game for the pure functions
const gml = (fn, ...a) => tool.call(fn, ...a);

// ───────────────────────────── 1. real GameMaker names ─────────────────────────────

function gmlFiles() {
  const out = [];
  for (const dir of ['scripts', 'objects']) {
    const base = path.join(ROOT, dir);
    for (const asset of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      for (const f of fs.readdirSync(path.join(base, asset))) if (f.endsWith('.gml')) out.push(path.join(base, asset, f));
    }
  }
  return out;
}

test('every GameMaker function, variable and constant the GML uses is a real one', () => {
  const known = new Set(fs.readFileSync(path.join(ROOT, 'test/gml-builtins.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')));
  // The project's own assets are names too.
  for (const dir of ['objects', 'rooms', 'scripts']) for (const a of fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []) known.add(a);
  // The objects' events and the demo set instance variables (`level = 0;`) that their other events and the demo's
  // functions read as bare names: those are the game's own, not GameMaker's.
  const own = new Set();
  const files = gmlFiles();
  for (const f of files) {
    const toks = tokenize(fs.readFileSync(f, 'utf8'), f, { lenient: true }).filter((t) => t.t !== 'ws' && t.t !== 'comment');
    toks.forEach((t, i) => {
      if (t.t === 'macro') own.add(t.name);
      if (t.v === 'function' && toks[i + 1]?.t === 'id') own.add(toks[i + 1].v);
      const prev = toks[i - 1];
      if (f.includes('/objects/') && t.t === 'id' && toks[i + 1]?.v === '=' && (!prev || prev.v === ';' || prev.v === '}' || prev.v === '{')) own.add(t.v);
    });
  }
  const unknown = [];
  for (const f of files) {
    for (const name of builtins(fs.readFileSync(f, 'utf8'), f, own)) {
      if (!known.has(name) && !name.startsWith('__')) unknown.push(`${path.relative(ROOT, f)}: ${name}`);
    }
  }
  assert.deepEqual(unknown, [], 'check these in the manual, then add them to gml-builtins.txt');
});

// Where GameMaker is installed, its runtime ships its own list of every GML name (fnames): the allowlist must agree.
function installedRuntimes() {
  const roots = [process.env.GM_RUNTIME && path.dirname(process.env.GM_RUNTIME), ...['GameMakerStudio2-LTS2026', 'GameMakerStudio2-Beta', 'GameMakerStudio2'].map((d) => `/Users/Shared/${d}/Cache/runtimes`)].filter(Boolean);
  return roots.flatMap((r) => (fs.existsSync(r) ? fs.readdirSync(r).filter((d) => d.startsWith('runtime-')).map((d) => path.join(r, d)) : [])).filter((r) => fs.existsSync(path.join(r, 'fnames')));
}
const runtimes = installedRuntimes();
test('every name in gml-builtins.txt is in the installed runtime\'s own list', { skip: runtimes.length ? false : 'no GameMaker runtime installed' }, () => {
  const known = fs.readFileSync(path.join(ROOT, 'test/gml-builtins.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const rt of runtimes) {
    const names = new Set(fs.readFileSync(path.join(rt, 'fnames'), 'utf8').split('\n').map((l) => /^([A-Za-z_][A-Za-z0-9_]*)/.exec(l)?.[1]).filter(Boolean));
    assert.deepEqual(known.filter((n) => !names.has(n)), [], path.basename(rt));
  }
});

// ───────────────────────────── 2. the same numbers as JavaScript ─────────────────────────────

test('the GML sketch buckets every frame time like the JavaScript sketch', () => {
  const sk = gml('__glitchless_sketch_new');
  for (const v of fixture.values) gml('__glitchless_sketch_add', sk, v);
  const mine = JSON.parse(gml('json_stringify', gml('__glitchless_sketch_json', sk)));
  assert.deepEqual(mine.b, fixture.sketch.b);
  for (const k of ['a', 'n', 'z', 'mn', 'mx']) assert.equal(mine[k], fixture.sketch[k], k);
  assert.ok(Math.abs(mine.s - fixture.sketch.s) < 0.2, `sum ${mine.s} vs ${fixture.sketch.s}`);
  for (const [v, i] of fixture.indexes) assert.equal(gml('__glitchless_sketch_index', sk, v), i, `index of ${v}`);
  for (const [q, v] of Object.entries(fixture.quantiles)) assert.equal(gml('__glitchless_sketch_quantile', sk, Number(q)), v, `q${q}`);
  assert.equal(gml('__glitchless_sketch_fraction_above', sk, 19.17), fixture.fraction_above_19_17);
  // and the server reads the GML sketch back as its own
  const back = Sketch.from(mine);
  assert.equal(back.n, fixture.values.length);
  assert.equal(back.quantile(0.95), fixture.quantiles['0.95']);
});

test('rounding goes half up, like Math.round, not to the even neighbour', () => {
  assert.equal(gml('__glitchless_round', 2.5, 1), 3);
  assert.equal(gml('__glitchless_round', 0.125, 0.01), Math.round(0.125 * 100) / 100);
  assert.equal(gml('__glitchless_round', -2.5, 1), Math.round(-2.5));
  assert.equal(gml('__glitchless_round', undefined, 0.1), undefined);
});

test('error fingerprints and normalized messages match the browser SDK', () => {
  for (const e of fixture.fingerprints) {
    assert.equal(gml('__glitchless_normalize_message', e.message).slice(0, 200), e.normalized.slice(0, 200), e.message);
    assert.equal(gml('__glitchless_fingerprint', e.kind, e.message, e.fn), e.fingerprint, e.message);
  }
  // and on messages made of the characters the patterns care about
  const parts = ['0', '1', '12', '123', '4567', 'x', 'X', '0x', '0X', 'ab', 'F', 'g', ' ', '\t', 'Uncaught', 'Uncaught ', '🐶', 'é', '日本', '.', '-'];
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let i = 0; i < 400; i++) {
    let m = '';
    const len = 1 + rand(30);
    for (let j = 0; j < len; j++) m += parts[rand(parts.length)];
    if (i % 50 === 0) m = 'z'.repeat(190 + rand(15)) + m;
    assert.equal(gml('__glitchless_fingerprint', 'crash', m, 'obj_demo.Step_0'), fingerprint('crash', m, 'obj_demo.Step_0'), JSON.stringify(m));
    if (i % 50 !== 0) assert.equal(gml('__glitchless_normalize_message', m), normalizeMessage(m), JSON.stringify(m));
  }
});

test('paths on the player\'s computer are cut down as the Godot SDK cuts them', () => {
  const godot = (s) =>
    s
      .replace(/(\/Users|\/home)\/[^/\s'"]+/g, '$1/~')
      .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s'"]+/g, '$1~');
  const cases = [
    'file not found: /Users/ada/Library/Application Support/caverun/save.json',
    'at /home/bob/games/x and /home/carol',
    'C:\\Users\\Dana Smith\\AppData\\Local\\caverun\\save.ini',
    'D:/Users/eve/x "quoted /Users/fay"',
    'nothing to cut',
    '/Users/',
    'e:\\users\\lower stays',
  ];
  for (const c of cases) assert.equal(gml('__glitchless_scrub', c, ''), godot(c), c);
  assert.equal(gml('__glitchless_scrub', '/Users/ada/Library/Application Support/caverun/glitchless/outbox.json', '/Users/ada/Library/Application Support/caverun/'), 'save:/glitchless/outbox.json');
});

test('callstack lines become frames with an object, an event, a function and a line', () => {
  const f = (s) => JSON.parse(gml('json_stringify', gml('__glitchless_parse_frame', s)));
  assert.deepEqual(f('gml_Object_obj_player_Step_0 (line 12)'), { fn: 'obj_player.Step_0', source: 'obj_player', line: 12, raw: 'gml_Object_obj_player_Step_0' });
  assert.deepEqual(f('gml_Object_obj_big_boss_Collision_obj_wall_Step (line 3)'), { fn: 'obj_big_boss.Collision_obj_wall_Step', source: 'obj_big_boss', line: 3, raw: 'gml_Object_obj_big_boss_Collision_obj_wall_Step' });
  assert.deepEqual(f('gml_Script_spawn_wave (line 23)'), { fn: 'spawn_wave', source: 'spawn_wave', line: 23, raw: 'gml_Script_spawn_wave' });
  assert.deepEqual(f('gml_Script_spawn_wave:23'), { fn: 'spawn_wave', source: 'spawn_wave', line: 23, raw: 'gml_Script_spawn_wave' });
  assert.equal(f('gml_Script_anon@512@gml_Object_obj_demo_Create_0 (line 4)').fn, 'anon in obj_demo.Create_0');
  assert.deepEqual(f('gml_RoomCC_rm_level_1_0_Create (line 1)'), { fn: 'rm_level_1_0_Create', source: 'rm_level_1_0_Create', line: 1, raw: 'gml_RoomCC_rm_level_1_0_Create' });
});

test('rooms named like menus, boot and loading rooms are not levels', () => {
  for (const name of ['rm_level_1', 'Room1', 'rm_cave', 'rmForest2', 'room_boss', 'rm_game']) assert.equal(gml('__glitchless_level_for_room', name), name, name);
  for (const name of ['rm_main_menu', 'rmMainMenu', 'rm_title', 'rm_boot', 'rm_init', 'rmLoading', 'room_game_over', 'rmGameOver', 'rm_settings', 'HUDMenu', 'rm_splash', '']) assert.equal(gml('__glitchless_level_for_room', name), '', name);
  assert.deepEqual([...gml('__glitchless_words', 'rmHUDMenu_2nd-try')], ['rm', 'hud', 'menu', '2nd', 'try']);
});

test('a Steam Deck says so, as the Unreal plugin decides it: SteamDeck=1, a Valve board, or SteamOS', () => {
  const device = (opts, full = false) => {
    const game = launch({ saveDir: newSave(), ...opts });
    return JSON.parse(game.call('json_stringify', game.call('__glitchless_device', full)));
  };
  const proton = device({ osType: 0, env: { SteamDeck: '1' } }, true);
  assert.equal(proton.steam_deck, true);
  assert.equal(proton.os, 'SteamOS', 'a Windows build under Proton on a Deck');
  assert.equal(proton.gpu_tier, 'low');
  assert.equal(proton.model, 'Steam Deck');
  const oled = device({ osType: 6, files: { '/sys/class/dmi/id/board_vendor': 'Valve\n', '/sys/class/dmi/id/board_name': 'Galileo\n', '/etc/os-release': 'NAME="SteamOS"\nID=steamos\nID_LIKE=arch\n' } }, true);
  assert.deepEqual([oled.steam_deck, oled.os, oled.model], [true, 'SteamOS', 'Steam Deck OLED']);
  const board = device({ osType: 6, files: { '/sys/class/dmi/id/board_vendor': 'Valve', '/sys/class/dmi/id/board_name': 'Jupiter', '/etc/os-release': 'ID="arch"' } }, true);
  assert.deepEqual([board.steam_deck, board.os, board.model], [true, 'Linux', 'Steam Deck LCD'], 'another Linux on a Deck is still a Deck');
  const mac = device({});
  assert.equal(mac.steam_deck, false);
  assert.equal(mac.os, 'macOS');
  assert.ok(!('model' in mac), 'anonymous mode sends no model');
});

test('the client token is URL-encoded as encodeURIComponent does', () => {
  for (const s of ['gl_pub_dev', 'a b&c=d/é', '🐶!*()~\'', 'gl_pub_x+y%z']) assert.equal(gml('__glitchless_url_encode', s), encodeURIComponent(s), s);
});

test('random IDs have the prefix and length, and differ', () => {
  const a = gml('__glitchless_new_id', 's_', 16);
  const b = gml('__glitchless_new_id', 's_', 16);
  assert.match(a, /^s_[a-z0-9]{16}$/);
  assert.notEqual(a, b);
  const r = gml('__glitchless_unit_random');
  assert.ok(r >= 0 && r < 1, String(r));
});

// ───────────────────────────── 3. gzip ─────────────────────────────

for (const inverted of [false, true]) {
  test(`gzip from buffer_compress unpacks as gzip${inverted ? ' (a runner whose buffer_crc32 inverts)' : ''}`, () => {
    const game = launch({ saveDir: newSave(), crcInverted: inverted });
    assert.equal(game.call('__glitchless_gzip_works'), true);
    const text = JSON.stringify({ events: Array.from({ length: 50 }, (_, i) => ({ type: 'custom', name: `e${i}`, note: 'émoji 🐶' })) });
    const id = game.call('__glitchless_gzip', text);
    const bytes = game.state.buffers.get(id).bytes;
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
    assert.equal(zlib.gunzipSync(bytes).toString('utf8'), text);
    assert.ok(bytes.length < Buffer.byteLength(text) / 3, `${bytes.length} bytes`);
  });
}

// ───────────────────────────── 4. sessions against a real server ─────────────────────────────

const SERVICE = 'glitchless-gamemaker-test';
let port;
let deadPort;
let server;
const dataDir = path.join(tmp, 'data');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  port = await freePort();
  deadPort = await freePort();
  server = spawn(process.execPath, [path.join(REPO, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Glitchless server did not start');
});

after(() => {
  server?.kill(); // this test's own server, by its handle
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function query(name, params = {}) {
  // The pretend games run faster than real time, so their last events are a little in the future.
  const qs = new URLSearchParams({ service: SERVICE, from: '0', to: String(Date.now() + 3_600_000), ...params });
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${qs}`);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  return res.json();
}

function rawEvents() {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('events-'))
    .flatMap((f) => fs.readFileSync(path.join(dataDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

const ROOMS = ['rm_boot', 'rm_level_1', 'rm_level_2', 'rm_level_3', 'rm_main_menu'];

// A short run of a game like the demo: a boot room, three levels by room, a menu at the end. Level 2's power-up
// spawns 2500 instances in one frame, which also takes 120 ms of step code; a GC and a texture page load come in
// level 1. Returns the game, quit and settled unless `crashAt` stops it first.
async function play({ saveDir = newSave(), intake = `http://127.0.0.1:${port}`, args = ['-glitchless', '-autoplay'], options = {}, crashAt = null, extra = null } = {}) {
  const game = launch({ saveDir, args, rooms: ROOMS });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', intake, game.struct({ bug_reports: true, ...options }));
  await game.frames(20);
  for (const level of [1, 2, 3]) {
    game.roomGoto(level);
    for (let f = 0; f < 200; f++) {
      const t = f;
      const opts = {
        dt: 16.667,
        during: (g) => {
          if (t === 10) g.call('glitchless_track', 'pickup', 'coin');
          if (t === 30) g.call('glitchless_death', 120 + level, 340, level === 2 ? 'spikes' : 'fell');
          if (t === 50 && level === 1) g.call('glitchless_error', 'bonus table missing row 4821 in /Users/ada/Library/bonus.cfg', g.struct({ table: 'bonus' }));
          if (t === 60 && level === 2) g.call('glitchless_track', 'powerup', 'sparks');
          if (t === 80 && crashAt === level) {
            g.crash({ message: 'Unable to find instance for object index 7', longMessage: 'ERROR in action number 1', script: 'gml_Object_obj_demo_Step_0', line: 88, stacktrace: ['gml_Script_bonus_pay (line 14)', 'gml_Object_obj_demo_Step_0 (line 88)'] });
          }
          g.call('glitchless_set_context', g.struct({ sparks: level === 2 && t > 61 ? 2500 : 30 }));
          extra?.(g, level, t);
        },
      };
      // Level 2's power-up: 2500 instances made in one frame, which also takes 120 ms of step code.
      if (f === 61 && level === 2) Object.assign(opts, { dt: 130, step: 120, during: chain(opts.during, (g) => (g.state.instances += 2500)) });
      // Level 1: a 45 ms garbage collection, then a texture page loaded the first time something on it is drawn.
      if (f === 120 && level === 1) Object.assign(opts, { dt: 75, during: chain(opts.during, (g) => g.gc({ traversal: 40_000, collection: 5_000, collected: 9000 })) });
      if (f === 149 && level === 1) opts.during = chain(opts.during, (g) => (g.state.textureStatus.Default = 0));
      if (f === 150 && level === 1) Object.assign(opts, { dt: 90, during: chain(opts.during, (g) => (g.state.textureStatus.Default = 3)) });
      if (!(await game.frame(opts))) return game;
    }
    if (level < 3) game.call('glitchless_level_complete', undefined, 100 * level);
  }
  game.roomGoto(4);
  await game.frames(10);
  game.call('glitchless_quit');
  for (let i = 0; i < 200 && !game.state.ended; i++) {
    await game.frame();
    await new Promise((r) => setTimeout(r, 5));
  }
  await game.settle();
  return game;
}

const chain = (a, b) => (g) => {
  a?.(g);
  b(g);
};
const outbox = (dir) => path.join(dir, 'glitchless/outbox.json');
const sessionsNow = async () => (await query('sessions')).sessions;

test('offline, the outbox keeps the session without any ID; online, it goes under a new ID with the next run', async () => {
  const save = newSave();
  const offline = await play({ saveDir: save, intake: `http://127.0.0.1:${deadPort}` });
  assert.equal(offline.state.ended, true, 'glitchless_quit ends the game after its 1.5 s even with no network');
  const saved = fs.readFileSync(outbox(save), 'utf8');
  assert.ok(saved.includes('"session_start"') && saved.includes('"session_end"'), 'no whole session in the outbox');
  assert.ok(!/"(sid|pid|session_id|player_id)"/.test(saved), 'anonymous mode wrote an ID to disk');
  assert.ok(!fs.existsSync(path.join(save, 'glitchless/player_id')));
  const before = new Set((await sessionsNow()).map((s) => s.session_id));
  const online = await play({ saveDir: save });
  assert.ok(!fs.existsSync(outbox(save)), 'the outbox is empty once everything is sent');
  assert.equal(online.g.gzip, true, 'batches went gzipped');
  const fresh = (await sessionsNow()).filter((s) => !before.has(s.session_id));
  assert.equal(fresh.length, 2, JSON.stringify(fresh.map((s) => s.session_id)) + ' ' + JSON.stringify(online.g.stats) + ' ' + JSON.stringify(rawEvents().filter((e) => e.type === 'session_start').map((e) => e.session_id)));
  for (const s of fresh) {
    assert.equal(s.ended, true, `${s.session_id} not ended`);
    assert.deepEqual(s.levels, ['level_1', 'level_2', 'level_3'].map((l) => `rm_${l}`));
    assert.match(s.browser, /^GameMaker 2026\./);
    assert.equal(s.session_type, 'synthetic');
    assert.equal(s.player_id, s.session_id, 'anonymous sessions carry no player ID');
  }
});

test('full mode saves a random player ID and sends the GPU and death positions; install mode keeps the ID only', async () => {
  const save = newSave();
  await play({ saveDir: save, args: ['-glitchless', '-autoplay', '-glitchless-privacy=full'] });
  const pid = fs.readFileSync(path.join(save, 'glitchless/player_id'), 'utf8');
  assert.match(pid, /^p_[a-z0-9]{12}$/);
  const full = (await sessionsNow()).find((s) => s.player_id === pid);
  assert.ok(full, 'no session under the saved player ID');
  const detail = (await query('session', { id: full.session_id })).session;
  for (const k of ['os', 'gpu_tier', 'renderer', 'screen', 'refresh_hz']) assert.ok(k in detail.device, `full lacks ${k}`);
  assert.equal(detail.device.gpu, 'Apple M2 Pro');
  assert.equal(detail.device.gpu_tier, 'high');
  const deaths = rawEvents().filter((e) => e.type === 'death' && e.session_id === full.session_id);
  assert.ok(deaths.length === 3 && deaths.every((d) => typeof d.x === 'number'), JSON.stringify(deaths));

  const save2 = newSave();
  await play({ saveDir: save2, args: ['-glitchless', '-autoplay', '-glitchless-privacy=install'] });
  const pid2 = fs.readFileSync(path.join(save2, 'glitchless/player_id'), 'utf8');
  const install = (await sessionsNow()).find((s) => s.player_id === pid2);
  assert.ok(install, 'install mode sends its player ID');
  const start = rawEvents().find((e) => e.type === 'session_start' && e.session_id === install.session_id);
  assert.equal(start.privacy, 'install');
  assert.ok(!('gpu' in start.device), 'install mode sends the anonymous device');
  assert.ok(rawEvents().filter((e) => e.type === 'death' && e.session_id === install.session_id).every((d) => !('x' in d)), 'install mode sends no positions');
  // and anonymous mode deletes an ID another build left
  await play({ saveDir: save2 });
  assert.ok(!fs.existsSync(path.join(save2, 'glitchless/player_id')));
});

test('frame windows: the server reads the GML sketch back, a window never spans two levels, engine counts ride along', async () => {
  const game = await play();
  const sid = game.g.session_id;
  const windows = rawEvents().filter((e) => e.type === 'frame_window' && e.session_id === sid);
  assert.ok(windows.length >= 6, `${windows.length} windows`);
  for (const w of windows) {
    const s = Sketch.from(w.ft);
    assert.equal(s.n, w.frames);
    assert.equal(Math.round(s.quantile(0.5) * 100) / 100, w.ft_p50);
    assert.equal(w.sdk, 'glitchless-gamemaker/0.1.0');
    assert.equal(w.hz, 60);
    assert.equal(typeof w.process_ms, 'number');
    assert.equal(typeof w.render_ms, 'number');
    assert.equal(w.heap_mb, 64);
  }
  const levels = new Set(windows.map((w) => w.level));
  assert.deepEqual([...levels].sort(), [null, 'rm_level_1', 'rm_level_2', 'rm_level_3'], 'the boot and menu rooms\' frames have no level');
  const peak = (level) => Math.max(...windows.filter((w) => w.level === level).map((w) => w.ctx?.instances ?? 0));
  assert.ok(peak('rm_level_3') >= 2500, `rm_level_3 carries level 2's instances: ${peak('rm_level_3')}`);
  assert.ok(peak('rm_level_1') < 10, `rm_level_1 instances ${peak('rm_level_1')}`);
});

test('hitches name what GameMaker can see: instances spawned, step code, a collection, a texture page, a room change', async () => {
  const game = await play();
  const sid = game.g.session_id;
  const hitches = rawEvents().filter((e) => e.type === 'hitch' && e.session_id === sid);
  const spawn = hitches.find((h) => h.level === 'rm_level_2' && h.duration_ms >= 120);
  assert.ok(spawn, JSON.stringify(hitches.map((h) => [h.level, h.duration_ms, h.causes])));
  assert.deepEqual(spawn.causes, ['object_spawn', 'script']);
  assert.equal(spawn.instances_added, 2500);
  assert.equal(spawn.process_ms, 120);
  assert.ok(spawn.recent.includes('powerup'), JSON.stringify(spawn.recent));
  assert.equal(spawn.ctx.sparks, 30, 'ctx holds the gauges the slow frame ended with');
  const gc = hitches.find((h) => h.level === 'rm_level_1' && h.duration_ms === 75);
  assert.deepEqual(gc?.causes, ['gc']);
  assert.equal(gc.gc_ms, 45);
  const tex = hitches.find((h) => h.level === 'rm_level_1' && h.duration_ms === 90);
  assert.deepEqual(tex?.causes, ['texture_upload']);
  const win = rawEvents().find((e) => e.type === 'frame_window' && e.session_id === sid && e.level === 'rm_level_1' && e.gc_collections > 0);
  assert.ok(win && win.gc_ms === 45, 'the window counts the collection');
});

test('rooms as levels: a level room starts its level, a menu room leaves it; the game\'s own level_start turns it off', async () => {
  const game = await play();
  const sid = game.g.session_id;
  const starts = rawEvents().filter((e) => e.type === 'level_start' && e.session_id === sid).map((e) => e.level);
  assert.deepEqual(starts, ['rm_level_1', 'rm_level_2', 'rm_level_3']);
  const menu = rawEvents().filter((e) => e.session_id === sid && e.type === 'frame_window' && e.level === null);
  assert.ok(menu.length >= 1, 'the menu room\'s frames have no level');

  const own = await play({
    extra: (g, level, t) => {
      if (t === 0) g.call('glitchless_level_start', `stage_${level}`);
    },
  });
  const ownStarts = rawEvents().filter((e) => e.type === 'level_start' && e.session_id === own.g.session_id).map((e) => e.level);
  assert.deepEqual(ownStarts, ['rm_level_1', 'stage_1', 'stage_2', 'stage_3']);
});

test('errors: a caught error groups like the browser SDK, with its path cut down and its breadcrumbs', async () => {
  await play();
  const { issues } = await query('errors');
  const manual = issues.find((i) => i.kind === 'manual');
  assert.ok(manual, JSON.stringify(issues.map((i) => i.kind)));
  assert.equal(manual.message, 'bonus table missing row 4821 in /Users/~/Library/bonus.cfg');
  assert.equal(manual.fingerprint, fingerprint('manual', manual.message, 'obj_demo.Step_0'));
  assert.equal(manual.fn, 'obj_demo.Step_0', 'Glitchless\'s own frame is left out');
  assert.equal(manual.fatal, false);
  const e = rawEvents().find((x) => x.type === 'error' && x.kind === 'manual');
  assert.deepEqual(e.attrs, { table: 'bonus' });
  assert.ok(e.recent.includes('pickup'), JSON.stringify(e.recent));
  assert.ok(!JSON.stringify(e).includes('/Users/ada'), 'a user name was sent');
});

test('a crash is written to the outbox as the game stops and sent on the next launch', async () => {
  const save = newSave();
  const crashed = await play({ saveDir: save, crashAt: 2 });
  assert.equal(crashed.state.ended, true);
  const saved = fs.readFileSync(outbox(save), 'utf8');
  assert.ok(saved.includes('"kind":"crash"') && saved.includes('"reason":"crash"'), 'no crash in the outbox');
  const before = new Set((await sessionsNow()).map((s) => s.session_id));
  await play({ saveDir: save });
  assert.ok(!fs.existsSync(outbox(save)));
  const fresh = (await sessionsNow()).filter((s) => !before.has(s.session_id));
  const dead = fresh.find((s) => s.crashed);
  assert.ok(dead, JSON.stringify(fresh));
  const { issues } = await query('errors');
  const crash = issues.find((i) => i.kind === 'crash');
  assert.equal(crash.message, 'Unable to find instance for object index 7');
  assert.equal(crash.fn, 'bonus_pay');
  assert.equal(crash.fatal, true);
  assert.match(crash.stack, /^crash: Unable to find instance for object index 7\n {4}at bonus_pay \(gml_Script_bonus_pay:14\)\n {4}at obj_demo\.Step_0 \(gml_Object_obj_demo_Step_0:88\)/);
  assert.equal(crash.fingerprint, fingerprint('crash', crash.message, 'bonus_pay'));
  const end = rawEvents().find((e) => e.type === 'session_end' && e.reason === 'crash');
  assert.ok(end, 'no session_end with reason crash');
});

test('bug reports: from code straight away, through the form, and an offline one on the next launch', async () => {
  const save = newSave();
  const results = [];
  const report = (g, level, t) => {
    if (level === 1 && t === 100) g.call('glitchless_report_bug', 'the bonus on rm_level_1 never paid out', true, (r) => results.push(JSON.parse(g.call('json_stringify', r))));
    if (level === 2 && t === 20) g.state.pressed.add(119); // F8
    if (level === 2 && t === 22) g.state.pressed.add(27); // Esc: changed their mind
    if (level === 2 && t === 24) g.state.pressed.add(119);
    if (level === 2 && t === 26) g.state.keyboardString = 'sparks froze the screen';
    if (level === 2 && t === 28) g.state.pressed.add(13); // Enter
  };
  await play({ saveDir: save, intake: `http://127.0.0.1:${deadPort}`, extra: (g, level, t) => level === 1 && t === 100 && report(g, level, t) });
  assert.deepEqual(results, [{ sent: false, reason: 'error' }]);
  assert.ok(fs.readFileSync(outbox(save), 'utf8').includes('"bug_report"'), 'the report waits in the outbox');
  results.length = 0;
  const opened = [];
  const game = await play({
    saveDir: save,
    options: { bug_reports: tool.struct({ hotkey: 119, on_open: () => opened.push('open'), on_close: () => opened.push('close') }) },
    extra: report,
  });
  assert.deepEqual(results, [{ sent: true }]);
  assert.deepEqual(opened, ['open', 'close', 'open', 'close'], 'Esc closed the first form, Enter sent the second');
  const { reports } = await query('reports');
  const mine = reports.filter((r) => r.session_id === game.g.session_id).map((r) => r.note).sort();
  assert.deepEqual(mine, ['sparks froze the screen', 'the bonus on rm_level_1 never paid out']);
  assert.ok(reports.some((r) => r.note === 'the bonus on rm_level_1 never paid out' && r.session_id !== game.g.session_id), 'the offline run\'s report arrived');
  const one = (await query('report', { id: reports.find((r) => r.session_id === game.g.session_id && r.note.startsWith('sparks')).id })).report;
  assert.equal(one.screenshot, 'data:image/png;base64,' + PNG_1PX);
  assert.equal(one.sdk, 'glitchless-gamemaker/0.1.0');
  assert.equal(one.level, 'rm_level_2');
  assert.match(one.device, /^GameMaker 2026\./);
  assert.ok(one.recent.some((e) => e.type === 'level_start' && e.level === 'rm_level_2'), JSON.stringify(one.recent));
  assert.ok(one.frames.length > 0 && one.frames.every((f) => typeof f.fps === 'number' && typeof f.p95 === 'number'));
});

test('-glitchless-measure prints frame stats as one line of JSON, writes them to the save area and quits', async () => {
  const save = newSave();
  const out = path.join(tmp, 'measure-out.json');
  const game = launch({ saveDir: save, args: ['-autoplay', '-glitchless-measure=1', `-glitchless-out=${out}`], buildType: 'run' });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, game.struct({}));
  game.roomGoto(0);
  let frames = 0;
  while ((await game.frame({ dt: frames === 30 ? 80 : 16.667, during: (g) => frames === 30 && (g.state.instances += 100) })) && frames < 600) frames++;
  assert.equal(game.state.ended, true, 'the game quit');
  const line = game.debugMessages.find((m) => m.startsWith('{"glitchless_measure"'));
  assert.ok(line, game.debugMessages.join('\n'));
  const m = JSON.parse(line).glitchless_measure;
  assert.ok(m.frames > 30, `frames ${m.frames}`);
  for (const k of ['p50', 'p95', 'p99', 'worst']) assert.equal(typeof m.frame_ms[k], 'number', k);
  for (const k of ['fps', 'frame_budget_ms', 'pct_frames_over_budget', 'hitch_count', 'memory_delta', 'new_errors', 'process_ms', 'render_cpu_ms', 'session_id', 'sdk']) assert.ok(k in m, k);
  assert.equal(m.hitch_count, 1);
  assert.deepEqual(m.hitches[0].causes, ['object_spawn']);
  assert.equal(m.memory_delta.instances, 100);
  assert.equal(fs.readFileSync(path.join(save, 'glitchless/measure.json'), 'utf8').trim(), line);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), line);
  // A build run from the IDE without -glitchless sends nothing.
  assert.equal(game.g.enabled, false);
});

test('flags also come from GLITCHLESS_ARGS and, in a build run from the IDE, glitchless/args.txt', () => {
  const save = newSave();
  fs.mkdirSync(path.join(save, 'glitchless'), { recursive: true });
  fs.writeFileSync(path.join(save, 'glitchless/args.txt'), '-glitchless\n--seed=4 -autoplay\n');
  const run = launch({ saveDir: save, buildType: 'run', env: { GLITCHLESS_ARGS: '-glitchless-privacy=full -level-seconds=2' } });
  assert.equal(run.call('glitchless_has_flag', 'autoplay'), true);
  assert.equal(run.call('glitchless_flag_value', 'seed', ''), '4');
  assert.equal(run.call('glitchless_flag_value', 'level-seconds', ''), '2');
  const exe = launch({ saveDir: save, buildType: 'exe' });
  assert.equal(exe.call('glitchless_has_flag', 'autoplay'), false, 'a shipped build ignores args.txt');
});

test('a run of long frames (a hidden window) is dropped; one frozen frame between normal ones is a hitch', async () => {
  const game = launch({ saveDir: newSave(), args: ['-glitchless'] });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${deadPort}`, game.struct({}));
  await game.frames(100);
  await game.frames(5, { dt: 900 });
  await game.frames(50);
  await game.frame({ dt: 800 });
  await game.frames(50);
  const pending = game.g.pending_hitches.map((h) => h.duration_ms);
  const counted = game.g.win.frozen + game.g.queue.filter((e) => e.type === 'frame_window').reduce((n, w) => n + w.frozen, 0);
  assert.equal(counted, 1, 'only the lone frozen frame counts');
  assert.ok(game.g.stats.hitches === 1, `hitches ${game.g.stats.hitches} ${pending}`);
});
