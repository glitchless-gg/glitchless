// Writes the fixture the Unreal plugin's core tests check their C++ ports against: frame times with
// the sketch packages/sdk/src/sketch.js makes of them (as JSON.stringify writes it, byte for byte),
// V8's Math.log for the values the sketch buckets, numbers as JSON.stringify writes them, error
// fingerprints from fingerprint.js, and what device.js makes of browsers' user agents and GPUs (a web build
// reads its page the same way, Private/Core/GlitchlessPage.cpp).
//   node unreal/test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';
import { parseUserAgent, isSteamDeck, cleanGpu, cleanVendor, classifyGpu } from '../../packages/sdk/src/device.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'unreal/test/fixtures/js-fixture.json');

// A seeded generator, so the fixture only changes when the JavaScript does.
let seed = 0x9e3779b9;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const bits = (v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return b.toString('hex');
};

function sketchOf(values) {
  const sk = new Sketch();
  for (const v of values) sk.add(v);
  return {
    json: JSON.stringify(sk.toJSON()),
    quantiles: Object.fromEntries([0, 0.1, 0.5, 0.9, 0.95, 0.99, 1].map((q) => [String(q), sk.quantile(q)])),
    fraction_above: [8.33, 16.67, 19.17, 33.4, 50].map((t) => [t, sk.fractionAbove(t)]),
  };
}

// The Godot and Unity fixtures' frame times: mostly smooth 60 Hz frames, one in forty a stutter, plus edge values.
const godot = JSON.parse(fs.readFileSync(path.join(ROOT, 'godot/test/fixtures/sketch.json'), 'utf8')).values;

// More frame times: a 120 Hz game with hitches, sub-millisecond frames (negative buckets), and long freezes.
const fast = Array.from({ length: 2000 }, () => (random() < 0.03 ? 50 + random() * 400 : 8.33 * (0.8 + random() * 0.4)));
const tiny = Array.from({ length: 600 }, () => random() * 2);
const wide = Array.from({ length: 1500 }, () => Math.exp(random() * 22 - 7)); // 0.0009 ms to 3.6e6 ms
const edges = [0, 1e-4, 9.99e-4, 1e-3, 0.001000001, 1, 1.02, 1.0408163265306123, 16.666666666666668, 16.7, 33.333333333333336, 50, 50.00000000000001, 700, 1e6];

const sets = { godot, fast, tiny, wide, edges };
const sketches = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, { values: v, ...sketchOf(v) }]));

// V8's logarithm, bit for bit: the sketch's bucket is ceil(log(v) / log(gamma)).
// (The sketches above check the frame times' own buckets.)
const logInputs = [
  ...Array.from({ length: 6000 }, () => Math.exp(random() * 1400 - 700)),
  ...Array.from({ length: 1500 }, () => 1 + (random() - 0.5) * 1e-5), // near 1, where fdlibm takes its other path
  5e-324, 2.2250738585072014e-308, 1e-310, 0.5, 2, 4, 1024, 1.7976931348623157e308, (1 + 0.02) / (1 - 0.02),
];
const logs = logInputs.map((v) => [bits(v), bits(Math.log(v))]);

const numbers = [
  0, -0, 1, -1, 0.02, 16.78, 16.67, 1 / 3, 0.1 + 0.2, 123.456, 1e15, 1e15 + 0.5, 1e21, 1.5e21, 1e-6, 1e-7, 1.234e-9, 5e-324,
  1.7976931348623157e308, 1761000000000, 9007199254740993, 0.000123, 100, 2.5, -13.199039246309592, 12345678.9, 1e20, 123e18,
].map((v) => [bits(v), JSON.stringify(v)]);

// Math.round(v * 10^d) / 10^d, the rounding every SDK uses.
const roundInputs = [16.785, 16.775, 0.125, 0.135, 1.005, 2.675, -2.5, -0.005, 0.49999999999999994, 123.4549999, 1e-9, 99.995, 7.538847794792585];
const rounds = roundInputs.flatMap((v) => [0, 1, 2].map((d) => [bits(v), d, bits(Math.round(v * 10 ** d) / 10 ** d)]));

const errors = [
  ['exception', 'NullReferenceException: Object reference not set to an instance of an object', 'Player.Update'],
  ['log_error', 'Enemy 12345 lost its target at 0x7ffe12ab', 'Enemy.Think'],
  ['manual', 'Uncaught Save failed: disk full', ''],
  ['exception', 'KeyNotFoundException: The given key ‘frisbee’ was not present in the dictionary.', 'Fetch.Game.CatchToy'],
  ['js', 'TypeError: émoji 🐶 broke', 'spawn'],
  ['ensure', 'Ensure condition failed: Health > 0 [File:D:\\Game\\Source\\Game\\HealthComponent.cpp] [Line: 120]', 'UHealthComponent::ApplyDamage'],
  ['script', 'Accessed None trying to read property CallFunc_GetPlayerCharacter_ReturnValue. Node:  Set Health Graph:  EventGraph Function:  Execute Ubergraph BP Enemy Blueprint:  BP_Enemy', 'BP_Enemy_C.ExecuteUbergraph_BP_Enemy'],
  ['crash', 'Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000028', 'AMyCharacter::Tick'],
  ['log_error', 'X'.repeat(150) + '😀'.repeat(40), 'Long.Message'],
  ['log_error', 'Uncaught   \tspaces 0X1F 0x 00 007 1234567 0xGG', ''],
];

// Browsers as players have them, with userAgentData's mobile where Chromium gives it (null: none): the Unity
// fixture's list (unity/test/make-fixtures.mjs). Edge and Opera say Chrome/ before their own names, and every iOS
// browser says Safari/: the browser SDK goes by its rules' order, not the leftmost name, and the C++ port must too.
const agents = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', null],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0', false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15', null],
  ['Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', null],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', true],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0', true],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/92.0.0.0', true],
  ['Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36', true],
  ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', null],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', false],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', null],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36', null],
  ['Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1', null],
  ['Mozilla/5.0 Edg/ Edge/x EdgA/7a Chrome/ Version/ Safari/', null],
  ['', null],
];
const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const decks = [
  [linuxChrome, 'AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)'],
  [linuxChrome, 'ANGLE (AMD, AMD Custom GPU 0932, OpenGL 4.6)'],
  [linuxChrome, 'AMD Radeon RX 7800 XT'],
  [linuxChrome, 'AMD Custom GPU 04050 (not one)'],
  [linuxChrome, 'vangoghx'],
  ['Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1', ''],
  ['Mozilla/5.0 (X11; Linux x86_64) Steam Deck', ''],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Radeon R9 200 Series, or similar'],
];
// GPUs as a WebGL context names them (the unmasked vendor and renderer): ANGLE's wrappers on each OS, phones,
// software renderers, and odd ones.
const gpus = [
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Google)', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'],
  ['Google Inc. (Qualcomm)', 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)'],
  ['Google Inc. (ARM)', 'ANGLE (ARM, Mali-G78, OpenGL ES 3.2)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11-27.21.14.5671)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, Apple M2 (0xABCDEF) vs_5_0 OpenGL thing)'],
  ['Google Inc.', 'ANGLE (Vendor, , x)'],
  ['', 'ANGLE ()'],
  ['', 'ANGLE (only)'],
  ['Apple Inc.', 'Apple GPU'],
  ['ARM', 'Mali-G57'],
  ['Qualcomm', 'Adreno (TM) 650'],
  ['AMD', 'AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)'],
  ['NVIDIA Corporation', 'NVIDIA GeForce GTX 1060/PCIe/SSE2'],
  ['Intel Inc.', 'Intel Iris OpenGL Engine'],
  ['Mozilla', 'Mozilla'],
  ['', ''],
  ['', '  spaced name  '],
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      note: 'Written by unreal/test/make-fixtures.mjs from the JavaScript SDK. Do not edit by hand.',
      sketches,
      indexes: godot.filter((v) => v >= 1e-3).map((v) => [v, new Sketch().index(v)]),
      logs,
      numbers,
      rounds,
      fingerprints: errors.map(([kind, message, fn]) => ({ kind, message, fn, normalized: normalizeMessage(message), fingerprint: fingerprint(kind, message, fn) })),
      user_agents: agents.map(([ua, mobile]) => {
        const r = parseUserAgent({ userAgent: ua, userAgentData: mobile == null ? undefined : { mobile } });
        return { ua, uad_mobile: mobile, browser: r.browser, browser_version: r.browserVersion, os: r.os, mobile: r.mobile };
      }),
      steam_decks: decks.map(([ua, gpu]) => ({ ua, gpu, steam_deck: isSteamDeck({ userAgent: ua, gpu }) })),
      gpus: gpus.map(([vendor, renderer]) => {
        const name = cleanGpu(renderer);
        return { vendor, renderer, name, gpu_vendor: cleanVendor(vendor, renderer), tier: classifyGpu(name) };
      }),
    },
  ) + '\n',
);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(sketches).length} sketches, ${logs.length} logarithms, ${numbers.length} numbers, ${errors.length} fingerprints, ${agents.length} user agents, ${decks.length} Steam Deck checks, ${gpus.length} GPUs`);
