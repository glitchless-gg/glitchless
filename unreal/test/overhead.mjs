// What the Unreal plugin's core costs the game thread, measured: builds unreal/test/overhead/Overhead.cpp with the
// plugin's engine-independent core, with the flags Unreal builds with (-O2, no exceptions, no RTTI), and runs it. It
// times each frame of play on a clock it moves itself, the frames that close a window and flush, and the offline worst
// case, the outbox near its 4,000-event cap. Nothing is sent. Not part of core.mjs: it prints numbers, and the plugin
// README's "What it costs" quotes them. Needs zlib (macOS and Linux have it).
//   node unreal/test/overhead.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '../Plugins/Glitchless/Source/Glitchless/Private/Core');
const FDLIBM = path.resolve(HERE, '../Plugins/Glitchless/Source/ThirdParty/fdlibm');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-overhead-'));
const sources = [...fs.readdirSync(CORE).filter((f) => f.endsWith('.cpp')).map((f) => path.join(CORE, f)), path.join(HERE, 'overhead/Overhead.cpp')];
if (process.platform === 'win32') {
  console.error('This builds with clang or g++ and zlib: run it on macOS or Linux.');
  process.exit(2);
}
const cxx = process.env.CXX || (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status === 0 ? 'clang++' : 'c++');
const exe = path.join(OUT_DIR, 'overhead');
const compiled = spawnSync(cxx, ['-std=c++17', '-O2', '-fno-exceptions', '-fno-rtti', '-ffp-contract=fast', '-pthread', `-I${CORE}`, `-I${FDLIBM}`, '-o', exe, ...sources, '-lz'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const run = spawnSync(exe, [], { stdio: 'inherit' });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(run.status ?? 1);
