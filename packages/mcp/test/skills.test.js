// The skills served over MCP (served-skills.js), as a client of the Skills extension lists and reads them with the
// SDK's SkillsClient, which checks every file against its listed size and digest: the hosted server's (over HTTP, a
// server per request) and glitchless-mcp's on this computer (over stdio, the real process), which alone adds deck.
// A connection gets only the skills whose tools it has; each skill is the plugin's own, word for word, under its name;
// they fit what Claude Code loads (100 skills a server, 100 KB a text file, 400 KB a skill, nothing under dist/, no
// WebP); the resource list promises no changes; --no-skills (stdio and serve) and /mcp?skills=off serve none, and no
// resources; every skill folder is in the one list; and a skill the SDK refuses, or an attach that fails, leaves the
// server serving its tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-skills-'));
delete process.env.GLITCHLESS_API_KEY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG = path.join(ROOT, 'packages/mcp');
const SKILL_DIR = path.join(ROOT, 'plugin/glitchless/skills');

const { connection, createServer } = await import('../src/context.js');
const { createHttpHandler, serve } = await import('../src/http.js');
const { skillsFor, buildCatalogs, serveSkills } = await import('../src/served-skills.js');
const { SKILLS, TEXTS } = await import('../src/skills.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { SkillsClient, SKILLS_EXTENSION_ID } = await import('@modelcontextprotocol/client/ext/skills');

const KEY = `gl_ws_${'k'.repeat(43)}`;
const mcp = createHttpHandler();
let requests = 0;
let scopes = ['read', 'dashboard', 'manage'];
const host = http.createServer((req, res) => {
  requests++;
  return mcp.handle(req, res, { connection: connection({ base: 'http://127.0.0.1:9', apiKey: KEY }), scopes });
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${host.address().port}/mcp`;
test.after(() => host.close());

const quiet = async (client) => {
  const c = new Client({ name: 'skills-test', version: '0' });
  await c.connect(client);
  return c;
};
const hosted = (url = endpoint) => quiet(new StreamableHTTPClientTransport(new URL(url)));
const stdio = (...args) => quiet(new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'src/index.js'), ...args], cwd: PKG, env: { ...process.env, GLITCHLESS_URL: 'http://127.0.0.1:9' }, stderr: 'ignore' }));

// A skill's files as the plugin has them: { 'references/unity.md': text }.
function pluginFiles(skill, dir = path.join(SKILL_DIR, skill), rel = '') {
  return Object.fromEntries(
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.name === '.DS_Store' ? [] : e.isDirectory() ? Object.entries(pluginFiles(skill, dir, path.join(rel, e.name))) : [[path.join(rel, e.name).split(path.sep).join('/'), fs.readFileSync(path.join(dir, rel, e.name), 'utf8')]],
    ),
  );
}

// A server that serves no skills: no extension, no resources, and its tools all there.
async function servesNone(client, why) {
  const skills = new SkillsClient(client);
  assert.equal(skills.supported, false, why);
  assert.equal(client.getServerCapabilities().extensions?.[SKILLS_EXTENSION_ID], undefined, why);
  assert.equal(client.getServerCapabilities().resources, undefined, `${why}: no resources either`);
  assert.deepEqual((await skills.list()).skills, [], why);
  assert.ok((await client.listTools()).tools.length >= 17, `${why}: its tools are there`);
}

// Lists the skills and reads every file of each through SkillsClient (which throws on a size or digest that differs
// from the listing), checking each against the plugin and against Claude Code's limits.
async function readAll(client, want) {
  const skills = new SkillsClient(client);
  assert.ok(skills.supported, 'the server declares the Skills extension');
  assert.ok(client.getServerCapabilities().extensions?.[SKILLS_EXTENSION_ID], SKILLS_EXTENSION_ID);
  assert.deepEqual(client.getServerCapabilities().resources, { listChanged: false }, 'no resource-list changes promised');
  const { skills: entries } = await skills.list();
  assert.ok(entries.length <= 100, 'Claude Code shows up to 100 skills a server');
  assert.deepEqual(entries.map((e) => e.frontmatter.name).sort(), [...want].sort());
  for (const entry of entries) {
    const name = entry.frontmatter.name;
    assert.equal(entry.uri, `skill://${name}/SKILL.md`, 'named as the plugin names it');
    const plugin = pluginFiles(name);
    const listed = entry.resources.map((r) => r.uri.slice(`skill://${name}/`.length)).sort();
    assert.deepEqual(listed, Object.keys(plugin).sort(), `${name}: the plugin's files, no more and no fewer`);
    let bytes = 0;
    for (const r of entry.resources) {
      const rel = r.uri.slice(`skill://${name}/`.length);
      assert.ok(r.size <= 100 * 1024, `${r.uri}: ${r.size} bytes, over the 100 KB a text file Claude Code loads`);
      assert.ok(!/(^|\/)dist\/|\.webp$/i.test(rel), `${r.uri}: Claude Code skips a skill with this`);
      bytes += r.size;
      const file = await skills.read(entry, rel);
      assert.ok(file.verified, `${r.uri}: size and digest checked`);
      assert.equal(file.text, plugin[rel], `${r.uri}: the plugin's text`);
    }
    assert.ok(bytes <= 400 * 1024, `${name}: ${bytes} bytes, over the 400 KB a skill Claude Code loads`);
    const md = await skills.read(entry);
    assert.match(md.body, /^\s*# /, `${name}: SKILL.md's body follows its frontmatter`);
    assert.equal(md.frontmatter.description, entry.frontmatter.description);
  }
  return entries;
}

test('the hosted server serves instrument, dashboard and triage to a connection with every scope, each read in requests of its own', async () => {
  scopes = ['read', 'dashboard', 'manage'];
  const client = await hosted();
  const before = requests;
  await readAll(client, ['instrument', 'dashboard', 'triage']);
  assert.ok(requests - before > 15, 'every list and read is a request, each to a server built for it');
  // Another client, another set of servers: the one catalog serves them all the same.
  const again = await hosted();
  const [unity] = (await new SkillsClient(again).list()).skills.filter((s) => s.frontmatter.name === 'instrument');
  assert.match((await new SkillsClient(again).read(unity, 'references/unity.md')).text, /^# Unity/m);
  await client.close();
  await again.close();
});

test("a connection gets only the skills whose tools it has: instrument with manage, dashboard with the dashboard scope", async () => {
  for (const [given, want] of [
    [['read'], ['triage']],
    [['read', 'dashboard'], ['dashboard', 'triage']],
    [['read', 'manage'], ['instrument', 'triage']],
  ]) {
    scopes = given;
    const client = await hosted();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    assert.equal(names.has('glitchless_create_game'), given.includes('manage'), given.join());
    assert.equal(names.has('glitchless_set_dashboard'), given.includes('dashboard'), given.join());
    await readAll(client, want);
    await client.close();
  }
  scopes = ['read', 'dashboard', 'manage'];
});

test('/mcp?skills=off serves none, for a client whose plugin carries the skills', async () => {
  scopes = ['read', 'dashboard', 'manage'];
  const client = await hosted(`${endpoint}?skills=off`);
  await servesNone(client, '?skills=off');
  await client.close();
});

test('glitchless-mcp on this computer serves them and deck, which acts on this computer', async () => {
  assert.deepEqual(skillsFor(), ['instrument', 'dashboard', 'triage', 'deck']);
  const client = await stdio();
  await readAll(client, ['instrument', 'dashboard', 'triage', 'deck']);
  await client.close();
});

test('glitchless-mcp --no-skills, as the Claude Code plugin and the DeepSeek Harness plugin run it, serves none', async () => {
  const client = await stdio('--no-skills');
  await servesNone(client, '--no-skills');
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'glitchless_playtest'), 'and the tools on this computer are there');
  await client.close();
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/glitchless/.mcp.json'), 'utf8'));
  assert.ok(plugin.mcpServers.glitchless.args.includes('--no-skills'), "the Claude Code plugin's copy runs with --no-skills");
  assert.match(fs.readFileSync(path.join(ROOT, 'plugins/dsh/cordis.patch.yml'), 'utf8'), /args: \['-y', 'glitchless-mcp', '--no-skills'\]/, 'and the DeepSeek Harness one');
});

test('glitchless-mcp serve serves the hosted skills, and none with --no-skills', async (t) => {
  for (const [args, want] of [[[], ['instrument', 'dashboard', 'triage']], [['--no-skills'], null]]) {
    const served = await serve(['--port', '0', ...args]);
    t.after(() => served.close().closeAllConnections());
    const client = await hosted(`http://127.0.0.1:${served.address().port}/mcp`);
    if (want) await readAll(client, want);
    else await servesNone(client, 'serve --no-skills');
    await client.close();
  }
});

test('every folder in plugin/glitchless/skills is in the one list, served or deliberately left out', () => {
  const folders = fs.readdirSync(SKILL_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(Object.keys(SKILLS).sort(), folders, 'scripts/sync-agent-plugin.mjs SKILLS: run node scripts/sync-agent-plugin.mjs');
  for (const name of folders) assert.ok(TEXTS[`plugin/glitchless/skills/${name}/SKILL.md`], `${name}: in skills.js`);
});

test('a skill the SDK refuses, or an attach that fails, serves no skills and leaves the tools working', async () => {
  const said = [];
  const broken = { ...TEXTS, 'plugin/glitchless/skills/triage/SKILL.md': TEXTS['plugin/glitchless/skills/triage/SKILL.md'].replace(/^name: triage$/m, 'name: not-triage') };
  const none = await buildCatalogs({ texts: broken, log: (line) => said.push(line) });
  assert.equal(none.size, 0, 'no catalog at all');
  assert.match(said.join('\n'), /serving no skills: the skills did not load: .*not-triage/);

  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({ skills: false });
  serveSkills(server, {}, { from: none });
  await server.connect(a);
  await servesNone(await quiet(b), 'no catalogs');

  // A catalog whose attach throws, as one from a later SDK might.
  const later = new Map([[skillsFor().join(), { attach() { throw new Error('a later SDK attaches differently'); } }]]);
  const attachSaid = [];
  assert.doesNotThrow(() => serveSkills(createServer({ skills: false }), {}, { from: later, log: (line) => attachSaid.push(line) }));
  assert.match(attachSaid.join('\n'), /serving no skills: attaching them failed: a later SDK attaches differently/);
});
