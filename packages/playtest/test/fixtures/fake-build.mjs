// A stand-in for an engine build with the Glitchless SDK: it answers --glitchless-measure=SECONDS the way the
// Godot addon does, from the real Godot fixture, changed by --mode=NAME (one of the cases below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.replace(/^-+/, '').startsWith(`${name}=`))?.split('=').slice(1).join('=');
const mode = flag('mode') || 'ok';
const seconds = Number(flag('glitchless-measure'));
const out = flag('glitchless-out');
const godot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'godot.txt'), 'utf8');
const line = godot.split('\n').find((l) => l.startsWith('{"glitchless_measure"'));
const m = JSON.parse(line).glitchless_measure;
m.seconds = seconds;
m.headless = false;
m.args = args; // so a test can see what the build was started with

console.log('Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org');
if (mode === 'menu') m.level_start = m.level_end = null;
if (mode === 'slow') m.process_ms = { p50: m.process_ms.p50 + 6, p95: m.process_ms.p95 + 9 };
if (mode === 'error') m.errors.push({ count: 3, kind: 'script', location: '_on_enemy_hit (enemy.gd:42)', message: "Invalid access to property or key 'health' on a base object of type 'Nil'." });
if (mode === 'leak') m.memory_delta.orphan_nodes += 40_000;
if (mode === 'crash') {
  console.error('handle_crash: Program crashed with signal 11');
  console.error('[1] _spawn_wave (res://enemies/waves.gd:88)');
  process.exit(139);
}
if (mode === 'quit') process.exit(0);
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const text = JSON.stringify({ glitchless_measure: mode === 'off' ? { error: 'Glitchless is off: the player turned it off in the game\'s settings (set_enabled(false)), so no frames were measured.' } : m });
  if (out) fs.writeFileSync(out, `${text}\n`);
  // A Unity player on macOS prints nothing to stdout: the measurement only reaches the --glitchless-out file.
  if (mode !== 'silent') console.log(text);
  console.log('WARNING: 15000 ObjectDB instances were leaked at exit');
}
