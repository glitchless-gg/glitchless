// The Godot editor the tests run (test/e2e.mjs, test/web.mjs): $GODOT, `godot` on the PATH, or a Godot*.app in
// ~/Applications or /Applications, the first that is 4.5 or later.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findGodot() {
  const candidates = [
    process.env.GODOT,
    'godot',
    path.join(os.homedir(), 'Applications/Godot.app/Contents/MacOS/Godot'),
    '/Applications/Godot.app/Contents/MacOS/Godot',
    ...listGodotApps(path.join(os.homedir(), 'Applications')),
    ...listGodotApps('/Applications'),
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    const m = r.stdout?.match(/^(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 4 || (Number(m[1]) === 4 && Number(m[2]) >= 5))) return bin;
  }
  console.error('Godot 4.5 or later not found. Set GODOT=/path/to/Godot.');
  process.exit(2);
}

function listGodotApps(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^Godot.*\.app$/.test(f)).sort().reverse().map((f) => path.join(dir, f, 'Contents/MacOS/Godot'));
  } catch {
    return [];
  }
}
