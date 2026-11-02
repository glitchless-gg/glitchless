// Copies the DeepSeek Harness plugin into its own public repo (glitchless-gg/glitchless-dsh). DSH installs plugins
// from npm or from a repo whose root holds the package, and dsh-plugin.org lists a repo only when its root has the
// package.json and it carries the dsh-plugin topic, so the plugin can't be listed from a folder of this repo.
//   node scripts/export-dsh-plugin.mjs [path to the glitchless-dsh checkout]   (default ../glitchless-dsh)
// It copies the files git tracks in plugins/dsh, replacing what was there so removed files go too. Run it after
// changing the plugin or its skills (node scripts/sync-agent-plugin.mjs first), then commit, tag v<version> and push the
// mirror after looking at the diff, and publish the package to npm from the mirror.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'plugins/dsh';
const TO = path.resolve(process.argv[2] || path.join(ROOT, '..', 'glitchless-dsh'));

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, PLUGIN, 'package.json'), 'utf8'));
const tracked = execFileSync('git', ['ls-files', PLUGIN], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
if (!tracked.length) throw new Error(`git tracks nothing in ${PLUGIN}`);

// Everything but the mirror's own git history goes, so a file removed here goes there too: only in an empty folder
// or one that already holds this package.
fs.mkdirSync(TO, { recursive: true });
const there = path.join(TO, 'package.json');
const mirror = fs.existsSync(there) && JSON.parse(fs.readFileSync(there, 'utf8')).name === 'glitchless-dsh';
if (!mirror && fs.readdirSync(TO).some((entry) => entry !== '.git')) throw new Error(`${TO} isn't empty and isn't the glitchless-dsh mirror`);
for (const entry of fs.readdirSync(TO)) if (entry !== '.git') fs.rmSync(path.join(TO, entry), { recursive: true, force: true });
for (const file of tracked) {
  const dest = path.join(TO, file.slice(PLUGIN.length + 1));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), dest);
}
fs.writeFileSync(path.join(TO, '.gitignore'), 'node_modules/\n.DS_Store\n');
console.log(`${PLUGIN} ${version} → ${TO} (${tracked.length} files), with .gitignore`);
