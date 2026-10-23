// A self-hosted server's alerts (GLITCHLESS_ALERT_WEBHOOK): the open-source default project, checked against a
// fake webhook on localhost. The hosted service tests the rules in more depth with its own settings and state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { defaultAuth } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { watchAlerts } from '../src/alerts.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

test('GLITCHLESS_ALERT_WEBHOOK: a new error posts once, in Discord or Slack format', async (t) => {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-alerts-')));
  const app = await listen(createApp({ store, auth: defaultAuth(), logger: { warn() {}, error() {} } }));
  const posts = [];
  const hook = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  t.after(async () => {
    await app.close();
    await hook.close();
  });

  const send = (session, message) =>
    fetch(`${app.url}/v1/intake?token=gl_pub_dev`, {
      method: 'POST',
      body: JSON.stringify({ service: 'zoomies', env: 'prod', version: '1.0.0', session_id: session, sdk: 'test', events: [{ type: 'session_start', ts: Date.now() - 1 }, { type: 'error', ts: Date.now(), kind: 'js', message, fingerprint: message.replace(/\W+/g, '-') }] }),
    });
  await send('s_old', 'old trouble');
  const discord = watchAlerts({ store, url: `${hook.url}/discord`, appUrl: 'http://localhost:7777', everyMs: 3_600_000, logger: { warn() {} } });
  const slack = watchAlerts({ store, url: `${hook.url}/slack`, format: 'slack', everyMs: 3_600_000, logger: { warn() {} } });
  t.after(() => (discord.stop(), slack.stop()));
  await Promise.all([discord.first, slack.first]);
  assert.equal(posts.length, 0, 'what was there at start is the baseline');

  await new Promise((r) => setTimeout(r, 5));
  for (const s of ['s1', 's2', 's3']) await send(s, 'TypeError: x is undefined');
  assert.equal((await discord.check()).length, 1);
  assert.equal((await slack.check()).length, 1);
  assert.deepEqual((await discord.check()).length + (await slack.check()).length, 0, 'once');
  const [d, s] = [posts.find((p) => p.path === '/discord').body, posts.find((p) => p.path === '/slack').body];
  assert.match(d.content, /New error in zoomies/);
  assert.match(d.embeds[0].description, /Use glitchless_triage on zoomies, then look at finding error-TypeError-x-is-undefined/);
  assert.equal(d.embeds[0].url, 'http://localhost:7777/#/errors/TypeError-x-is-undefined');
  assert.match(s.text, /New error in zoomies: TypeError/);
  assert.ok(s.blocks.length >= 3);
});
