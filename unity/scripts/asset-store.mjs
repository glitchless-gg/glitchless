// Makes the Unity Asset Store copy of the SDK from a commit: a Unity project (dist/unity-asset-store/GlitchlessAssetStore)
// whose Packages/ holds gg.glitchless.sdk as the store sells it, ready for Unity's Asset Store Publishing Tools
// (Window > Tools > Asset Store > Validator, then Uploader > UPM Packages). It uploads nothing.
//
//   node unity/scripts/asset-store.mjs [--ref <commit>] [--publisher <name>] [--unity-release <patch>] [--out <dir>]
//
// The store copy differs from GitHub's in four ways. The Asset Store sells code under its own EULA (Submission
// Guidelines 1.2.c: other terms, open-source ones too, need Unity's written agreement), so LICENSE.md and the
// manifest's "license" go and "licensesUrl" points at the EULA; GitHub's copy stays MIT. The manifest gets
// "unityRelease" (5.2.e) and its author is the publisher's name on the store (5.2.f). And the tests stay behind (below).
//
// Checked here, from the Submission Guidelines (assetstore.unity.com/publishing/submission-guidelines, read
// 2026-10-26) and the UPM upload page: 5.2.e the manifest's name, displayName, version, unity, unityRelease, author
// and description; 5.2.g a semantic version; the package's folder named as its "name"; 5.2.a/d valid asmdef JSON and
// every script in an assembly; 5.2.b a .meta for every asset and no stray ones (folders ending in ~ excepted);
// 2.1.d no folder named AssetStoreTools; 2.1.e paths under 150 characters from the package's name; 1.5.a no
// executables; 1.2.a third-party code needs a notices file; the 550 MB upload limit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'gg.glitchless.sdk';
const SOURCE = `unity/Packages/${NAME}`;
const EULA = 'https://unity.com/legal/as-terms';
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ref = flag('ref', 'HEAD');
const publisher = flag('publisher', 'Glitchless');
const unityRelease = flag('unity-release', '0f1');
const out = path.resolve(ROOT, flag('out', 'dist/unity-asset-store'));
const project = path.join(out, 'GlitchlessAssetStore');
const pkg = path.join(project, 'Packages', NAME);
const failures = [];
const fail = (why) => failures.push(why);

// The package as the commit has it (what git tracks), so nothing local or ignored goes to the store.
const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
fs.rmSync(project, { recursive: true, force: true });
fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });
fs.mkdirSync(path.join(project, 'ProjectSettings'), { recursive: true });
const tar = execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', commit, SOURCE, 'unity/ProjectSettings/ProjectVersion.txt'], { maxBuffer: 1 << 30 });
const staging = path.join(out, '.staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
execFileSync('tar', ['-x', '-C', staging], { input: tar });
fs.cpSync(path.join(staging, SOURCE), pkg, { recursive: true });
fs.copyFileSync(path.join(staging, 'unity/ProjectSettings/ProjectVersion.txt'), path.join(project, 'ProjectSettings/ProjectVersion.txt'));
fs.rmSync(staging, { recursive: true, force: true });
fs.writeFileSync(path.join(project, 'Packages/manifest.json'), `${JSON.stringify({ dependencies: {} }, null, 2)}\n`);

// The store's licence and manifest. The tests stay on GitHub: in a project without Unity's Test Framework (the
// Validator's, a reviewer's) an embedded package's test assemblies compile and fail.
for (const f of ['LICENSE.md', 'LICENSE.md.meta', 'Tests', 'Tests.meta']) fs.rmSync(path.join(pkg, f), { recursive: true, force: true });
const manifestFile = path.join(pkg, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
delete manifest.license;
manifest.licensesUrl = EULA;
manifest.unityRelease = unityRelease;
manifest.author = { ...manifest.author, name: publisher };
const ordered = {};
for (const k of ['name', 'version', 'displayName', 'description', 'unity', 'unityRelease']) if (k in manifest) ordered[k] = manifest[k];
Object.assign(ordered, manifest);
fs.writeFileSync(manifestFile, `${JSON.stringify(ordered, null, 2)}\n`);

// ── checks ─────────────────────────────────────────────────────
for (const k of ['name', 'displayName', 'version', 'unity', 'unityRelease', 'author', 'description']) if (!ordered[k]) fail(`package.json has no "${k}"`);
if (ordered.name !== NAME) fail(`package.json's name is ${ordered.name}, not the folder's ${NAME}`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(ordered.version)) fail(`version ${ordered.version} isn't semantic`);
if (!/^\d+f\d+$/.test(ordered.unityRelease)) fail(`unityRelease ${ordered.unityRelease} isn't like 0f1`);

const walk = (dir, rel = '') =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = path.join(rel, e.name);
    return e.isDirectory() ? [{ rel: r, dir: true }, ...walk(dir, r)] : [{ rel: r, dir: false }];
  });
const entries = walk(pkg);
// Unity imports nothing inside a folder whose name ends in ~ (Samples~, Documentation~) or starts with a dot.
const imported = (rel) => !rel.split(path.sep).some((part) => part.endsWith('~') || part.startsWith('.'));
const names = new Set(entries.map((e) => e.rel));
let bytes = 0;
for (const e of entries) {
  const full = path.join(pkg, e.rel);
  if (!e.dir) bytes += fs.statSync(full).size;
  if (e.rel.split(path.sep).includes('AssetStoreTools')) fail(`${e.rel}: no folder may be named AssetStoreTools`);
  if (`${NAME}/${e.rel}`.length >= 150) fail(`${e.rel}: the path is ${NAME.length + 1 + e.rel.length} characters (under 150)`);
  if (!e.dir && /\.(exe|msi|app|dmg|pkg|bat|cmd|sh|command)$/i.test(e.rel)) fail(`${e.rel}: no executables (1.5.a)`);
  if (/(^|\/)(ThirdParty|third[-_]party)(\/|$)/i.test(e.rel) && !names.has('Third-Party Notices.md') && !names.has('Third-Party Notices.txt')) fail(`${e.rel}: third-party code needs a Third-Party Notices file (1.2.a)`);
  if (!imported(e.rel)) continue;
  if (e.rel.endsWith('.meta')) {
    if (!names.has(e.rel.slice(0, -5))) fail(`${e.rel}: a .meta without its asset`);
  } else if (!names.has(`${e.rel}.meta`)) fail(`${e.rel}: no .meta file`);
  if (!e.dir && e.rel.endsWith('.asmdef')) {
    try {
      JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      fail(`${e.rel}: not valid JSON`);
    }
  }
}
// Every script in an assembly: a folder above it (inside the package) holds an .asmdef.
const asmdefDirs = new Set(entries.filter((e) => e.rel.endsWith('.asmdef')).map((e) => path.dirname(e.rel)));
for (const e of entries.filter((x) => !x.dir && x.rel.endsWith('.cs') && imported(x.rel))) {
  let d = path.dirname(e.rel);
  while (d !== '.' && !asmdefDirs.has(d)) d = path.dirname(d);
  if (!asmdefDirs.has(d)) fail(`${e.rel}: not in any assembly (no .asmdef above it)`);
}
if (bytes > 550 * 1024 * 1024) fail(`the package is ${(bytes / 1048576).toFixed(0)} MB (550 at most)`);

if (failures.length) {
  console.error(`The store copy breaks the Asset Store's rules:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
const unity = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion: (\S+)/)?.[1];
console.log(`${path.relative(process.cwd(), project)}: ${NAME} ${ordered.version} from ${commit.slice(0, 12)}, ${entries.filter((e) => !e.dir).length} files, ${(bytes / 1024).toFixed(0)} KB.`);
console.log(`Author "${publisher}", Unity ${ordered.unity}.${ordered.unityRelease} and later, under the Asset Store EULA. Nothing was uploaded.`);
console.log(`Next: open it in Unity ${unity}, run Window > Tools > Asset Store > Validator (UPM), then Uploader > UPM Packages.`);
