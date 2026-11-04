// What the Unity SDK costs the game's main thread, measured: builds a release macOS player with only
// unity/Assets/Overhead in it (an empty scene; SampleBuilder.BuildOverhead) and runs it. The player times the runner's
// own per-frame work in a loop, a window closing, a flush and its send's answer, and the offline worst case, a save
// with the outbox near its 4,000-event cap, then prints the numbers and quits. Nothing is sent. Not part of
// test:unity: it prints numbers, and the package README's "What it costs" quotes them.
//
//   node unity/test/overhead.mjs               (UNITY=/path/to/Unity to pick the Editor; --no-build to run the last build)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.join(ROOT, 'unity');
const version = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion: (\S+)/)[1];
const unity = process.env.UNITY || `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`;
if (process.platform !== 'darwin') {
  console.error('This builds a macOS player. On another OS, build with SampleBuilder.BuildOverhead for your platform and run it.');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unity-overhead-'));
const app = path.join(project, 'Builds/overhead/Overhead.app');

if (!process.argv.includes('--no-build')) {
  if (!fs.existsSync(unity)) {
    console.error(`Unity ${version} not found at ${unity}. Install it or set UNITY=/path/to/Unity.`);
    process.exit(2);
  }
  console.log(`Unity ${version}: building the overhead player (release)…`);
  const log = path.join(tmp, 'build.log');
  const r = spawnSync(unity, ['-batchmode', '-nographics', '-quit', '-projectPath', project, '-executeMethod', 'SampleBuilder.BuildOverhead', '-logFile', log], { timeout: 900_000 });
  if (r.status !== 0) {
    console.error(`the build failed (log: ${log})`);
    process.exit(1);
  }
}

const out = path.join(tmp, 'overhead.txt');
const log = path.join(tmp, 'player.log');
const r = spawnSync(path.join(app, 'Contents/MacOS/Overhead'), ['-batchmode', '-logFile', log, `--glitchless-out=${out}`], { timeout: 300_000 });
if (r.status !== 0 || !fs.existsSync(out)) {
  console.error(`the player exited with ${r.status} and no numbers (log: ${log})`);
  process.exit(1);
}
process.stdout.write(fs.readFileSync(out, 'utf8'));
