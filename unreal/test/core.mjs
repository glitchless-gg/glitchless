// Builds and runs the Unreal plugin's engine-independent core tests (unreal/test/core/*.cpp) with
// the compilers Unreal itself uses, with the flags Unreal builds with: no exceptions, no RTTI, and
// floating-point contraction on (MSVC: /fp:fast), so the sketch's parity is tested the hard way. MSVC also gets
// Unreal's _CRT_SECURE_NO_WARNINGS, or /WX would fail on fopen and getenv.
//   node unreal/test/core.mjs [test name filter]
// Uses clang++ (or c++) on macOS and Linux, cl.exe on Windows (from a Developer Command Prompt).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '../Plugins/Glitchless/Source/Glitchless/Private/Core');
const FDLIBM = path.resolve(HERE, '../Plugins/Glitchless/Source/ThirdParty/fdlibm');
const TESTS = path.join(HERE, 'core');
const FIXTURE = path.join(HERE, 'fixtures/js-fixture.json');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-core-'));
const sources = [
  ...fs.readdirSync(CORE).filter((f) => f.endsWith('.cpp')).map((f) => path.join(CORE, f)),
  ...fs.readdirSync(TESTS).filter((f) => f.endsWith('.cpp')).map((f) => path.join(TESTS, f)),
];

function has(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

let exe;
let build;
if (process.platform === 'win32' && !process.env.CXX) {
  exe = path.join(OUT_DIR, 'core-tests.exe');
  build = ['cl', ['/nologo', '/std:c++17', '/O2', '/W4', '/WX', '/EHs-c-', '/D_HAS_EXCEPTIONS=0', '/GR-', '/fp:fast', '/utf-8', '/D_CRT_SECURE_NO_WARNINGS', `/I${CORE}`, `/I${FDLIBM}`, `/I${TESTS}`, `/Fo${OUT_DIR}\\`, `/Fe${exe}`, ...sources]];
} else {
  const cxx = process.env.CXX || (has('clang++') ? 'clang++' : 'c++');
  exe = path.join(OUT_DIR, 'core-tests');
  build = [cxx, ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-fno-exceptions', '-fno-rtti', '-ffp-contract=fast', `-I${CORE}`, `-I${FDLIBM}`, `-I${TESTS}`, '-o', exe, ...sources]];
}

console.log(`building with ${build[0]}`);
const compiled = spawnSync(build[0], build[1], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const run = spawnSync(exe, [`--fixture=${FIXTURE}`, ...process.argv.slice(2)], { stdio: 'inherit' });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(run.status ?? 1);
