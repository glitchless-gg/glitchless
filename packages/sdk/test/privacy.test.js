// Anonymous mode: what leaves the browser. See PRIVACY.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubUrls } from '../src/core.js';
import { anonymizeDevice } from '../src/device.js';

test('scrubUrls drops query strings and fragments, keeps the path', () => {
  assert.equal(scrubUrls('failed to load https://cdn.example.com/a/level2.glb?token=abc123&u=sam#top'), 'failed to load https://cdn.example.com/a/level2.glb');
  assert.equal(scrubUrls("fetch 'http://localhost:5173/api?email=a@b.c' failed"), "fetch 'http://localhost:5173/api' failed");
  assert.equal(scrubUrls('no urls here'), 'no urls here');
});

test('scrubUrls keeps the line and column of stack frames', () => {
  const chrome = 'TypeError: x is undefined\n    at spawnScorePopup (http://localhost:5173/src/fx.js?t=1712:45:12)\n    at http://localhost:5173/src/main.js?v=9:10:3';
  assert.equal(scrubUrls(chrome), 'TypeError: x is undefined\n    at spawnScorePopup (http://localhost:5173/src/fx.js:45:12)\n    at http://localhost:5173/src/main.js:10:3');
  const firefox = 'spawnScorePopup@http://localhost:5173/src/fx.js?t=1712:45:12\n@http://localhost:5173/src/main.js#x:10:3';
  assert.equal(scrubUrls(firefox), 'spawnScorePopup@http://localhost:5173/src/fx.js:45:12\n@http://localhost:5173/src/main.js:10:3');
});

test('anonymizeDevice keeps tiers and drops identifying detail', () => {
  const full = {
    browser: 'Chrome',
    browser_version: '141.0.7390.54',
    os: 'macOS',
    mobile: false,
    gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)',
    gpu_vendor: 'Apple',
    gpu_tier: 'high',
    webgl: 2,
    cores: 16,
    memory_gb: 64,
    screen: [1728, 1117],
    dpr: 2,
  };
  assert.deepEqual(anonymizeDevice(full), { browser: 'Chrome', browser_version: '141', os: 'macOS', mobile: false, gpu_tier: 'high', webgl: 2, screen: [1728, 1117], dpr: 2 });
  assert.equal(anonymizeDevice(null), null);
});
