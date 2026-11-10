// The Glitchless Toolset in Unreal MCP. The test project's editor starts Unreal MCP on a port of its own, and an MCP
// client (plain JSON-RPC over HTTP, as an agent's client speaks it) finds the toolset among the editor's, with its
// Status and Measure tools, and calls Status, which says the game isn't playing (nothing starts Play In Editor here).
// Toolset 0.5.4 and earlier never registered itself with the Toolset Registry, so Unreal MCP never listed it.
//
//   node unreal/test/toolset.mjs               build the editor target, then check
//   node unreal/test/toolset.mjs --no-build    check with the last build
//
// Unreal MCP is on by default in 5.9 and off in 5.8, so the editor is started with it enabled either way.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PROJECT, UE_ROOT, WINDOWS, buildEditor, checker, freePort, requireEngine } from './harness.mjs';

const EDITOR = path.join(UE_ROOT, WINDOWS ? 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe' : 'Engine/Binaries/Mac/UnrealEditor-Cmd');
const { check, finish } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-toolset-'));

requireEngine();
if (!process.argv.includes('--no-build')) buildEditor(path.join(tmp, 'build.log'));

const port = await freePort();
const url = `http://127.0.0.1:${port}/mcp`;
const args = [PROJECT, '-nullrhi', '-unattended', '-nosplash', '-nosound', '-stdout', '-FullStdOutLogOutput', '-EnablePlugins=ModelContextProtocol',
  '-ModelContextProtocolStartServer', `-ModelContextProtocolPort=${port}`];
console.log(`starting the editor with Unreal MCP on ${port}…`);
const editor = spawn(EDITOR, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
editor.stdout.on('data', (d) => (out += d));
editor.stderr.on('data', (d) => (out += d));
const exited = new Promise((resolve) => editor.on('exit', (status, signal) => resolve({ status, signal })));

// One JSON-RPC message; the answer comes as JSON or as server-sent events, by the server's choice.
let session = null;
let nextId = 1;
async function rpc(method, params = {}, notification = false) {
  const id = notification ? undefined : nextId++;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
  });
  session = r.headers.get('mcp-session-id') || session;
  const text = await r.text();
  if (notification) return null;
  const messages = (r.headers.get('content-type') || '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const answer = messages.find((m) => m.id === id);
  if (!answer) throw new Error(`${method}: no answer (${r.status}): ${text.slice(0, 300)}`);
  if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error)}`);
  return answer.result;
}

// The text a tool call answered with.
const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const tools = [];
const found = { listed: '', described: '', status: '' };
try {
  const end = Date.now() + 600_000;
  let init = null;
  while (!init && Date.now() < end) {
    try {
      init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'glitchless-toolset-test', version: '1' } });
    } catch {
      const gone = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
      if (gone) throw new Error(`the editor quit (${JSON.stringify(gone)}) before Unreal MCP answered`);
    }
  }
  if (!init) throw new Error('Unreal MCP never answered');
  console.log(`Unreal MCP answered: ${init.serverInfo?.name} ${init.serverInfo?.version || ''}`);
  await rpc('notifications/initialized', {}, true);
  for (let cursor; ; ) {
    const page = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    if (!(cursor = page.nextCursor)) break;
  }
  const names = tools.map((t) => t.name);
  // A tool call made while the editor is still loading answers "Not run: … a slow task": wait, then call again.
  const call = async (name, args) => {
    const until = Date.now() + 300_000;
    for (;;) {
      const text = textOf(await rpc('tools/call', { name, arguments: args }));
      if (!/^Not run:/.test(text) || Date.now() > until) return text;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  // The toolset's tools are listed themselves, or reached through the server's toolset tools (5.9: list_toolsets,
  // describe_toolsets, call_tool with a toolset and a tool name).
  const direct = names.filter((n) => /glitchless/i.test(n));
  const lister = names.find((n) => /^list_toolsets$/.test(n));
  const describer = names.find((n) => /^describe_toolsets?$/.test(n)); // 5.8 describes one toolset, 5.9 several
  const caller = names.find((n) => /^call_tool$/.test(n));
  if (direct.length) found.listed = direct.join(', ');
  else if (lister) found.listed = await call(lister, {});
  const toolset = found.listed.match(/[\w.]*GlitchlessToolset[\w.]*/)?.[0] || 'GlitchlessToolset.GlitchlessToolset';
  if (describer) found.described = await call(describer, describer.endsWith('s') ? { toolset_names: [toolset] } : { toolset_name: toolset });
  const status = direct.find((n) => /status/i.test(n));
  if (status) found.status = await call(status, {});
  else if (caller) found.status = await call(caller, { toolset_name: toolset, tool_name: 'Status', arguments: {} });
} catch (e) {
  found.error = e.message;
} finally {
  editor.kill('SIGKILL');
  await exited;
  fs.writeFileSync(path.join(tmp, 'editor.log'), out);
  fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({ tools: tools.map((t) => ({ name: t.name, args: Object.keys(t.inputSchema?.properties || {}) })), found }, null, 1));
}

check('Unreal MCP answers, with the editor\'s tools', () => {
  assert.equal(found.error, undefined);
  assert.ok(tools.length > 0, 'no tools');
});
check('Unreal MCP lists the Glitchless Toolset', () => {
  assert.match(found.listed, /GlitchlessToolset/, `tools: ${tools.map((t) => t.name).join(', ')}; listed: ${found.listed.slice(0, 400)}`);
});
check('its Status and Measure tools are described', () => {
  assert.match(found.described, /Status/);
  assert.match(found.described, /Measure/);
});
check('Status answers through Unreal MCP: the game isn\'t playing, since nothing started Play In Editor', () => {
  assert.match(found.status, /isn't playing in the editor/, found.status.slice(0, 400));
});
finish(`Unreal MCP in the editor, ${WINDOWS ? 'Win64' : 'Mac'}`, tmp);
