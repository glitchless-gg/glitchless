// Elicitation: a client that can ask the person something mid-call (MCP elicitation) is asked to, and any other
// client gets exactly the answer it got before. glitchless_sign_in opens the approve page for the person (URL mode)
// and waits for their approval; glitchless_create_game's delete asks "Delete <game> for good?" (a form) before
// anything goes, on top of the key's "Delete games and their data, for good". A 2026-07-28 client answers and calls
// again (the SDK client does that itself); on an older stdio connection the SDK sends the question; over HTTP an older
// client is never asked, since each request gets a server of its own. Against fake Glitchless Clouds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-elicit-'));
for (const k of ['GLITCHLESS_API_KEY', 'GLITCHLESS_URL', 'GLITCHLESS_SERVICE', 'GLITCHLESS_GAME']) delete process.env[k];

const KEY = `gl_ws_${'k'.repeat(43)}`;

// ── a fake Glitchless Cloud ──
// Sign-in: /connect hands out a code; /connect/poll says approved once `approve` is set, denied once `deny` is.
const signIn = { approve: false, deny: false, codes: 0, page: null };
// Games: delete as the real one does (the name again, the id when two share it, the key's scopes).
let games = [];
let keyScopes = ['read', 'dashboard', 'manage', 'delete_games'];
const deletes = [];
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (url.pathname === '/v1/agent/connect') {
      signIn.codes++;
      return send(200, { device_code: `dev-${signIn.codes}`, user_code: `CODE-${signIn.codes}`, verification_url: signIn.page ?? `${apiBase}/#/connect?code=CODE-${signIn.codes}`, expires_in: 600, interval: 0.05 });
    }
    if (url.pathname === '/v1/agent/connect/poll') {
      if (signIn.deny) return send(200, { status: 'denied' });
      if (!signIn.approve) return send(200, { status: 'pending' });
      return send(200, { status: 'approved', token: KEY, workspace: { id: 'w_jam', name: 'Jam team' }, scopes: ['read', 'manage'] });
    }
    if (url.pathname === '/v1/agent/whoami') return send(200, { workspace: { id: 'w_jam', name: 'Jam team' }, scopes: keyScopes });
    if (url.pathname === '/v1/agent/games' && req.method === 'GET') return send(200, { games, intake: apiBase });
    const one = /^\/v1\/agent\/games\/([\w-]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      deletes.push([one[1], body]);
      if (!keyScopes.includes('delete_games')) return send(403, { error: "This key can't delete games.", code: 'SCOPE' });
      const game = games.find((g) => g.id === one[1]);
      if (!game) return send(404, { error: 'No such game in this workspace.' });
      // Glitchless Cloud's nameKey: any case, spaces as typed, several (tabs, no-break spaces) counting as one.
      const key = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (key(body.name) !== key(game.name)) return send(400, { error: "That isn't this game's name, so nothing was deleted.", code: 'CONFIRM_NAME' });
      if (games.filter((g) => key(g.name) === key(body.name)).length > 1 && body.id !== game.id) return send(409, { error: 'Two games share the name.', code: 'SAME_NAME', games: games.filter((g) => key(g.name) === key(body.name)).map((g) => ({ id: g.id, created_at: '2026-11-01T00:00:00Z', has_data: false })) });
      games = games.filter((g) => g !== game);
      return send(200, { deleted: { id: game.id, name: game.name }, done: true });
    }
    send(404, { error: 'Not found.' });
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${api.address().port}`;

const { createServer, connection, useCredentials } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { SIGN_IN_WAIT } = await import('../src/tools/workspace.js');
const { createHttpHandler } = await import('../src/http.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { serveStdio } = await import('@modelcontextprotocol/server/stdio');

const ERAS = { legacy: undefined, modern: { mode: { pin: '2026-07-28' } } };

// A client of the stdio server (served as index.js serves it), on either protocol, with these elicitation
// capabilities (none: it can't be asked) and an answer to each question: answer(request params) → the ElicitResult.
// asked collects the questions it got.
async function stdioClient({ era = 'modern', elicitation, answer = () => ({ action: 'decline' }), conn = null } = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  serveStdio(() => createServer(conn ? { connection: conn } : {}), { transport: a });
  return client(b, { era, elicitation, answer });
}
async function client(transport, { era, elicitation, answer }) {
  const asked = [];
  const c = new Client({ name: 'test', version: '0' }, { ...(elicitation ? { capabilities: { elicitation } } : {}), ...(ERAS[era] ? { versionNegotiation: ERAS[era] } : {}) });
  if (elicitation) {
    c.setRequestHandler('elicitation/create', async (req) => {
      asked.push(req.params);
      return answer(req.params);
    });
  }
  await c.connect(transport);
  return { c, asked, call: (name, args) => c.callTool({ name, arguments: args }) };
}

test.after(() => api.close());

// ── glitchless_sign_in ──

const signedOut = () => {
  useCredentials({ url: apiBase, token: '' });
  Object.assign(signIn, { approve: false, deny: false, page: null });
};

test('a client that can open a link opens the approve page, and the call waits until the person approves', async () => {
  for (const era of ['modern', 'legacy']) {
    signedOut();
    const { c, asked, call } = await stdioClient({
      era,
      elicitation: { form: {}, url: {} },
      // The person opens the page, then approves it there a moment later.
      answer: () => (setTimeout(() => (signIn.approve = true), 150), { action: 'accept' }),
    });
    const r = await call('glitchless_sign_in', { url: apiBase });
    assert.ok(!r.isError, r.content[0].text);
    assert.match(r.content[0].text, /^Signed in to Jam team \(read, manage\)/, era);
    assert.equal(asked.length, 1, era);
    assert.equal(asked[0].mode, 'url');
    assert.equal(asked[0].url, `${apiBase}/#/connect?code=CODE-${signIn.codes}`);
    assert.match(asked[0].message, new RegExp(`^Code CODE-${signIn.codes}: approve it on the page that opens`), 'the code first: Claude Code shows one line of it');
    if (era === 'legacy') assert.ok(asked[0].elicitationId, 'the 2025 protocol needs an elicitationId, which the SDK adds');
    // Later calls use the workspace at once.
    assert.match((await call('glitchless_sign_in', {})).content[0].text, /Already signed in/);
    await c.close();
  }
});

test("the person not opening the page, or not approving yet, says so; a client that can't open links gets the link and code", async () => {
  signedOut();
  const declined = await stdioClient({ elicitation: { url: {} }, answer: () => ({ action: 'decline' }) });
  const no = await declined.call('glitchless_sign_in', { url: apiBase });
  assert.match(no.content[0].text, /The person didn't open the sign-in page\. If they still want to connect, ask them to open .*#\/connect\?code=CODE-\d+ and approve the code CODE-\d+/);
  // Approving it later still signs in: the server switches over as soon as it's approved.
  signIn.approve = true;
  await new Promise((r) => setTimeout(r, 200));
  assert.match((await declined.call('glitchless_sign_in', {})).content[0].text, /^Already signed in to Jam team/);
  await declined.c.close();

  signedOut();
  SIGN_IN_WAIT.ms = 300;
  const waiting = await stdioClient({ elicitation: { url: {} }, answer: () => ({ action: 'accept' }) });
  const later = await waiting.call('glitchless_sign_in', { url: apiBase });
  assert.match(later.content[0].text, /^Still waiting: the person has the sign-in page open but hasn't approved the code CODE-\d+ yet\. Call this tool again once they have/);
  signIn.approve = true;
  await new Promise((r) => setTimeout(r, 200));
  assert.match((await waiting.call('glitchless_sign_in', {})).content[0].text, /^Already signed in to Jam team/);
  assert.equal(waiting.asked.length, 1, 'the page opens once per sign-in');
  await waiting.c.close();
  SIGN_IN_WAIT.ms = 100_000;

  // Today's reply, word for word, for a client with no URL elicitation (form only, or none), on either protocol.
  for (const [era, elicitation] of [['modern', undefined], ['legacy', undefined], ['modern', { form: {} }], ['legacy', {}]]) {
    signedOut();
    const plain = await stdioClient({ era, elicitation });
    const r = await plain.call('glitchless_sign_in', { url: apiBase });
    assert.equal(r.content[0].text, `Ask the person to open this link and approve the code CODE-${signIn.codes}:\n${apiBase}/#/connect?code=CODE-${signIn.codes}\nThe code works for 10 minutes. This server switches to the workspace as soon as it's approved.\n\n{}`, `${era} ${JSON.stringify(elicitation)}`);
    assert.equal(plain.asked.length, 0);
    signIn.approve = true;
    await new Promise((r) => setTimeout(r, 200));
    assert.match((await plain.call('glitchless_sign_in', {})).content[0].text, /^Already signed in to Jam team/);
    await plain.c.close();
  }
});

test("the approve page must be the server's own site, and two sign-ins at once share one code and one page", async () => {
  const { ownPage } = await import('../src/login.js');
  for (const [api, page, ok] of [
    ['https://api.glitchless.gg', 'https://app.glitchless.gg/#/connect?code=AB', true],
    ['https://api.glitchless.gg', 'https://api.glitchless.gg/connect', true],
    ['https://glitchless.example', 'https://app.glitchless.example/#/connect', true],
    ['http://127.0.0.1:7788', 'http://localhost:7788/#/connect', true],
    ['https://api.glitchless.gg', 'http://app.glitchless.gg/#/connect', false],
    ['https://api.glitchless.gg', 'https://glitchless.gg.evil.example/#/connect', false],
    ['https://api.glitchless.gg', 'https://evil.gg/#/connect', false],
    ['https://api.glitchless.gg', 'http://localhost:7788/#/connect', false],
    ['https://api.glitchless.gg', 'https://user:pw@app.glitchless.gg/', false],
    ['https://api.glitchless.gg', 'javascript:alert(1)', false],
  ]) assert.equal(ownPage(api, page), ok, `${api} → ${page}`);

  signedOut();
  signIn.page = 'https://phish.example/#/connect?code=X';
  const foreign = await stdioClient({ elicitation: { url: {} }, answer: () => ({ action: 'accept' }) });
  const r = await foreign.call('glitchless_sign_in', { url: apiBase });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /answered with an approve page on another site \(https:\/\/phish\.example\/.*\), so it wasn't shown or opened/);
  assert.equal(foreign.asked.length, 0);
  await foreign.c.close();

  signedOut();
  const before = signIn.codes;
  const both = await stdioClient({ elicitation: { url: {} }, answer: () => (setTimeout(() => (signIn.approve = true), 150), { action: 'accept' }) });
  const [one, two] = await Promise.all([both.call('glitchless_sign_in', { url: apiBase }), both.call('glitchless_sign_in', { url: apiBase })]);
  assert.equal(signIn.codes - before, 1, 'one code');
  assert.equal(both.asked.length, 1, 'one page opened');
  const texts = [one, two].map((x) => x.content[0].text);
  assert.ok(texts.some((t) => /^Signed in to Jam team/.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /^Still waiting for approval\. Ask the person to open/.test(t)), texts.join(' | '));
  await both.c.close();
});

// ── glitchless_create_game's delete ──

const reset = () => {
  games = [
    { id: 'p_test', name: 'Test Game', client_token: 'gl_pub_test', services: [], dashboard: 'https://app.example.test/?ws=w_jam&game=p_test' },
    { id: 'p_twin_a', name: 'Twin', client_token: 'gl_pub_a', services: [] },
    { id: 'p_twin_b', name: 'Twin', client_token: 'gl_pub_b', services: [] },
  ];
  keyScopes = ['read', 'dashboard', 'manage', 'delete_games'];
  deletes.length = 0;
};
const workspace = () => connection({ base: apiBase, apiKey: KEY });
const yes = () => ({ action: 'accept', content: { delete: true } });

test('a client that can ask asks the person before a game is deleted, and deletes only on their yes', async () => {
  for (const era of ['modern', 'legacy']) {
    reset();
    const { c, asked, call } = await stdioClient({ era, elicitation: { form: {} }, answer: yes, conn: workspace() });
    const r = await call('glitchless_create_game', { game: 'Test Game', delete: 'test game' });
    assert.ok(!r.isError, r.content[0].text);
    assert.match(r.content[0].text, /^Deleted Test Game\./);
    assert.equal(asked.length, 1, era);
    assert.equal(asked[0].mode ?? 'form', 'form');
    assert.match(asked[0].message, /^Delete Test Game for good\? Its data, dashboard, bug reports, keys, share links, alerts and store connections all go, and it can't be undone/);
    assert.deepEqual(asked[0].requestedSchema.required, ['delete']);
    assert.equal(asked[0].requestedSchema.properties.delete.type, 'boolean');
    assert.deepEqual(deletes, [['p_test', { name: 'test game' }]]);
    await c.close();
  }
});

test('no, a form sent back unticked, or the question closed: nothing is deleted', async () => {
  for (const [answer, why] of [
    [{ action: 'decline' }, /The person said no when asked to confirm deleting Test Game, so nothing was deleted/],
    [{ action: 'accept', content: { delete: false } }, /The person sent the question about deleting Test Game back without ticking the box, so nothing was deleted/],
    [{ action: 'cancel' }, /^Glitchless error: Nothing was deleted: the question asking the person to confirm deleting Test Game was closed without an answer .* Tell the person they can delete it themselves in the Glitchless dashboard, Settings → Game \(https:\/\/app\.example\.test\/\?ws=w_jam&game=p_test#\/settings\?tab=game\), typing its name again\. If they're here and say yes in the chat, you may call again/],
  ]) {
    reset();
    const { c, call } = await stdioClient({ elicitation: { form: {} }, answer: () => answer, conn: workspace() });
    const r = await call('glitchless_create_game', { game: 'Test Game', delete: 'Test Game' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, why);
    assert.deepEqual(deletes, [], JSON.stringify(answer));
    assert.ok(games.some((g) => g.id === 'p_test'));
    await c.close();
  }
});

test("it always asks a client that can, and Glitchless's own refusal answers afterwards", async () => {
  reset();
  const { c, asked, call } = await stdioClient({ elicitation: { form: {} }, answer: yes, conn: workspace() });
  // The wrong name, two games sharing the name: asked, then refused by Glitchless, nothing deleted.
  assert.match((await call('glitchless_create_game', { game: 'Test Game', delete: 'Other Game' })).content[0].text, /isn't this game's name/);
  assert.match((await call('glitchless_create_game', { game: 'Twin', delete: 'Twin' })).content[0].text, /2 games in this workspace are called "Twin".*Nothing was deleted/);
  assert.equal(asked.length, 2);
  assert.equal(games.length, 3);
  // Spaces Glitchless counts as one (two spaces, a tab, a no-break space) are asked about too, never deleted unasked.
  for (const spaced of ['Test  Game', 'Test\tGame', 'Test\u00a0Game']) {
    reset();
    asked.length = 0;
    const { c: d, asked: q, call: del } = await stdioClient({ elicitation: { form: {} }, answer: () => ({ action: 'decline' }), conn: workspace() });
    assert.match((await del('glitchless_create_game', { game: 'Test Game', delete: spaced })).content[0].text, /said no/, JSON.stringify(spaced));
    assert.equal(q.length, 1, JSON.stringify(spaced));
    assert.deepEqual(deletes, []);
    await d.close();
  }
  // Named by its id, one of the two is asked about and deleted.
  reset();
  asked.length = 0;
  const twin = await call('glitchless_create_game', { game: 'p_twin_b', delete: 'Twin' });
  assert.match(twin.content[0].text, /^Deleted Twin\./);
  assert.equal(asked.length, 1);
  // A key without "Delete games and their data, for good": Glitchless refuses, and nobody was asked.
  reset();
  keyScopes = ['read', 'manage'];
  asked.length = 0;
  assert.match((await call('glitchless_create_game', { game: 'Test Game', delete: 'Test Game' })).content[0].text, /can't delete games/);
  assert.equal(asked.length, 0);
  await c.close();
});

test('the question names the game as it is now, even when the list of games was read moments before', async () => {
  reset();
  const { c, asked, call } = await stdioClient({ elicitation: { form: {} }, answer: () => ({ action: 'decline' }), conn: workspace() });
  await call('glitchless_list_games', {});
  // Renamed elsewhere (the dashboard) while this server holds the list it read.
  games[0] = { ...games[0], name: 'Renamed Game' };
  const r = await call('glitchless_create_game', { game: 'p_test', delete: 'Renamed Game' });
  assert.match(r.content[0].text, /said no when asked to confirm deleting Renamed Game/);
  assert.match(asked[0].message, /^Delete Renamed Game for good\?/);
  assert.deepEqual(deletes, []);
  await c.close();
});

test("an answer counts only with the state the question went out with: one made up, for another game or name, tampered, expired or used already asks again", async () => {
  const { STATE_LIMITS } = await import('../src/request-state.js');
  reset();
  // A 2026-07-28 client by hand, so it can send any answer and state it likes.
  const [a, b] = InMemoryTransport.createLinkedPair();
  const waiting = new Map();
  b.onmessage = (m) => m.id != null && waiting.get(m.id)?.(m);
  serveStdio(() => createServer({ connection: workspace() }), { transport: a });
  await b.start();
  let id = 0;
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
  const del = (args, answer, requestState) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, (m) => resolve(m.result));
      b.send({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'glitchless_create_game', arguments: args, _meta: meta, ...(answer ? { inputResponses: { confirm_delete: answer } } : {}), ...(requestState !== undefined ? { requestState } : {}) } });
    });
  const accept = { action: 'accept', content: { delete: true } };
  const asks = (r) => r.resultType === 'input_required' && r.inputRequests.confirm_delete;
  const testGame = { game: 'Test Game', delete: 'Test Game' };

  // A yes with a state the client made up (the game's id, as the state once was), or none at all.
  assert.ok(asks(await del(testGame, accept, 'p_test')));
  assert.ok(asks(await del(testGame, accept)));
  const first = await del(testGame);
  assert.ok(asks(first));
  const state = first.requestState;
  assert.match(state, /^[\w-]+\.[\w-]+$/, 'sealed, not the game id');
  // For another game, or another name for this one.
  assert.ok(asks(await del({ game: 'p_twin_b', delete: 'Twin' }, accept, state)));
  assert.ok(asks(await del({ game: 'Test Game', delete: 'Other Game' }, accept, state)));
  // Tampered with.
  const [body, seal] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), game: 'p_twin_b' })).toString('base64url');
  assert.ok(asks(await del({ game: 'p_twin_b', delete: 'Twin' }, accept, `${forged}.${seal}`)));
  assert.deepEqual(deletes, []);
  // The real one, for the name as Glitchless compares it, deletes; the same answer again is spent.
  const done = await del({ game: 'Test Game', delete: 'test  game' }, accept, state);
  assert.match(done.content[0].text, /^Deleted Test Game\./);
  reset();
  assert.ok(asks(await del(testGame, accept, state)), 'a yes counts once');
  // Expired.
  STATE_LIMITS.ttlMs = -1;
  const stale = (await del(testGame)).requestState;
  STATE_LIMITS.ttlMs = 10 * 60_000;
  assert.ok(asks(await del(testGame, accept, stale)));
  assert.deepEqual(deletes, []);
  await b.close();
});

test("a client that can't ask deletes as before, on stdio and over HTTP, where an older client is never asked", async () => {
  reset();
  const plain = await stdioClient({ conn: workspace() });
  assert.match((await plain.call('glitchless_create_game', { game: 'Test Game', delete: 'Test Game' })).content[0].text, /^Deleted Test Game\./);
  await plain.c.close();

  // The hosted server: one server per request, with the token's scopes.
  const mcp = createHttpHandler();
  const host = http.createServer((req, res) => mcp.handle(req, res, { connection: workspace(), scopes: ['read', 'manage', 'delete_games'] }));
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const endpoint = new URL(`http://127.0.0.1:${host.address().port}/mcp`);
  try {
    // An older client that says it can answer forms isn't asked: no server could take its answer.
    reset();
    const old = await client(new StreamableHTTPClientTransport(endpoint), { era: 'legacy', elicitation: { form: {} }, answer: yes });
    const r = await old.call('glitchless_create_game', { game: 'Test Game', delete: 'Test Game' });
    assert.match(r.content[0].text, /^Deleted Test Game\./);
    assert.equal(old.asked.length, 0);
    await old.c.close();
    // A 2026-07-28 client is asked: its answer comes back as a request of its own, with the game's id.
    for (const [answer, deleted] of [[yes(), true], [{ action: 'decline' }, false]]) {
      reset();
      const now = await client(new StreamableHTTPClientTransport(endpoint), { era: 'modern', elicitation: { form: {} }, answer: () => answer });
      const d = await now.call('glitchless_create_game', { game: 'Test Game', delete: 'Test Game' });
      assert.equal(now.asked.length, 1);
      assert.equal(/^Deleted Test Game\./.test(d.content[0].text), deleted, d.content[0].text);
      assert.equal(games.some((g) => g.id === 'p_test'), !deleted);
      await now.c.close();
    }
  } finally {
    host.close();
    host.closeAllConnections();
  }
});
