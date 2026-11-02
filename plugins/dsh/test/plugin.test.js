// The DeepSeek Harness plugin (plugins/dsh): it registers the three skills under the names DSH users get from
// skills.sh too, each with its body and its folder for references/, and its bundle patch mounts DSH's MCP client on
// glitchless-mcp. A real DSH loads it the same way (checked by hand with DSH 0.2.1-rc.5: 27 mcp__glitchless__ tools,
// the skills in the slash menu, and a DeepSeek turn calling glitchless_list_games and glitchless_triage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../index.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('apply registers each skill once on ctx.skills, with its body and its folder', () => {
  const registered = [];
  plugin.apply({ skills: { register: (skill) => (registered.push(skill), () => {}) } });
  assert.deepEqual(registered.map((s) => s.name).sort(), ['glitchless-dashboard', 'glitchless-setup', 'glitchless-triage']);
  assert.deepEqual(plugin.inject, ['skills']);
  for (const skill of registered) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'DSH skill names are kebab-case');
    assert.ok(skill.description.length > 40, skill.name);
    assert.doesNotMatch(skill.description, /^["']/, 'quotes are taken off');
    assert.ok(skill.content.startsWith('\n# '), `${skill.name}: the body, without its frontmatter`);
    assert.equal(skill.resourceBase.kind, 'directory');
    assert.ok(fs.existsSync(path.join(skill.resourceBase.path, 'SKILL.md')));
  }
  const setup = registered.find((s) => s.name === 'glitchless-setup');
  assert.ok(fs.existsSync(path.join(setup.resourceBase.path, 'references', 'godot.md')), 'references/ sits under the base');
});

test('parseSkill reads quoted and plain values', () => {
  const { meta, content } = plugin.parseSkill('---\nname: x\ndescription: "Has: a colon"\n---\n\n# Body\n');
  assert.deepEqual(meta, { name: 'x', description: 'Has: a colon' });
  assert.equal(content, '\n# Body\n');
  assert.throws(() => plugin.parseSkill('# no frontmatter'));
});

test('the package is a DSH bundle that mounts this plugin and the MCP client on glitchless-mcp', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.keywords.includes('dsh-plugin'));
  for (const file of pkg.files) assert.ok(fs.existsSync(path.join(DIR, file)), `${file} is in the package`);
  const patch = fs.readFileSync(path.join(DIR, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`name: ${pkg.name}\\n`), 'the patch mounts this package');
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, /serverName: glitchless\n/);
  assert.match(patch, /args: \['-y', 'glitchless-mcp'\]/);
  assert.doesNotMatch(patch, /gl_(ws|sk|ct)_/, 'no key in the patch');
});
