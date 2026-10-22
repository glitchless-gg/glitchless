// Frame windows against levels, the frame budget, and what the Three.js adapter says a hitch was. Found by
// the Glitch Arcade demos (a tower defense game, an arena shooter, a racer): 6-second tower-defense waves
// handed their frames to the next wave, and Three.js hitches came back without a cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5178', pathname: '/' };

const { Glitchless } = await import('../src/core.js');
const { instrumentThree } = await import('../src/three.js');

// Made without `window`, so the core skips its own requestAnimationFrame loop and timers: the test drives
// tick() itself.
function sdk() {
  return new Glitchless({ service: 'frames', version: '1.0.0', intake: null });
}

function play(gd, t, frames, ms = 16.7, during = () => {}) {
  for (let i = 0; i < frames; i++) {
    gd.tick((t += ms));
    during(i);
  }
  return t;
}

const windows = (gd) => gd.queue.filter((e) => e.type === 'frame_window');

test("a level start closes the frame window, so a short level keeps its own frames", () => {
  const gd = sdk();
  gd.levelStart('wave-8');
  let t = play(gd, 1000, 100);
  gd.levelStart('wave-9'); // 1.7 s into the window: before, these frames went to wave-9
  t = play(gd, t, 50);
  gd.closeWindow();
  const [a, b] = windows(gd);
  assert.equal(a.level, 'wave-8');
  assert.equal(a.frames, 99); // the first tick only starts the clock
  assert.equal(b.level, 'wave-9');
  assert.equal(b.frames, 50);
});

test('positions sampled on a level go with that level', () => {
  const gd = sdk();
  gd.positionsOn = true;
  gd.levelStart('round-1');
  gd.setPosition({ x: 1, y: 0, z: 2 });
  gd.samplePosition();
  gd.levelStart('round-2');
  gd.setPosition({ x: 5, y: 0, z: 5 });
  gd.samplePosition();
  gd.closeWindow();
  const pos = gd.queue.filter((e) => e.type === 'pos');
  assert.deepEqual(
    pos.map((p) => [p.level, p.pts.length]),
    [
      ['round-1', 1],
      ['round-2', 1],
    ],
  );
});

test('a busy start does not set a 30 Hz budget for the whole session', () => {
  const gd = sdk();
  // Shader compiles and loading: most early frames take two refreshes, some only one.
  let t = play(gd, 1000, 121, 33.3);
  assert.equal(gd.hz, 30); // nothing faster seen yet
  const mixed = sdk();
  let m = 1000;
  for (let i = 0; i < 121; i++) mixed.tick((m += i % 3 === 0 ? 16.7 : 33.3));
  assert.equal(mixed.hz, 60, 'a third of the frames at 16.7 ms is a 60 Hz display');
  // Later the game settles at 60 fps: the budget follows, and a slow stretch afterwards doesn't lower it.
  t = play(gd, t, 480, 16.7);
  assert.equal(gd.hz, 60);
  assert.ok(Math.abs(gd.budgetMs - 16.67) < 0.01);
  play(gd, t, 960, 33.3);
  assert.equal(gd.hz, 60);
});

test('a 120 Hz display gets an 8.3 ms budget', () => {
  const gd = sdk();
  play(gd, 1000, 121, 8.33);
  assert.equal(gd.hz, 120);
});

// A WebGL context with the calls three.js makes, and a renderer around it.
function fakeRenderer() {
  const noop = () => {};
  const gl = { texImage2D: noop, texSubImage2D: noop, texImage3D: noop, texSubImage3D: noop, compressedTexImage2D: noop, compressedTexSubImage2D: noop, bufferData: noop, bufferSubData: noop, linkProgram: noop };
  return {
    gl,
    info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] },
    getContext: () => gl,
    domElement: null,
    render() {},
  };
}

function threeSdk() {
  const gd = sdk();
  const renderer = fakeRenderer();
  instrumentThree(gd, { renderer, scene: {}, camera: {} });
  return { gd, renderer, gl: renderer.gl };
}

const canvas = { width: 128, height: 16 };

test('a Three.js hitch while a swarm uploads its health bars is a texture_upload', () => {
  const { gd, gl, renderer } = threeSdk();
  let t = play(gd, 1000, 60);
  // The frame that hitches: 120 canvas textures uploaded (three.js on WebGL2: texSubImage2D with a source).
  for (let i = 0; i < 120; i++) gl.texSubImage2D(3553, 0, 0, 0, 6408, 5121, canvas);
  renderer.render({}, {});
  gd.tick((t += 140));
  const [h] = gd.pendingHitches;
  assert.ok(h, 'a hitch');
  assert.ok(h._engine.causes.includes('texture_upload'), `causes: ${h._engine.causes}`);
  assert.equal(h._engine.fields.textures_uploaded, 120);
  assert.equal(h._engine.fields.texture_mpx, 0.25);
});

test('shader links and geometry buffers in the hitched frame are named; the frame before is not counted', () => {
  const { gd, gl } = threeSdk();
  let t = play(gd, 1000, 60);
  for (let i = 0; i < 300; i++) gl.bufferData(34962, new Float32Array(64), 35044); // an earlier frame's uploads
  t = play(gd, t, 1);
  gl.linkProgram({});
  gl.linkProgram({});
  for (let i = 0; i < 40; i++) gl.bufferData(34962, new Float32Array(300), 35044);
  gd.tick((t += 400));
  const { causes, fields } = gd.pendingHitches[0]._engine;
  assert.deepEqual(causes, ['shader_compile', 'geometry_upload']);
  assert.equal(fields.programs_linked, 2);
  assert.equal(fields.buffers_uploaded, 40);
  assert.equal(fields.textures_uploaded, 0);
});

test('a slow frame with nothing uploaded has no engine cause', () => {
  const { gd, gl } = threeSdk();
  let t = play(gd, 1000, 60);
  gl.texSubImage2D(3553, 0, 0, 0, 6408, 5121, canvas); // one HUD texture redrawn: normal
  gd.tick((t += 120));
  assert.deepEqual(gd.pendingHitches[0]._engine.causes, []);
});
