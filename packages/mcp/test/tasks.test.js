// Tasks (tasks.js): glitchless_playtest, called by a client that says on the call it takes MCP tasks
// (io.modelcontextprotocol/tasks, protocol 2026-07-28), answers at once with a task; tasks/get has the latest step and
// then the result, and tasks/cancel kills the build. A client that doesn't say so waits for the result as before, and
// the hosted server's tools never run as tasks. The playtests run a stand-in engine build (glitchless-playtest's
// fixtures/fake-build.mjs). The SDK's own client can't take a task, so the 2026-07-28 calls are written by hand, as a
// client sends them, over an in-memory connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-tasks-'));
for (const k of ['GLITCHLESS_API_KEY', 'GLITCHLESS_URL', 'GLITCHLESS_SERVICE', 'GLITCHLESS_GAME']) delete process.env[k];

const FAKE_BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../playtest/test/fixtures/fake-build.mjs');
const { createServer, TASK_LIMITS } = await import('../src/context.js').then(async (m) => ({ ...m, ...(await import('../src/tasks.js')) }));
await import('../src/hosted-tools.js');
await import('../src/tools/playtest.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { define, callProgress } = await import('../src/context.js');
const { CAN_STOP } = await import('../src/tools/playtest.js');

// A task tool whose work can't stop part-way, as glitchless_playtest is with a glitchless-playtest older than 0.5.0.
define('test_unstoppable', { description: 'A test tool that ignores cancelling.', inputSchema: {} }, async (args, ctx) => {
  callProgress(ctx).cantStop();
  await new Promise((r) => setTimeout(r, 3000));
  return { content: [{ type: 'text', text: 'done' }] };
}, { local: true, task: true });
const { serveStdio } = await import('@modelcontextprotocol/server/stdio');

// A game project whose build plays one scenario with these params (fake-build.mjs: sleep, mode, pidfile).
function project(params) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-task-game-'));
  fs.writeFileSync(path.join(dir, 'glitchless.playtest.json'), JSON.stringify({ command: [process.execPath, FAKE_BUILD], engine: 'godot', scenarios: [{ name: 'run', params: { autoplay: true, ...params }, seconds: 2 }] }));
  process.chdir(dir);
  return dir;
}

const TASKS = 'io.modelcontextprotocol/tasks';
const meta = (capabilities = { extensions: { [TASKS]: {} } }) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': capabilities });

// A 2026-07-28 client by hand, against the stdio server as index.js serves it (serveStdio, over an in-memory pipe):
// rpc(method, params, capabilities) → the JSON-RPC response.
async function rawClient(factory = () => createServer()) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const waiting = new Map();
  b.onmessage = (m) => m.id != null && waiting.get(m.id)?.(m);
  serveStdio(factory, { transport: a });
  await b.start();
  let id = 0;
  const rpc = (method, params = {}, capabilities) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      b.send({ jsonrpc: '2.0', id: n, method, params: { ...params, _meta: meta(capabilities) } });
    });
  return { rpc, close: () => b.close() };
}

const until = async (f, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('the stdio server says it serves tasks; the hosted one does not', async () => {
  const { rpc } = await rawClient();
  const found = await rpc('server/discover');
  assert.deepEqual(found.result.capabilities.extensions?.[TASKS], {});
  const hosted = await rawClient(() => createServer({ remote: true }));
  assert.equal((await hosted.rpc('server/discover')).result.capabilities.extensions?.[TASKS], undefined);
  // An older client (initialize) can't take a task, and isn't told of them.
  const [x, y] = InMemoryTransport.createLinkedPair();
  serveStdio(() => createServer(), { transport: x });
  const old = new Client({ name: 'test', version: '0' });
  await old.connect(y);
  assert.equal(old.getServerCapabilities().extensions?.[TASKS], undefined);
  assert.equal(old.getServerCapabilities().tools?.listChanged, false);
  await old.close();
  // And the hosted server has no tasks/get to ask.
  assert.equal((await hosted.rpc('tasks/get', { taskId: 'x' })).error.code, -32601);
});

test('a playtest becomes a task: working with its latest step, then completed with the result', async () => {
  project({ sleep: 2500 });
  const { rpc } = await rawClient();
  const t0 = Date.now();
  const called = await rpc('tools/call', { name: 'glitchless_playtest', arguments: { save_as: 'baseline' } });
  assert.ok(Date.now() - t0 < TASK_LIMITS.graceMs + 1000, 'it answers at once, not when the playtest ends');
  const task = called.result;
  assert.equal(task.resultType, 'task');
  assert.match(task.taskId, /^[\x21-\x7e]{1,128}$/, "Claude Code's limit: 128 printable ASCII characters");
  assert.equal(task.status, 'working');
  assert.ok(!Number.isNaN(Date.parse(task.createdAt)) && !Number.isNaN(Date.parse(task.lastUpdatedAt)));
  assert.equal(task.pollIntervalMs, 2000);
  assert.ok(task.ttlMs >= 3600e3, 'a finished result stays at least an hour');
  assert.equal(task.result, undefined);

  const working = (await rpc('tasks/get', { taskId: task.taskId })).result;
  assert.equal(working.resultType, 'complete');
  assert.equal(working.status, 'working');
  assert.match(working.statusMessage, /run 1\/1: run|Candidate: running/);

  const done = await until(async () => {
    const r = (await rpc('tasks/get', { taskId: task.taskId })).result;
    return r.status === 'completed' && r;
  });
  assert.equal(done.result.isError, undefined);
  assert.match(done.result.content[0].text, /Verdict: NONE/);
  assert.match(done.result.content[0].text, /Saved as `baseline`/);
  assert.ok(done.ttlMs >= 3600e3);
  // It stays readable, and cancelling a finished task changes nothing.
  assert.deepEqual((await rpc('tasks/cancel', { taskId: task.taskId })).result, { resultType: 'complete', _meta: (await rpc('tasks/cancel', { taskId: task.taskId })).result._meta });
  assert.equal((await rpc('tasks/get', { taskId: task.taskId })).result.status, 'completed');
});

test('cancelling the task kills the build, and the task reads cancelled', async () => {
  const dir = project({ mode: 'hang', pidfile: path.join(os.tmpdir(), `glitchless-task-${process.pid}.pid`) });
  const pidfile = path.join(os.tmpdir(), `glitchless-task-${process.pid}.pid`);
  fs.rmSync(pidfile, { force: true });
  const { rpc } = await rawClient();
  const task = (await rpc('tools/call', { name: 'glitchless_playtest', arguments: {} })).result;
  assert.equal(task.status, 'working');
  await until(() => fs.existsSync(pidfile));
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  const ack = (await rpc('tasks/cancel', { taskId: task.taskId })).result;
  assert.equal(ack.resultType, 'complete');
  const after = (await rpc('tasks/get', { taskId: task.taskId })).result;
  assert.equal(after.status, 'cancelled');
  assert.match(after.statusMessage, /Cancelled/);
  assert.equal(after.result, undefined);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000);
  assert.ok(!fs.existsSync(path.join(dir, '.glitchless/playtest/latest.json')), 'a cancelled run is not saved');
});

test("cancelling says what happened: stopped with this glitchless-playtest, only asked with one that can't stop", async () => {
  assert.equal(CAN_STOP, true, 'the glitchless-playtest in this repo stops runs');
  const { rpc } = await rawClient();
  const task = (await rpc('tools/call', { name: 'test_unstoppable', arguments: {} })).result;
  assert.equal(task.resultType, 'task');
  await rpc('tasks/cancel', { taskId: task.taskId });
  const after = (await rpc('tasks/get', { taskId: task.taskId })).result;
  assert.equal(after.status, 'cancelled');
  assert.match(after.statusMessage, /^Cancelled: asked the run to stop, but the glitchless-playtest installed here \(older than 0\.5\.0\) can't stop part-way, so it plays to the end in the background and saves its run/);
});

test('one run at a time in a project: a second call while one runs is refused, and the next one after it ends works', async () => {
  project({ sleep: 2500 });
  const { rpc } = await rawClient();
  const first = (await rpc('tools/call', { name: 'glitchless_playtest', arguments: {} })).result;
  assert.equal(first.resultType, 'task');
  const [second, plain] = await Promise.all([rpc('tools/call', { name: 'glitchless_playtest', arguments: {} }), rpc('tools/call', { name: 'glitchless_playtest', arguments: { check_url: 'https://example.test/' } }, {})]);
  for (const r of [second.result, plain.result]) {
    assert.equal(r.isError, true, JSON.stringify(r));
    assert.match(r.content[0].text, /A playtest is already running in this project \(started \d+ s ago\)\. Wait for its result before starting another: two at once fight over the GPU/);
  }
  await until(async () => (await rpc('tasks/get', { taskId: first.taskId })).result.status === 'completed');
  const again = (await rpc('tools/call', { name: 'glitchless_playtest', arguments: {} })).result;
  assert.equal(again.resultType, 'task', 'free again once the first ended');
  await until(async () => (await rpc('tasks/get', { taskId: again.taskId })).result.status === 'completed');
});

test('a call that fails at once answers directly, not as a task', async () => {
  project({});
  const { rpc } = await rawClient();
  const r = (await rpc('tools/call', { name: 'glitchless_playtest', arguments: { compare_to: 'never-saved' } })).result;
  assert.equal(r.resultType, 'complete');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No saved playtest run named "never-saved"/);
});

test('tasks/get, tasks/cancel and tasks/update refuse a client that did not declare tasks, and an unknown task', async () => {
  const { rpc } = await rawClient();
  for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
    const refused = await rpc(method, { taskId: 'nope', inputResponses: {} }, {});
    assert.equal(refused.error.code, -32021, method);
    assert.deepEqual(refused.error.data.requiredCapabilities, { extensions: { [TASKS]: {} } });
    const unknown = await rpc(method, { taskId: 'nope', inputResponses: {} });
    assert.equal(unknown.error.code, -32602, method);
    assert.match(unknown.error.message, /Task not found/);
  }
});

test('a call that is not a task runs to the end when its client gives up on it, as before: the baseline is saved', async () => {
  const dir = project({ sleep: 1500 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  serveStdio(() => createServer(), { transport: a });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const gaveUp = new AbortController();
  const call = client.callTool({ name: 'glitchless_playtest', arguments: { save_as: 'baseline' } }, { signal: gaveUp.signal });
  setTimeout(() => gaveUp.abort(), 300);
  await assert.rejects(call);
  await until(() => fs.existsSync(path.join(dir, '.glitchless/playtest/baseline.json')), 15_000);
  await client.close();
});

test('a client that does not take tasks gets the result itself, as before, on either protocol', async () => {
  project({ sleep: 2000 });
  const { rpc } = await rawClient();
  const plain = (await rpc('tools/call', { name: 'glitchless_playtest', arguments: {} }, {})).result;
  assert.equal(plain.resultType, 'complete');
  assert.match(plain.content[0].text, /Verdict: NONE/);

  for (const mode of [undefined, { pin: '2026-07-28' }]) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    serveStdio(() => createServer(), { transport: a });
    const client = new Client({ name: 'test', version: '0' }, mode ? { versionNegotiation: { mode } } : {});
    await client.connect(b);
    const r = await client.callTool({ name: 'glitchless_playtest', arguments: {} });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.match(r.content[0].text, /Verdict: NONE/);
    await client.close();
  }
});
