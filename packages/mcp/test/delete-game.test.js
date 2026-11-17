// glitchless_create_game's delete: a game in the workspace goes for good, named with game and its name repeated back
// as the person confirmed it, with a key its person gave delete_games; when two games share the name, by its id.
// Called over an in-memory MCP connection against a fake Glitchless Cloud, which answers as the real one does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-delete-'));
delete process.env.GLITCHLESS_API_KEY;
delete process.env.GLITCHLESS_URL;

let games = [
  { id: 'p_test', name: 'Test Game', client_token: 'gl_pub_test', services: [] },
  { id: 'p_real', name: 'Real Game', client_token: 'gl_pub_real', services: [] },
];
const asked = [];
let canDelete = true;
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/v1/agent/games' && req.method === 'GET') return send(200, { games, intake: 'https://api.example.test' });
  const one = /^\/v1\/agent\/games\/([\w-]+)$/.exec(url.pathname);
  if (one && req.method === 'PATCH') {
    asked.push([one[1], 'PATCH']);
    return send(200, { game: { id: one[1], name: 'Renamed' } });
  }
  if (one && req.method === 'DELETE') {
    let raw = '';
    req.on('data', (d) => (raw += d));
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      asked.push([one[1], body]);
      if (!canDelete) return send(403, { error: 'This key can\'t delete games: deleting is off unless its person turns it on. They make a new key with "Delete games and their data, for good" ticked in Settings → Keys & access, or connect the app again and tick it there.', code: 'SCOPE' });
      const game = games.find((g) => g.id === one[1]);
      if (!game) return send(404, { error: 'No such game in this workspace.', code: 'PROJECT_NOT_FOUND' });
      const key = (n) => String(n).trim().toLowerCase();
      if (key(body.name) !== key(game.name)) return send(400, { error: "That isn't this game's name, so nothing was deleted.", code: 'CONFIRM_NAME' });
      const same = games.filter((g) => key(g.name) === key(body.name));
      if (same.length > 1 && body.id !== game.id) {
        const listed = same.map((g) => ({ id: g.id, name: g.name, created_at: g.created_at, has_data: g.services.length > 0, last_seen: g.services[0]?.last_seen ?? null }));
        return send(409, { error: `${same.length} games in this workspace are called "${body.name}": …`, code: 'SAME_NAME', games: listed });
      }
      games = games.filter((g) => g !== game);
      return send(200, { deleted: { id: game.id, name: game.name }, done: true });
    });
  }
  send(404, { error: 'Not found.' });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const { createServer, connection } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ remote: true, connection: connection({ base: `http://127.0.0.1:${api.address().port}`, apiKey: `gl_ws_${'k'.repeat(43)}` }) }).connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = (args) => client.callTool({ name: 'glitchless_create_game', arguments: args });

test.after(() => api.close());

test('delete needs the game named and its name again, takes nothing else, and says what happens next', async () => {
  const tool = (await client.listTools()).tools.find((t) => t.name === 'glitchless_create_game');
  assert.equal(tool.annotations.destructiveHint, true);
  assert.match(tool.description, /can't be undone/);
  assert.match(tool.description, /Owner or Admin/);
  assert.match(tool.description, /gone from Glitchless within the hour, and backups, including old copies of its files, keep it up to 35 more days/);
  assert.match(tool.description, /"Delete games and their data, for good", which is off unless they ticked it/);
  assert.match(tool.description, /When two games in the workspace share the name, nothing is deleted .* call again with game set to its id/);

  for (const [args, why] of [
    [{ delete: 'Test Game' }, /name the game to delete with game/],
    [{ game: 'Test Game', delete: 'Test Game', engine: 'godot' }, /leave out name, demo, rename, engine and files/],
    [{ game: 'Test Game', delete: 'Real Game' }, /isn't this game's name/],
  ]) {
    const r = await call(args);
    assert.ok(r.isError && why.test(r.content[0].text), r.content[0].text);
  }
  const done = await call({ game: 'test game', delete: 'TEST GAME' });
  assert.ok(!done.isError, done.content[0].text);
  assert.match(done.content[0].text, /^Deleted Test Game\. .*its client token is refused from now on; it's gone from Glitchless within the hour/);
  assert.deepEqual(asked.at(-1), ['p_test', { name: 'TEST GAME' }]);
  // The game is gone from the list, and later calls don't fall back to it.
  const again = await call({ game: 'Test Game', delete: 'Test Game' });
  assert.ok(again.isError && /No game called "Test Game"/.test(again.content[0].text), again.content[0].text);
  await call({ rename: 'Renamed' });
  assert.deepEqual(asked.at(-1), ['p_real', 'PATCH'], 'with no game named, the one game left');
});

test("a key without delete_games is refused with where to turn it on; two games of one name are deleted by id", async () => {
  games.push(
    { id: 'p_racer_old', name: 'Racer', created_at: '2026-10-01T10:00:00.000Z', client_token: 'gl_pub_a', services: [{ service: 'racer', last_seen: '2026-11-16T09:00:00.000Z' }] },
    { id: 'p_racer_new', name: 'racer', created_at: '2026-11-17T10:00:00.000Z', client_token: 'gl_pub_b', services: [] },
  );
  canDelete = false;
  const refused = await call({ game: 'Real Game', delete: 'Real Game' });
  assert.ok(refused.isError && /Settings → Keys & access/.test(refused.content[0].text), refused.content[0].text);
  canDelete = true;

  // Named by its name, either Racer could be meant: nothing goes, and the answer says which is which.
  const which = await call({ game: 'Racer', delete: 'Racer' });
  assert.ok(which.isError, which.content[0].text);
  assert.equal(
    which.content[0].text,
    'Glitchless error: 2 games in this workspace are called "Racer": p_racer_old (made 2026-10-01, last sent data 2026-11-16); p_racer_new (made 2026-11-17, no data yet). Nothing was deleted. Ask the person which one they mean, then call this again with game set to that one\'s id.',
  );
  assert.deepEqual(asked.at(-1), ['p_racer_old', { name: 'Racer' }], 'by name, no id goes with it');

  // Named by its id: the id goes too, and only that one is deleted.
  const done = await call({ game: 'p_racer_new', delete: 'Racer' });
  assert.ok(!done.isError, done.content[0].text);
  assert.deepEqual(asked.at(-1), ['p_racer_new', { name: 'Racer', id: 'p_racer_new' }]);
  assert.deepEqual(games.map((g) => g.id), ['p_real', 'p_racer_old']);
});

test("over HTTP, a connection whose token doesn't carry delete_games is refused before anything is asked", async () => {
  const [x, y] = InMemoryTransport.createLinkedPair();
  await createServer({ remote: true, scopes: ['read', 'dashboard', 'manage'], connection: connection({ base: `http://127.0.0.1:${api.address().port}`, apiKey: `gl_ws_${'k'.repeat(43)}` }) }).connect(x);
  const narrow = new Client({ name: 'test', version: '0' });
  await narrow.connect(y);
  const sent = asked.length;
  const r = await narrow.callTool({ name: 'glitchless_create_game', arguments: { game: 'Real Game', delete: 'Real Game' } });
  assert.ok(r.isError && /connect this app again and tick "Delete games and their data, for good"/.test(r.content[0].text), r.content[0].text);
  assert.equal(asked.length, sent, 'nothing reached Glitchless Cloud');
  await narrow.close();
});
