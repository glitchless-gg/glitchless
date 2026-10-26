// The PlayCanvas adapter against a real PlayCanvas app on the engine's NullGraphicsDevice: the app's own loop, events,
// component systems, shader and texture lists, no GPU. Scene loading, asset failures and context loss are driven
// through the same registry calls and events PlayCanvas uses. The real game is checked in a browser by the demo
// (apps/playcanvas-demo).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5177', pathname: '/' };

// Imported without `window`, so PlayCanvas runs as it does outside a browser: app.tick() is driven by the test.
const pc = await import('playcanvas');
const { Glitchless, SDK_VERSION } = await import('../src/core.js');
const { instrumentPlayCanvas, inspectPlayCanvas } = await import('../src/playcanvas.js');

let gd;
let app;
let canvas;
let t;
beforeEach(() => {
  gd = new Glitchless({ service: 'spark-run', version: '1.0.0', intake: null });
  const listeners = new Map();
  canvas = {
    width: 320,
    height: 180,
    style: {},
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }),
    fire: (name) => listeners.get(name)?.({ preventDefault() {} }),
  };
  app = new pc.AppBase(canvas);
  const opts = new pc.AppOptions();
  opts.graphicsDevice = new pc.NullGraphicsDevice(canvas);
  opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem, pc.ScriptComponentSystem];
  opts.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler, pc.ScriptHandler];
  app.init(opts);
  const camera = new pc.Entity('camera');
  camera.addComponent('camera');
  camera.setPosition(0, 0, 10);
  app.root.addChild(camera);
  app.start();
  t = 1000;
});
afterEach(() => app.destroy());

// One PlayCanvas frame, `ms` after the last.
function tick(ms = 16.7) {
  t += ms;
  app.tick(t);
}

function busy(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms);
}

function box(name, material) {
  const e = new pc.Entity(name);
  e.addComponent('render', { type: 'box', material });
  app.root.addChild(e);
  return e;
}

test("frames come from the app's loop, split into update and render, with triangles counted at the device", () => {
  box('crate');
  instrumentPlayCanvas(gd, { app, pc });
  for (let i = 0; i < 10; i++) tick();
  assert.equal(gd.win.frames, 9, 'ten frames time nine');
  assert.equal(gd.win.triangles / gd.win.renderFrames, 12, 'a box is 12 triangles');
  assert.ok(gd.win.updateFrames > 0, 'frames are split into update and render time');
  assert.equal(gd.sdk, `glitchless-playcanvas/${SDK_VERSION}`);
  assert.deepEqual(gd.engine, { name: 'playcanvas', version: pc.version, renderer: 'headless' });
});

test('a slow frame is a hitch with the causes PlayCanvas saw', () => {
  instrumentPlayCanvas(gd, { app, pc });
  for (let i = 0; i < 3; i++) tick();
  const onUpdate = () => {
    const glow = new pc.StandardMaterial();
    glow.useLighting = false; // a material variant this app has not drawn yet: a new shader
    glow.emissive = new pc.Color(1, 0.6, 0.1);
    glow.update();
    for (let i = 0; i < 60; i++) box(`spark-${i}`, glow);
    busy(120);
  };
  app.once('update', onUpdate);
  tick();
  tick();
  const hitch = gd.pendingHitches[0];
  assert.ok(hitch, 'a hitch was recorded');
  gd.closeWindow();
  const sent = gd.queue.find((e) => e.type === 'hitch');
  for (const c of ['shader_compile', 'object_spawn', 'script']) assert.ok(sent.causes.includes(c), `${c} in ${sent.causes}`);
  assert.equal(sent.objects_added, 60);
  assert.ok(sent.shaders_compiled >= 1);
  assert.ok(sent.process_ms >= 119);
  assert.equal(sent.ctx.entities, 61);
  assert.equal(sent.ctx.mesh_instances, 60);
  const fw = gd.queue.find((e) => e.type === 'frame_window');
  assert.ok(fw.process_ms != null, 'frame windows carry update time');
  assert.equal(fw.programs, app.graphicsDevice.shaders.length);
});

test('editor scenes become levels; menus and overlays do not', () => {
  instrumentPlayCanvas(gd, { app, pc });
  // What SceneRegistry does once a scene's file is loaded, without the file.
  app.scenes._loadSceneHierarchy = (item, before, callback) => callback(null, app.root);
  app.scenes.add('MainMenu', 'menu.json');
  app.scenes.add('Level1', 'level1.json');
  app.scenes.add('HUD', 'hud.json');
  app.scenes.changeScene('MainMenu');
  assert.equal(gd.level, null);
  let called = false;
  app.scenes.changeScene('Level1', (err) => (called = !err));
  assert.equal(called, true, "the game's own callback still runs");
  assert.equal(gd.level, 'Level1');
  app.scenes.loadSceneHierarchy('HUD');
  assert.equal(gd.level, 'Level1', 'an overlay loaded on top is not a level');
  app.scenes.changeScene('level1.json'); // by URL: a restart
  app.scenes.changeScene('MainMenu');
  assert.equal(gd.level, null, 'back to the menu: no level');
  const starts = gd.queue.filter((e) => e.type === 'level_start').map((e) => e.level);
  assert.deepEqual(starts, ['Level1', 'Level1']);
  gd.levelStart('wave-2', { heat: 2 }); // the game's own call takes over, with its attributes
  assert.deepEqual(gd.queue.filter((e) => e.type === 'level_start').at(-1).attrs, { heat: 2 });
  // The frame after a load pays for what it shows; it is closed (and read for a hitch) when the next one starts.
  tick();
  tick();
  assert.ok(gd.render.hitchDetail(200).causes.includes('scene_change'));
  tick();
  assert.ok(!gd.render.hitchDetail(200).causes.includes('scene_change'), 'and only that frame');
});

test('failed asset loads, script errors and context loss are reported', () => {
  instrumentPlayCanvas(gd, { app, pc });
  const sky = new pc.Asset('sky', 'texture', { url: 'https://cdn.example.com/art/sky.png?token=abc' });
  app.assets.add(sky);
  app.assets.fire('error', 'Error loading Texture from: sky.png', sky);
  // The debug build catches a script's error, turns the script off and fires 'error' on its script component.
  const player = new pc.Entity('player');
  player.addComponent('script');
  app.root.addChild(player);
  const err = new TypeError("Cannot read properties of undefined (reading 'seconds')");
  player.script.fire('error', { __scriptType: { __name: 'collector' } }, err, 'update');
  canvas.fire('webglcontextlost');
  const errors = gd.queue.filter((e) => e.type === 'error');
  assert.deepEqual(
    errors.map((e) => e.kind),
    ['asset', 'js', 'webgl_context_lost'],
  );
  assert.equal(errors[0].message, 'Failed to load texture "sky": sky.png');
  assert.doesNotMatch(JSON.stringify(errors[0]), /token=abc/, 'anonymous mode keeps query strings out');
  assert.deepEqual(errors[1].attrs, { script: 'collector', method: 'update', script_disabled: true });
  assert.match(errors[1].message, /^TypeError: Cannot read properties of undefined/);
});

test('inspectScene groups entities and flags copies that should be instanced and share a material', () => {
  instrumentPlayCanvas(gd, { app, pc });
  const device = app.graphicsDevice;
  for (let i = 0; i < 30; i++) {
    const e = new pc.Entity(`spark-${i}`);
    const mesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry({ halfExtents: new pc.Vec3(0.1, 0.1, 0.1) }));
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, new pc.StandardMaterial())] });
    app.root.addChild(e);
  }
  const shared = new pc.StandardMaterial();
  for (let i = 0; i < 25; i++) box(`coin-${i}`, shared);
  tick();
  const report = gd.render.inspectScene({ top: 5 });
  assert.deepEqual(inspectPlayCanvas(app, { top: 5, version: pc.version }).top_groups, report.top_groups);
  const sparks = report.top_groups.find((g) => g.name === 'spark');
  assert.equal(sparks.count, 30);
  assert.equal(sparks.instancing_candidate, true);
  assert.equal(sparks.material_per_entity, true);
  const coins = report.top_groups.find((g) => g.name === 'coin');
  assert.equal(coins.count, 25);
  assert.equal(coins.instancing_candidate, false, 'box renders share one mesh');
  assert.equal(coins.material_per_entity, false);
  assert.equal(report.entities, 56);
  assert.equal(report.playcanvas, pc.version);
});

test('session_start says which engine, nothing more', () => {
  instrumentPlayCanvas(gd, { app, pc });
  const start = gd.sessionStartEvent.call({ ...gd, device: () => ({ browser: 'Chrome', browser_version: '156.0.1', os: 'macOS', gpu: 'Apple M3 Max', gpu_tier: 'high', cores: 16 }) });
  assert.deepEqual(start.engine, { name: 'playcanvas', version: pc.version, renderer: 'headless' });
  assert.equal(start.device.gpu, undefined);
});
