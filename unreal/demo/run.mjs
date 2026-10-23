// Builds the Unreal demo (unreal/demo/GlitchlessDemo), lets bots play it against a fresh local Glitchless server,
// and checks that the findings name its three planted problems with Unreal advice: the first-use PSO hitch on
// gallery, the garbage-collection spikes on forge and the forge's ensure.
//
//   node unreal/demo/run.mjs               build (editor target, content, then a packaged Mac or Win64
//                                          Development build), then play and check
//   node unreal/demo/run.mjs --no-build    play the last package again
//   node unreal/demo/run.mjs --build-only  build, and play nothing (frame-time runs may need the machine to themselves)
//   node unreal/demo/run.mjs --runs 3      bot runs to play (default 3: findings want two sessions or more)
//   node unreal/demo/run.mjs --serve       leave the server running afterwards, with the dashboard, for a look
//   node unreal/demo/run.mjs --shots       also play once with -demo-shots and copy its 1920 x 1080 screenshots
//                                          to dist/unreal-demo/shots
//   UE_ROOT=/path/to/UE_5.8 node unreal/demo/run.mjs
//
// Each run starts with the demo's Metal shader cache cleared, as a player's first launch would (macOS keeps
// compiled pipelines per app, so a second launch would not hitch). It never builds while another Unreal build,
// cook or shader compile is running.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PROJECT = path.join(HERE, 'GlitchlessDemo/GlitchlessDemo.uproject');
const SERVICE = 'glitchless-unreal-demo';
const WINDOWS = process.platform === 'win32';
const UE_ROOT = process.env.UE_ROOT || (WINDOWS ? 'C:/Program Files/Epic Games/UE_5.8' : '/Users/Shared/Epic Games/UE_5.8');
const PLATFORM = WINDOWS ? 'Win64' : 'Mac';
const STAGED = path.join(HERE, 'GlitchlessDemo/Saved/StagedBuilds');
const argv = process.argv.slice(2);
const build = !argv.includes('--no-build');
const buildOnly = argv.includes('--build-only');
const serve = argv.includes('--serve');
const shots = argv.includes('--shots');
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-demo-'));
const out = path.join(ROOT, 'dist/unreal-demo');
fs.mkdirSync(out, { recursive: true });

if (!fs.existsSync(UE_ROOT)) {
  console.error(`Unreal Engine not found at ${UE_ROOT}. Install 5.8 or set UE_ROOT.`);
  process.exit(2);
}

function busy() {
  if (WINDOWS) return '';
  return spawnSync('pgrep', ['-fl', 'ShaderCompileWorker|UnrealBuildTool|RunUAT|AutomationTool']).stdout.toString().trim();
}

function run(label, cmd, args) {
  const log = path.join(tmp, `${label}.log`);
  console.log(`${label}… (log: ${log})`);
  const r = spawnSync(cmd, args, { shell: WINDOWS, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3 * 3600_000 });
  fs.writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) {
    console.error(`${r.stdout}`.split('\n').filter((l) => /error/i.test(l)).slice(0, 30).join('\n'));
    throw new Error(`${label} failed with ${r.status} (log: ${log})`);
  }
  return r.stdout;
}

function buildDemo() {
  const others = busy();
  if (others) throw new Error(`another Unreal build or shader compile is running; try again when it's done:\n${others}`);
  const batch = path.join(UE_ROOT, 'Engine/Build/BatchFiles');
  const editorOpen = !WINDOWS && spawnSync('pgrep', ['-x', 'UnrealEditor']).status === 0;
  run('build the editor target', path.join(batch, WINDOWS ? 'Build.bat' : 'Mac/Build.sh'), ['GlitchlessDemoEditor', PLATFORM, 'Development', `-project=${PROJECT}`, '-waitmutex', ...(editorOpen ? ['-NoHotReload'] : [])]);
  const editor = path.join(UE_ROOT, 'Engine/Binaries', WINDOWS ? 'Win64/UnrealEditor-Cmd.exe' : 'Mac/UnrealEditor-Cmd');
  run('make the content', editor, [PROJECT, '-run=pythonscript', `-script=${path.join(HERE, 'GlitchlessDemo/Scripts/make_content.py')}`, '-unattended', '-nosplash', '-nullrhi', '-stdout']);
  run(`package a ${PLATFORM} Development build`, path.join(batch, WINDOWS ? 'RunUAT.bat' : 'RunUAT.sh'), ['BuildCookRun', `-project=${PROJECT}`, `-platform=${PLATFORM}`, '-clientconfig=Development', '-build', '-cook', '-stage', '-pak', '-nop4', '-utf8output', '-unattended', '-nocompileeditor']);
}

function app() {
  const exe = WINDOWS ? path.join(STAGED, 'Windows/GlitchlessDemo.exe') : path.join(STAGED, 'Mac/GlitchlessDemo.app/Contents/MacOS/GlitchlessDemo');
  if (!fs.existsSync(exe)) throw new Error(`no packaged demo at ${exe}: run without --no-build`);
  const bundle = WINDOWS ? null : spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(STAGED, 'Mac/GlitchlessDemo.app/Contents/Info.plist')], { encoding: 'utf8' }).stdout.trim();
  return { exe, bundle };
}

// macOS keeps the GPU code it compiled for each app's pipelines; without it, the next launch compiles them again.
function freshShaderCache(bundle) {
  if (WINDOWS || !bundle) return;
  const caches = spawnSync('getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).stdout.trim();
  for (const dir of [path.join(caches, bundle, bundle, 'com.apple.metal'), path.join(caches, bundle, bundle, 'com.apple.metalfe')]) fs.rmSync(dir, { recursive: true, force: true });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_OTLP: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

function play(exe, args, label, timeout = 240_000) {
  const log = path.join(tmp, `${label}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-windowed', '-ResX=1280', '-ResY=720', '-unattended', '-nosound', '-nosplash', '-stdout', '-FullStdOutLogOutput', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(log, text);
      if (status !== 0) reject(new Error(`${label}: the demo exited with ${status ?? signal} (log: ${log})`));
      else resolve({ stdout: text, log });
    });
  });
}

async function query(port, name, params = {}) {
  const qs = new URLSearchParams({ service: SERVICE, from: '0', ...params });
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${qs}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

// A run that sends nothing and saves a HighResShot of each level; the shots land in the game's Saved folder (inside
// its container on a Mac).
async function takeShots(exe, bundle) {
  const saved = WINDOWS ? path.join(process.env.LOCALAPPDATA || '', 'GlitchlessDemo/Saved') : path.join(os.homedir(), 'Library/Containers', bundle, 'Data/Library/Application Support/Epic/GlitchlessDemo/Saved');
  const dir = path.join(saved, 'Screenshots');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('screenshots…');
  await play(exe, ['-autoplay', '-demo-shots', '-glitchless-off'], 'shots');
  const found = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => /\.png$/i.test(f)).sort() : [];
  const to = path.join(out, 'shots');
  fs.mkdirSync(to, { recursive: true });
  found.forEach((f, i) => fs.copyFileSync(path.join(dir, f), path.join(to, `${['gallery', 'forge'][i] || `shot-${i}`}.png`)));
  check('screenshots of both levels', found.length >= 2, `found ${found.length} in ${dir}`);
}

const results = [];
function check(name, ok, detail) {
  results.push([ok ? 'ok' : 'FAIL', name, ok ? '' : detail]);
}

let server;
try {
  if (build) buildDemo();
  const { exe, bundle } = app();
  if (buildOnly) {
    console.log(`built: ${exe}`);
    process.exit(0);
  }
  const port = Number(process.env.PORT) || (await freePort());
  server = await startServer(port, path.join(tmp, 'data'));
  const intake = `-glitchless-intake=http://127.0.0.1:${port}`;
  for (let i = 1; i <= runs; i++) {
    freshShaderCache(bundle);
    console.log(`bot run ${i} of ${runs} (about a minute)…`);
    await play(exe, ['-autoplay', intake], `run-${i}`);
  }

  // One measured run on gallery, as an agent would take before and after a fix.
  freshShaderCache(bundle);
  console.log('measure: gallery, 15 s…');
  const m = await play(exe, ['-glitchless-off', '-glitchless-warmup=1', '-glitchless-measure=15'], 'measure');
  const line = m.stdout.split('\n').find((l) => l.startsWith('{"glitchless_measure"'));
  const measure = line ? JSON.parse(line).glitchless_measure : null;
  check('measure prints one line of JSON', !!measure, `no {"glitchless_measure" line (log: ${m.log})`);
  const causes = (measure?.hitches || []).flatMap((h) => h.causes || []);
  check('measure: a hitch on gallery with pso_compile among its causes', causes.includes('pso_compile'), `hitch causes: ${JSON.stringify(measure?.hitches)}`);

  if (shots) await takeShots(exe, bundle);

  const { findings } = await query(port, 'findings');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'findings.json'), JSON.stringify(findings, null, 2));
  if (measure) fs.writeFileSync(path.join(out, 'measure.json'), JSON.stringify(measure, null, 2));
  const gallery = findings.find((f) => f.id === 'hitches-level-gallery' || f.id === 'perf-level-gallery');
  check('a finding names the PSO hitch on gallery', !!gallery?.evidence?.hitch_causes?.pso_compile, `gallery: ${JSON.stringify(gallery ?? null)}`);
  check('… with Unreal\'s PSO advice', /PSO precaching/.test(gallery?.suggestion || '') && /bundled PSO cache/.test(gallery?.suggestion || ''), gallery?.suggestion);
  check('… and the fireworks before it', /fireworks/.test(`${gallery?.summary} ${gallery?.suggestion}`), gallery?.summary);
  const forge = findings.find((f) => f.id === 'hitches-level-forge' || f.id === 'perf-level-forge');
  check('a finding names the GC spikes on forge', !!forge?.evidence?.hitch_causes?.gc, `forge: ${JSON.stringify(forge ?? null)}`);
  check('… with Unreal\'s GC advice', /garbage collections.*NewObject/.test(forge?.suggestion || ''), forge?.suggestion);
  const ensure = findings.find((f) => f.category === 'stability' && f.evidence?.kind === 'ensure');
  check('a finding names the ensure', /ForgeGate|Gate != nullptr/.test(`${ensure?.title} ${ensure?.evidence?.stack}`), `stability: ${JSON.stringify(findings.filter((f) => f.category === 'stability'))}`);
  check('… on forge, with Unreal\'s advice', ensure?.evidence?.levels?.includes('forge') && /IsValid\(\)/.test(ensure?.suggestion || ''), ensure?.suggestion);
  const overview = await query(port, 'overview').catch(() => null);
  check('no session counts as crashed', !overview || overview.kpis?.crash_free_pct == null || overview.kpis.crash_free_pct === 100, `crash-free: ${overview?.kpis?.crash_free_pct}`);

  console.log('');
  for (const f of [gallery, forge, ensure].filter(Boolean)) console.log(`[${f.severity}] ${f.title}\n  ${f.suggestion.slice(0, 240)}…\n`);
  for (const [status, name, detail] of results) console.log(`${status === 'ok' ? '  ok  ' : '  FAIL'}  ${name}${detail ? `\n          ${String(detail).slice(0, 600)}` : ''}`);
  console.log(`\nfindings: ${path.join(out, 'findings.json')}; the server's data: ${path.join(tmp, 'data')}; logs: ${tmp}`);
  if (serve) {
    console.log(`\nthe server stays up with the dashboard: http://127.0.0.1:${port}/  (Ctrl+C to stop)`);
    await new Promise(() => {});
  }
  process.exitCode = results.some(([s]) => s === 'FAIL') ? 1 : 0;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (!serve) server?.kill();
}
