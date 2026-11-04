// What gamemaker/test/e2e.mjs and overhead.mjs share: the GameMaker runtime and licence a person set up (found by
// their paths and handed to Igor, never read here), a VM build of the demo for the mac target in gamemaker/.build, and
// runs of it with flags on the command line until it quits. Importing it stops the script when GameMaker isn't set up.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = path.join(ROOT, 'gamemaker/Glitchless.yyp');
export const BUILD = path.join(ROOT, 'gamemaker/.build');

if (process.platform !== 'darwin') {
  console.error('This runs a GameMaker VM build for the mac target, on macOS.');
  process.exit(2);
}

// The newest runtime with an Igor and a Mac runner, from GM_RUNTIME, the IDE's shared cache or a gm-cli cache.
function findRuntime() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ok = (rt) => fs.existsSync(path.join(rt, 'bin/igor/osx', arch, 'Igor')) && fs.existsSync(path.join(rt, 'mac/YoYo Runner.app'));
  if (process.env.GM_RUNTIME) return ok(process.env.GM_RUNTIME) ? process.env.GM_RUNTIME : null;
  const roots = [
    ...['GameMakerStudio2-LTS2026', 'GameMakerStudio2'].map((d) => `/Users/Shared/${d}/Cache/runtimes`),
    path.join(process.env.GAMEMAKER_CLI_CACHE_DIR || path.join(os.homedir(), 'Library/Caches/GameMakerCLI-glitchless'), 'runtimes-gms2'),
  ];
  const all = roots.flatMap((r) => (fs.existsSync(r) ? fs.readdirSync(r).filter((d) => d.startsWith('runtime-')).map((d) => path.join(r, d)) : [])).filter(ok);
  return all.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }))[0] ?? null;
}

// The licence: GM_LICENCE, a signed-in IDE user folder (passed whole with -uf), or a gm-cli cache's licence.plist.
function findLicence() {
  if (process.env.GM_LICENCE) return fs.existsSync(process.env.GM_LICENCE) ? ['-lf', process.env.GM_LICENCE] : null;
  for (const base of ['GameMakerStudio2-LTS2026', 'GameMakerStudio2'].map((d) => path.join(os.homedir(), 'Library/Application Support', d))) {
    if (!fs.existsSync(base)) continue;
    const user = fs.readdirSync(base).find((d) => !d.startsWith('unknownUser') && fs.existsSync(path.join(base, d, 'licence.plist')));
    if (user) return ['-uf', path.join(base, user)];
  }
  const cli = path.join(process.env.GAMEMAKER_CLI_CACHE_DIR || path.join(os.homedir(), 'Library/Caches/GameMakerCLI-glitchless'), 'license/licence.plist');
  return fs.existsSync(cli) ? ['-lf', cli] : null;
}

export const RUNTIME = findRuntime();
const LICENCE = findLicence();
if (!RUNTIME || !LICENCE) {
  console.error(`${RUNTIME ? 'No GameMaker licence found' : 'No GameMaker runtime found'}. A person sets GameMaker up once (it accepts GameMaker's terms): see "Testing" in gamemaker/README.md.`);
  process.exit(2);
}
const IGOR = path.join(RUNTIME, 'bin/igor/osx', process.arch === 'arm64' ? 'arm64' : 'x64', 'Igor');
const RUNNER = path.join(RUNTIME, 'mac/YoYo Runner.app');
const OUT = path.join(BUILD, 'out');
const GAME = path.join(OUT, 'game.ios');

// A VM build for the mac target, compiled once.
export function build() {
  for (const d of ['out', 'cache', 'temp']) fs.rmSync(path.join(BUILD, d), { recursive: true, force: true });
  const prefabs = path.join(path.dirname(path.dirname(path.dirname(RUNTIME))), 'Prefabs');
  const args = ['-rp', RUNTIME, ...LICENCE, '-project', PROJECT, '-runtime', 'VM', '-cache', path.join(BUILD, 'cache'), '-temp', path.join(BUILD, 'temp'), '-of', path.join(OUT, 'Glitchless'), ...(fs.existsSync(prefabs) ? ['-prefabs', prefabs] : []), '-jsonErrors', '--', 'Mac', 'Compile'];
  const r = spawnSync(IGOR, args, { encoding: 'utf8', timeout: 600_000, env: { ...process.env, COMPlus_ZapDisable: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const log = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0 || !fs.existsSync(path.join(OUT, 'assets/game.ios'))) throw new Error(`Igor could not build the demo (exit ${r.status})\n${log.slice(-6000)}`);
  fs.copyFileSync(path.join(OUT, 'assets/game.ios'), GAME); // beside options.ini and the included files, where the runner looks
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export let saveDir = null; // the runner's save area, known once the first run prints it
let runs = 0;

// One run of the demo with these flags, until it quits. Returns what the game logged.
export function runGame(flags, label, { timeoutMs = 120_000 } = {}) {
  const log = path.join(BUILD, `run-${++runs}.log`);
  fs.rmSync(log, { force: true });
  const r = spawnSync('open', ['-n', '-W', '-a', RUNNER, '--args', '-game', GAME, '-debugoutput', log, ...flags], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error?.code === 'ETIMEDOUT') {
    // Ours is the only runner on this game file: stop it by its PID.
    const pids = spawnSync('pgrep', ['-f', GAME], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) process.kill(Number(pid));
    throw new Error(`${label}: the game did not quit within ${timeoutMs / 1000} s`);
  }
  const out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const dir = /glitchless demo save dir: (.+?)\s*$/m.exec(out)?.[1];
  if (dir && !saveDir) saveDir = dir.replace(/\/$/, '');
  if (!dir) throw new Error(`${label}: the demo never started\n${out.slice(-4000)}`);
  return out;
}
