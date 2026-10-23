// Makes the Unreal plugin's release zips from a commit: plugin source only (what git tracks, so no Binaries,
// Intermediate or Saved), with the repo's LICENSE, checked before and after zipping. It creates no release.
//
//   node unreal/scripts/package-plugin.mjs                     GitHub: glitchless-unreal-<version>.zip and
//                                                              glitchless-unreal-toolset-<version>.zip
//   node unreal/scripts/package-plugin.mjs --fab --engine 5.8 [--fab-url <id>]
//                                                              Fab: Glitchless_<version>_UE5.8.zip, the descriptor
//                                                              stamped with EngineVersion (and FabURL)
//   options: --ref <commit> (default HEAD)  --out <dir> (default dist/unreal)  --version <x.y.z> (must match the
//            .uplugin's VersionName)  --allow-dirty  --build (then compile the staged plugin with RunUAT BuildPlugin;
//            UE_ROOT or the default install; never while another Unreal build or shader compile is running)
//
// Fab's Technical Requirements (fab.com/technical-requirements, read 2026-10-23) checked here: 4.2.1.a one plugin
// per zip; 4.2.2.d one zip per engine version, differing in EngineVersion; 4.3.6.a EngineVersion; 4.3.6.b a
// PlatformAllowList or PlatformDenyList on every module; 4.3.6.c FabURL; 4.3.6.d no user-made plugin
// dependencies; 4.3.6.1.b a copyright notice in every source and header file; 4.3.6.1.c a C++ module;
// 4.3.6.1.e no .exe or .msi; 4.3.7.1.c names in English letters, digits and underscores; 4.3.7.3.a no
// Binaries, Build, Intermediate or Saved; 4.3.7.3.b a Config/FilterPlugin.ini for anything outside Config,
// Content, Resources and Source; 4.3.7.3.c paths of 170 characters or less. Without --fab they are warnings.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGINS = 'unreal/Plugins';
const args = parseArgs(process.argv.slice(2));
const fab = !!args.fab;
const ref = args.ref || 'HEAD';
const outDir = path.resolve(ROOT, args.out || 'dist/unreal');
const UE_ROOT = process.env.UE_ROOT || (process.platform === 'win32' ? 'C:/Program Files/Epic Games/UE_5.8' : '/Users/Shared/Epic Games/UE_5.8');
// The real path: on a Mac os.tmpdir() is under /var, a symlink to /private/var, which Unreal's build accelerator
// (UBA) can't follow when BuildPlugin writes its precompiled headers there.
const TMP = fs.realpathSync(os.tmpdir());
const LOCAL_DIRS = ['Binaries', 'Build', 'Intermediate', 'Saved', 'DerivedDataCache'];
const SOURCE_EXT = /\.(h|hpp|inl|c|cc|cpp|cs)$/i;
const NOTICE = /copyright/i;
const failures = [];
const warnings = [];

if (fab && !/^5\.\d+$/.test(args.engine || '')) usage('--fab needs --engine 5.x (the engine version this zip is for)');

const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
// Every staged file gets the commit's time, as git archive gives its own, so the same commit makes the same zip.
const commitTime = Number(git(['log', '-1', '--format=%ct', commit]).trim());
const packages = fab
  ? [{ plugin: 'Glitchless', zip: (v) => `Glitchless_${v}_UE${args.engine}.zip` }]
  : [
      { plugin: 'Glitchless', zip: (v) => `glitchless-unreal-${v}.zip` },
      { plugin: 'GlitchlessToolset', zip: (v) => `glitchless-unreal-toolset-${v}.zip` },
    ];

fs.mkdirSync(outDir, { recursive: true });
const made = [];
for (const p of packages) made.push(packagePlugin(p));

for (const w of warnings) console.warn(`warning: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`error: ${f}`);
  console.error(`\n${failures.length} problem(s): no zip written.`);
  for (const m of made) for (const f of [m.zip, `${m.zip}.sha256`]) fs.rmSync(f, { force: true });
  process.exit(1);
}
const shown = (f) => (path.relative(process.cwd(), f).startsWith('..') ? f : path.relative(process.cwd(), f));
for (const m of made) console.log(`${shown(m.zip)}  ${m.files} files, ${(m.bytes / 1024).toFixed(0)} KB, sha256 ${m.sha256}`);
console.log(`from ${commit.slice(0, 12)}${fab ? `, for Unreal Engine ${args.engine}` : ''}. Nothing was published.`);

function packagePlugin({ plugin, zip }) {
  const dir = `${PLUGINS}/${plugin}`;
  if (!args['allow-dirty']) {
    const dirty = git(['status', '--porcelain', '--', dir]).trim();
    if (dirty && ref === 'HEAD') failures.push(`${dir} has uncommitted changes, which a zip from ${ref} would leave out (commit them, or pass --allow-dirty):\n${dirty}`);
  }
  const descriptorPath = `${plugin}.uplugin`;
  const descriptor = JSON.parse(git(['show', `${commit}:${dir}/${descriptorPath}`]));
  const version = descriptor.VersionName;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) failures.push(`${plugin}: VersionName "${version}" isn't x.y.z`);
  if (args.version && args.version !== version) failures.push(`${plugin}: VersionName is ${version}, not --version ${args.version}`);

  // Stage what git has at the commit: the plugin folder, the licence, and (for Fab) the stamped descriptor.
  const stage = fs.mkdtempSync(path.join(TMP, `glitchless-${plugin}-`));
  const top = path.join(stage, plugin);
  fs.mkdirSync(top);
  const tar = spawnSync('git', ['archive', '--format=tar', commit, '--', dir], { cwd: ROOT, maxBuffer: 1 << 28 });
  if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', stage, '-f', '-', `--strip-components=${dir.split('/').length}`], { input: tar.stdout, cwd: stage });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  // --strip-components took the folder's own name off too: everything is in the stage root, so move it in.
  for (const name of fs.readdirSync(stage)) if (name !== plugin) fs.renameSync(path.join(stage, name), path.join(top, name));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(top, 'LICENSE'));
  if (fab) {
    // Fab wants the EngineVersion right after VersionName, and FabURL once the draft listing exists.
    const stamped = {};
    for (const [k, v] of Object.entries(descriptor)) {
      if (k === 'EngineVersion' || k === 'FabURL') continue;
      stamped[k] = v;
      if (k === 'VersionName') stamped.EngineVersion = `${args.engine}.0`;
      if (k === 'DocsURL' && args['fab-url']) stamped.FabURL = fabUrl(args['fab-url']);
    }
    if (args['fab-url'] && !stamped.FabURL) stamped.FabURL = fabUrl(args['fab-url']);
    if (!args['fab-url'] && descriptor.FabURL) stamped.FabURL = descriptor.FabURL;
    fs.writeFileSync(path.join(top, descriptorPath), JSON.stringify(stamped, null, '\t') + '\n');
  }

  for (const f of [...walk(top, Infinity, true), top]) fs.utimesSync(f, commitTime, commitTime);

  check(plugin, top, JSON.parse(fs.readFileSync(path.join(top, descriptorPath), 'utf8')));
  if (args.build) buildPlugin(plugin, top);

  const out = path.join(outDir, zip(version));
  fs.rmSync(out, { force: true });
  // Info-ZIP's zip (macOS, Linux) without extra fields, so the same commit gives the same bytes; Windows 10+ has
  // bsdtar instead, which writes zips too.
  const z =
    process.platform === 'win32'
      ? spawnSync('tar', ['--format', 'zip', '-c', '-f', out, plugin], { cwd: stage })
      : spawnSync('zip', ['-r', '-X', '-D', '-q', out, ...walk(path.join(stage, plugin)).map((f) => path.relative(stage, f)).sort()], { cwd: stage });
  if (z.status !== 0) throw new Error(`zipping failed: ${z.stderr}`);

  // Read the zip back: one top folder, the descriptor, the licence, nothing local.
  const listed = (process.platform === 'win32' ? spawnSync('tar', ['-t', '-f', out]) : spawnSync('unzip', ['-Z1', out])).stdout.toString().split(/\r?\n/).filter(Boolean); // Windows' tar ends its lines in \r\n
  const files = listed.filter((f) => !f.endsWith('/'));
  const tops = new Set(listed.map((f) => f.split('/')[0]));
  if (tops.size !== 1 || !tops.has(plugin)) failures.push(`${zip(version)}: holds ${[...tops].join(', ')}, not one ${plugin} folder`);
  for (const need of [`${plugin}/${descriptorPath}`, `${plugin}/LICENSE`]) if (!files.includes(need)) failures.push(`${zip(version)}: no ${need}`);
  if (!files.some((f) => f.startsWith(`${plugin}/Source/`))) failures.push(`${zip(version)}: no Source folder`);
  for (const f of files) if (f.split('/').some((part) => LOCAL_DIRS.includes(part))) failures.push(`${zip(version)}: ${f} is a local build file`);

  const bytes = fs.statSync(out).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  fs.writeFileSync(`${out}.sha256`, `${sha256}  ${path.basename(out)}\n`);
  fs.rmSync(stage, { recursive: true, force: true });
  return { zip: out, files: files.length, bytes, sha256 };
}

// Fab's rules, as errors for a Fab zip and warnings for a GitHub one (where some don't apply yet).
function check(plugin, top, d) {
  const problem = (msg, alwaysError = false) => (fab || alwaysError ? failures : warnings).push(`${plugin}: ${msg}`);
  const files = walk(top).map((f) => path.relative(top, f).split(path.sep).join('/'));
  if (!Array.isArray(d.Modules) || !d.Modules.length) problem('the descriptor lists no modules (Fab 4.3.6.1.c)', true);
  for (const m of d.Modules || []) {
    if (!files.some((f) => f.startsWith(`Source/${m.Name}/`) && f.endsWith('.Build.cs'))) problem(`module ${m.Name} has no Source/${m.Name}/*.Build.cs`, true);
    if (!m.PlatformAllowList && !m.PlatformDenyList) problem(`module ${m.Name} has no PlatformAllowList or PlatformDenyList (Fab 4.3.6.b)`);
  }
  if (fab && !d.EngineVersion) problem('no EngineVersion (Fab 4.3.6.a)');
  if (fab && !d.FabURL) warnings.push(`${plugin}: no FabURL yet (Fab 4.3.6.c): create the draft listing, then run again with --fab-url <the listing's id>`);
  // Fab 4.3.6.d: dependencies only on plugins that ship with the engine.
  for (const dep of d.Plugins || []) {
    const shipped = fs.existsSync(path.join(UE_ROOT, 'Engine/Plugins')) ? walk(path.join(UE_ROOT, 'Engine/Plugins'), 4).some((f) => path.basename(f) === `${dep.Name}.uplugin`) : null;
    if (shipped === false) problem(`depends on ${dep.Name}, which isn't an engine plugin (Fab 4.3.6.d)`);
    if (shipped === null) warnings.push(`${plugin}: can't check that ${dep.Name} ships with the engine (no engine at ${UE_ROOT})`);
  }
  const unnoticed = [];
  for (const f of files) {
    if (/\.(exe|msi)$/i.test(f)) problem(`${f}: Fab takes no .exe or .msi (4.3.6.1.e)`, true);
    if (`${plugin}/${f}`.length > 170) problem(`${plugin}/${f} is over 170 characters (Fab 4.3.7.3.c)`);
    if (f.split('/').some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(part))) problem(`${f}: Fab wants names of English letters, digits and underscores (4.3.7.1.c)`);
    if (f.split('/').some((part) => LOCAL_DIRS.includes(part))) problem(`${f} is a local build file (Fab 4.3.7.3.a)`, true);
    if (SOURCE_EXT.test(f) && f.startsWith('Source/') && !f.startsWith('Source/ThirdParty/')) {
      const head = fs.readFileSync(path.join(top, f), 'utf8').split('\n').slice(0, 5).join('\n');
      if (!/^\s*(\/\/|\/\*)/m.test(head) || !NOTICE.test(head)) unnoticed.push(f);
    }
  }
  if (unnoticed.length) problem(`${unnoticed.length} source and header files have no copyright notice in their first lines (Fab 4.3.6.1.b), for example ${unnoticed.slice(0, 3).join(', ')}`);
  // Fab builds with BuildPlugin, which keeps only Config, Content, Resources and Source unless FilterPlugin.ini lists more.
  const extra = [...new Set(files.filter((f) => !/^(Config|Content|Resources|Source)\//.test(f) && f !== `${plugin}.uplugin`).map((f) => f.split('/')[0]))];
  const filter = files.includes('Config/FilterPlugin.ini') ? fs.readFileSync(path.join(top, 'Config/FilterPlugin.ini'), 'utf8') : '';
  for (const e of extra) if (!filter.split('\n').some((l) => l.trim().replace(/^\//, '').split('/')[0] === e)) problem(`${e} isn't in Config/FilterPlugin.ini, so a build from Fab leaves it out (Fab 4.3.7.3.b)`);
  if (!files.includes('Resources/Icon128.png')) warnings.push(`${plugin}: no Resources/Icon128.png: the Plugins window and Fab's build show a blank icon`);
}

function buildPlugin(plugin, top) {
  // BuildPlugin builds a plugin alone, in a host project with nothing else in it, so one that needs another of
  // these plugins can't build there (UBT: "Unable to find plugin"). The test project, which has both, builds it:
  // its editor target with -NoPCH is the same check without a shared PCH.
  const needs = (JSON.parse(fs.readFileSync(path.join(top, `${plugin}.uplugin`), 'utf8')).Plugins || []).map((p) => p.Name).filter((n) => fs.existsSync(path.join(ROOT, PLUGINS, n)));
  if (needs.length) {
    warnings.push(`${plugin}: not built here: it needs ${needs.join(', ')}, and BuildPlugin builds a plugin alone (build unreal/test/GlitchlessTest's editor target with -NoPCH instead)`);
    return;
  }
  const busy = spawnSync('pgrep', ['-fl', 'ShaderCompileWorker|UnrealBuildTool|RunUAT|AutomationTool']).stdout?.toString().trim();
  if (busy) {
    failures.push(`${plugin}: not building, another Unreal build is running:\n${busy}`);
    return;
  }
  const uat = path.join(UE_ROOT, 'Engine/Build/BatchFiles', process.platform === 'win32' ? 'RunUAT.bat' : 'RunUAT.sh');
  const pkg = fs.mkdtempSync(path.join(TMP, `glitchless-build-${plugin}-`));
  const platform = process.platform === 'win32' ? 'Win64' : 'Mac';
  console.log(`building ${plugin} from the staged copy for ${platform} (RunUAT BuildPlugin)…`);
  // Windows runs a .bat only through cmd (Node refuses otherwise), as one command line with its paths quoted.
  const uatArgs = ['BuildPlugin', `-Plugin=${path.join(top, `${plugin}.uplugin`)}`, `-Package=${pkg}`, `-TargetPlatforms=${platform}`, '-Rocket', '-unattended', '-nop4'];
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const opts = { encoding: 'utf8', maxBuffer: 1 << 28 };
  const r = process.platform === 'win32' ? spawnSync([uat, ...uatArgs].map(q).join(' '), { ...opts, shell: true }) : spawnSync(uat, uatArgs, opts);
  const log = path.join(outDir, `${plugin}-BuildPlugin-${platform}.log`);
  fs.writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) failures.push(`${plugin}: BuildPlugin failed (${r.status}); log: ${log}`);
  const own = `${r.stdout}`.split('\n').filter((l) => /warning|error/i.test(l) && (l.includes(`/${plugin}/`) || l.includes(`\\${plugin}\\`)));
  if (own.length) (fab ? failures : warnings).push(`${plugin}: BuildPlugin printed ${own.length} warning or error line(s) from the plugin (Fab 4.3.6.2.a); log: ${log}\n${own.slice(0, 10).join('\n')}`);
  fs.rmSync(pkg, { recursive: true, force: true });
}

function fabUrl(id) {
  const m = /([0-9a-f]{32}|[0-9a-f-]{36})\/?$/i.exec(id);
  if (!m) usage(`--fab-url: "${id}" doesn't end in the listing's id`);
  return id.startsWith('com.epicgames.launcher://') ? id : `com.epicgames.launcher://ue/Fab/product/${m[1]}`;
}

// Files under `dir` (and with `dirs`, the folders too).
function walk(dir, depth = Infinity, dirs = false) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dirs) out.push(p);
      if (depth > 0) out.push(...walk(p, depth - 1, dirs));
    } else out.push(p);
  }
  return out;
}

function git(a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) usage(`unexpected ${a}`);
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (['ref', 'out', 'version', 'engine', 'fab-url'].includes(k)) out[k] = list[++i];
    else if (['fab', 'allow-dirty', 'build'].includes(k)) out[k] = true;
    else usage(`unknown option --${k}`);
  }
  return out;
}

function usage(msg) {
  console.error(`${msg}\nusage: node unreal/scripts/package-plugin.mjs [--fab --engine 5.8 [--fab-url <id>]] [--ref <commit>] [--out <dir>] [--version <x.y.z>] [--allow-dirty] [--build]`);
  process.exit(2);
}
