// Glitchless for DeepSeek Harness (DSH): a Cordis plugin that adds Glitchless's skills to DSH's skill catalog, as
// glitchless-setup, glitchless-dashboard and glitchless-triage. DSH skill names share one namespace, so they carry the
// names the skills.sh copies have: DSH also reads ~/.agents/skills, and someone with both gets one of each.
// cordis.patch.yml mounts this beside DSH's MCP client, which runs the glitchless-mcp server the skills call. The
// skills are copies of the Claude Code plugin's (node scripts/sync-agent-plugin.mjs keeps them in step); each loads
// with its folder as the base for the references/ files it points to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'glitchless';
export const inject = ['skills'];

const SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
// A skill's name in DSH, by its folder; the rest are glitchless-<folder>.
const NAMES = { instrument: 'glitchless-setup' };

// A SKILL.md's frontmatter (one `key: value` a line, values optionally quoted) and the Markdown after it.
export function parseSkill(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error('no frontmatter');
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    meta[kv[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return { meta, content: text.slice(match[0].length) };
}

// Every skill in skills/, as DSH's runtime registrations.
export function skills(dir = SKILLS) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => {
      const file = path.join(dir, entry.name, 'SKILL.md');
      const { meta, content } = parseSkill(fs.readFileSync(file, 'utf8'));
      return {
        name: NAMES[entry.name] ?? `glitchless-${entry.name}`,
        description: meta.description,
        content,
        path: file,
        source: 'plugin',
        resourceBase: { kind: 'directory', path: path.dirname(file) },
        metadata: meta,
      };
    });
}

export function apply(ctx) {
  // Each registration unwinds when the plugin unloads.
  for (const skill of skills()) ctx.skills.register(skill);
}
