// The server's instructions (context.js): what an agent reads before any tool. Claude Code keeps 4,096 characters of
// them (2,048 before v2.1.296) and, with tool search, loads only them and the tools' names upfront. So for every kind
// of connection they stay under 2,048 characters, put the first step of each task in order (set up a game, then read
// one, then check a change), end with the feedback sentence, and name no tool the connection doesn't have. Every
// tool's description fits in the 4,096 characters Claude Code keeps of one; a mode's or an option's detail goes in its
// parameter's description, which isn't cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-instructions-'));
delete process.env.GLITCHLESS_API_KEY;

const { createServer, connection, SETUP_URL } = await import('../src/context.js');
await import('../src/hosted-tools.js');
await import('../src/tools/playtest.js');
await import('../src/tools/deck.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const KEY = `gl_ws_${'k'.repeat(43)}`;
const LIMIT = 2048;

// Every connection a server can be built for: glitchless-mcp on this computer, the hosted server as each set of scopes
// sees it (the claude.ai connector's default, read only, read alone), and glitchless-mcp serve (no scopes).
const MODES = {
  stdio: {},
  'hosted, manage': { remote: true, scopes: ['read', 'dashboard', 'manage'] },
  'hosted, read only': { remote: true, scopes: ['read', 'dashboard'] },
  'hosted, read alone': { remote: true, scopes: ['read'] },
  'glitchless-mcp serve': { remote: true },
};

async function connect(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ ...options, connection: options.remote ? connection({ base: 'http://127.0.0.1:9', apiKey: KEY }) : null }).connect(a);
  const c = new Client({ name: 'instructions-test', version: '0' });
  await c.connect(b);
  const tools = new Set((await c.listTools()).tools.map((t) => t.name));
  const text = c.getInstructions();
  await c.close();
  return { text, tools };
}

for (const [mode, options] of Object.entries(MODES)) {
  test(`${mode}: the instructions fit in ${LIMIT} characters, first steps first, naming only tools it has`, async () => {
    const { text, tools } = await connect(options);
    assert.ok(text.length < LIMIT, `${text.length} characters`);

    for (const name of new Set(text.match(/glitchless_\w+/g))) assert.ok(tools.has(name), `names ${name}, which this connection doesn't have`);

    const manage = !options.scopes || options.scopes.includes('manage');
    const steps = [
      text.indexOf('Glitchless is observability for games'),
      manage ? text.indexOf("call glitchless_create_game first, before changing the game's code") : text.indexOf(`follow the setup steps at ${SETUP_URL}: this connection may only read`),
      text.indexOf('start with glitchless_triage'),
      ...(options.remote ? [] : [text.indexOf('run glitchless_playtest with save_as "baseline"')]),
      text.indexOf('glitchless_compare_versions confirms it with real players'),
      text.indexOf('tell the Glitchless team with glitchless_feedback'),
    ];
    assert.ok(steps.every((at) => at >= 0), `every step is there: ${steps}`);
    assert.deepEqual([...steps].sort((x, y) => x - y), steps, 'in order');
    assert.match(text, /tell the Glitchless team with glitchless_feedback\. You may send one without asking first, but never once the person has said not to\. At the end of your turn, tell the person what you sent and the ID it gave\.$/, 'the feedback sentence ends them');

    assert.equal(text.includes('A read-only link to a board: glitchless_share_links.'), manage, 'share links, where the connection can make them');
    if (options.remote) assert.match(text, /If a game hasn't sent data yet, say so first and give the person its next_step before answering anything else\./);
    else assert.match(text, /glitchless_sign_in connects you to the person's whole workspace/);
  });
}

test("every tool's description fits in the 4,096 characters Claude Code keeps, on this computer and hosted", async () => {
  for (const options of [{}, { remote: true }]) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ ...options, connection: options.remote ? connection({ base: 'http://127.0.0.1:9', apiKey: KEY }) : null }).connect(a);
    const c = new Client({ name: 'instructions-test', version: '0' });
    await c.connect(b);
    const tools = (await c.listTools()).tools;
    await c.close();
    for (const t of tools) assert.ok(t.description.length <= 4096, `${t.name}: ${t.description.length} characters`);
  }
});

// What left the instructions went to the tool it's about, so an agent that reads that tool still finds it.
test('what the instructions no longer carry is in the tools it concerns', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const c = new Client({ name: 'instructions-test', version: '0' });
  await c.connect(b);
  const tools = (await c.listTools()).tools;
  await c.close();
  const by = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  const param = (tool, name) => tools.find((t) => t.name === tool).inputSchema.properties[name].description;
  assert.match(by.glitchless_list_games, /hasn't sent data yet comes with next_step: tell the person it has no data yet and give them that step before answering anything else/);
  assert.match(by.glitchless_compare_versions, /bump the version the game passes to Glitchless\.init first/);
  assert.match(by.glitchless_performance, /WebMCP connected has live tools \(glitchless_live_performance, glitchless_measure, glitchless_inspect_scene/);
  assert.match(by.glitchless_performance, /--glitchless-measure=SECONDS \(-glitchless-measure in Unreal and GameMaker\)/);
  assert.match(by.glitchless_performance, /Unreal MCP with the Glitchless Toolset has a Measure tool/);

  // And what left the three descriptions that were over 4,096 went to their parameters, or to the dashboard guide.
  assert.match(param('glitchless_store', 'show'), /Glitchless also counts a stopped game loop/);
  assert.match(param('glitchless_store', 'show'), /a fall, such as fraud itch\.io removed, counts as none/);
  assert.match(param('glitchless_store', 'show'), /Pre Order; add-on purchases and cancelled or charged pre-orders listed but not counted as the game/);
  assert.match(param('glitchless_playtest', 'check_url'), /CPU slowed 4×, a phone's touch screen and a 4G-like connection, two thirds as long/);
  assert.match(param('glitchless_playtest', 'check_url'), /an open-source server gets the dashboard and no link/);
  assert.match(param('glitchless_playtest', 'check_name'), /the check goes to "<name> \(game check\)"/);
  assert.match(param('glitchless_playtest', 'ai'), /at most 40 screenshots a profile/);
  assert.match(param('glitchless_playtest', 'engine'), /Enable Studio as MCP server/);
  assert.match(by.glitchless_set_dashboard, /glitchless_dashboard with guide: true says how, with example dashboards and every panel's options/);
});
