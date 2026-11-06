// Writes the fixture the Unity SDK's EditMode tests check its C# ports against: frame times with the
// sketch packages/sdk/src/sketch.js makes of them, error fingerprints from fingerprint.js, and what device.js makes
// of browsers' user agents and GPUs (a Unity web build reads its page the same way, Runtime/WebPage.cs).
//   node unity/test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';
import { parseUserAgent, isSteamDeck } from '../../packages/sdk/src/device.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'unity/Packages/gg.glitchless.sdk/Tests/Editor/Fixtures/js-fixture.json');

// The Godot fixture's frame times: mostly smooth 60 Hz frames, one in forty a stutter, plus edge values.
const values = JSON.parse(fs.readFileSync(path.join(ROOT, 'godot/test/fixtures/sketch.json'), 'utf8')).values;
const sk = new Sketch();
for (const v of values) sk.add(v);
const quantiles = Object.fromEntries([0.1, 0.5, 0.9, 0.95, 0.99].map((q) => [String(q), sk.quantile(q)]));

const errors = [
  ['exception', "NullReferenceException: Object reference not set to an instance of an object", 'Player.Update'],
  ['log_error', 'Enemy 12345 lost its target at 0x7ffe12ab', 'Enemy.Think'],
  ['manual', 'Uncaught Save failed: disk full', ''],
  ['exception', 'KeyNotFoundException: The given key ‘frisbee’ was not present in the dictionary.', 'Fetch.Game.CatchToy'],
  ['js', 'TypeError: émoji 🐶 broke', 'spawn'],
];

// Browsers as players have them, with userAgentData's mobile where Chromium gives it (null: none). Edge and Opera say
// Chrome/ before their own names, and every iOS browser says Safari/: the browser SDK goes by its rules' order, not the
// leftmost name, and the C# port must too. Samsung Internet, Android's web view and headless Chrome are Chrome.
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
  ['', null],
];
const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const decks = [
  [linuxChrome, 'AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.5.0-valve22-1-neptune-65)'],
  [linuxChrome, 'ANGLE (AMD, AMD Custom GPU 0932, OpenGL 4.6)'],
  [linuxChrome, 'AMD Radeon RX 7800 XT'],
  ['Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1', ''],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Radeon R9 200 Series, or similar'],
];

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      note: 'Written by unity/test/make-fixtures.mjs from the JavaScript SDK. Do not edit by hand.',
      values,
      sketch: sk.toJSON(),
      quantiles,
      fraction_above_19_17: sk.fractionAbove(19.17),
      indexes: values.filter((v) => v >= 1e-3).slice(0, 200).map((v) => [v, sk.index(v)]),
      fingerprints: errors.map(([kind, message, fn]) => ({ kind, message, fn, normalized: normalizeMessage(message), fingerprint: fingerprint(kind, message, fn) })),
      user_agents: agents.map(([ua, mobile]) => {
        const r = parseUserAgent({ userAgent: ua, userAgentData: mobile == null ? undefined : { mobile } });
        return { ua, uad_mobile: mobile, browser: r.browser, browser_version: r.browserVersion, os: r.os, mobile: r.mobile };
      }),
      steam_decks: decks.map(([ua, gpu]) => ({ ua, gpu, steam_deck: isSteamDeck({ userAgent: ua, gpu }) })),
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${values.length} values, ${Object.keys(sk.toJSON().b).length} buckets, ${errors.length} fingerprints, ${agents.length} user agents, ${decks.length} GPUs`);
