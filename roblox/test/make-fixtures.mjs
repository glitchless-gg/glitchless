// Writes the fixture the Roblox SDK's Luau is checked against: frame times with the sketch packages/sdk/src/sketch.js
// makes of them, error fingerprints and normalized messages from fingerprint.js, and match IDs hashed as groups.js
// hashes them.
//   node roblox/test/make-fixtures.mjs
//
// roblox/test/sketch.test.luau and errors.test.luau (run under Lune: `lune run roblox/test/run`) compare the Luau
// ports with it, so a Roblox server and a browser or Unity client merge one sketch and group one issue.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';
import { hashGroupId } from '../../packages/sdk/src/groups.js';
import { looksIdentifying, propKeyProblem, propValue } from '../../packages/sdk/src/props.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'fixtures/js-fixture.json');

// The Godot fixture's frame times: mostly smooth 60 Hz frames, one in forty a stutter, plus edge values.
const values = JSON.parse(fs.readFileSync(path.join(ROOT, 'godot/test/fixtures/sketch.json'), 'utf8')).values;
const sk = new Sketch();
for (const v of values) sk.add(v);
const quantiles = Object.fromEntries([0.1, 0.5, 0.9, 0.95, 0.99].map((q) => [String(q), sk.quantile(q)]));
// A round trip sketch, as frame_window.net sends it (5%).
const rtt = new Sketch(0.05);
for (const v of [38, 41, 40, 39, 120, 44, 43, 0.5, 0.99, 1000]) rtt.add(v); // 0.99: bucket -0, which JavaScript writes "0"

const errors = [
  ['script', "attempt to index nil with 'Humanoid'", 'Race.onTouched'],
  ['script', 'Checkpoint 12345 missing at 0x7ffe12ab', 'Checkpoints'],
  ['manual', 'Uncaught DataStore request dropped 0X1234abcd and 0xZZ', ''],
  ['script', 'émoji 🐶 broke', 'Shop.buy'],
  ['script', 'a'.repeat(199) + '🐶 JavaScript cuts this dog in half at 200 UTF-16 units', 'Long.run'],
  ['manual', '日本語のエラー 1234', 'Lobby'],
];

const props = ['gold', '  Gold Tier  ', 'player@example.com', 'https://x.io', 'www.roblox.com', '5551234567', '555-123-4567', '(555) 123-4567', '+44 20 7946 0958', '3000-3499', 'summer_2026', 'corpse_explosion', 'e7c4c6a2-5b0e-4f7e-9a51-1b2c3d4e5f60', 'deadbeefdeadbeef', 'aZ9kLmP0qRsTuVwX', 'a'.repeat(80)];
const keys = ['rank', 'Rank', 'car_class', 'level', 'user_id', 'name', 'x'.repeat(33), '9lives', 'region'];

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const fixture = {
  note: 'Written by roblox/test/make-fixtures.mjs from the JavaScript SDK. Do not edit by hand.',
  values,
  sketch: sk.toJSON(),
  quantiles,
  fraction_above_19_17: sk.fractionAbove(19.17),
  indexes: values.filter((v) => v >= 1e-3).slice(0, 200).map((v) => [v, sk.index(v)]),
  rtt: rtt.toJSON(),
  // A message cut in the middle of an emoji leaves half of it, which JSON readers refuse: its normalized text is left out.
  fingerprints: errors.map(([kind, message, fn]) => ({ kind, message, fn, normalized: LONE_SURROGATE.test(normalizeMessage(message)) ? null : normalizeMessage(message), fingerprint: fingerprint(kind, message, fn) })),
  groups: [
    ['zoomies', 'm_8f2c91d04ab7'],
    ['Nardo-Racing', 'race-2026-11-06-0042'],
    ['glitchless.gg', 'e7c4c6a2-5b0e-4f7e-9a51-1b2c3d4e5f60'],
  ].map(([service, id]) => ({ service, id, hashed: hashGroupId(service, id) })),
  props: props.map((v) => ({ value: v, identifying: looksIdentifying(v.trim().slice(0, 64)), sent: propValue(v) ?? null })),
  keys: keys.map((k) => ({ key: k, ok: propKeyProblem(k) === null })),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1) + '\n');
console.log(`wrote ${path.relative(ROOT, OUT)}: ${values.length} values, ${Object.keys(fixture.sketch.b).length} buckets, ${errors.length} fingerprints, ${fixture.groups.length} group IDs, ${props.length} property values`);
