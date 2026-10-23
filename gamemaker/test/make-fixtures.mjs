// Writes the fixture the GameMaker SDK's GML is checked against: frame times with the sketch packages/sdk/src/sketch.js
// makes of them, and error fingerprints and normalized messages from fingerprint.js.
//   node gamemaker/test/make-fixtures.mjs
//
// core.test.mjs checks the GML (run in Node) against it. The same file goes into the project's Included Files
// (datafiles/glitchless_fixture.json), and the demo's -glitchless-selftest flag makes a real GameMaker run compute the
// same sketch and fingerprints and write them to its save area, which e2e.mjs compares: that catches a runner whose
// ln() or string functions differ from JavaScript's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { fingerprint, normalizeMessage } from '../../packages/sdk/src/fingerprint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = [path.join(HERE, 'fixtures/js-fixture.json'), path.join(HERE, '../datafiles/glitchless_fixture.json')];

// The Godot fixture's frame times: mostly smooth 60 Hz frames, one in forty a stutter, plus edge values.
const values = JSON.parse(fs.readFileSync(path.join(ROOT, 'godot/test/fixtures/sketch.json'), 'utf8')).values;
const sk = new Sketch();
for (const v of values) sk.add(v);
const quantiles = Object.fromEntries([0.1, 0.5, 0.9, 0.95, 0.99].map((q) => [String(q), sk.quantile(q)]));

const errors = [
  ['crash', 'Variable <unknown_object>.target(100012, -2147483648) not set before reading it.', 'obj_demo.Step_0'],
  ['crash', 'Unable to find instance for object index 7', 'bonus_pay'],
  ['manual', 'Uncaught   save slot 12345 unreadable at 0x7ffe12ab', 'load_save'],
  ['manual', 'hex 0X1234abcd and 0xZZ and 0x', ''],
  ['crash', 'émoji 🐶 broke', 'spawn'],
  ['crash', 'a'.repeat(199) + '🐶 JavaScript cuts this dog in half at 200 UTF-16 units', 'obj_long.Draw_0'],
  ['crash', 'Variable obj_enemy.hp(100045, -2147483648) not set before reading it. '.repeat(4), 'obj_enemy.Step_0'],
  ['manual', '日本語のエラー 1234', 'gml_Script_anon'],
];

const fixture = {
  note: 'Written by gamemaker/test/make-fixtures.mjs from the JavaScript SDK. Do not edit by hand.',
  values,
  sketch: sk.toJSON(),
  quantiles,
  fraction_above_19_17: sk.fractionAbove(19.17),
  indexes: values.filter((v) => v >= 1e-3).slice(0, 200).map((v) => [v, sk.index(v)]),
  fingerprints: errors.map(([kind, message, fn]) => ({ kind, message, fn, normalized: normalizeMessage(message), fingerprint: fingerprint(kind, message, fn) })),
};
for (const out of OUT) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
  console.log(`wrote ${path.relative(ROOT, out)}: ${values.length} values, ${Object.keys(fixture.sketch.b).length} buckets, ${errors.length} fingerprints`);
}
