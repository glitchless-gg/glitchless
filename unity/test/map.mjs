// Level maps (the Unity SDK's Glitchless.CaptureMap) for real: rendered in each pipeline, and taken in a WebGL build that
// sends them to a Glitchless server, whose heatmap query must put each death on what stood there.
//
//   node unity/test/map.mjs                          (npm run test:unity:map)
//   node unity/test/map.mjs --pipelines=builtin      (any of builtin, urp2d, urp3d; --pipelines= for none)
//   node unity/test/map.mjs --webgl=builtin          (the WebGL build's pipeline: urp2d, the default, or builtin; none skips it)
//   node unity/test/map.mjs --intake=http://127.0.0.1:7777   (the WebGL player sends there, to a server already running,
//                                                    such as `glitchless` in .claude/launch.json, instead of a fresh one)
//   node unity/test/map.mjs --pipelines= --probe=/tmp/…/Builds/map-probe   (plays a probe built before, without building)
//   UNITY=/path/to/Unity node unity/test/map.mjs
//
// 1. pipelines: the PlayMode MapCaptureTests (a 2D side view of sprites and a 3D level from above, each decoded and read
//    where the dashboard draws a point) in the built-in pipeline, in URP with its 2D renderer and in URP with its
//    Universal renderer, each on a copy of unity/ (URP added to the copies). The Editor runs with a graphics device (no
//    -nographics): nothing is rendered without one.
// 2. webgl: builds Assets/MapProbe as a WebGL player (SampleBuilder.BuildMapProbe; in URP's 2D renderer, as a Unity jam
//    platformer has it), plays it in headless Chromium on this Mac's GPU against a local Glitchless server, and checks
//    /v1/query/heatmap for its two levels: the map with its axis, bounds and size, the deaths on it, and the colour the
//    picture has where the dashboard draws each death. Prints each capture's cost, step by step, as the player measured it.
// The maps are kept in the temporary folder printed at the end, to look at.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { editorVersionOf, fitManifest } from './editor-packages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = path.join(ROOT, 'unity');
const VERSION = fs.readFileSync(path.join(PROJECT, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion: (\S+)/)[1];
const unity = process.env.UNITY || `/Applications/Unity/Hub/Editor/${VERSION}/Unity.app/Contents/MacOS/Unity`;
const editorVersion = unity.match(/Editor\/([^/]+)\//)?.[1] ?? 'custom';
// Another Editor (UNITY=…) gets copies without the Library and with its own packages (editor-packages.mjs).
const otherEditor = editorVersion !== VERSION;
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const pipelines = arg('pipelines', 'builtin,urp2d,urp3d').split(',').filter(Boolean);
const webgl = arg('webgl', 'urp2d');
const intakeGiven = arg('intake', null);
const probeGiven = arg('probe', null);
if (process.platform !== 'darwin') {
  console.error('This test runs the Editor and Chromium on macOS (Metal). Elsewhere, run MapCaptureTests in the Test Runner.');
  process.exit(2);
}
if (!fs.existsSync(unity)) {
  console.error(`Unity ${VERSION} not found at ${unity}. Install it or set UNITY=/path/to/Unity.`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unity-map-'));
const maps = path.join(tmp, 'maps');
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

function run(label, args, env = {}) {
  const log = path.join(tmp, `${label}.log`);
  return new Promise((resolve) => {
    const child = spawn(unity, [...args, '-logFile', log], { env: { ...process.env, ...env }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 1_800_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, log, text: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' });
    });
  });
}

// URP in a copy: the package (the Editor's own version; built into Unity 6.3, nothing to download) and a pipeline
// asset with the 2D or the Universal renderer, made as URP's own Create menu makes them (its helpers are internal, so
// through reflection), in linear colour space as URP projects are.
const URP_SETUP = `using System;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public static class MapUrpSetup
{
    public static void Use2D() => Use("_2DRenderer", AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("UnityEditor.Rendering.Universal.Renderer2DMenus")).First(t => t != null));
    public static void Use3D() => Use("UniversalRenderer", typeof(UniversalRenderPipelineAsset));

    static void Use(string type, Type maker)
    {
        System.IO.Directory.CreateDirectory("Assets/URP");
        var make = maker.GetMethod("CreateRendererAsset", BindingFlags.NonPublic | BindingFlags.Static);
        var kind = Enum.Parse(make.GetParameters()[1].ParameterType, type);
        var data = (ScriptableRendererData)make.Invoke(null, new object[] { "Assets/URP/Renderer.asset", kind, false, "Renderer" });
        var asset = UniversalRenderPipelineAsset.Create(data);
        AssetDatabase.CreateAsset(asset, "Assets/URP/URP.asset");
        GraphicsSettings.defaultRenderPipeline = asset;
        PlayerSettings.colorSpace = ColorSpace.Linear; // as URP projects have it (the built-in copy stays in gamma)
        AssetDatabase.SaveAssets();
        Debug.Log("[map] pipeline: " + GraphicsSettings.currentRenderPipeline + ", renderer " + data.GetType().Name + ", " + PlayerSettings.colorSpace + " colour space");
    }
}
`;

async function copyProject(name, pipeline) {
  const dir = path.join(tmp, name);
  // A clone of the folder (APFS: no space taken), Library too, so only what changes is imported again. Another Editor
  // imports everything again, with its own packages.
  const skip = otherEditor ? /[/\\](Library|Temp|Logs|Builds|UserSettings|obj)$/ : /[/\\](Temp|Logs|Builds|UserSettings|obj)$/;
  fs.cpSync(PROJECT, dir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (p) => !skip.test(p) });
  if (otherEditor) for (const change of fitManifest(dir, unity)) console.log(`${name}: ${change}`);
  if (pipeline !== 'builtin') {
    const manifest = path.join(dir, 'Packages/manifest.json');
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    m.dependencies['com.unity.render-pipelines.universal'] = editorVersionOf(unity, 'com.unity.render-pipelines.universal') ?? '17.3.0';
    fs.writeFileSync(manifest, JSON.stringify(m, null, 2));
    fs.writeFileSync(path.join(dir, 'Assets/Editor/MapUrpSetup.cs'), URP_SETUP);
    const r = await run(`${name}-setup`, ['-batchmode', '-nographics', '-quit', '-projectPath', dir, '-executeMethod', pipeline === 'urp2d' ? 'MapUrpSetup.Use2D' : 'MapUrpSetup.Use3D']);
    const said = r.text.match(/\[map\] pipeline: .*/)?.[0];
    if (r.code !== 0 || !said) throw new Error(`${name}: URP setup failed (log: ${r.log})`);
    console.log(`${name}: ${said.slice(6)}`);
  }
  return dir;
}

// The test runner's XML: each case's result, message and output.
function cases(xml) {
  return [...xml.matchAll(/<test-case [^>]*?\sname="([^"]+)"[^>]*?\sresult="([^"]+)"[\s\S]*?<\/test-case>/g)].map(([whole, name, result]) => ({
    name,
    result,
    message: whole.match(/<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/)?.[1],
    output: whole.match(/<output><!\[CDATA\[([\s\S]*?)\]\]><\/output>/)?.[1],
  }));
}

async function pipelineTests(pipeline) {
  const dir = await copyProject(pipeline, pipeline);
  const xml = path.join(tmp, `${pipeline}.xml`);
  const r = await run(pipeline, ['-batchmode', '-projectPath', dir, '-runTests', '-testPlatform', 'PlayMode', '-testFilter', 'GlitchlessSdk.Tests.MapCaptureTests', '-testResults', xml], { GLITCHLESS_MAP_DUMP: path.join(maps, pipeline) });
  const found = fs.existsSync(xml) ? cases(fs.readFileSync(xml, 'utf8')) : [];
  check(`${pipeline}: MapCaptureTests ran (log ${r.log})`, () => assert.ok(found.length >= 4, `${found.length} tests ran`));
  for (const c of found) {
    check(`${pipeline}: ${c.name}`, () => assert.equal(c.result, 'Passed', c.message));
    for (const line of (c.output || '').split('\n')) if (/^(2D|3D) map/.test(line)) console.log(`  ${pipeline}: ${line}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_OTLP: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serve(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The dashboard's toPx (apps/dashboard/src/heatmap.jsx), in the picture's own pixels: where it draws a death.
function toPx(axis, bounds, [w, h], d) {
  const a = d.x;
  const b = axis === 'xy' ? d.y : d.z;
  const x = ((a - bounds.min[0]) / (bounds.max[0] - bounds.min[0])) * w;
  const y = axis === 'xy' ? ((bounds.max[1] - b) / (bounds.max[1] - bounds.min[1])) * h : ((b - bounds.min[1]) / (bounds.max[1] - bounds.min[1])) * h;
  return [Math.floor(x), Math.floor(y)];
}

async function webglTest(pipeline) {
  let out = probeGiven && path.resolve(probeGiven);
  if (!out) {
    const dir = await copyProject(`webgl-${pipeline}`, pipeline);
    out = path.join(dir, 'Builds/map-probe');
    console.log(`webgl: building the map probe (${pipeline})…`);
    const t = Date.now();
    const built = await run(`webgl-${pipeline}-build`, ['-batchmode', '-nographics', '-quit', '-projectPath', dir, '-buildTarget', 'WebGL', '-executeMethod', 'SampleBuilder.BuildMapProbe'], { GLITCHLESS_BUILD_OUT: 'Builds/map-probe' });
    check(`webgl (${pipeline}): the probe builds`, () => assert.ok(built.code === 0 && fs.existsSync(path.join(out, 'index.html')), `Unity exited with ${built.code} (log ${built.log})`));
    console.log(`webgl: built in ${Math.round((Date.now() - t) / 1000)} s: ${out}`);
  }
  if (!fs.existsSync(path.join(out, 'index.html'))) return;

  const port = intakeGiven ? null : await freePort();
  const intake = intakeGiven || `http://127.0.0.1:${port}`;
  const server = intakeGiven ? null : await startServer(port, path.join(tmp, 'data'));
  const files = await serve(out);
  const { chromium } = await import('playwright');
  // Headless Chromium on the real GPU (ANGLE on Metal), as a player's browser draws.
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const lines = [];
    page.on('console', (m) => lines.push(m.text().trim()));
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no WebGL 2';
    });
    console.log(`webgl: Chromium ${browser.version()}, ${gpu}`);
    await page.goto(`http://127.0.0.1:${files.address().port}/index.html?intake=${encodeURIComponent(intake)}`);
    const started = Date.now();
    while (!lines.some((l) => l.includes('[map-probe] done')) && Date.now() - started < 180_000) await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(tmp, `webgl-${pipeline}.console.log`), lines.join('\n'));
    check(`webgl (${pipeline}): the probe ran to its end`, () => assert.ok(lines.some((l) => l.includes('[map-probe] done')), `no "[map-probe] done" in ${path.join(tmp, `webgl-${pipeline}.console.log`)}`));

    // What each capture cost, step by step (the SDK's debug line), and the frames around it.
    for (const level of ['probe-2d', 'probe-3d']) {
      const sdk = lines.find((l) => l.includes(`[glitchless] map of ${level}:`));
      const probe = lines.map((l) => l.match(/\[map-probe\] (\{.*\})/)?.[1]).filter(Boolean).map((j) => JSON.parse(j)).find((p) => p.level === level);
      if (sdk) console.log(`  webgl ${pipeline}: ${sdk.slice(sdk.indexOf('map of'))}`);
      if (probe) {
        const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
        console.log(`  webgl ${pipeline}: ${level} frames before ${median(probe.before_ms).toFixed(1)} ms median (longest ${Math.max(...probe.before_ms).toFixed(1)}), during the capture [${probe.during_ms.join(', ')}] ms`);
      }
      check(`webgl (${pipeline}): ${level} took its map over several frames`, () => {
        assert.ok(sdk, 'no "[glitchless] map of" line: no map was taken');
        assert.ok(probe?.sent, 'CaptureMap answered with no picture');
        assert.ok(probe.during_ms.length >= 3, `${probe.during_ms.length} frames`);
      });
    }

    // What the server keeps, and where the dashboard puts each death on it.
    const query = async (level) => {
      const qs = new URLSearchParams({ service: 'map-probe', from: String(started - 60_000), level });
      return (await fetch(`${intake}/v1/query/heatmap?${qs}`)).json();
    };
    const expected = {
      'probe-2d': { axis: 'xy', bounds: { min: [0, 0], max: [96, 18] }, size: [1024, 192], deaths: { spikes: [255, 0, 0], fell: [0, 0, 255] } },
      'probe-3d': { axis: 'xz', bounds: { min: [0, 0], max: [50, 30] }, size: [640, 384], deaths: { lava: [255, 0, 0], trap: [0, 0, 255] } },
    };
    for (const [level, want] of Object.entries(expected)) {
      let h = await query(level);
      for (let i = 0; i < 20 && !(h.map && h.deaths?.length >= 2); i++) {
        await new Promise((r) => setTimeout(r, 500));
        h = await query(level);
      }
      check(`webgl (${pipeline}): ${level}'s map is stored as the browser SDK's (axis, bounds, size)`, () => {
        assert.ok(h.map?.image?.startsWith('data:image/jpeg;base64,'), 'no map');
        assert.ok(h.map.image.length <= 60_000, `${h.map.image.length} characters`);
        assert.equal(h.axis, want.axis);
        assert.deepEqual(h.bounds, want.bounds);
        assert.deepEqual(h.map.size, want.size);
        assert.ok(h.density?.samples > 0, 'no path drawn');
      });
      if (!h.map?.image) continue;
      fs.mkdirSync(maps, { recursive: true });
      fs.writeFileSync(path.join(maps, `${level}-webgl-${pipeline}.jpg`), Buffer.from(h.map.image.split(',')[1], 'base64'));
      // The picture's colour where the dashboard draws each death, read in the browser.
      const points = h.deaths.map((d) => ({ cause: d.cause, px: toPx(h.axis, h.bounds, h.map.size, d) }));
      const colours = await page.evaluate(async ({ image, points }) => {
        const img = new Image();
        img.src = image;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return points.map((p) => ({ cause: p.cause, rgb: [...ctx.getImageData(p.px[0], p.px[1], 1, 1).data.slice(0, 3)] }));
      }, { image: h.map.image, points });
      check(`webgl (${pipeline}): ${level}'s deaths land on what stood there`, () => {
        assert.equal(colours.length, 2, `${colours.length} deaths`);
        for (const { cause, rgb } of colours) {
          const target = want.deaths[cause];
          assert.ok(target, `an unexpected death: ${cause}`);
          assert.ok(rgb.every((v, i) => Math.abs(v - target[i]) < 64), `${cause}: the map is rgb(${rgb}) where the dashboard draws it, not rgb(${target})`);
        }
      });
    }
  } finally {
    await browser.close();
    files.close();
    server?.kill();
  }
}

try {
  await Promise.all([...pipelines.map((p) => pipelineTests(p).catch((err) => results.push(['FAIL', p, err.message]))), webgl !== 'none' ? webglTest(webgl).catch((err) => results.push(['FAIL', 'webgl', err.message])) : null]);
} catch (err) {
  results.push(['FAIL', 'run', err.message]);
}

let failed = 0;
for (const [status, name, why] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${why ? `\n    ${why}` : ''}`);
  if (status !== 'ok') failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed (Unity ${editorVersion}; logs and maps in ${tmp})`);
process.exit(failed ? 1 : 0);
