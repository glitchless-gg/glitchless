// A real engine build end to end: glitchless-playtest runs the Godot demo (godot/demo) twice with its autoplay
// bot, saves a baseline and compares. Skipped where Godot 4.5 or later isn't installed (GODOT=/path/to/Godot to
// pick one). Headless, so it runs without a screen; frame times then only warn, which this checks too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playtest } from '../src/index.js';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../godot');

// The same search as godot/test/e2e.mjs.
function findGodot() {
  const apps = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => /^Godot.*\.app$/.test(f)).sort().reverse().map((f) => path.join(dir, f, 'Contents/MacOS/Godot'));
    } catch {
      return [];
    }
  };
  const candidates = [process.env.GODOT, 'godot', path.join(os.homedir(), 'Applications/Godot.app/Contents/MacOS/Godot'), '/Applications/Godot.app/Contents/MacOS/Godot', ...apps(path.join(os.homedir(), 'Applications')), ...apps('/Applications')].filter(Boolean);
  for (const bin of candidates) {
    const m = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout?.match(/^(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 4 || (Number(m[1]) === 4 && Number(m[2]) >= 5))) return bin;
  }
  return null;
}

const godot = fs.existsSync(path.join(DEMO, 'project.godot')) ? findGodot() : null;

test('the Godot demo: a baseline, then the same build again passes', { skip: !godot && 'Godot 4.5 or later not found (set GODOT=/path/to/Godot)', timeout: 120_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-godot-playtest-'));
  fs.writeFileSync(
    path.join(cwd, 'glitchless.playtest.json'),
    JSON.stringify({
      command: [godot, '--headless', '--max-fps', '60', '--path', DEMO],
      // Levels last 2 s: the bot is on level_2 when the 3 s measure ends, after level_1's planted error.
      scenarios: [{ name: 'seed 7', params: { autoplay: true, seed: 7, 'level-seconds': 2 }, seconds: 3 }],
    }),
  );
  const lines = [];
  const baseline = await playtest({ cwd, saveAs: 'baseline', log: (l) => lines.push(l) });
  const run = baseline.candidate;
  assert.equal(run.kind, 'engine');
  assert.equal(run.engine, 'godot');
  assert.match(run.machine.browser, /^Godot · glitchless-godot\//);
  const m = run.scenarios[0].measure;
  assert.ok(m.frames > 60, `frames ${m.frames}`);
  assert.equal(m.seconds, 3);
  assert.equal(m.headless, true);
  assert.deepEqual([m.level_start, m.level_end], ['level_1', 'level_2']);
  assert.ok(run.summary.frame_p95 > 0 && run.summary.frame_p99 >= run.summary.frame_p95);
  assert.ok(run.summary.update_cpu_ms != null);
  assert.deepEqual(run.summary.errors.map((e) => e.fingerprint), ['push_error|bonus table missing row # in user://bonus.cfg|_play_event (demo.gd)']);
  assert.match(baseline.report, /The build ran headless/);

  const after = await playtest({ cwd });
  assert.equal(after.verdict, 'pass', after.report);
  assert.equal(after.comparison.regressions.length, 0);
  assert.equal(after.comparison.new_errors.length, 0);
  fs.rmSync(cwd, { recursive: true, force: true });
});
