// Adds the Glitchless SDK to a GameMaker project without the IDE: copies its scripts and objects into the project and
// lists them in its .yyp, in a "Glitchless" folder. It does what Tools → Import Local Package does, for a coding
// agent or a script. Running it again updates the SDK's files and leaves everything else alone.
//
//   node gamemaker/tools/install.mjs path/to/Game.yyp
//
// The .yyp is edited as text, a line per new asset, so the rest of the file stays byte for byte as GameMaker wrote
// it. Close the project in the IDE first, or let the IDE reload it when asked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['Glitchless', '__glitchless_core', '__glitchless_send', '__glitchless_sketch', '__glitchless_text', '__glitchless_device', '__glitchless_bug_report', '__glitchless_play', '__glitchless_engine'];
const OBJECTS = ['obj_glitchless', 'obj_glitchless_tail'];
const FOLDER = 'Glitchless';

const yypPath = process.argv[2];
if (!yypPath || !yypPath.endsWith('.yyp') || !fs.existsSync(yypPath)) {
  console.error('usage: node gamemaker/tools/install.mjs path/to/Game.yyp');
  process.exit(2);
}
const project = path.dirname(path.resolve(yypPath));
let yyp = fs.readFileSync(yypPath, 'utf8');
if (!/"\$GMProject"\s*:/.test(yyp)) {
  console.error(`${yypPath} is in GameMaker's older project format. Open it once in GameMaker 2024.2 or later, which converts it, then run this again.`);
  process.exit(2);
}
const eol = yyp.includes('\r\n') ? '\r\n' : '\n';

// Copy the SDK's asset folders over the project's (an update replaces the old files; an event file the new version
// no longer has is removed).
const copied = [];
for (const [dir, names] of [['scripts', SCRIPTS], ['objects', OBJECTS]]) {
  for (const name of names) {
    const from = path.join(SDK_ROOT, dir, name);
    const to = path.join(project, dir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
    copied.push(`${dir}/${name}/${name}.yy`);
  }
}

// List each asset in the .yyp's "resources" and the folder in "Folders", where they aren't already.
function insertInto(key, line) {
  const m = new RegExp(`("${key}"\\s*:\\s*\\[)`).exec(yyp);
  if (!m) throw new Error(`no "${key}" list in ${yypPath}`);
  const at = m.index + m[0].length;
  yyp = yyp.slice(0, at) + `${eol}    ${line}` + yyp.slice(at); // GameMaker indents list items by four spaces
}
let added = 0;
if (!new RegExp(`"folderPath"\\s*:\\s*"folders/${FOLDER}\\.yy"`).test(yyp)) {
  insertInto('Folders', `{"$GMFolder":"","%Name":"${FOLDER}","folderPath":"folders/${FOLDER}.yy","name":"${FOLDER}","resourceType":"GMFolder","resourceVersion":"2.0",},`);
}
for (const rel of copied.slice().reverse()) {
  const name = path.basename(rel, '.yy');
  if (yyp.includes(`"path":"${rel}"`) || yyp.includes(`"path": "${rel}"`)) continue;
  insertInto('resources', `{"id":{"name":"${name}","path":"${rel}",},},`);
  added++;
}
// An empty list written as [] gets its closing bracket on a line of its own once it has items.
yyp = yyp.replace(/("(?:Folders|resources)"\s*:\s*\[)((?:\r?\n[ \t]*\{[^\n]*\},)+)\]/g, (all, head, items) => `${head}${items}${eol}  ]`);
fs.writeFileSync(yypPath, yyp);

console.log(`Glitchless added to ${path.basename(yypPath)}: ${copied.length} assets copied into scripts/ and objects/, ${added} listed in the .yyp.`);
console.log('Next: call glitchless_init(...) in your first room\'s creation code or your first object\'s Create event (gamemaker/README.md).');
