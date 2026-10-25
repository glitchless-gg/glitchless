// Copies the Claude Code plugin's skills into the public skills repo (glitchless-gg/game-dev-skills), under the
// names people search for on skills.sh, and points their mentions of each other at the new names.
//   node scripts/export-skills.mjs [path to the game-dev-skills checkout]   (default ../game-dev-skills)
// It only writes those four folders (each skill's whole folder, references/ included); the repo's own skills
// (game-performance, threejs-performance, ...) are written there by hand. Run it after changing a plugin skill,
// then commit and push the skills repo after looking at the diff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'plugin', 'glitchless', 'skills');
const TO = path.resolve(process.argv[2] || path.join(ROOT, '..', 'game-dev-skills'), 'skills');

// plugin skill → skills repo name
const NAMES = {
  instrument: 'glitchless-setup',
  dashboard: 'glitchless-dashboard',
  triage: 'glitchless-triage',
  deck: 'steam-deck-testing',
};

if (!fs.existsSync(TO)) {
  console.error(`No skills folder at ${TO}. Pass the game-dev-skills checkout as the first argument.`);
  process.exit(1);
}

// The skills CLI parses frontmatter with the strict `yaml` package and skips a skill it can't read. The usual
// break is an unquoted value with ": " or " #" in it (YAML reads a second key, or a comment).
function checkFrontmatter(file, text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (!fm) throw new Error(`${file}: no frontmatter`);
  for (const line of fm.split('\n')) {
    const value = line.match(/^[\w-]+: (.*)$/)?.[1];
    if (value && !/^["'|>]/.test(value) && /: | #/.test(value)) {
      throw new Error(`${file}: "${line.slice(0, 60)}…" has ": " or " #" in an unquoted value; reword it or quote it`);
    }
  }
}

// "the `dashboard` skill", "the instrument skill": the other skills by their new names.
function rename(text) {
  for (const [a, b] of Object.entries(NAMES)) {
    text = text.replace(new RegExp(`(\`?)\\b${a}\\b\\1 skill`, 'g'), `\`${b}\` skill`);
  }
  return text;
}

// Every file under a folder, as paths relative to it.
function files(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.name === '.DS_Store' ? [] : e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
  );
}

for (const [from, to] of Object.entries(NAMES)) {
  const src = path.join(FROM, from);
  const skill = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8');
  checkFrontmatter(`plugin/glitchless/skills/${from}/SKILL.md`, skill);
  // The whole folder (SKILL.md and its references/), replacing what was there so removed files go too.
  const dir = path.join(TO, to);
  fs.rmSync(dir, { recursive: true, force: true });
  const copied = files(src);
  for (const rel of copied) {
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!rel.endsWith('.md')) {
      fs.copyFileSync(path.join(src, rel), out);
      continue;
    }
    let text = fs.readFileSync(path.join(src, rel), 'utf8');
    if (rel === 'SKILL.md') text = text.replace(/^name: .*$/m, `name: ${to}`);
    fs.writeFileSync(out, rename(text));
  }
  console.log(`${from} → skills/${to}/ (${copied.length} file${copied.length === 1 ? '' : 's'})`);
}
