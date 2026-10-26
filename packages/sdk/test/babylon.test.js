// The Babylon.js adapter against Babylon's own NullEngine: real engine and scene observables, counters and meshes, no
// GPU. Where the NullEngine draws nothing (draw calls, shader compiles, texture failures), the test drives the same
// counters and observables Babylon's WebGL and WebGPU engines do. The real game is checked in a browser by the demo
// (apps/babylon-demo).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class Emitter {
  constructor() {
    this.l = new Map();
  }
  on(name, fn) {
    if (!this.l.has(name)) this.l.set(name, []);
    this.l.get(name).push(fn);
  }
  emit(name, ...args) {
    for (const fn of [...(this.l.get(name) || [])]) fn(...args);
  }
}

const windowEvents = new Emitter();
globalThis.document = { hidden: false, referrer: '', addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5176', pathname: '/' };
// Like a browser: an error thrown inside a frame callback goes to window's 'error' listeners.
const fakeWindow = {
  addEventListener: (name, fn) => windowEvents.on(name, fn),
  removeEventListener() {},
  requestAnimationFrame: (fn) =>
    setTimeout(() => {
      try {
        fn(performance.now());
      } catch (error) {
        windowEvents.emit('error', { error, message: error.message, filename: 'http://localhost:5176/src/game.js', lineno: 88, colno: 13 });
      }
    }, 5),
  cancelAnimationFrame: (id) => clearTimeout(id),
};
globalThis.window = fakeWindow;

const B = await import('@babylonjs/core');
const { Glitchless, SDK_VERSION } = await import('../src/core.js');
const { instrumentBabylon, inspectBabylon } = await import('../src/babylon.js');

let gd;
let engine;
beforeEach(() => {
  // Made without `window`, so the core skips its own requestAnimationFrame loop and browser listeners.
  delete globalThis.window;
  gd = new Glitchless({ service: 'comet-garden', version: '1.0.0', intake: null });
  globalThis.window = fakeWindow;
  engine = new B.NullEngine();
});
afterEach(() => engine.dispose());

function world(level) {
  const scene = new B.Scene(engine);
  if (level) scene.metadata = { level };
  const camera = new B.FreeCamera('camera', new B.Vector3(0, 0, -10), scene);
  camera.setTarget(B.Vector3.Zero());
  return scene;
}

// One engine frame: what Engine._renderLoop does around the game's render function.
function frame(scene, during = () => {}) {
  engine.beginFrame();
  during();
  scene.render();
  engine.endFrame();
}

function busy(ms) {
  const t = performance.now();
  while (performance.now() - t < ms);
}

test('frames come from Babylon\'s loop, with its draw-call counter and active indices', () => {
  const scene = world('meadow');
  B.MeshBuilder.CreateBox('crate', { size: 1 }, scene);
  instrumentBabylon(gd, { engine, scene });
  for (let i = 0; i < 10; i++) frame(scene, () => engine._reportDrawCall(3)); // what drawElementsType counts
  assert.equal(gd.win.frames, 9, 'ten frames time nine');
  assert.equal(gd.win.drawCalls / gd.win.renderFrames, 3);
  assert.equal(gd.win.triangles / gd.win.renderFrames, scene.getActiveIndices() / 3);
  assert.ok(gd.win.updateFrames > 0, 'frames are split into update and render time');
  assert.equal(gd.sdk, `glitchless-babylon/${SDK_VERSION}`);
  assert.deepEqual(gd.engine, { name: 'babylon', version: B.Engine.Version, renderer: 'headless' });
});

test('a scene the game names is a level; disposing it ends the level; a new name is a new level', () => {
  const menu = world();
  instrumentBabylon(gd, { engine, scene: menu });
  frame(menu);
  assert.equal(gd.level, null, 'a scene without metadata.level is not a level');
  menu.dispose();
  const meadow = world('meadow');
  frame(meadow);
  assert.equal(gd.level, 'meadow');
  meadow.metadata.level = 'meadow-2'; // the same scene rebuilt for the next level
  frame(meadow);
  assert.equal(gd.level, 'meadow-2');
  meadow.dispose();
  assert.equal(gd.level, null);
  const retry = world('meadow-2'); // a new scene for the same level: a new attempt
  frame(retry);
  const starts = gd.queue.filter((e) => e.type === 'level_start').map((e) => e.level);
  assert.deepEqual(starts, ['meadow', 'meadow-2', 'meadow-2']);
});

test('the levels option and a manual levelStart take over', () => {
  const scene = world();
  instrumentBabylon(gd, { engine, scene, levels: () => 'arena' });
  frame(scene);
  assert.equal(gd.level, 'arena');
  gd.levelStart('arena-wave-3', { heat: 4 });
  assert.deepEqual(gd.queue.filter((e) => e.type === 'level_start').at(-1).attrs, { heat: 4 }, 'its attributes pass through');
  scene.dispose();
  const next = world();
  frame(next);
  assert.equal(gd.level, 'arena-wave-3', 'scene levels are off once the game calls levelStart');
});

test('a slow frame is a hitch with the causes Babylon saw', () => {
  const scene = world('nebula');
  instrumentBabylon(gd, { engine, scene });
  for (let i = 0; i < 3; i++) frame(scene);
  frame(scene, () => {
    for (let i = 0; i < 60; i++) B.MeshBuilder.CreateBox(`shard-${i}`, { size: 0.2 }, scene);
    new B.DynamicTexture('glow', 64, scene);
    // What Engine.createShaderProgram does around a compile.
    engine.onBeforeShaderCompilationObservable.notifyObservers(engine);
    busy(30);
    engine.onAfterShaderCompilationObservable.notifyObservers(engine);
    busy(110);
  });
  frame(scene);
  const hitch = gd.pendingHitches[0];
  assert.ok(hitch, 'a hitch was recorded');
  assert.ok(hitch.duration_ms >= 140);
  gd.closeWindow();
  const sent = gd.queue.find((e) => e.type === 'hitch');
  for (const c of ['shader_compile', 'object_spawn', 'texture_upload', 'script']) assert.ok(sent.causes.includes(c), `${c} in ${sent.causes}`);
  assert.equal(sent.shaders_compiled, 1);
  assert.ok(sent.shader_compile_ms >= 29);
  assert.equal(sent.meshes_added, 60);
  assert.equal(sent.textures_added, 1);
  assert.ok(sent.process_ms >= 139, 'game code before the render targets is update time');
  assert.equal(sent.ctx.meshes, 60);
  const fw = gd.queue.find((e) => e.type === 'frame_window');
  assert.ok(fw.process_ms != null, 'frame windows carry update time');
  assert.equal(fw.geometries, scene.geometries.length);
  assert.equal(fw.programs, Object.keys(engine._compiledEffects).length);
});

test('context loss, shader errors and failed texture loads are reported', () => {
  const scene = world('meadow');
  instrumentBabylon(gd, { engine, scene });
  engine.onContextLostObservable.notifyObservers(engine);
  engine.onEffectErrorObservable.notifyObservers({ effect: { name: { vertex: 'prism', fragment: 'prism' } }, errors: "FRAGMENT SHADER ERROR: 0:12: 'glow' : undeclared identifier" });
  const tex = new B.Texture('https://cdn.example.com/art/sky.png?token=abc', scene);
  // Where Texture records a failed load (Babylon has no error observable for it).
  tex._loadingError = true;
  tex._errorObject = { message: 'HTTP 404' };
  for (let i = 0; i < 31; i++) frame(scene);
  const errors = gd.queue.filter((e) => e.type === 'error');
  assert.deepEqual(
    errors.map((e) => e.kind),
    ['webgl_context_lost', 'shader', 'asset'],
  );
  assert.equal(errors[1].message, 'Shader failed to compile: prism');
  assert.match(errors[1].attrs.errors, /undeclared identifier/);
  assert.equal(errors[2].message, 'Failed to load texture: sky.png');
  assert.equal(errors[2].source, 'sky.png');
  assert.doesNotMatch(JSON.stringify(errors[2]), /token=abc/, 'anonymous mode keeps query strings out');
});

test('an uncaught error that stops Babylon\'s render loop is reported once', async () => {
  const scene = world('nebula');
  instrumentBabylon(gd, { engine, scene });
  let n = 0;
  engine.runRenderLoop(() => {
    if (++n === 4) {
      const err = new TypeError("Cannot read properties of undefined (reading 'duration')");
      err.stack = "TypeError: Cannot read properties of undefined (reading 'duration')\n    at Garden.collect (http://localhost:5176/src/game.js:88:13)";
      throw err;
    }
    scene.render();
  });
  await new Promise((r) => setTimeout(r, 3400));
  assert.equal(n, 4, 'Babylon queues no frame after one that threw');
  engine.stopRenderLoop();
  const stopped = [...gd.errorLog.values()].filter((e) => e.kind === 'game_loop_stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].count, 1);
  assert.match(stopped[0].message, /^Babylon\.js's render loop stopped after an uncaught error: TypeError/);
  assert.match(stopped[0].location, /^Garden\.collect \(game\.js:88:13\)/);
});

test('a render loop started again does not time the pause as a frame', () => {
  const scene = world('meadow');
  instrumentBabylon(gd, { engine, scene });
  frame(scene);
  frame(scene);
  busy(120); // stopped (a pause menu, a tab the game paused itself)
  engine.runRenderLoop(() => {});
  engine.stopRenderLoop();
  frame(scene);
  assert.equal(gd.pendingHitches.length, 0);
});

test('inspectScene groups meshes and flags copies that should be instances and shared materials', () => {
  const scene = world('meadow');
  for (let i = 0; i < 30; i++) {
    const shard = B.MeshBuilder.CreateBox(`shard-${i}`, { size: 0.2 }, scene);
    shard.material = new B.StandardMaterial(`shard-mat-${i}`, scene);
  }
  const rock = B.MeshBuilder.CreateSphere('rock', { segments: 4 }, scene);
  for (let i = 0; i < 25; i++) rock.createInstance(`rock-${i}`);
  instrumentBabylon(gd, { engine, scene });
  const report = gd.render.inspectScene({ top: 5 });
  assert.deepEqual(inspectBabylon(engine, { top: 5 }).top_groups, report.top_groups);
  const shards = report.top_groups.find((g) => g.name === 'shard');
  assert.equal(shards.count, 30);
  assert.equal(shards.instancing_candidate, true);
  assert.equal(shards.material_per_mesh, true);
  const rocks = report.top_groups.find((g) => g.name === 'rock' && g.class === 'InstancedMesh');
  assert.equal(rocks.count, 25);
  assert.equal(rocks.instancing_candidate, false);
  assert.equal(report.scenes[0].instances, 25);
  assert.equal(report.scenes[0].level, 'meadow');
  assert.equal(report.babylon, B.Engine.Version);
});

test('session_start says which engine, nothing more', () => {
  const scene = world();
  instrumentBabylon(gd, { engine, scene });
  const start = gd.sessionStartEvent.call({ ...gd, device: () => ({ browser: 'Chrome', browser_version: '156.0.1', os: 'macOS', gpu: 'Apple M3 Max', gpu_tier: 'high', cores: 16 }) });
  assert.deepEqual(start.engine, { name: 'babylon', version: B.Engine.Version, renderer: 'headless' });
  assert.equal(start.device.gpu, undefined);
});
