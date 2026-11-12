// The browser SDK in a Reddit post (SPEC §5g): it sends to its app's relay at a path on the page's own origin, and as
// the page goes it sends by fetch with keepalive, never by beacon, since only the page's own fetch carries the app's
// token that Devvit's /api/ routes need. packages/sdk/test/devvit-webview.mjs plays it in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'https://daily-dots-x1-webview.devvit.net', pathname: '/game.html' };

const { Glitchless } = await import('../src/core.js');

function page({ devvit }) {
  const sent = [];
  const beacons = [];
  Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: (url) => (beacons.push(url), true) }, configurable: true });
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response('{}', { status: 202 });
  };
  const gd = new Glitchless({ service: 'daily-dots', version: '1.0.0', intake: '/api/glitchless/', clientToken: 'gl_pub_x' });
  gd.devvit = devvit; // what inDevvit() reads from Reddit's script on a real page
  gd.startedAt -= 5000;
  return { gd, sent, beacons };
}

test('in a Reddit post the page sends its last batch by keepalive fetch, uncompressed, to the relay\'s path', async () => {
  const { gd, sent, beacons } = page({ devvit: true });
  gd.levelStart('daily-2026-11-12');
  gd.end('pagehide');
  assert.deepEqual(beacons, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/glitchless/v1/intake?token=gl_pub_x');
  assert.equal(sent[0].init.keepalive, true);
  assert.equal(typeof sent[0].init.body, 'string', 'no time to gzip as the page goes');
  assert.deepEqual(JSON.parse(sent[0].init.body).events.map((e) => e.type), ['session_start', 'level_start', 'level_abandon', 'session_end']);
});

test('elsewhere the last batch is still a beacon', () => {
  const { gd, sent, beacons } = page({ devvit: false });
  gd.end('pagehide');
  assert.deepEqual(beacons, ['/api/glitchless/v1/intake?token=gl_pub_x']);
  assert.equal(sent.length, 0);
});
