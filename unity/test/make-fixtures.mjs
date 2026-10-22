// Writes the fixture the Unity SDK's EditMode tests check its C# ports against: frame times with the
// sketch packages/sdk/src/sketch.js makes of them, and error fingerprints from fingerprint.js.
//   node unity/test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';

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
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${values.length} values, ${Object.keys(sk.toJSON().b).length} buckets, ${errors.length} fingerprints`);
