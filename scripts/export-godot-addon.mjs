// Copies the Godot addon into its own public repo (glitchless-gg/glitchless-godot) and makes the zip for the Godot
// Asset Store. Godot has two catalogues, and each release goes to both:
// - The Asset Library (godotengine.org/asset-library, listing 5587) installs a commit's zip from the mirror, so the
//   addon sits at addons/glitchless/ from the repo's root, with the LICENSE file the library requires, a short README,
//   and a .gitattributes that keeps all but the addon out of the zip. Its entry takes each release's commit.
// - The Asset Store (store.godotengine.org, built into the editor from Godot 4.7) takes an uploaded zip per version:
//   dist/godot-asset-store/glitchless-<version>.zip, holding addons/glitchless/ alone (its guidelines want that
//   folder, the licence inside it, and no .gitignore, .gitattributes or .DS_Store).
//   node scripts/export-godot-addon.mjs [path to the glitchless-godot checkout]   (default ../glitchless-godot)
//   node scripts/export-godot-addon.mjs --fields [path]   after the mirror's commit is tagged and pushed: what to type
//                                                           into the Asset Library's edit form
// It copies the files git tracks in godot/addons/glitchless (no editor caches), replacing what was there so removed
// files go too, and points links that leave the addon at this repo on GitHub. Run it at each Godot release, then
// commit, tag v<version> and push the mirror after looking at the diff, and run it again with --fields.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADDON = 'godot/addons/glitchless';
const FIELDS = process.argv.includes('--fields');
const TO = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(ROOT, '..', 'glitchless-godot'));
const SOURCE = 'https://github.com/glitchless-gg/glitchless';
const MIRROR = 'https://github.com/glitchless-gg/glitchless-godot';
const LISTING = 'https://godotengine.org/asset-library/asset/5587';

const version = fs.readFileSync(path.join(ROOT, ADDON, 'plugin.cfg'), 'utf8').match(/^version="([^"]+)"/m)?.[1];
if (!version) throw new Error(`${ADDON}/plugin.cfg has no version`);

// The Asset Library's edit form, from the mirror's commit for this version. Refuses a commit that isn't tagged
// v<version> or isn't on GitHub yet, since the library downloads it from there.
if (FIELDS) {
  const git = (...args) => execFileSync('git', args, { cwd: TO, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  let tagged = '';
  try {
    tagged = git('rev-parse', `v${version}^{commit}`);
  } catch {}
  if (tagged !== commit) throw new Error(`the mirror's HEAD (${commit.slice(0, 7)}) isn't tagged v${version}: commit and tag it first`);
  const remote = git('ls-remote', '--tags', `${MIRROR}.git`, `v${version}`);
  if (!remote.split('\n').some((line) => line.startsWith(commit))) {
    throw new Error(`push the mirror and its tag first: GitHub has no v${version} at ${commit.slice(0, 7)}`);
  }
  console.log(`Asset Library edit for Glitchless ${version} (${LISTING}, "Submit an edit"):
  Version:          ${version}
  Download Commit:  ${commit}
  Download URL:     ${MIRROR}/archive/${commit}.zip
Everything else stays as it is. A moderator approves the edit.`);
  process.exit(0);
}
const tracked = execFileSync('git', ['ls-files', ADDON], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
if (!tracked.length) throw new Error(`git tracks nothing in ${ADDON}`);

// A Markdown link that leaves the addon ("../../../docs/SPEC.md#5-godot-sdk") becomes the file on GitHub.
function relink(text) {
  return text.replace(/\]\((\.\.\/[^)#\s]*)(#[^)\s]*)?\)/g, (all, link, hash = '') => {
    const target = path.posix.normalize(path.posix.join(ADDON, link));
    return target.startsWith(`${ADDON}/`) ? all : `](${SOURCE}/blob/main/${target}${hash})`;
  });
}

const out = path.join(TO, 'addons', 'glitchless');
fs.rmSync(out, { recursive: true, force: true });
for (const file of tracked) {
  const rel = file.slice(ADDON.length + 1);
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (rel.endsWith('.md')) fs.writeFileSync(dest, relink(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  else fs.copyFileSync(path.join(ROOT, file), dest);
}
// The licence at the root for the library, and with the addon so it travels into every project that installs it.
const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
fs.writeFileSync(path.join(TO, 'LICENSE'), license);
fs.writeFileSync(path.join(out, 'LICENSE'), license);

fs.writeFileSync(
  path.join(TO, '.gitattributes'),
  `# The Godot Asset Library installs this repository's zip: only addons/ goes in it.
/README.md export-ignore
/LICENSE export-ignore
/.gitattributes export-ignore
/.gitignore export-ignore
`,
);
fs.writeFileSync(path.join(TO, '.gitignore'), '.godot/\n.DS_Store\n');
fs.writeFileSync(
  path.join(TO, 'README.md'),
  `# Glitchless for Godot

**Coding agents can build a game. They can't see anyone play it. Glitchless lets them.**

Glitchless is game observability for coding agents. This addon times every frame on every player's device and names
each hitch's likely cause, groups errors and crashes with what the player did just before, and shows where players
quit. Your coding agent (Claude Code, Codex, Cursor) reads it over MCP and fixes the next build. For Godot 4.5 and
later; this is version ${version}.

This repository is the addon alone, copied from [glitchless-gg/glitchless](${SOURCE}) at each release so the Godot
Asset Library can install it. Report issues and send changes there.

## Install

1. In the editor's AssetLib tab, search for Glitchless and install it (once it's listed there), or copy
   \`addons/glitchless/\` into your project's \`addons/\`.
2. Turn on the plugin under *Project Settings → Plugins*. It adds the \`Glitchless\` autoload.
3. Call \`Glitchless.init(...)\` when the game starts.

Or let your coding agent do it: [the setup steps](https://www.glitchless.gg/godot.html). The
[addon's README](addons/glitchless/README.md) has every option, and [PRIVACY.md](addons/glitchless/PRIVACY.md) lists
what each privacy mode sends (anonymous by default).

Free on [Glitchless Cloud](https://www.glitchless.gg/pricing.html) (5,000 play sessions a month), or run the
open-source server yourself. MIT licence.
`,
);
console.log(`${ADDON} ${version} → ${out} (${tracked.length} files), with LICENSE, README.md, .gitattributes and .gitignore`);

// The Asset Store's zip: the mirror's addons/glitchless/ alone, just written, so nothing else can be in it. -X leaves
// out macOS's extra attributes, which would otherwise come out as __MACOSX files.
const zip = path.join(ROOT, 'dist', 'godot-asset-store', `glitchless-${version}.zip`);
fs.mkdirSync(path.dirname(zip), { recursive: true });
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, 'addons/glitchless', '-x', '*.DS_Store'], { cwd: TO });
console.log(`Asset Store zip → ${path.relative(ROOT, zip)} (${Math.round(fs.statSync(zip).size / 1024)} KB): upload it as version ${version}`);
