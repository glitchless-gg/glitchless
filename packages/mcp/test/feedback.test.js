// glitchless_feedback: an agent's report to the Glitchless team. Signed in to a workspace it's sent to Glitchless Cloud
// with the app and glitchless-mcp's version, and the answer is its ID; anywhere else nothing is sent and the answer is a
// GitHub issue filled in with it. Called over in-memory MCP connections against a fake Glitchless Cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-feedback-'));
delete process.env.GLITCHLESS_API_KEY;
delete process.env.GLITCHLESS_URL;

const sent = [];
let answer = 'ok';
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (url.pathname === '/v1/agent/feedback' && req.method === 'POST') {
      sent.push({ key: req.headers['x-glitchless-api-key'], body: JSON.parse(raw) });
      if (answer === 'missing') return send(404, { error: 'Not found.', code: 'NOT_FOUND' });
      if (answer === 'full') return send(429, { error: 'Glitchless takes 20 reports a day from a workspace, and this one has sent them today.', code: 'TOO_MANY_REPORTS' });
      if (answer === 'refused') return send(401, { error: 'This workspace key was revoked.', code: 'INVALID_KEY' });
      return send(200, { id: 'fb_k3m9x2p7qa' });
    }
    // Any other call is a mistake: the tool reads no game.
    sent.push({ other: url.pathname });
    send(404, { error: 'Not found.' });
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;

const { createServer, connection, VERSION } = await import('../src/context.js');
await import('../src/hosted-tools.js');
const { FEEDBACK, issueLink, blank } = await import('../src/tools/feedback.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const KEY = `gl_ws_${'k'.repeat(43)}`;
async function connect({ apiKey = '', remote = false, client = { name: 'claude-code', version: '2.1.3' } } = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ remote, connection: connection({ base, apiKey }) }).connect(a);
  const c = new Client(client);
  await c.connect(b);
  return c;
}
const report = { message: 'glitchless_create_game made the game, but the Godot steps name a menu Godot 4.5 no longer has.', type: 'bug', impact: 'worked_around', tool: 'glitchless_create_game', task: 'Set up Glitchless in my Godot game', expected: 'Project → Install Plugin', actual: 'No such menu; I copied the addon by hand', engine: 'godot' };

test.after(() => api.close());

test('signed in to a workspace, the report goes to Glitchless Cloud with what sent it, and the answer is its ID', async () => {
  sent.length = 0;
  answer = 'ok';
  const c = await connect({ apiKey: KEY });
  const tool = (await c.listTools()).tools.find((t) => t.name === 'glitchless_feedback');
  assert.equal(tool.title, 'Send feedback');
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(tool.inputSchema.required.sort(), ['impact', 'message', 'type']);
  // What an agent must know before it sends one: when, what to leave out, the limits, and to tell the person.
  for (const say of [/a setup step didn't work in this engine/, /without asking first, but never once the person has said not to/, /Leave out secrets and keys, player data/, /at most 4,000 characters in all, and a workspace sends at most 20 a day/, /tell the person what you sent and the ID, and that they can write to support@glitchless\.gg if they want an answer/, /never a name, an email address, a game, its data or keys/, /nothing is sent: it answers with a link to a GitHub issue/]) assert.match(tool.description, say);
  assert.ok(!/email/i.test(tool.description.replace('email address', '')), 'nothing about the report is emailed');

  const r = await c.callTool({ name: 'glitchless_feedback', arguments: { ...report, game: 'Zoomies' } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /^Sent to the Glitchless team as fb_k3m9x2p7qa\. At the end of your turn, tell the person what you sent and this ID, and that they can write to support@glitchless\.gg if they want an answer\./);
  assert.equal(sent.length, 1, 'one request, and no game looked up');
  const { game, ...fields } = { ...report, game: undefined };
  assert.deepEqual(sent[0], { key: KEY, body: { ...fields, app: { name: 'claude-code', version: '2.1.3' }, mcp: { version: VERSION, transport: 'stdio' } } });
  await c.close();

  // Over HTTP the transport says so; the cloud itself tells its own hosted server apart.
  const remote = await connect({ apiKey: KEY, remote: true, client: { name: 'claude-ai', version: '0.1.0' } });
  await remote.callTool({ name: 'glitchless_feedback', arguments: { message: 'No way to export a board as a picture', type: 'missing', impact: 'minor' } });
  assert.deepEqual(sent[1].body, { message: 'No way to export a board as a picture', type: 'missing', impact: 'minor', app: { name: 'claude-ai', version: '0.1.0' }, mcp: { version: VERSION, transport: 'http' } });
  await remote.close();
});

test('a report past 4,000 characters in all is refused before anything is sent', async () => {
  sent.length = 0;
  const c = await connect({ apiKey: KEY });
  const r = await c.callTool({ name: 'glitchless_feedback', arguments: { message: 'x'.repeat(2500), actual: 'y'.repeat(2000), type: 'bug', impact: 'blocked' } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /This report is 4,500 characters, and one is at most 4,000 in all\. Shorten it/);
  const blank = await c.callTool({ name: 'glitchless_feedback', arguments: { message: '   ', type: 'bug', impact: 'blocked' } });
  assert.ok(blank.isError && /say what happened in message/.test(blank.content[0].text), blank.content[0].text);
  assert.equal(sent.length, 0);
  await c.close();
});

test('without a workspace nothing is sent, and the answer is a GitHub issue filled in with the report', async () => {
  sent.length = 0;
  const c = await connect();
  const r = await c.callTool({ name: 'glitchless_feedback', arguments: report });
  assert.ok(!r.isError, r.content[0].text);
  const out = r.content[0].text;
  assert.match(out, /^Nothing was sent: this connection isn't signed in to a Glitchless Cloud workspace \(glitchless_sign_in connects one/);
  assert.match(out, /The issue is public, so they should take out anything private first/);
  assert.equal(sent.length, 0);
  const link = new URL(out.match(/https:\/\/github\.com\/\S+/)[0]);
  assert.equal(`${link.origin}${link.pathname}`, 'https://github.com/glitchless-gg/glitchless/issues/new');
  assert.equal(link.searchParams.get('title'), `bug: ${report.message}`.slice(0, 85));
  const body = link.searchParams.get('body');
  for (const part of [report.message, '**What the person wanted:** Set up Glitchless in my Godot game', '**Expected:** Project → Install Plugin', '**What happened:** No such menu', 'type: bug · impact: worked_around · tool: glitchless_create_game · engine: godot', `glitchless-mcp ${VERSION} (stdio) in claude-code 2.1.3`]) assert.ok(body.includes(part), part);
  await c.close();

  // A game's own key on any server isn't a workspace either.
  const gameKey = await connect({ apiKey: 'gl_sk_onegame' });
  const g = await gameKey.callTool({ name: 'glitchless_feedback', arguments: report });
  assert.match(g.content[0].text, /^Nothing was sent/);
  assert.equal(sent.length, 0);
  await gameKey.close();
});

test("a server without the route, or a workspace past today's reports, still gets the person the issue link", async () => {
  const c = await connect({ apiKey: KEY });
  answer = 'missing';
  const missing = await c.callTool({ name: 'glitchless_feedback', arguments: report });
  // Signed in, but the server refused the report: it isn't told to sign in.
  assert.ok(!missing.isError && /^Nothing was sent: this Glitchless server doesn't take feedback\. Give the person this link instead/.test(missing.content[0].text), missing.content[0].text);
  assert.ok(!/glitchless_sign_in|isn't signed in/.test(missing.content[0].text));
  assert.match(missing.content[0].text, /github\.com\/glitchless-gg\/glitchless\/issues\/new\?/);
  answer = 'full';
  const full = await c.callTool({ name: 'glitchless_feedback', arguments: report });
  assert.match(full.content[0].text, /^Nothing was sent: Glitchless takes 20 reports a day from a workspace[\s\S]*issues\/new\?/);
  // Any other refusal is the tool's error, as the server gave it.
  answer = 'refused';
  const refused = await c.callTool({ name: 'glitchless_feedback', arguments: report });
  assert.ok(refused.isError && /This workspace key was revoked/.test(refused.content[0].text), refused.content[0].text);
  answer = 'ok';
  await c.close();
});

test("a long report's issue link is cut to fit what GitHub takes, keeping what sent it", () => {
  const long = { message: 'Ünïcode and spaces '.repeat(200), type: 'friction', impact: 'minor', actual: 'z'.repeat(200) };
  const link = issueLink(long, { app: { name: 'cursor', version: '1.0' }, mcp: { version: VERSION, transport: 'stdio' } });
  assert.ok(link.length <= 6000, String(link.length));
  const body = new URL(link).searchParams.get('body');
  assert.match(body, /type: friction · impact: minor\nglitchless-mcp .* in cursor 1\.0, sent with glitchless_feedback\n\(Cut short to fit the link\.\)$/);
  assert.equal(FEEDBACK.chars, 4000);
  // Whatever else is in it, the cutting ends.
  const huge = issueLink({ message: 'short', type: 'bug', impact: 'minor' }, { app: { name: 'n'.repeat(9000), version: null }, mcp: { version: VERSION, transport: 'http' } });
  assert.ok(huge.startsWith('https://github.com/glitchless-gg/glitchless/issues/new?'));
});

test("an app that names itself at length still gets the link, its name cut to a line", async () => {
  const c = await connect({ client: { name: 'x'.repeat(5000), version: 'v'.repeat(500) } });
  const r = await c.callTool({ name: 'glitchless_feedback', arguments: report });
  assert.ok(!r.isError, r.content[0].text);
  const link = r.content[0].text.match(/https:\/\/github\.com\/\S+/)[0];
  assert.ok(link.length <= 6000, String(link.length));
  assert.ok(new URL(link).searchParams.get('body').includes(`in ${'x'.repeat(80)} ${'v'.repeat(40)}, sent with`));
  await c.close();
});

test('keys pasted into a report are removed on the GitHub link too, and from the app it names itself as', async () => {
  const ws = `gl_ws_${'k'.repeat(43)}`;
  const sk = `gl_sk_${'s'.repeat(30)}`;
  const hook = 'https://discord.com/' + 'api/webhooks/1234567890/AbCdEf_gh-ij';
  const c = await connect({ client: { name: `my key is ${ws}`, version: '1' } });
  const r = await c.callTool({ name: 'glitchless_feedback', arguments: { message: `Alerts failed: ${hook}`, actual: `401 with KEY_${sk}`, task: `Bearer ${'t'.repeat(30)}`, type: 'bug', impact: 'blocked' } });
  const link = r.content[0].text.match(/https:\/\/github\.com\/\S+/)[0];
  const body = new URL(link).searchParams.get('body');
  const title = new URL(link).searchParams.get('title');
  for (const secret of [ws, sk, hook, 't'.repeat(30)]) assert.ok(!link.includes(encodeURIComponent(secret)) && !body.includes(secret) && !title.includes(secret), secret.slice(0, 12));
  assert.ok(body.includes('Alerts failed: [key removed]') && body.includes('401 with KEY_[key removed]') && body.includes('Bearer [key removed]'), body);
  assert.ok(body.includes('in my key is [key removed] 1, sent with'), body);
  await c.close();
});

test('blank() removes the secrets this product handles, and leaves ordinary text alone', () => {
  const removed = {
    glitchless: `gl_ws_${'a'.repeat(43)}`,
    'OAuth token': `gl_at_${'c'.repeat(40)}`,
    'share link': `gl_share_${'d'.repeat(40)}`,
    'Stripe secret': `sk_live_${'e'.repeat(24)}`,
    'Stripe restricted': `rk_test_${'f'.repeat(24)}`,
    'Stripe webhook secret': `whsec_${'g'.repeat(32)}`,
    RevenueCat: `sk_${'Hh1'.repeat(8)}`,
    Anthropic: `sk-ant-api03-${'Ij2'.repeat(10)}`,
    OpenAI: `sk-proj-${'Kl3'.repeat(10)}`,
    npm: `npm_${'m4'.repeat(18)}`,
    // In parts, as the other keys are: the public export refuses a file with an AWS key ID written out, and GitHub's
    // push protection one with a whole webhook URL or Slack token.
    'AWS access key ID': `${'AKIA'}${'IOSFODNN7EXAMPLE'}`,
    'AWS secret, alone': 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    GitHub: `ghp_${'n'.repeat(36)}`,
    'GitHub fine-grained': `github_pat_${'o5'.repeat(20)}`,
    Slack: 'xoxb-' + '1234567890-abcdefghij',
    'Discord webhook': 'https://discord.com/' + 'api/webhooks/123456789012345678/AbCdEfGhIj-KlMnOp_QrSt',
    'Slack webhook': 'https://hooks.slack.com/' + 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'private key': `-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA ${'PRIVATE'} KEY-----`,
  };
  for (const [what, secret] of Object.entries(removed)) assert.equal(blank(`before ${secret} after`), 'before [key removed] after', what);
  assert.equal(blank(`GLITCHLESS_KEY_gl_sk_${'b'.repeat(30)}`), 'GLITCHLESS_KEY_[key removed]', 'a key run into a name');
  assert.equal(blank('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'), 'aws_secret_access_key = "[key removed]"');
  assert.equal(blank(`Authorization: Bearer ${'p'.repeat(24)}`), 'Authorization: Bearer [key removed]');
  for (const kept of [`gl_pub_${'q'.repeat(20)} is a game's public client token`, 'commit 3f786850e387550fdab836ed7e6dc881de23001b', 'res://addons/glitchless/plugin.cfg', 'Assets/Scripts/Player/Controller.cs', 'GlitchlessBootstrapperEditorWindowHelper', 'risk_assessment_documentation_for_the_team', 'Project → Install Plugin']) assert.equal(blank(kept), kept);
});
