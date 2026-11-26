// A web playtest stopped part-way (run.js): its signal closes Chrome while the bot waits for the game, and the run ends
// at once with the signal's reason, not at the 20-second wait. Skipped where Playwright or a browser isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadPlaywright, runScenarios } from '../src/run.js';

let why = false;
try {
  const { chromium } = await loadPlaywright();
  await (await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())).close();
} catch (err) {
  why = `no browser to play in: ${err.message.split('\n')[0]}`;
}

test('a web run stops at once when its signal fires: Chrome closes and the run ends with the reason', { skip: why }, async () => {
  // A page with no Glitchless on it: the bot would wait 20 seconds for it to start.
  const site = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>blank</title><canvas></canvas>'));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(new Error('Stopped by the test.')), 1500);
    const cfg = { channel: 'chrome', headed: false, env: 'dev', server: 'http://127.0.0.1:9', viewport: { width: 800, height: 600 }, done_when: 'false' };
    await assert.rejects(runScenarios(cfg, { game: `http://127.0.0.1:${site.address().port}/`, scenarios: [{ params: {} }], signal: stop.signal }), /Stopped by the test/);
    assert.ok(Date.now() - t0 < 10_000, `it stopped at once (${Date.now() - t0} ms), not after the 20-second wait`);
  } finally {
    site.close();
  }
});
