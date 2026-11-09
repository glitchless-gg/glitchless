// The addon loads with no script warnings, as the Godot Asset Store's guidelines ask ("Fix or suppress all script
// warnings"). Godot hides warnings in addons/ by default, so a game's developer never sees them, but the store's
// reviewers do. This makes a fresh project holding only the addon, turns every warning Godot shows by default into an
// error, imports it and runs the autoload: any warning fails the import, with its file and line.
//   node godot/test/warnings.mjs   (part of npm run test:godot)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGodot } from './godot-bin.mjs';

const ADDON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'addons', 'glitchless');
const godot = findGodot();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-godot-warnings-'));
const run = (...args) => spawnSync(godot, ['--headless', '--path', dir, ...args], { encoding: 'utf8', timeout: 120_000 });

try {
  fs.cpSync(ADDON, path.join(dir, 'addons', 'glitchless'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Warnings"\n');

  // Godot's own list of warnings and their default levels (0 off, 1 warn, 2 error), from this Godot.
  fs.writeFileSync(
    path.join(dir, 'levels.gd'),
    `extends SceneTree
func _init():
	for p in ProjectSettings.get_property_list():
		if p.name.begins_with("debug/gdscript/warnings/") and typeof(ProjectSettings.get_setting(p.name)) == TYPE_INT:
			print("LEVEL ", p.name, "=", ProjectSettings.get_setting(p.name))
	quit()
`,
  );
  const shown = [...run('-s', 'levels.gd').stdout.matchAll(/^LEVEL (debug\/gdscript\/warnings\/\w+)=1$/gm)].map((m) => m[1]);
  if (shown.length < 20) throw new Error(`read only ${shown.length} warning settings from Godot`);

  // Every warning shown by default becomes an error, addons included. Godot 4.7 hides addons with directory_rules;
  // 4.5 and 4.6 with exclude_addons.
  fs.writeFileSync(
    path.join(dir, 'project.godot'),
    `config_version=5

[application]
config/name="Warnings"

[autoload]
Glitchless="*res://addons/glitchless/glitchless.gd"

[debug]
${shown.map((name) => `${name.replace('debug/', '')}=2`).join('\n')}
gdscript/warnings/exclude_addons=false
gdscript/warnings/directory_rules={}

[editor_plugins]
enabled=PackedStringArray("res://addons/glitchless/plugin.cfg")
`,
  );
  fs.writeFileSync(
    path.join(dir, 'start.gd'),
    `extends SceneTree
func _process(_delta):
	var gl = root.get_node_or_null("Glitchless")
	print("STARTED ", gl.SDK if gl else "none")
	quit()
	return true
`,
  );
  const imported = run('--import');
  const started = run('-s', 'start.gd');
  const out = `${imported.stdout}${imported.stderr}${started.stdout}${started.stderr}`;
  const problems = out.split('\n').filter((l, i, all) => /SCRIPT ERROR|^ERROR/.test(l) || /^\s+at: GDScript/.test(l) && /SCRIPT ERROR/.test(all[i - 1] || ''));
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n✘ the addon has script warnings (${shown.length} kinds checked): fix them, or mark one that is meant with @warning_ignore`);
    process.exit(1);
  }
  if (!/^STARTED glitchless-godot\//m.test(out)) {
    console.error(out);
    console.error('\n✘ the Glitchless autoload did not start in a fresh project');
    process.exit(1);
  }
  console.log(`✔ no script warnings in the addon (${shown.length} kinds Godot shows by default, as errors), and its autoload starts in a fresh project`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
