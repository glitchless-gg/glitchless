// Makes the Unity Asset Store copy of the SDK from a commit, as a Unity project ready for Unity's Asset Store
// Publishing Tools. It uploads nothing. Two shapes, for the two kinds of Asset Store product:
//
//   node unity/scripts/asset-store.mjs --classic   a classic package (.unitypackage): the SDK in Assets/Glitchless,
//                                                  the Fetch! sample in Assets/Glitchless/Samples/Fetch
//                                                  (dist/unity-asset-store/GlitchlessClassic; Uploader → your draft)
//   node unity/scripts/asset-store.mjs             a UPM product: gg.glitchless.sdk in Packages/, as GitHub's git URL
//                                                  installs it (dist/unity-asset-store/GlitchlessAssetStore; Uploader →
//                                                  UPM Packages, after the UPM publisher enrollment)
//   options: --ref <commit> (default HEAD)  --publisher <name>  --unity-release <patch> (default 0f1)  --out <dir>
//
// The store copy differs from GitHub's. The Asset Store sells code under its own EULA (Submission Guidelines 1.2.c:
// other terms, open-source ones too, need Unity's written agreement), so LICENSE.md goes and the UPM manifest's
// "licensesUrl" points at the EULA; GitHub's copy stays MIT. The tests stay behind: in a project without Unity's Test
// Framework (the Validator's, a reviewer's) their assemblies compile and fail. For UPM the manifest gets
// "unityRelease" (5.2.e) and the publisher's name as author (5.2.f). Classic has no manifest: its project lists the
// built-in modules the SDK and the sample use instead, and its assets keep the package's GUIDs (in .meta files), so an
// update replaces files instead of duplicating them; the few folders and files that had none get GUIDs made from their
// paths, the same every time. Both rewrite the README's install and tests text (and classic the sample's) for the store.
//
// Checked here, from the Submission Guidelines (assetstore.unity.com/publishing/submission-guidelines, read
// 2026-10-26) and the UPM upload page: a .meta for every asset and no stray ones; 2.1.d no folder named
// AssetStoreTools; 1.5.a no executables; 1.2.a third-party code needs a notices file. For UPM also: 5.2.e the
// manifest's name, displayName, version, unity, unityRelease, author and description; 5.2.g a semantic version; the
// folder named as the package; 5.2.a/d valid asmdef JSON and every script in an assembly; 2.1.e paths under 150
// characters from the package's name; the 550 MB upload limit.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const classic = process.argv.includes('--classic');
// What the Fetch! sample uses beyond the SDK's own modules (its README says so). A classic package compiles the sample
// as soon as it's imported, so the store copy declares these too.
const SAMPLE_MODULES = { 'com.unity.modules.physics': '1.0.0' };
const ref = flag('ref', 'HEAD');
const publisher = flag('publisher', 'Glitchless');
const unityRelease = flag('unity-release', '0f1');
const out = path.resolve(ROOT, flag('out', 'dist/unity-asset-store'));
const project = path.join(out, classic ? 'GlitchlessClassic' : 'GlitchlessAssetStore');
// Where the SDK sits in the project, and how its paths read from there.
const pkg = classic ? path.join(project, 'Assets', 'Glitchless') : path.join(project, 'Packages', NAME);
const shown = classic ? 'Assets/Glitchless' : NAME;
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
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
// A UPM package brings its own dependencies (Unity's built-in modules). A classic package can't, so its project lists
// them, as every new Unity project does, and the Uploader's "Include Package Manifest" can declare them.
const modules = classic ? { ...manifest.dependencies, ...SAMPLE_MODULES } : {};
fs.mkdirSync(path.join(project, 'Packages'), { recursive: true });
fs.writeFileSync(path.join(project, 'Packages/manifest.json'), `${JSON.stringify({ dependencies: modules }, null, 2)}\n`);
for (const f of ['LICENSE.md', 'LICENSE.md.meta', 'Tests', 'Tests.meta']) fs.rmSync(path.join(pkg, f), { recursive: true, force: true });

// A .meta Unity accepts, with a GUID made from the path: the same on every run, so updates keep it.
const guidFor = (rel) => crypto.createHash('md5').update(`${NAME}:classic:${rel}`).digest('hex');
const meta = (rel, dir) =>
  `fileFormatVersion: 2\nguid: ${guidFor(rel)}\n${dir ? 'folderAsset: yes\nDefaultImporter' : rel.endsWith('.md') ? 'TextScriptImporter' : 'DefaultImporter'}:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;

// The README as the store has it: installed from My Assets, and the tests left on GitHub. Each edit must find its text,
// so a README rewrite can't slip past.
const readme = path.join(pkg, 'README.md');
let text = fs.readFileSync(readme, 'utf8');
const edit = (from, to) => {
  if (!from.test(text)) fail(`README.md no longer has ${from}: update the store edits in this script`);
  text = text.replace(from, to);
};
const moduleNames = { unitywebrequest: 'Unity Web Request', imgui: 'IMGUI', imageconversion: 'Image Conversion', screencapture: 'Screen Capture', physics: 'Physics' };
const named = Object.keys(manifest.dependencies || {}).map((m) => moduleNames[m.replace('com.unity.modules.', '')] || m).join(', ').replace(/, ([^,]*)$/, ' and $1');
edit(
  /## Install\n[\s\S]*?(?=\n## )/,
  classic
    ? `## Install\n\nFrom the Asset Store: **Window → Package Manager → My Assets → Glitchless → Import**. It all goes in \`Assets/Glitchless\`, and the SDK compiles into its own assembly, \`GlitchlessSdk\`. The SDK uses Unity's built-in modules ${named}, and the sample uses Physics. Every new project has them; **Package Manager → Built-in** turns one back on where it's off.\n`
    : `## Install\n\nFrom the Asset Store: **Window → Package Manager → My Assets → Glitchless → Install**.\n`,
);
if (classic) edit(/\*\*Package Manager → Glitchless → Samples → Fetch! → Import\*\* adds a small runner/, '`Samples/Fetch` is a small runner');
edit(
  /## Tests\n[\s\S]*$/,
  '## Tests\n\nThe SDK\'s EditMode and PlayMode tests stay with its source on [GitHub](https://github.com/glitchless-gg/glitchless/tree/main/unity/Packages/gg.glitchless.sdk).\n',
);
fs.writeFileSync(readme, text);

let ordered = manifest;
if (classic) {
  // The sample comes out of Samples~ (which Unity never imports) into the folder; package.json has no place there.
  for (const f of ['package.json', 'package.json.meta']) fs.rmSync(path.join(pkg, f), { force: true });
  fs.mkdirSync(path.join(pkg, 'Samples'), { recursive: true });
  fs.renameSync(path.join(pkg, 'Samples~', 'Fetch'), path.join(pkg, 'Samples', 'Fetch'));
  fs.rmSync(path.join(pkg, 'Samples~'), { recursive: true, force: true });
  const missing = ['Assets/Glitchless'];
  const walkAll = (rel) =>
    fs.readdirSync(path.join(project, rel), { withFileTypes: true }).forEach((e) => {
      if (e.name.endsWith('.meta')) return;
      const r = `${rel}/${e.name}`;
      if (!fs.existsSync(path.join(project, `${r}.meta`))) missing.push(r);
      if (e.isDirectory()) walkAll(r);
    });
  walkAll('Assets/Glitchless');
  for (const rel of missing) if (!fs.existsSync(path.join(project, `${rel}.meta`))) fs.writeFileSync(path.join(project, `${rel}.meta`), meta(rel, fs.statSync(path.join(project, rel)).isDirectory()));
} else {
  const manifestFile = path.join(pkg, 'package.json');
  delete manifest.license;
  manifest.licensesUrl = EULA;
  manifest.unityRelease = unityRelease;
  manifest.author = { ...manifest.author, name: publisher };
  ordered = {};
  for (const k of ['name', 'version', 'displayName', 'description', 'unity', 'unityRelease']) if (k in manifest) ordered[k] = manifest[k];
  Object.assign(ordered, manifest);
  fs.writeFileSync(manifestFile, `${JSON.stringify(ordered, null, 2)}\n`);
  for (const k of ['name', 'displayName', 'version', 'unity', 'unityRelease', 'author', 'description']) if (!ordered[k]) fail(`package.json has no "${k}"`);
  if (ordered.name !== NAME) fail(`package.json's name is ${ordered.name}, not the folder's ${NAME}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(ordered.version)) fail(`version ${ordered.version} isn't semantic`);
  if (!/^\d+f\d+$/.test(ordered.unityRelease)) fail(`unityRelease ${ordered.unityRelease} isn't like 0f1`);
}

// ── checks ─────────────────────────────────────────────────────
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
  if (!classic && `${NAME}/${e.rel}`.length >= 150) fail(`${e.rel}: the path is ${NAME.length + 1 + e.rel.length} characters (under 150)`);
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
if (classic && !fs.existsSync(`${pkg}.meta`)) fail('Assets/Glitchless has no .meta file');
// UPM: every script in an assembly, a folder above it (inside the package) holding an .asmdef. In a classic package the
// sample's scripts go to Assembly-CSharp, as a project's own do.
if (!classic) {
  const asmdefDirs = new Set(entries.filter((e) => e.rel.endsWith('.asmdef')).map((e) => path.dirname(e.rel)));
  for (const e of entries.filter((x) => !x.dir && x.rel.endsWith('.cs') && imported(x.rel))) {
    let d = path.dirname(e.rel);
    while (d !== '.' && !asmdefDirs.has(d)) d = path.dirname(d);
    if (!asmdefDirs.has(d)) fail(`${e.rel}: not in any assembly (no .asmdef above it)`);
  }
  if (bytes > 550 * 1024 * 1024) fail(`the package is ${(bytes / 1048576).toFixed(0)} MB (550 at most)`);
}

if (failures.length) {
  console.error(`The store copy breaks the Asset Store's rules:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
const unity = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion: (\S+)/)?.[1];
console.log(`${path.relative(process.cwd(), project)}: ${shown}, Glitchless for Unity ${manifest.version} from ${commit.slice(0, 12)}, ${entries.filter((e) => !e.dir).length} files, ${(bytes / 1024).toFixed(0)} KB, under the Asset Store EULA. Nothing was uploaded.`);
if (classic) console.log(`Needs Unity's built-in modules ${Object.keys(modules).map((m) => m.replace('com.unity.modules.', '')).join(', ')} (on in every new project). Next: open it in Unity ${unity}, then Window > Tools > Asset Store > Uploader: your draft, the folder Assets/Glitchless, Include Package Manifest with those modules, Validate, Export and Upload.`);
else console.log(`Author "${publisher}", Unity ${ordered.unity}.${ordered.unityRelease} and later. Next: open it in Unity ${unity}, run Window > Tools > Asset Store > Validator (UPM), then Uploader > UPM Packages.`);
