// Copies the Claude Code plugin's skills into plugins/glitchless, the Agent Plugins package that Codex and ChatGPT,
// Cursor and Antigravity install (its manifests point them at the hosted MCP server; the Claude Code plugin in
// plugin/glitchless keeps its own local server). plugin/glitchless/skills is the source; the copies are committed
// because those tools install straight from this repo.
//   node scripts/sync-agent-plugin.mjs           write the copies
//   node scripts/sync-agent-plugin.mjs --check   fail if they differ from the source (npm test runs this)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'plugin', 'glitchless', 'skills');
const TO = path.join(ROOT, 'plugins', 'glitchless', 'skills');
// The deck skill drives a Steam Deck on the local network: it stays in the Claude Code plugin and the skills repo.
const SKILLS = ['instrument', 'dashboard', 'triage'];
const check = process.argv.includes('--check');

// Every file under a folder, as paths relative to it.
function files(dir, rel = '') {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.name === '.DS_Store' ? [] : e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
  );
}

// Skill loaders read frontmatter as strict YAML: an unquoted value with ": " or " #" in it breaks it.
function checkFrontmatter(file, text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (!fm) throw new Error(`${file}: no frontmatter`);
  for (const line of fm.split('\n')) {
    const value = line.match(/^[\w-]+: (.*)$/)?.[1];
    if (value && !/^["'|>]/.test(value) && /: | #/.test(value)) throw new Error(`${file}: "${line.slice(0, 60)}…" has ": " or " #" in an unquoted value`);
  }
}

const stale = [];
for (const skill of SKILLS) {
  const src = path.join(FROM, skill);
  const dst = path.join(TO, skill);
  checkFrontmatter(`plugin/glitchless/skills/${skill}/SKILL.md`, fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'));
  const want = files(src);
  const have = files(dst);
  for (const f of new Set([...want, ...have])) {
    const a = want.includes(f) ? fs.readFileSync(path.join(src, f)) : null;
    const b = have.includes(f) ? fs.readFileSync(path.join(dst, f)) : null;
    if (a && b && a.equals(b)) continue;
    stale.push(path.join(skill, f));
    if (check) continue;
    if (a) {
      fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true });
      fs.writeFileSync(path.join(dst, f), a);
    } else fs.rmSync(path.join(dst, f));
  }
}
for (const extra of files(TO).filter((f) => !SKILLS.includes(f.split(path.sep)[0]))) {
  stale.push(extra);
  if (!check) fs.rmSync(path.join(TO, extra));
}

if (check && stale.length) {
  console.error(`plugins/glitchless/skills is behind plugin/glitchless/skills (${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''}).\nRun: node scripts/sync-agent-plugin.mjs`);
  process.exit(1);
}
console.log(check ? 'plugins/glitchless/skills matches the Claude Code plugin.' : `plugins/glitchless/skills: ${stale.length} file(s) written or removed.`);
