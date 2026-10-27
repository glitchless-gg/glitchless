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
// 5. What the Starlift audit found: a batch sent again stored once (batch_id), an abandon at quit, the load event at
//    the first frame with first_launch, and gpu_or_os.
// 6. Genre coverage (docs/design/genre-coverage.md A5 to A8): counters, properties, groups with level attributes and
//    zones, and network samples, checked against the design's wire format in the batches the GML sends.
// 7. The player's off switch (SPEC §4d): glitchless_set_enabled, glitchless_is_enabled and opt_in, checked against every
//    request the GML makes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
    assert.equal(w.sdk, 'glitchless-gamemaker/0.4.0');
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
  assert.equal(one.sdk, 'glitchless-gamemaker/0.4.0');
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

// ───────────────────────────── 5. what the Starlift audit found ─────────────────────────────
// A batch whose reply never came was sent again (after 20 s, or from the outbox on the next launch) and stored
// twice: every batch now names itself (batch_id) and the server stores it once. Leaving a level is an abandon, not a
// fail. The load event happened at the first frame, and says whether it was a version's first launch. A long frame
// nothing measured explains is gpu_or_os.

// Passes each request on to the server, so it is stored, but holds back the reply to the `hold`th intake request for
// good: what a phone that stalled, or a game that ended mid-request, sees. Each reply the server sent is in `replies`.
function holdingFetch(hold = 1) {
  let n = 0;
  const replies = [];
  const impl = async (url, init) => {
    const r = await fetch(url, init);
    const body = await r.text();
    if (url.includes('/v1/intake')) {
      replies.push(JSON.parse(body));
      if (++n === hold) return new Promise(() => {});
    }
    return new Response(body, { status: r.status });
  };
  return { impl, replies };
}

const storedTwice = (sid) => {
  const seen = new Set();
  const twice = [];
  for (const e of rawEvents().filter((x) => x.session_id === sid)) {
    const key = JSON.stringify({ ...e, received: 0 });
    if (seen.has(key)) twice.push(e.type);
    seen.add(key);
  }
  return twice;
};

test('a batch whose reply never came goes again under its batch_id, and the server stores it once', async () => {
  const held = holdingFetch(1);
  const game = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS, fetchImpl: held.impl });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, game.struct({}));
  game.roomGoto(1);
  await game.frames(180); // the first batch goes at 2 s; its reply never comes
  await new Promise((r) => setTimeout(r, 100));
  const first = game.g.outbox[0]?.batch_id;
  assert.match(first, /^b_[a-z0-9]{16}$/);
  await game.frames(1500); // 20 s without a reply: tried again, later, under the same ID
  await game.settle();
  assert.ok(held.replies.some((r) => r.duplicate === true), JSON.stringify(held.replies));
  assert.deepEqual(storedTwice(game.g.session_id), []);
  assert.ok(!game.g.outbox.some((b) => b.batch_id === first), 'the repeat was answered, so it left the outbox');
});

test('a batch the server took as the game ended goes again on the next launch, and is not stored twice', async () => {
  const save = newSave();
  const held = holdingFetch(2);
  const first = launch({ saveDir: save, args: ['-glitchless'], rooms: ROOMS, fetchImpl: held.impl });
  first.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, first.struct({}));
  await first.frames(130);
  first.call('glitchless_quit'); // the last batch is taken, but its reply never comes before the game ends
  for (let i = 0; i < 200 && !first.state.ended; i++) await first.frame();
  await new Promise((r) => setTimeout(r, 100));
  const saved = JSON.parse(fs.readFileSync(outbox(save), 'utf8')).batches;
  assert.equal(saved.length, 1);
  assert.match(saved[0].batch_id, /^b_[a-z0-9]{16}$/, 'saved with its ID, in anonymous mode too');
  assert.ok(!/"(sid|pid)"/.test(JSON.stringify(saved)), 'and still no session or player ID');

  const next = launch({ saveDir: save, args: ['-glitchless'], rooms: ROOMS });
  next.state.timer += 1_234_567; // a real launch's clock is never where the last one's was: new IDs
  next.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, next.struct({}));
  assert.equal(next.g.outbox[0].batch_id, saved[0].batch_id);
  await next.frames(200);
  await next.settle();
  assert.ok(!fs.existsSync(outbox(save)) || !fs.readFileSync(outbox(save), 'utf8').includes(saved[0].batch_id), 'answered, so gone');
  const ends = rawEvents().filter((e) => e.type === 'session_end' && e.reason === 'quit' && e.ts === saved[0].events.find((x) => x.type === 'session_end')?.ts);
  assert.equal(ends.length, 1, 'the ending batch is stored once, not again under the replay\'s new session ID');
});

test('quitting mid-level sends an abandon before the end, and drops a fail the game sends for that level after it', async () => {
  const game = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, game.struct({}));
  game.call('glitchless_level_start', 'cave_1');
  await game.frames(30);
  game.call('glitchless_level_abandon'); // the player went back to the menu
  game.call('glitchless_level_start', 'cave_2');
  await game.frames(30);
  game.call('glitchless_quit');
  game.call('glitchless_level_fail', 'cave_2', 'left'); // a game's own Clean Up event, after Glitchless ended the session
  for (let i = 0; i < 200 && !game.state.ended; i++) await game.frame();
  await game.settle();
  const sid = game.g.session_id;
  const events = rawEvents().filter((e) => e.session_id === sid && ['level_abandon', 'level_fail', 'session_end'].includes(e.type));
  assert.deepEqual(events.map((e) => [e.type, e.level, e.reason ?? e.cause ?? null]), [
    ['level_abandon', 'cave_1', null],
    ['level_abandon', 'cave_2', 'quit'],
    ['session_end', 'cave_2', 'quit'],
  ]);
  const session = (await sessionsNow()).find((s) => s.session_id === sid);
  assert.deepEqual(session.abandoned, ['cave_1', 'cave_2']);
  assert.equal(session.rage_quit, false);
  // A room level ended by its room (back in the menu) has nothing to abandon at quit.
  const roomy = await play();
  assert.deepEqual(rawEvents().filter((e) => e.session_id === roomy.g.session_id && e.type === 'level_abandon'), []);
});

test('the load event is stamped at the first frame, and says whether this was the version\'s first launch here', async () => {
  const save = newSave();
  const runs = [];
  for (const [i, version] of ['1.2.0', '1.2.0', '1.3.0'].entries()) {
    const game = launch({ saveDir: save, args: ['-glitchless'], rooms: ROOMS });
    game.state.timer += i * 1_234_567; // a real launch's clock is never where the last one's was: new IDs
    game.call('glitchless_init', SERVICE, version, 'dev', `http://127.0.0.1:${port}`, game.struct({}));
    await game.frames(200);
    await game.settle();
    const sid = game.g.session_id;
    const start = rawEvents().find((e) => e.session_id === sid && e.type === 'session_start');
    const load = rawEvents().filter((e) => e.session_id === sid && e.type === 'load' && e.ttff_ms != null).at(-1);
    assert.ok(load.ts - start.ts < 100, `load ${load.ts - start.ts} ms after the start: the first frame, not the first flush at 2 s`);
    runs.push(load.first_launch);
  }
  assert.deepEqual(runs, [true, false, true], 'the first launch of 1.2.0, a later one, the first of 1.3.0');
  assert.equal(fs.readFileSync(path.join(save, 'glitchless/launched'), 'utf8'), '1.3.0');
});

test('a long frame that step and draw time don\'t explain is gpu_or_os; one they explain is not', () => {
  const game = launch({ saveDir: newSave() });
  const g = game.call('__glitchless');
  const f = (extra) => game.struct({ dt: 66.7, step: 0.4, draw: 0.6, gc_ms: 0, gc_collected: 0, instances_added: 0, texture_loads: 0, room_changed: false, ...extra });
  assert.deepEqual([...game.call('__glitchless_causes', g, f({}))], ['gpu_or_os']);
  assert.deepEqual([...game.call('__glitchless_causes', g, f({ step: 40 }))], ['script']);
  assert.deepEqual([...game.call('__glitchless_causes', g, f({ step: undefined }))], [], 'nothing measured, nothing said');
  assert.deepEqual([...game.call('__glitchless_causes', g, f({ dt: 900 }))], ['gpu_or_os', 'frozen']);
});

test('a batch sent before the first frame (focus lost as the game opened) does not lose the load event', async () => {
  const game = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS });
  game.state.timer += 7_654_321;
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, game.struct({}));
  game.state.focus = false; // the first tick sees focus gone and sends what there is: the session's start
  await game.frame();
  game.state.focus = true;
  await game.frames(400); // to the next batch, 5 s on
  await game.settle();
  const sid = game.g.session_id;
  const types = rawEvents().filter((e) => e.session_id === sid).map((e) => e.type);
  assert.equal(types[0], 'session_start');
  const load = rawEvents().find((e) => e.session_id === sid && e.type === 'load' && e.ttff_ms != null);
  assert.ok(load, types.join(' '));
  assert.equal(load.first_launch, true);
});

// ───────────────────────────── 6. genre coverage (A5 to A8) ─────────────────────────────
// The server's side is built apart, so these read what the game sends: every batch, unpacked, on its way to the
// server (which stores the event types it knows and drops the rest, as an older server does).

const FEATURES = ['counts', 'props', 'groups', 'net'];

// Records each batch the game sends and passes it on to the server. GET /v1/health is answered with `health`: a
// server that takes counters by default, `{ ok: true }` for one that doesn't yet.
function recordingFetch({ health = { ok: true, features: FEATURES } } = {}) {
  const batches = [];
  const impl = async (url, init) => {
    if (url.endsWith('/v1/health')) return new Response(JSON.stringify(health), { status: 200 });
    if (url.includes('/v1/intake')) {
      const body = Buffer.isBuffer(init.body) && init.body[0] === 0x1f ? zlib.gunzipSync(init.body).toString('utf8') : String(init.body);
      batches.push(JSON.parse(body));
    }
    return fetch(url, init);
  };
  const events = (type) => batches.flatMap((b) => b.events.map((e) => ({ ...e, session_id: b.session_id }))).filter((e) => !type || e.type === type);
  return { impl, batches, events };
}

async function genreGame({ args = ['-glitchless'], options = {}, health, intake = `http://127.0.0.1:${port}` } = {}) {
  const rec = recordingFetch({ health });
  const game = launch({ saveDir: newSave(), args, rooms: ROOMS, fetchImpl: rec.impl });
  game.state.timer += Math.floor(Math.random() * 1e9); // its own session ID
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', intake, game.struct(options));
  await game.settle(); // the health check
  return { game, rec };
}

// Cuts the window now and waits for the batch to reach the server.
async function flushNow(game) {
  game.call('glitchless_flush');
  await game.settle();
}

const plainJson = (game, v) => JSON.parse(game.call('json_stringify', v));

test('A5: a stream of events is added up on the device and goes once a window as one counts event', async () => {
  const { game, rec } = await genreGame();
  assert.equal(game.g.counts_ok, true, 'the server\'s features say it takes counters');
  game.call('glitchless_level_start', 'nmd_ghoa');
  await game.frames(60, (i) => ({
    during: (g) => {
      if (i < 37) g.call('glitchless_count', 'kill', g.struct({ monster: 'elite' }));
      if (i < 52) g.call('glitchless_count', 'gold', g.struct({ source: 'loot', amount: 35 }));
      if (i === 5) g.call('glitchless_count', 'kill', g.struct({ monster: 'imp' }), 5);
    },
  }));
  await flushNow(game);
  await game.frames(3, { during: (g) => g.call('glitchless_count', 'kill', g.struct({ monster: 'elite' })) });
  game.call('glitchless_level_start', 'nmd_two'); // closes the window: those 3 kills keep their level
  game.call('glitchless_count', 'tap');
  await game.frames(2);
  await flushNow(game);

  const counts = rec.events('counts');
  assert.equal(counts.length, 3, JSON.stringify(counts));
  const [first, second, third] = counts;
  assert.equal(first.level, 'nmd_ghoa');
  assert.equal(first.dropped, 0);
  assert.equal(typeof first.ts, 'number');
  assert.ok(first.duration_s > 0.9 && first.duration_s < 1.2, String(first.duration_s));
  assert.deepEqual(first.counts.map(({ first_ts, ...c }) => c), [
    { name: 'kill', attrs: { monster: 'elite' }, n: 37 },
    { name: 'gold', attrs: { source: 'loot' }, n: 52, sums: { amount: 1820 } },
    { name: 'kill', attrs: { monster: 'imp' }, n: 5 },
  ]);
  for (const c of first.counts) assert.ok(c.first_ts >= first.ts && c.first_ts < first.ts + 2000, 'first_ts is within the window');
  assert.ok(first.counts[2].first_ts > first.counts[0].first_ts, 'the imp entry began 5 frames in');
  assert.deepEqual([second.level, second.counts.map((c) => [c.name, c.n])], ['nmd_ghoa', [['kill', 3]]]);
  assert.deepEqual([third.level, third.counts], ['nmd_two', [{ name: 'tap', attrs: {}, n: 1, first_ts: third.counts[0].first_ts }]]);
  assert.ok(!rec.events('custom').some((e) => e.name === 'kill' || e.name === 'gold'), 'a counter queues no custom events');
  assert.ok(rec.batches.every((b) => b.events.length < 20), 'the queue stayed small');
});

test('A5: a counter groups by 4 words and sums 4 numbers; a full window sends new groups as (other) and drops new names', async () => {
  const game = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS });
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${deadPort}`, game.struct({}));
  await game.settle(); // offline: what the server takes isn't known, so counters stay on
  assert.equal(game.g.counts_ok, undefined);
  const g = game.g;
  game.call('glitchless_count', 'hit', game.struct({ a: '1', b: '2', c: '3', crit: true, d: '4', e: '5', dmg: 10, w: 1, x: 2, y: 3, z: 4, tags: ['x'] }));
  game.call('glitchless_count', 'hit', game.struct({ a: '1', b: '2', c: '3', crit: true, dmg: 5, z: 9 }));
  game.call('glitchless_count', 'tap', undefined, 0); // nothing happened
  game.call('glitchless_count', 'tap', undefined, 5e6);
  game.call('glitchless_count', 'word', 'endless');
  for (let i = 0; game.g.win.count_list.length < 64; i++) game.call('glitchless_count', 'loot', game.struct({ rarity: `r${i}` }));
  game.call('glitchless_count', 'loot', game.struct({ rarity: 'r0' })); // an entry it has: still counted
  game.call('glitchless_count', 'loot', game.struct({ rarity: 'legendary' }), 2);
  game.call('glitchless_count', 'loot', game.struct({ rarity: 'mythic', gold: 7 }));
  game.call('glitchless_count', 'brand_new', undefined, 7);
  const e = plainJson(game, game.call('__glitchless_counts_event', g, g.win, 5));
  assert.equal(e.type, 'counts');
  assert.equal(e.counts.length, 65, 'the 64 entries and one (other) for loot');
  assert.deepEqual(e.counts[0].attrs, { a: '1', b: '2', c: '3', crit: true }, 'the first 4 words and flags by name');
  assert.deepEqual(e.counts[0].sums, { dmg: 15, w: 1, x: 2, y: 3 }, 'the first 4 numbers by name, added up; z was the fifth');
  assert.equal(e.counts[0].n, 2);
  assert.deepEqual(e.counts.find((c) => c.name === 'tap').n, 1000000, 'n is at most 1,000,000 a call');
  assert.deepEqual(e.counts.find((c) => c.name === 'word').attrs, { what: 'endless' }, 'one word is `what`, as with glitchless_track');
  assert.equal(e.counts.find((c) => c.name === 'loot' && c.attrs.rarity === 'r0').n, 2);
  assert.deepEqual(e.counts.at(-1), { name: 'loot', attrs: { rarity: '(other)' }, n: 3, sums: { gold: 7 }, first_ts: e.counts.at(-1).first_ts });
  assert.equal(e.dropped, 7, 'a new name in a full window is dropped and counted');
});

test('A5: a server without counters gets none, with one warning; a name tracked 20+ times a second earns a warning', async () => {
  const { game, rec } = await genreGame({ health: { ok: true, store: 'file' } });
  assert.equal(game.g.counts_ok, false);
  assert.equal(game.debugMessages.filter((m) => m.includes('does not take counters')).length, 1);
  game.call('glitchless_count', 'kill');
  await game.frames(10);
  await flushNow(game);
  assert.deepEqual(rec.events('counts'), []);

  // One counted before the server answered is taken back out of the queue.
  const early = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS, fetchImpl: recordingFetch({ health: { ok: true } }).impl });
  early.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, early.struct({}));
  early.call('glitchless_count', 'kill');
  early.call('__glitchless_close_window', early.g, false);
  assert.equal(early.g.queue.filter((q) => q.type === 'counts').length, 1);
  await early.settle();
  assert.equal(early.g.queue.filter((q) => q.type === 'counts').length, 0);

  const debug = launch({ saveDir: newSave(), args: ['-glitchless', '-glitchless-debug'], rooms: ROOMS });
  debug.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${deadPort}`, debug.struct({}));
  for (let i = 0; i < 50; i++) debug.call('glitchless_track', 'shot', 'ar');
  for (let i = 0; i < 5; i++) debug.call('glitchless_track', 'jump');
  const warnings = debug.debugMessages.filter((m) => m.includes('glitchless_count('));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /"shot" is tracked more than 20 times a second/);
  const shipped = launch({ saveDir: newSave(), args: ['-glitchless'], rooms: ROOMS });
  shipped.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${deadPort}`, shipped.struct({}));
  for (let i = 0; i < 50; i++) shipped.call('glitchless_track', 'shot');
  assert.ok(!shipped.debugMessages.some((m) => m.includes('glitchless_count(')), 'a shipped build says nothing');
});

test('A6: property keys and values are checked before they go', () => {
  const problem = (k, v) => gml('__glitchless_prop_problem', k, v);
  for (const [k, v] of [['rank', 'diamond'], ['level_band', '30-39'], ['trophy_band', '3000-3499'], ['arena', 'arena_7'], ['season', 's9'], ['solo', true], ['heat', 8], ['floor', -3], ['cap', 1000000], ['region', 'eu-west'], ['k'.padEnd(32, 'x'), 'necromancer'], ['spender', 'none'], ['realm', undefined]]) {
    assert.equal(problem(k, v), '', `${k}=${v}`);
  }
  for (const [k, v] of [['Rank', 'gold'], ['1st', 'a'], ['rank-tier', 'a'], ['k'.padEnd(33, 'x'), 'a'], ['', 'a'], ['version', '1.2'], ['level', 'x'], ['zone', 'docks'], ['match', 'x'], ['run', 'x'], ['platform', 'pc'], ['steam_branch', 'beta'], ['players', 4], ['email', 'x'], ['user_id', 'x'], ['steam_id', 'x'], ['age', 30], ['city', 'Oslo']]) {
    assert.notEqual(problem(k, v), '', `key ${k}`);
  }
  for (const v of [1.5, 1000001, -2e6, 'ada@example.com', 'https://glitchless.gg', 'www.example.com', '+1 555 123 4567', '(555) 123-4567', '555-123-4567', '5551234', '123e4567-e89b-12d3-a456-426614174000', 'dGhpcyBpcyBhIHRva2Vu1', 'deadbeefdeadbeef', 'eyJhbGciOiJIUzI1NiJ9', '', ['a'], gml('__struct', {})]) {
    assert.notEqual(problem('rank', v), '', JSON.stringify(v));
  }
});

test('A6: properties go with session_start, and later changes as one props event a window with each key\'s last value', async () => {
  const { game, rec } = await genreGame({ args: ['-glitchless', '-glitchless-debug'], options: { properties: tool.struct({ mode: 'squads' }) } });
  const set = (o) => game.call('glitchless_set_properties', game.struct(o));
  set({ rank: 'gold', region: '  eu-west  ', email: 'ada@example.com', level_band: '30-39', guild: 'https://x.example' });
  await game.frames(130); // the first batch, at 2 s
  await game.settle();
  const sid = game.g.session_id;
  const start = rec.events('session_start').find((e) => e.session_id === sid);
  assert.equal(start.privacy, 'anonymous', 'properties go in every mode');
  assert.deepEqual(start.props, { mode: 'squads', rank: 'gold', region: 'eu-west', level_band: '30-39' });
  assert.deepEqual(rec.events('props'), [], 'what session_start says goes no second time');
  assert.ok(game.debugMessages.some((m) => /property "email" dropped/.test(m)));
  assert.ok(game.debugMessages.some((m) => /property "guild" dropped: it looks like a link/.test(m)));

  set({ rank: 'platinum' });
  await game.frames(5);
  set({ rank: 'diamond', party_size: 3 });
  await flushNow(game);
  set({ region: undefined, mode: 'squads' }); // mode is as it was
  await flushNow(game);
  set({ mode: 'squads' }); // nothing changes, nothing goes
  await flushNow(game);
  const props = rec.events('props');
  assert.deepEqual(props.map((e) => e.props), [{ rank: 'diamond', party_size: 3 }, { region: null }]);
  assert.ok(props.every((e) => typeof e.ts === 'number' && 'level' in e));

  // 12 keys a session: region was removed, and still counts.
  set(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(game.g.prop_keys).length, 12);
  assert.ok(!('k7' in game.g.props) && game.debugMessages.some((m) => /"k7" dropped: a session has at most 12/.test(m)));
  // and the server takes session_start with its props
  const stored = rawEvents().find((e) => e.type === 'session_start' && e.session_id === sid);
  assert.deepEqual(stored.props, start.props);
});

test('A7: level attributes, match and party groups (hashed), runs and zones are carried by the events after them', async () => {
  const { game, rec } = await genreGame();
  const sha = (s) => 'h_' + crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 24);
  await game.frames(2); // the first frame is never timed
  game.call('glitchless_level_start', 'nmd_ghoa', game.struct({ tier: 'pit_80', party_size: 3, build: ['blood_surge', 'corpse_explosion'] }));
  await game.frames(10, { during: (g) => g.call('glitchless_track', 'before', 'x') });
  const match = game.call('glitchless_set_group', 'match', 'm-8f2c-4410-aa', game.struct({ mode: 'squads', players: 100 }));
  assert.equal(match, sha(`${SERVICE}:m-8f2c-4410-aa`), 'SHA-1 of the service and the ID');
  // The vector every SDK checks, so a match's players and its server hash its ID alike.
  const zoomies = game.call('__glitchless_copy', game.g);
  zoomies.service = 'zoomies';
  assert.equal(game.call('__glitchless_hash_group_id', zoomies, 'm_8f2c91d04ab7'), 'h_d8a6ac978165726ac21a722b');
  assert.equal(game.call('glitchless_set_group', 'match', 'abc'), '', 'too short: dropped');
  assert.equal(game.call('glitchless_set_group', 'match', 'has a space in it'), '', 'not in the ID alphabet: dropped');
  assert.equal(game.call('glitchless_set_group', 'guild', 'guild-00001'), '', 'not a kind');
  const party = game.call('glitchless_set_group', 'party', 'party_0042_x');
  await game.frames(60, { // a second: long enough for the zone change after it to close the window
    during: (g) => {
      g.call('glitchless_track', 'fight', g.struct({ weapon: 'shotgun', won: true }));
      g.call('glitchless_count', 'shot');
    },
  });
  game.call('glitchless_set_zone', 'docks');
  await game.frames(10, { during: (g) => g.call('glitchless_death', 10, 20, 'storm') });
  game.call('glitchless_set_group', 'match', undefined);
  game.call('glitchless_set_zone', '');
  await game.frames(10, { during: (g) => g.call('glitchless_track', 'after') });
  await flushNow(game);

  const start = rec.events('level_start').find((e) => e.level === 'nmd_ghoa');
  assert.deepEqual(start.attrs, { tier: 'pit_80', party_size: 3, build: ['blood_surge', 'corpse_explosion'] });
  const groups = rec.events('group');
  assert.deepEqual(groups.map(({ kind, id, attrs, resumed }) => ({ kind, id, attrs, resumed })), [
    { kind: 'match', id: match, attrs: { mode: 'squads', players: 100 }, resumed: undefined },
    { kind: 'party', id: sha(`${SERVICE}:party_0042_x`), attrs: undefined, resumed: undefined },
    { kind: 'match', id: null, attrs: undefined, resumed: undefined },
  ]);
  assert.equal(party, groups[1].id);
  const custom = (name) => rec.events('custom').filter((e) => e.name === name);
  assert.ok(custom('before').every((e) => !('match' in e) && !('party' in e) && !('zone' in e)));
  assert.ok(custom('fight').every((e) => e.match === match && e.party === party && !('zone' in e)));
  const death = rec.events('death')[0];
  assert.deepEqual([death.match, death.party, death.zone, death.level], [match, party, 'docks', 'nmd_ghoa']);
  assert.ok(custom('after').every((e) => !('match' in e) && e.party === party && !('zone' in e)));
  assert.equal(rec.events('counts')[0].match, match, 'a counts event carries its window\'s groups');
  // Each change closed the frame window: no window spans two matches or two zones.
  const windows = rec.events('frame_window').filter((w) => w.level === 'nmd_ghoa');
  assert.deepEqual(windows.map((w) => [w.frames, w.match ?? null, w.zone ?? null]), [
    [10, null, null],
    [60, match, null],
    [10, match, 'docks'],
    [10, null, null],
  ]);
  // The server takes them: level_start keeps its attrs, events keep their group fields.
  const stored = rawEvents().find((e) => e.type === 'level_start' && e.session_id === game.g.session_id);
  assert.deepEqual(stored.attrs, start.attrs);

  // A developer who wants to match them against their own server logs sends them as they are.
  const raw = await genreGame({ options: { hash_group_ids: false } });
  assert.equal(raw.game.call('glitchless_set_group', 'match', 'm-8f2c-4410-aa'), 'm-8f2c-4410-aa');

  // A player stepping back and forth over a zone's edge: a window closes for a change only once it has run a second.
  const edge = await genreGame();
  await edge.game.frames(30);
  await flushNow(edge.game);
  await edge.game.frames(120, (i) => ({ during: (g) => i % 10 === 0 && g.call('glitchless_set_zone', i % 20 === 0 ? 'docks' : 'town') }));
  await flushNow(edge.game);
  const zoned = edge.rec.events('frame_window').filter((w) => w.zone);
  assert.ok(zoned.length >= 2 && zoned.length <= 3, `${zoned.length} windows for 12 zone changes in 2 s`);
});

test('A7: a run gets its ID from the SDK, and resumes under a saved one in install and full mode only', async () => {
  const anon = await genreGame();
  const run = anon.game.call('glitchless_set_group', 'run');
  assert.match(run, /^r_[a-z0-9]{12}$/);
  const swapped = anon.game.call('glitchless_set_group', 'run', 'r_saved00000a');
  assert.match(swapped, /^r_[a-z0-9]{12}$/);
  assert.notEqual(swapped, 'r_saved00000a', 'anonymous mode: nothing ties two launches together');
  anon.game.call('glitchless_track', 'boon_offer', anon.game.struct({ boon: 'zeus_strike', picked: true }));
  await flushNow(anon.game);
  assert.deepEqual(anon.rec.events('group').map((e) => [e.kind, e.id, e.resumed ?? false]), [['run', run, false], ['run', swapped, true]]);
  assert.equal(anon.rec.events('custom').find((e) => e.name === 'boon_offer').run, swapped);

  const install = await genreGame({ args: ['-glitchless', '-glitchless-privacy=install'] });
  assert.equal(install.game.call('glitchless_set_group', 'run', 'r_saved00000a'), 'r_saved00000a');
  await flushNow(install.game);
  assert.equal(install.rec.events('group')[0].resumed, true);
});

test('A6, A7: a new session in the same launch starts with the properties and groups still set', async () => {
  const { game, rec } = await genreGame();
  game.call('glitchless_set_properties', game.struct({ rank: 'gold' }));
  const match = game.call('glitchless_set_group', 'match', 'match-0001-abcd', game.struct({ mode: 'duo' }));
  await game.frames(130);
  await game.settle();
  const first = game.g.session_id;
  game.call('__glitchless_new_session', game.g); // back after the background timeout
  await game.frames(5);
  await flushNow(game);
  const second = game.g.session_id;
  assert.notEqual(first, second);
  const events = rec.events().filter((e) => e.session_id === second);
  assert.equal(events[0].type, 'session_start');
  assert.deepEqual(events[0].props, { rank: 'gold' });
  assert.deepEqual(events.filter((e) => e.type === 'group').map((e) => [e.kind, e.id, e.attrs]), [['match', match, { mode: 'duo' }]]);
});

test('A8: net samples become each frame window\'s net; a disconnect sends its numbers and abandons the level', async () => {
  const { game, rec } = await genreGame();
  game.call('glitchless_level_start', 'arena_7');
  await game.frames(30);
  await flushNow(game); // a window before the first sample: no net
  const rtts = [40, 45, 50, 55, 60];
  await game.frames(300, (i) => ({
    during: (g) => {
      if (i % 60 === 0) g.call('glitchless_net_sample', rtts[i / 60], 0.5);
      if (i % 60 === 10) g.call('glitchless_net_sample', 900); // too soon after the last: ignored
    },
  }));
  await flushNow(game);
  game.call('glitchless_net_sample', 70, undefined, 7); // the game knows its jitter
  await game.frames(60);
  game.call('glitchless_disconnect', 'timeout');
  await game.frames(60);
  game.call('glitchless_reconnect');
  await game.frames(10);
  await flushNow(game);

  const windows = rec.events('frame_window').filter((w) => w.level === 'arena_7');
  assert.ok(!('net' in windows[0]), 'not connected yet: no net');
  const net = windows[1].net;
  const sketch = Sketch.from(net.rtt);
  assert.equal(net.rtt.a, 0.05);
  assert.equal(sketch.n, 5);
  assert.equal(net.samples, 5);
  assert.equal(net.rtt_p95, Math.round(sketch.quantile(0.95) * 10) / 10);
  assert.ok(Math.abs(net.rtt_p50 - 50) <= 2.5, String(net.rtt_p50));
  assert.deepEqual({ ...net, rtt: undefined, rtt_p50: undefined, rtt_p95: undefined }, {
    rtt: undefined, rtt_p50: undefined, rtt_p95: undefined,
    rtt_max: 60, jitter_ms: 5, loss_pct: 0.5, in_kbps: null, out_kbps: null, samples: 5, transport: 'gamemaker', link: null, host: false,
  });
  assert.deepEqual([windows[2].net.jitter_ms, windows[2].net.loss_pct, windows[2].net.samples], [7, null, 1]);
  assert.ok(!('net' in windows[3]), 'after the disconnect: no net');

  const after = rec.events().filter((e) => ['disconnect', 'level_abandon', 'reconnect'].includes(e.type));
  assert.deepEqual(after.map((e) => e.type), ['disconnect', 'level_abandon', 'reconnect']);
  const [disconnect, abandon, reconnect] = after;
  assert.equal(disconnect.reason, 'timeout');
  assert.ok(Math.abs(disconnect.connected_s - 6) < 0.1, `connected since the first sample, 6 s before: ${disconnect.connected_s}`);
  assert.equal(disconnect.rtt_p95, windows[2].net.rtt_p95);
  assert.equal(disconnect.loss_pct, null);
  assert.deepEqual([abandon.level, abandon.reason], ['arena_7', 'disconnect']);
  assert.ok(Math.abs(reconnect.after_s - 1) < 0.1, String(reconnect.after_s));
  // The server reads the disconnect's abandon as an abandon: never a fail, never a rage quit.
  const session = (await sessionsNow()).find((s) => s.session_id === game.g.session_id);
  assert.deepEqual(session.abandoned, ['arena_7']);
  assert.equal(session.rage_quit, false);
});

test('A8: a disconnect before any sample says so; other reasons are "other"; 20 a session', async () => {
  const { game, rec } = await genreGame();
  game.call('glitchless_disconnect', 'failed_to_connect');
  game.call('glitchless_disconnect', 'cable_unplugged');
  for (let i = 0; i < 25; i++) game.call('glitchless_disconnect');
  game.call('glitchless_reconnect');
  game.call('glitchless_reconnect'); // not after a disconnect: nothing
  await flushNow(game);
  const disconnects = rec.events('disconnect');
  assert.equal(disconnects.length, 20);
  assert.deepEqual({ ...disconnects[0], ts: 0, session_id: 0 }, { type: 'disconnect', ts: 0, session_id: 0, level: null, reason: 'failed_to_connect', connected_s: 0, rtt_p95: null, loss_pct: null });
  assert.equal(disconnects[1].reason, 'other');
  assert.equal(rec.events('level_abandon').length, 0, 'no level open, nothing to abandon');
  assert.equal(rec.events('reconnect').length, 1);
});

// ───────────────────────────── 7. the player's off switch (SPEC §4d) ─────────────────────────────
// A player turns Glitchless off in the game's settings (glitchless_set_enabled), and back on. These read every request
// the game makes, the health check included, and the batches in them.

// Every request the game makes ({url, body}: an intake request's batch, unpacked), passed on to the server. With `hold`,
// the reply to the first batch waits for release(): a request on its way as the player turns Glitchless off.
function switchFetch({ hold = false } = {}) {
  const requests = [];
  let release = () => {};
  const held = hold ? new Promise((r) => (release = r)) : null;
  let batches = 0;
  const impl = async (url, init) => {
    const intake = url.includes('/v1/intake');
    const body = intake ? JSON.parse(Buffer.isBuffer(init.body) && init.body[0] === 0x1f ? zlib.gunzipSync(init.body).toString('utf8') : String(init.body)) : null;
    requests.push({ url, body });
    if (url.endsWith('/v1/health')) return new Response(JSON.stringify({ ok: true, features: FEATURES }), { status: 200 });
    const r = await fetch(url, init);
    const text = await r.text();
    if (intake && held && ++batches === 1) await held;
    return new Response(text, { status: r.status });
  };
  // The events sent, a session's (`sid`) or all of them.
  const events = (sid) => requests.filter((q) => q.body && (!sid || q.body.session_id === sid)).flatMap((q) => q.body.events);
  return { impl, requests, events, release: () => release() };
}

function switchGame({ saveDir = newSave(), args = ['-glitchless'], options = {}, hold = false, buildType = 'exe', intake = `http://127.0.0.1:${port}`, before = null } = {}) {
  const rec = switchFetch({ hold });
  const game = launch({ saveDir, args, rooms: ROOMS, fetchImpl: rec.impl, buildType });
  game.state.timer += Math.floor(Math.random() * 1e9); // its own session ID
  before?.(game);
  game.call('glitchless_init', SERVICE, '1.2.0', 'dev', intake, game.struct(options));
  return { game, rec, saveDir };
}

const choiceOf = (dir) => (fs.existsSync(path.join(dir, 'glitchless/enabled')) ? fs.readFileSync(path.join(dir, 'glitchless/enabled'), 'utf8') : null);
const types = (events) => events.map((e) => e.type);
// Waits for the batch in flight to be answered (a reply held back by switchFetch is not waited for).
async function answered(game) {
  for (let i = 0; i < 100 && game.g.in_flight !== -1; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await game.deliver();
  }
}

test('off: what was waiting goes, the outbox on the device too, and nothing more is measured or sent, not even a session_end', async () => {
  // Offline, so batches pile up in the outbox and on the device; install mode, so there is a player ID to keep.
  const { game, rec, saveDir } = switchGame({ args: ['-glitchless', '-glitchless-privacy=install'], intake: `http://127.0.0.1:${deadPort}` });
  game.call('glitchless_level_start', 'cave_1');
  game.call('glitchless_set_group', 'match', 'match-0001-abcd');
  await game.frames(200, (i) => ({ during: (g) => i % 20 === 0 && g.call('glitchless_track', 'jump') }));
  await game.frame({ dt: 130 }); // a hitch, waiting in the window for its causes
  await game.frame({ during: (g) => g.call('glitchless_count', 'kill') });
  const g = game.g;
  assert.ok(fs.existsSync(outbox(saveDir)) && g.outbox.length > 0, 'the first batch could not go, so it waits on the device');
  assert.ok(g.queue.length > 0 && g.pending_hitches.length === 1 && g.win.count_list.length === 1 && g.win.frames > 0);
  assert.equal(game.call('glitchless_is_enabled'), true);
  assert.equal(choiceOf(saveDir), null, 'nothing is saved until the game calls glitchless_set_enabled');
  const sent = rec.requests.length;
  const errors = g.stats.errors;
  const hitches = g.stats.hitches;

  game.call('glitchless_set_enabled', false);
  assert.equal(choiceOf(saveDir), 'off');
  assert.equal(game.call('glitchless_is_enabled'), false);
  assert.equal(g.stats.last_status, 'off');
  assert.deepEqual([g.queue.length, g.outbox.length, g.win.frames, g.win.count_list.length, g.pending_hitches.length, g.pos_buffer.length], [0, 0, 0, 0, 0, 0]);
  assert.ok(!fs.existsSync(outbox(saveDir)), 'the outbox on the device is deleted');
  assert.ok(fs.existsSync(path.join(saveDir, 'glitchless/player_id')), 'the player ID stays, so a player who turns it back on is still one player');
  assert.equal(g.level, 'cave_1', 'what the game said stays in memory');

  // Every call stays safe and does nothing: no frame, hitch, error, event, count, position or network sample is kept.
  await game.frames(400, (i) => ({
    dt: i === 200 ? 130 : 16.667,
    during: (gm) => {
      gm.call('glitchless_track', 'after_off');
      gm.call('glitchless_count', 'kill');
      gm.call('glitchless_set_position', 10, 20);
      gm.call('glitchless_set_context', gm.struct({ enemies: 7 }));
      if (i === 10) gm.call('glitchless_death', 1, 2, 'spikes');
      if (i === 20) gm.call('glitchless_error', 'save slot missing');
      if (i % 60 === 0) gm.call('glitchless_net_sample', 40);
      if (i === 100) gm.call('glitchless_disconnect', 'timeout');
      if (i === 300) gm.call('glitchless_level_complete');
    },
  }));
  game.call('glitchless_flush');
  game.state.focus = false; // losing focus flushes
  await game.frame();
  game.state.focus = true;
  await game.frames(2);
  assert.deepEqual([g.queue.length, g.outbox.length, g.win.frames, g.win.count_list.length, g.pos_buffer.length, g.stats.errors, g.stats.hitches], [0, 0, 0, 0, 0, errors, hitches]);
  assert.equal(g.recent.length, 0, 'nothing for a later hitch or report to carry');
  game.call('glitchless_quit');
  assert.equal(game.state.ended, true, 'quitting ends the game at once: nothing waits to go');
  game.call('__glitchless_game_end'); // the Game End event
  assert.ok(!fs.existsSync(outbox(saveDir)), 'nothing was saved for the next launch');
  assert.equal(rec.requests.length, sent, 'no request of any kind after the player said no');
  assert.deepEqual(rec.events().filter((e) => ['session_end', 'level_abandon'].includes(e.type)), [], 'the session ends without a session_end or level_abandon');
});

test('a request on its way as the player turns Glitchless off: its answer changes nothing', async () => {
  const { game, rec } = switchGame({ hold: true });
  await game.frames(130); // the first batch goes at 2 s; its reply is held back
  await new Promise((r) => setTimeout(r, 100));
  const g = game.g;
  const buffer = g.http_buffer;
  assert.ok(g.http_id !== -1 && buffer !== -1 && game.state.buffers.has(buffer), 'a gzipped batch in flight');
  game.call('glitchless_set_enabled', false);
  assert.equal(Object.keys(g.ignored).length, 1);
  game.call('glitchless_set_enabled', true);
  await game.frames(130); // the new session's first batch goes, and is answered
  await answered(game);
  const before = { sent: g.stats.sent, outbox: g.outbox.length, status: g.stats.last_status };
  rec.release();
  await game.settle();
  assert.deepEqual({ sent: g.stats.sent, outbox: g.outbox.length, status: g.stats.last_status }, before, 'the old reply was ignored');
  assert.deepEqual(Object.keys(g.ignored), []);
  assert.ok(!game.state.buffers.has(buffer), 'its body buffer was freed when the answer came');
});

test('on after off: a new session with the properties and groups still set, measured from the next frame; the attempt open at off gets no outcome, and no load goes again', async () => {
  const { game, rec } = switchGame();
  game.call('glitchless_set_properties', game.struct({ rank: 'gold' }));
  const match = game.call('glitchless_set_group', 'match', 'match-0001-abcd', game.struct({ mode: 'duo' }));
  game.call('glitchless_level_start', 'cave_1');
  await game.frames(130);
  await game.settle();
  const first = game.g.session_id;
  assert.ok(types(rec.events(first)).includes('load'));

  game.call('glitchless_set_enabled', false);
  // What the game says while off stays in memory, unsent.
  game.call('glitchless_set_properties', game.struct({ rank: 'platinum' }));
  game.call('glitchless_set_zone', 'docks');
  await game.frames(60, { during: (g) => g.call('glitchless_track', 'while_off') });
  game.call('glitchless_set_enabled', true);
  const second = game.g.session_id;
  assert.notEqual(second, first);
  assert.equal(choiceOf(game.saveDir), 'on');
  assert.equal(game.call('glitchless_is_enabled'), true);
  await game.frames(5, (i) => ({ during: (g) => i === 2 && g.call('glitchless_track', 'back') }));
  // cave_1 was going when the player turned Glitchless off: the new session never saw it start.
  game.call('glitchless_level_fail', undefined, 'spikes');
  game.call('glitchless_level_abandon');
  game.call('glitchless_level_complete', 'cave_1', 10);
  game.call('glitchless_level_start', 'cave_2');
  game.call('glitchless_level_complete', undefined, 20);
  await flushNow(game);

  const events = rec.events(second);
  assert.equal(events[0].type, 'session_start');
  assert.deepEqual(events[0].props, { rank: 'platinum' }, 'with the properties set by now');
  assert.deepEqual(events.filter((e) => e.type === 'group').map((e) => [e.kind, e.id, e.attrs]), [['match', match, { mode: 'duo' }]]);
  assert.ok(!types(events).includes('load'), 'the load is not sent again');
  assert.ok(!rec.events().some((e) => e.name === 'while_off'));
  const back = events.find((e) => e.name === 'back');
  assert.deepEqual([back.level, back.zone, back.match], ['cave_1', 'docks', match], 'the level, zone and match are still the current ones');
  assert.deepEqual(events.filter((e) => e.type.startsWith('level_')).map((e) => [e.type, e.level]), [['level_start', 'cave_2'], ['level_complete', 'cave_2']]);
  const windows = events.filter((e) => e.type === 'frame_window');
  assert.deepEqual([windows[0].level, windows[0].frames], ['cave_1', 4], 'measured from the frame after the call');
  assert.deepEqual(types(rec.events(first)).filter((t) => ['session_end', 'level_abandon'].includes(t)), [], 'the first session just went quiet');
  // The server takes the new session.
  assert.ok(rawEvents().some((e) => e.type === 'session_start' && e.session_id === second));

  // Turned off before the launch's first batch: its load never goes, not the first frame's nor the first input's.
  const early = switchGame();
  await early.game.frames(30);
  early.game.call('glitchless_set_enabled', false);
  early.game.call('glitchless_set_enabled', true);
  await early.game.frames(130, (i) => ({ during: (g) => i === 60 && g.state.pressed.add(32) }));
  await early.game.settle();
  assert.equal(early.rec.events()[0].type, 'session_start');
  assert.ok(!types(early.rec.events()).includes('load'), JSON.stringify(types(early.rec.events())));
});

test('a call that changes nothing does nothing, and the choice is saved as on or off once the game calls it', async () => {
  const { game, rec, saveDir } = switchGame();
  await game.frames(130);
  await game.settle();
  const sid = game.g.session_id;
  const requests = rec.requests.length;
  game.call('glitchless_set_enabled', true); // on while on: saved, nothing else
  assert.equal(choiceOf(saveDir), 'on');
  assert.deepEqual([game.g.session_id, game.g.session_start_sent, rec.requests.length], [sid, true, requests]);
  game.call('glitchless_set_enabled', false);
  game.call('glitchless_set_enabled', false);
  assert.equal(choiceOf(saveDir), 'off');
  game.call('glitchless_set_enabled', true);
  const next = game.g.session_id;
  game.call('glitchless_set_enabled', true);
  assert.equal(game.g.session_id, next, 'one new session, not two');
  assert.notEqual(next, sid);
  await game.frames(130);
  await game.settle();
  assert.equal(rec.events(next).filter((e) => e.type === 'session_start').length, 1);
});

test('the saved choice is read before anything else: off, an earlier launch\'s outbox is deleted unread and nothing is measured or sent', async () => {
  const saveDir = newSave();
  await play({ saveDir, intake: `http://127.0.0.1:${deadPort}` });
  assert.ok(fs.existsSync(outbox(saveDir)), 'an earlier launch left batches');
  fs.writeFileSync(path.join(saveDir, 'glitchless/enabled'), 'off');
  fs.rmSync(path.join(saveDir, 'glitchless/launched'));
  const { game, rec } = switchGame({ saveDir });
  assert.ok(!fs.existsSync(outbox(saveDir)), 'deleted unread at glitchless_init');
  assert.deepEqual([game.g.outbox.length, game.call('glitchless_is_enabled'), game.g.stats.last_status], [0, false, 'off']);
  const results = [];
  await game.frames(300, (i) => ({
    during: (g) => {
      g.call('glitchless_track', 'jump');
      if (i === 10) g.call('glitchless_error', 'save slot missing');
      if (i === 100) g.call('glitchless_measure', 3, (r) => results.push(plainJson(g, r)));
    },
  }));
  assert.equal(results.length, 1, 'measure answers at once');
  assert.match(results[0].error, /Glitchless is off on this device/);
  assert.deepEqual([game.g.win.frames, game.g.queue.length, game.g.stats.errors], [0, 0, 0]);
  assert.ok(!fs.existsSync(path.join(saveDir, 'glitchless/launched')), 'nothing else is written to the device');
  game.call('glitchless_quit');
  assert.equal(game.state.ended, true);
  assert.deepEqual(rec.requests, [], 'not the outbox, not a health check: nothing');

  // -glitchless-measure says so too, and the game still quits.
  const measured = launch({ saveDir, args: ['-glitchless', '-glitchless-measure=1'], rooms: ROOMS });
  measured.call('glitchless_init', SERVICE, '1.2.0', 'dev', `http://127.0.0.1:${port}`, measured.struct({}));
  for (let i = 0; i < 300 && (await measured.frame()); i++);
  assert.equal(measured.state.ended, true);
  assert.match(JSON.parse(measured.debugMessages.find((m) => m.startsWith('{"glitchless_measure"'))).glitchless_measure.error, /off/);

  // A choice made before glitchless_init holds from init.
  const early = switchGame({ before: (g) => g.call('glitchless_set_enabled', false) });
  await early.game.frames(200, { during: (g) => g.call('glitchless_track', 'jump') });
  assert.deepEqual([choiceOf(early.saveDir), early.game.call('glitchless_is_enabled'), early.rec.requests.length], ['off', false, 0]);
});

test('opt_in: with no saved choice the device starts off until glitchless_set_enabled(true); a saved choice wins over it', async () => {
  const saveDir = newSave();
  const { game, rec } = switchGame({ saveDir, options: { opt_in: true } });
  assert.equal(game.call('glitchless_is_enabled'), false);
  await game.frames(200, { during: (g) => g.call('glitchless_track', 'menu') });
  assert.deepEqual([rec.requests.length, choiceOf(saveDir)], [0, null], 'nothing measured, kept or sent, and no choice made yet');
  game.call('glitchless_set_enabled', true); // the player said yes
  assert.equal(game.call('glitchless_is_enabled'), true);
  assert.equal(choiceOf(saveDir), 'on');
  await game.frames(130, { during: (g) => g.call('glitchless_track', 'play') });
  await game.settle();
  assert.ok(rec.requests.some((q) => q.url.endsWith('/v1/health')), 'it asks what the server takes now');
  const events = rec.events(game.g.session_id);
  assert.equal(events[0].type, 'session_start');
  assert.ok(events.some((e) => e.name === 'play') && !events.some((e) => e.name === 'menu'));
  assert.ok(!types(events).includes('load'), 'the launch was not measured from its start');
  game.call('glitchless_quit');
  await game.settle();

  // The next launch reads the player's yes, whatever opt_in says.
  const next = switchGame({ saveDir, options: { opt_in: true } });
  assert.equal(next.game.call('glitchless_is_enabled'), true);
  await next.game.frames(130);
  await next.game.settle();
  assert.ok(next.rec.events(next.game.g.session_id).some((e) => e.type === 'load' && e.ttff_ms != null));
});

test('a build that sends nothing stays off: glitchless_set_enabled(true) can\'t turn it on, but the choice is saved', async () => {
  const { game, rec, saveDir } = switchGame({ buildType: 'run', args: [] }); // run from the IDE without -glitchless
  assert.equal(game.call('glitchless_is_enabled'), false);
  const results = [];
  game.call('glitchless_set_enabled', false);
  assert.equal(choiceOf(saveDir), 'off');
  game.call('glitchless_measure', 1, (r) => results.push(plainJson(game, r)));
  await game.frames(2);
  assert.match(results[0]?.error ?? '', /Glitchless is off/);
  game.call('glitchless_set_enabled', true);
  assert.equal(choiceOf(saveDir), 'on');
  assert.equal(game.call('glitchless_is_enabled'), false, 'the build\'s own off holds');
  game.call('glitchless_measure', 1, (r) => results.push(plainJson(game, r)));
  await game.frames(70);
  assert.ok(results[1]?.frames > 50, 'it measures again for an agent: ' + JSON.stringify(results[1]));
  await flushNow(game);
  assert.deepEqual(rec.requests, []);
});

test('bug reports while off: an open form closes, F8 and glitchless_open_bug_report open none, and glitchless_report_bug answers off', async () => {
  const seen = [];
  const { game, rec } = switchGame({ options: { bug_reports: tool.struct({ on_open: () => seen.push('open'), on_close: () => seen.push('close') }) } });
  await game.frames(5);
  game.state.pressed.add(119); // F8
  await game.frame();
  assert.equal(game.call('glitchless_bug_report_is_open'), true);
  game.call('glitchless_set_enabled', false);
  assert.equal(game.call('glitchless_bug_report_is_open'), false);
  assert.deepEqual(seen, ['open', 'close'], 'the game\'s own pause is undone');
  game.state.pressed.add(119);
  await game.frame();
  game.call('glitchless_open_bug_report');
  await game.frames(2);
  assert.equal(game.call('glitchless_bug_report_is_open'), false);
  const results = [];
  const note = (r) => results.push(plainJson(game, r));
  game.call('glitchless_report_bug', 'the bonus never paid out', true, note);
  game.call('glitchless_report_bug', 'no screenshot', false, note);
  assert.deepEqual(results, [{ sent: false, reason: 'off' }, { sent: false, reason: 'off' }], 'answered at once, with no screenshot taken');

  // A report waiting for this frame's screenshot as the player turns Glitchless off answers off too.
  game.call('glitchless_set_enabled', true);
  game.call('glitchless_report_bug', 'waiting for its screenshot', true, note);
  game.call('glitchless_set_enabled', false);
  await game.frames(2);
  assert.deepEqual(results.at(-1), { sent: false, reason: 'off' });
  assert.equal(results.length, 3);
  assert.ok(!rec.events().some((e) => e.type === 'bug_report'));
});

test('a crash while the player has Glitchless off writes nothing to the outbox, and the game\'s own handler still runs', async () => {
  const theirs = [];
  const { game, rec, saveDir } = switchGame({ options: { exception_handler: (ex) => theirs.push(ex.message) } });
  await game.frames(130);
  await game.settle();
  const sent = rec.requests.length;
  game.call('glitchless_set_enabled', false);
  game.crash({ message: 'off-switch crash 4412', stacktrace: ['gml_Script_bonus_pay (line 14)'] });
  game.call('__glitchless_game_end'); // GameMaker then closes the game
  assert.deepEqual(theirs, ['off-switch crash 4412']);
  assert.ok(!fs.existsSync(outbox(saveDir)), 'no crash written for the next launch');
  assert.equal(rec.requests.length, sent);
  // The next launch reads the choice and sends nothing either.
  const next = switchGame({ saveDir });
  await next.game.frames(200);
  await next.game.settle();
  assert.deepEqual(next.rec.requests, []);
  assert.ok(!rawEvents().some((e) => e.message === 'off-switch crash 4412'));
});
