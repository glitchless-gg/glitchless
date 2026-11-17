// A request line that isn't a URL is answered with a 400. `new URL` refuses "//", and a handler that threw on it would
// reject with nobody to handle it, which ends the Node process and every request it was serving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { defaultAuth } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';

// One request with its path sent as given (fetch would tidy it first).
const get = (port, target) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    // Unanswered, the request would hang: that's the failure this test is for.
    req.setTimeout(3000, () => req.destroy(new Error(`no answer to GET ${target}`)));
    req.end();
  });

test('a request for "//" gets a 400 and the server carries on', async (t) => {
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-line-')));
  const app = createApp({ store, auth: defaultAuth(), logger: { warn() {}, error() {} } });
  const unhandled = [];
  const note = (err) => unhandled.push(err);
  process.on('unhandledRejection', note);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    process.off('unhandledRejection', note);
    server.close();
  });
  const { port } = server.address();

  for (const target of ['//', '//?token=gl_pub_dev']) {
    const bad = await get(port, target);
    assert.equal(bad.status, 400, target);
    assert.deepEqual(JSON.parse(bad.body), { error: 'bad request' });
  }
  const health = await get(port, '/v1/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'nothing was left to reject unhandled');
});
