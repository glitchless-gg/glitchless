// What the GameMaker SDK costs the game, measured: builds the demo (a VM build for the mac target, as e2e.mjs does) and
// runs it with -glitchless-overhead, which times the SDK's per-frame calls in a loop, the frame window closing, a flush,
// and the offline worst case, a save with the outbox near its 4,000-event cap (demo_overhead in scripts/demo). Nothing
// is sent. Not part of the tests: it prints numbers, and the README's "What it costs" quotes them.
//   node gamemaker/test/overhead.mjs              (--no-build to run the last build again)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, runGame, saveDir } from './runner.mjs';

// The runner's save area (every GameMaker game run from the IDE shares it): only Glitchless's own files go, so a saved
// "off" from an earlier run doesn't leave nothing to measure.
const runnerSave = path.join(os.homedir(), 'Library/Application Support/com.yoyogames.macyoyorunner/glitchless');
for (const f of ['overhead.txt', 'outbox.json', 'outbox.json.tmp', 'enabled']) fs.rmSync(path.join(runnerSave, f), { force: true });
if (!process.argv.includes('--no-build')) {
  console.log('building the demo (VM, mac)…');
  build();
}
runGame(['-glitchless', '-glitchless-overhead'], 'overhead', { timeoutMs: 300_000 });
const out = path.join(saveDir, 'glitchless/overhead.txt');
if (!fs.existsSync(out)) {
  console.error(`no numbers in ${out}`);
  process.exit(1);
}
const cpu = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout.trim();
process.stdout.write(fs.readFileSync(out, 'utf8').replace('\n', `, ${cpu}\n`));
fs.rmSync(out, { force: true });
