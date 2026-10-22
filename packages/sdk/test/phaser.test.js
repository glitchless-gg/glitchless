// The Phaser adapter against a stand-in game: the events, scene states and WebGL calls Phaser 3 and 4
// share. The real games are checked in a browser by the demo (apps/phaser-demo) and the playtest.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class Emitter {
  constructor() {
    this.l = new Map();
  }
  on(name, fn) {
    if (!this.l.has(name)) this.l.set(name, []);
    this.l.get(name).push(fn);
    return this;
  }
  once(name, fn) {
    const wrapped = (...a) => {
      this.off(name, wrapped);
      fn(...a);
    };
    return this.on(name, wrapped);
  }
  off(name, fn) {
    const list = this.l.get(name) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }
  emit(name, ...args) {
    for (const fn of [...(this.l.get(name) || [])]) fn(...args);
  }
  eventNames() {
    return [...this.l.keys()];
  }
  listenerCount(name) {
    return (this.l.get(name) || []).length;
  }
}

const windowEvents = new Emitter();
globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5175', pathname: '/' };
globalThis.window = { addEventListener: (name, fn) => windowEvents.on(name, fn) };

const { Glitchless, SDK_VERSION } = await import('../src/core.js');
const { instrumentPhaser, inspectPhaser } = await import('../src/phaser.js');

const RUNNING = 5;
const SHUTDOWN = 8;

function scene(key) {
  return { sys: { settings: { key, status: 0 }, events: new Emitter(), load: new Emitter(), updateList: { length: 0 } }, children: { list: [] } };
}

function fakeGl() {
  const calls = [];
  return {
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    TRIANGLE_FAN: 6,
    calls,
    drawArrays(mode, first, count) {
      calls.push(['drawArrays', mode, count]);
    },
    drawElements(mode, count) {
      calls.push(['drawElements', mode, count]);
    },
    linkProgram() {},
    deleteProgram() {},
  };
}

function fakeGame(keys) {
  const scenes = keys.map(scene);
  return {
    events: new Emitter(),
    isBooted: true,
    loop: { running: true },
    scene: { scenes },
    renderer: { gl: fakeGl() },
    textures: Object.assign(new Emitter(), { list: { __DEFAULT: {}, __MISSING: {}, dog: {} } }),
    sound: { sounds: [] },
    canvas: null,
  };
}

function start(game, key) {
  const s = game.scene.scenes.find((x) => x.sys.settings.key === key);
  s.sys.settings.status = RUNNING;
  s.sys.events.emit('start');
  return s;
}

function stop(game, key) {
  const s = game.scene.scenes.find((x) => x.sys.settings.key === key);
  s.sys.settings.status = SHUTDOWN;
  s.sys.events.emit('shutdown');
}

// One Phaser step at `time`: what Game.step emits, in order.
function step(game, time, during = () => {}) {
  game.events.emit('prestep', time, 16.7);
  during();
  game.events.emit('poststep', time, 16.7);
  game.events.emit('prerender', game.renderer, time, 16.7);
  game.events.emit('postrender', game.renderer, time, 16.7);
}

let gd;
beforeEach(() => {
  // Made without `window`, so the core skips its own requestAnimationFrame loop and browser listeners.
  const w = globalThis.window;
  delete globalThis.window;
  gd = new Glitchless({ service: 'fetch', version: '1.0.0', intake: null });
  globalThis.window = w;
});

test('scenes become levels; menus, loaders, overlays and end screens do not', () => {
  const game = fakeGame(['Boot', 'Preloader', 'MainMenu', 'level-1', 'Rooftops', 'UIScene', 'HUD', 'GameOverScene']);
  instrumentPhaser(gd, { game, Phaser: { VERSION: '3.90.0' } });
  start(game, 'Boot');
  start(game, 'Preloader');
  start(game, 'MainMenu');
  assert.equal(gd.level, null);
  start(game, 'level-1');
  start(game, 'UIScene');
  start(game, 'HUD');
  assert.equal(gd.level, 'level-1');
  stop(game, 'level-1');
  assert.equal(gd.level, null, 'back to a menu: no level');
  start(game, 'Rooftops');
  assert.equal(gd.level, 'Rooftops');
  start(game, 'GameOverScene');
  assert.equal(gd.level, 'Rooftops');
  const starts = gd.queue.filter((e) => e.type === 'level_start').map((e) => e.level);
  assert.deepEqual(starts, ['level-1', 'Rooftops']);
  assert.equal(gd.sdk, `glitchless-phaser/${SDK_VERSION}`);
  assert.deepEqual(gd.engine, { name: 'phaser', version: '3.90.0', renderer: 'webgl' });
});

test('a restart is a new level start, a wake is not', () => {
  const game = fakeGame(['Game']);
  instrumentPhaser(gd, { game });
  start(game, 'Game');
  stop(game, 'Game');
  start(game, 'Game');
  const s = game.scene.scenes[0];
  s.sys.events.emit('sleep');
  assert.equal(gd.level, null);
  s.sys.events.emit('wake');
  assert.equal(gd.level, 'Game');
  assert.equal(gd.queue.filter((e) => e.type === 'level_start').length, 2);
});

test('the levels option and a manual levelStart take over', () => {
  const game = fakeGame(['Play', 'Bonus']);
  instrumentPhaser(gd, { game, levels: (s) => (s.sys.settings.key === 'Play' ? 'world-1' : null) });
  start(game, 'Bonus');
  assert.equal(gd.level, null);
  start(game, 'Play');
  assert.equal(gd.level, 'world-1');
  gd.levelStart('world-1-2'); // the game knows better: scene levels stop
  stop(game, 'Play');
  start(game, 'Play');
  assert.equal(gd.level, 'world-1-2');
});

test('scenes already running when the adapter arrives are picked up', () => {
  const game = fakeGame(['Boot', 'Level1']);
  game.scene.scenes[1].sys.settings.status = RUNNING;
  instrumentPhaser(gd, { game });
  assert.equal(gd.level, 'Level1');
});

test('frames come from Phaser steps, with draw calls and triangles counted on the context', () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game });
  const gl = game.renderer.gl;
  for (let i = 0; i < 10; i++) {
    step(game, 1000 + i * 16.7, () => {
      gl.drawArrays(gl.TRIANGLES, 0, 600); // 200 triangles
      gl.drawElements(gl.TRIANGLE_STRIP, 12); // 10 triangles
    });
  }
  assert.equal(gl.calls.length, 20, 'the real draw functions still run');
  assert.equal(gd.win.frames, 9, 'ten steps time nine frames');
  assert.equal(gd.win.drawCalls / gd.win.renderFrames, 2);
  assert.equal(gd.win.triangles / gd.win.renderFrames, 210);
  assert.ok(gd.win.updateFrames > 0);
});

test('a slow step is a hitch with the causes the engine saw', () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game });
  const level = start(game, 'Level1');
  step(game, 1000);
  step(game, 1016.7, () => {
    for (let i = 0; i < 60; i++) level.sys.events.emit('addedtoscene');
    game.textures.emit('addtexture', 'sparkles-0');
    game.renderer.gl.linkProgram({});
  });
  step(game, 1016.7 + 180); // that step took 180 ms
  const hitch = gd.pendingHitches[0];
  assert.ok(hitch, 'a hitch was recorded');
  assert.equal(Math.round(hitch.duration_ms), 180);
  gd.closeWindow();
  const sent = gd.queue.find((e) => e.type === 'hitch');
  assert.ok(sent.causes.includes('object_spawn'));
  assert.ok(sent.causes.includes('texture_upload'));
  assert.ok(sent.causes.includes('shader_compile'));
  assert.equal(sent.objects_added, 60);
  assert.equal(sent.programs_linked, 1);
  const fw = gd.queue.find((e) => e.type === 'frame_window');
  assert.ok(fw.process_ms != null, 'frame windows carry update time');
});

test('time spent paused is not a frame', () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game });
  step(game, 1000);
  game.events.emit('pause');
  game.events.emit('resume', 5000);
  step(game, 9000);
  step(game, 9016.7);
  assert.equal(gd.win.frames, 1);
  assert.equal(gd.pendingHitches.length, 0);
});

test('failed loads and gauges', () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game });
  const level = start(game, 'Level1');
  level.sys.load.emit('loaderror', { type: 'image', key: 'dog', src: 'https://cdn.example.com/art/dog.png?token=abc' });
  const err = gd.queue.find((e) => e.type === 'error');
  assert.equal(err.kind, 'asset');
  assert.match(err.message, /Failed to load image "dog": dog\.png/);
  assert.doesNotMatch(JSON.stringify(err), /token=abc/, 'anonymous mode keeps query strings out');
  level.children.list.push({ type: 'Image', visible: true }, { type: 'Container', list: [{ type: 'Sprite' }, { type: 'Sprite' }] });
  level.sys.events.on('update', () => {});
  level.sys.events.on('update', () => {});
  for (let i = 0; i < 31; i++) step(game, 2000 + i * 16.7);
  assert.equal(gd.ctx.game_objects, 4);
  assert.ok(gd.ctx.listeners >= 2);
  const report = inspectPhaser(game, { version: '3.90.0' });
  assert.equal(report.scenes[0].objects, 4);
  assert.equal(report.textures, 1, 'Phaser\'s own __ textures are left out');
  assert.deepEqual(report.scenes[0].busiest_events[0], { event: 'update', listeners: 2 });
});

test('a game loop that stops after an uncaught error is reported once', async () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game });
  start(game, 'Level1');
  step(game, 1000);
  const error = new TypeError("Cannot read properties of undefined (reading 'seconds')");
  error.stack = "TypeError: Cannot read properties of undefined (reading 'seconds')\n    at Level.catchToy (http://localhost:5175/src/scenes.js:263:43)";
  windowEvents.emit('error', { error, message: error.message, filename: 'http://localhost:5175/src/scenes.js', lineno: 263, colno: 43 });
  await new Promise((r) => setTimeout(r, 3200));
  game.isDestroyed = true;
  // It is flushed straight away (with no intake, that empties the queue), so read the SDK's error log.
  const stopped = [...gd.errorLog.values()].filter((e) => e.kind === 'game_loop_stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].count, 1);
  assert.match(stopped[0].message, /game loop stopped after an uncaught error: TypeError/);
  assert.match(stopped[0].location, /^Level\.catchToy \(scenes\.js:263:43\)/);
});

test('session_start says which engine, nothing more', () => {
  const game = fakeGame(['Level1']);
  instrumentPhaser(gd, { game, Phaser: { VERSION: '4.2.1' } });
  const start = gd.sessionStartEvent.call({ ...gd, device: () => ({ browser: 'Chrome', browser_version: '156.0.1', os: 'macOS', gpu: 'Apple M3 Max', gpu_tier: 'high', cores: 16 }) });
  assert.deepEqual(start.engine, { name: 'phaser', version: '4.2.1', renderer: 'webgl' });
  assert.equal(start.device.gpu, undefined);
  assert.equal(start.device.cores, undefined);
});
