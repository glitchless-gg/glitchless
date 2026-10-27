// What the browser SDK costs a game, measured in real Chrome (Playwright), for the "what Glitchless costs" page and
// anyone who wants to check it. It reports:
//   size     what a Three.js game adds to its download (esbuild, minified, gzip and brotli), and the full bundles
//   frame    the per-frame work (tick: a sketch insert and a few counters), the 5 s window summary and the 15 s batch
//            (JSON and gzip with the browser's CompressionStream), in a tight loop over realistic frame times
//   scene    a real three.js scene (400 meshes, one shadow-casting light) drawn for 1,200 frames per run without and
//            with Glitchless, five runs each, alternating: the main-thread time of each frame
//   network  60 s of that scene with Glitchless sending to a stand-in intake: requests and bytes on the wire
//   memory   the JavaScript heap after garbage collection: the scene alone, then after 60 s with Glitchless on
//
//   npm run build -w glitchless && node packages/sdk/bench/overhead.mjs [--quick]
// --quick skips the 60 s network and memory run. Needs Chrome installed; prints JSON and a summary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SDK, '../..');
const THREE = path.join(ROOT, 'node_modules/three/build/three.module.js');
const quick = process.argv.includes('--quick');
const kb = (n) => Math.round((n / 1024) * 10) / 10;

// ── size ──
const sizes = {};
for (const file of ['glitchless.esm.js', 'glitchless.js']) {
  const buf = fs.readFileSync(path.join(SDK, 'dist', file));
  sizes[file] = { raw_kb: kb(buf.length), gzip_kb: kb(zlib.gzipSync(buf, { level: 9 }).length), brotli_kb: kb(zlib.brotliCompressSync(buf).length) };
}
// What a Three.js game actually ships: only the core and the three.js adapter, tree-shaken.
const threeOnly = await build({ stdin: { contents: "export { Glitchless, instrumentThree } from './src/index.js';", resolveDir: SDK }, bundle: true, minify: true, format: 'esm', write: false });
const shaken = Buffer.from(threeOnly.outputFiles[0].contents);
sizes.three_game = { raw_kb: kb(shaken.length), gzip_kb: kb(zlib.gzipSync(shaken, { level: 9 }).length), brotli_kb: kb(zlib.brotliCompressSync(shaken).length) };

// ── the page: three.js, the SDK and a stand-in intake, all served from bench.test ──
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const intake = [];
await page.route('http://bench.test/**', async (route) => {
  const url = new URL(route.request().url());
  // three.module.js imports three.core.js beside it.
  if (/^\/three\.[a-z.]+\.js$/.test(url.pathname)) return route.fulfill({ body: fs.readFileSync(path.join(path.dirname(THREE), url.pathname.slice(1))), contentType: 'text/javascript' });
  if (url.pathname === '/glitchless.esm.js') return route.fulfill({ body: fs.readFileSync(path.join(SDK, 'dist/glitchless.esm.js')), contentType: 'text/javascript' });
  if (url.pathname === '/v1/intake') {
    intake.push({ at: Date.now(), bytes: route.request().postDataBuffer()?.length ?? 0 });
    return route.fulfill({ status: 202, body: '{}', contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
  }
  return route.fulfill({ body: '<!doctype html><title>bench</title><body style="margin:0"></body>', contentType: 'text/html' });
});
await page.goto('http://bench.test/');
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

// ── frame: the per-frame, per-window and per-batch work, in a tight loop ──
const frame = await page.evaluate(async () => {
  const { Glitchless } = await import('http://bench.test/glitchless.esm.js');
  const gd = new Glitchless({ service: 'bench', version: '1.0.0', intake: null });
  // Realistic frame times: mostly 16.7 ms with jitter, 2% slow (25 to 40 ms), 0.1% hitches (80 ms).
  const dts = Array.from({ length: 4096 }, (_, i) => (i % 1000 === 7 ? 80 : i % 50 === 3 ? 25 + (i % 16) : 16.7 + ((i * 7919) % 100) / 100 - 0.5));
  let t = performance.now();
  for (let i = 0; i < 200_000; i++) gd.tick((t += dts[i & 4095])); // warm up
  const N = 2_000_000;
  const a = performance.now();
  for (let i = 0; i < N; i++) gd.tick((t += dts[i & 4095]));
  const tickNs = ((performance.now() - a) / N) * 1e6;

  // A 5 s window at 60 fps is 300 frames: time closing 2,000 of them, with a level and a few events on each.
  const W = 2000;
  let closing = 0;
  gd.levelStart('level-2');
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < 300; i++) gd.tick((t += dts[(w * 300 + i) & 4095]));
    if (w % 5 === 0) gd.track('pickup', { item: 'coin', combo: w % 7 });
    const b = performance.now();
    gd.closeWindow();
    closing += performance.now() - b;
    if (gd.queue.length > 30) gd.queue.length = 0;
  }
  const windowUs = (closing / W) * 1000;

  // One 15 s batch: the session's events from three windows and a few of the game's own, as JSON then gzip.
  gd.queue.length = 0;
  for (let w = 0; w < 3; w++) {
    for (let i = 0; i < 900; i++) gd.tick((t += dts[i & 4095]));
    gd.track('pickup', { item: 'coin', combo: 3 });
    gd.track('enemy_spawned', { kind: 'drone', wave: 4 });
    gd.closeWindow();
  }
  const events = gd.queue.slice();
  const R = 200;
  let json = 0;
  let zip = 0;
  let raw = 0;
  let gz = 0;
  for (let r = 0; r < R; r++) {
    const b = performance.now();
    const body = JSON.stringify({ service: 'bench', env: 'prod', version: '1.0.0', session_id: 's_x', player_id: null, sdk: 'glitchless/x', batch_id: `b_${r}`, events });
    const c = performance.now();
    const out = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    zip += performance.now() - c;
    json += c - b;
    raw = body.length;
    gz = out.byteLength;
  }
  return { tick_ns: Math.round(tickNs * 10) / 10, window_us: Math.round(windowUs * 10) / 10, batch_json_us: Math.round((json / R) * 1000), batch_gzip_ms_async: Math.round((zip / R) * 100) / 100, batch_bytes: raw, batch_gzip_bytes: gz, batch_events: events.length };
});

// ── scene: the same three.js scene without and with Glitchless, three runs each ──
async function sceneRun(withSdk) {
  return page.evaluate(async (withSdk) => {
    const THREE = await import('http://bench.test/three.module.js');
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(960, 540);
    renderer.shadowMap.enabled = true;
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 960 / 540, 0.1, 200);
    camera.position.set(0, 18, 34);
    camera.lookAt(0, 0, 0);
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(10, 20, 10);
    light.castShadow = true;
    scene.add(light, new THREE.AmbientLight(0xffffff, 0.4));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2ee6a6 });
    const boxes = [];
    for (let i = 0; i < 400; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set((i % 20) * 2 - 19, 0.5, Math.floor(i / 20) * 2 - 19);
      m.castShadow = true;
      scene.add(m);
      boxes.push(m);
    }
    let gd = null;
    if (withSdk) {
      const { Glitchless, instrumentThree } = await import('http://bench.test/glitchless.esm.js');
      gd = new Glitchless({ service: 'bench', version: '1.0.0', intake: null });
      instrumentThree(gd, { renderer, scene, camera, THREE });
    }
    const work = [];
    await new Promise((done) => {
      let n = 0;
      const loop = () => {
        const a = performance.now();
        for (const b of boxes) b.rotation.y += 0.01;
        renderer.render(scene, camera);
        work.push(performance.now() - a);
        if (++n < 1300) requestAnimationFrame(loop);
        else done();
      };
      requestAnimationFrame(loop);
    });
    gd?.stop();
    renderer.dispose();
    const w = work.slice(100).sort((x, y) => x - y);
    const at = (q) => w[Math.floor(w.length * q)];
    return { p50_ms: Math.round(at(0.5) * 1000) / 1000, p95_ms: Math.round(at(0.95) * 1000) / 1000, mean_ms: Math.round((w.reduce((s, x) => s + x, 0) / w.length) * 1000) / 1000 };
  }, withSdk);
}
// Five runs each, the order swapped every time, so whatever comes second (a warmer GPU, a fuller heap) evens out.
const scene = { without: [], with: [] };
for (let r = 0; r < 5; r++) {
  for (const withSdk of r % 2 ? [true, false] : [false, true]) scene[withSdk ? 'with' : 'without'].push(await sceneRun(withSdk));
}
const median = (runs, k) => runs.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
const sceneSummary = {
  without: { p50_ms: median(scene.without, 'p50_ms'), p95_ms: median(scene.without, 'p95_ms'), mean_ms: median(scene.without, 'mean_ms') },
  with: { p50_ms: median(scene.with, 'p50_ms'), p95_ms: median(scene.with, 'p95_ms'), mean_ms: median(scene.with, 'mean_ms') },
  runs: scene,
};

// ── network and memory: 60 s of the scene with Glitchless sending to the stand-in intake ──
let network = null;
let memory = null;
if (!quick) {
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  // The scene first, drawing for 5 s without Glitchless; the heap then, and again after 60 s with it.
  await page.goto('http://bench.test/');
  await page.evaluate(async () => {
    const THREE = await import('http://bench.test/three.module.js');
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(960, 540);
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 960 / 540, 0.1, 200);
    camera.position.set(0, 18, 34);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 1));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2ee6a6 });
    for (let i = 0; i < 400; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set((i % 20) * 2 - 19, 0.5, Math.floor(i / 20) * 2 - 19);
      scene.add(m);
    }
    window.bench = { THREE, renderer, scene, camera, frames: 0, gd: null };
    const loop = () => {
      renderer.render(scene, camera);
      // One of the game's own events every 5 s at 60 fps, once Glitchless is on.
      if (++window.bench.frames % 300 === 0) window.bench.gd?.track('pickup', { item: 'coin' });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(5_000);
  const before = await heap();
  intake.length = 0;
  const started = Date.now();
  await page.evaluate(async () => {
    const { Glitchless, instrumentThree } = await import('http://bench.test/glitchless.esm.js');
    const { THREE, renderer, scene, camera } = window.bench;
    const gd = Glitchless.init({ service: 'bench', version: '1.0.0', intake: 'http://bench.test', clientToken: 'gl_pub_bench' });
    instrumentThree(gd, { renderer, scene, camera, THREE });
    gd.levelStart('level-1');
    window.bench.gd = gd;
  });
  await page.waitForTimeout(61_000);
  const after = await heap();
  const inMinute = intake.filter((r) => r.at - started <= 61_000);
  network = { seconds: 60, requests: inMinute.length, bytes: inMinute.reduce((s, r) => s + r.bytes, 0), per_request: inMinute.map((r) => r.bytes) };
  memory = { heap_before_kb: kb(before), heap_after_kb: kb(after), sdk_kb: kb(after - before) };
}
await browser.close();

const result = {
  measured: new Date().toISOString().slice(0, 10),
  machine: `${os.cpus()[0].model}, ${os.platform()} ${os.release()}`,
  chrome: browser.version(),
  gpu,
  sizes,
  frame,
  scene: sceneSummary,
  network,
  memory,
};
console.log(JSON.stringify(result, null, 2));
console.log(`\nA Three.js game adds ${sizes.three_game.gzip_kb} KB gzipped (${sizes.three_game.brotli_kb} KB brotli).`);
console.log(`Per frame: ${frame.tick_ns} ns. Every 5 s: ${frame.window_us} µs. Every 15 s: ${frame.batch_json_us} µs of JSON, ${frame.batch_bytes} bytes gzipped to ${frame.batch_gzip_bytes}.`);
console.log(`Scene frame (main thread), median of 5 runs: ${sceneSummary.without.mean_ms} ms without, ${sceneSummary.with.mean_ms} ms with (p95 ${sceneSummary.without.p95_ms} vs ${sceneSummary.with.p95_ms}).`);
if (network) console.log(`Network: ${network.requests} requests, ${kb(network.bytes)} KB in 60 s. JavaScript heap after GC: +${memory.sdk_kb} KB after a minute with Glitchless.`);
