// Bug reports (SPEC §2 bug_report): what a report carries, how it is sent, the screenshot's size, and which input
// the form holds back from the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const canvases = [];
globalThis.document = {
  hidden: false,
  referrer: '',
  addEventListener() {},
  // A canvas whose JPEG is as long as its area times the quality: what fitScreenshot shrinks.
  createElement: () => {
    const c = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: (type, q) => 'data:image/jpeg;base64,' + 'A'.repeat(Math.round(c.width * c.height * q)) };
    canvases.push(c);
    return c;
  },
};
globalThis.location = { origin: 'http://localhost:5173', pathname: '/' };
globalThis.Image = class {
  set src(v) {
    this.width = 1600;
    this.height = 900;
    queueMicrotask(() => this.onload());
  }
};

const { Glitchless } = await import('../src/core.js');
const { fitScreenshot, route, MAX_SCREENSHOT } = await import('../src/bugreport.js');

function sdk(options = {}) {
  const gd = new Glitchless({ service: 'zoomies', version: '1.2.0', intake: 'http://intake.test', ...options });
  gd.sessionStartSent = true; // the test is about the report, not the session's first batch
  return gd;
}

// Requests the SDK sends, decoded.
function capture() {
  const sent = [];
  globalThis.fetch = async (url, { body }) => {
    sent.push({ url, body: JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())) });
    return { ok: true };
  };
  return sent;
}

test('reportBug sends the note, screenshot, place, recent events and frame windows on a request of its own', async () => {
  const sent = capture();
  const gd = sdk({ positions: true });
  gd.render = { screenshot: async () => 'data:image/jpeg;base64,c2NyZWVu' };
  gd.levelStart('level-2');
  gd.track('bone_collected', { kind: 'gold' });
  gd.death({ x: 3, y: 1, z: 0, cause: 'squirrel' });
  gd.recentWindows.push({ ts: Date.now() - 5000, level: 'level-2', fps: 58.4, p95: 21.5 });
  gd.setPosition({ x: 12.345, y: 2, z: -1 });
  gd.queue.push({ type: 'custom', name: 'queued', ts: Date.now() });

  assert.deepEqual(await gd.reportBug({ note: 'fell through the floor' }), { sent: true });
  const reports = sent.filter((r) => r.body.events.some((e) => e.type === 'bug_report'));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.events.length, 1, 'the report goes alone');
  assert.ok(sent.some((r) => r.body.events.some((e) => e.name === 'queued')), "the session's queued events are sent too");
  const [e] = reports[0].body.events;
  assert.equal(e.note, 'fell through the floor');
  assert.equal(e.level, 'level-2');
  assert.equal(e.screenshot, 'data:image/jpeg;base64,c2NyZWVu');
  assert.deepEqual([e.x, e.y, e.z], [12.35, 2, -1]);
  assert.deepEqual(e.recent.map((r) => r.type + (r.name ? `:${r.name}` : '')), ['level_start', 'custom:bone_collected', 'death']);
  assert.deepEqual(e.recent[1].attrs, { kind: 'gold' });
  assert.deepEqual(e.frames, [{ ts: gd.recentWindows[0].ts, level: 'level-2', fps: 58.4, p95: 21.5 }]);
  assert.equal(typeof e.ts, 'number');
  assert.ok(e.device && !('gpu' in e.device), 'an anonymous session sends the anonymous device');
  assert.equal(reports[0].body.service, 'zoomies');
  assert.equal(reports[0].body.session_id, gd.sessionId);
});

test('without positions on, a report says nothing about where the player was; screenshot: false sends none', async () => {
  const sent = capture();
  const gd = sdk();
  gd.render = { screenshot: () => 'data:image/jpeg;base64,c2NyZWVu' };
  gd.setPosition({ x: 1, y: 2, z: 3 });
  await gd.reportBug({ note: 'no picture', screenshot: false });
  const e = sent.flatMap((r) => r.body.events).find((x) => x.type === 'bug_report');
  assert.equal('x' in e, false);
  assert.equal('screenshot' in e, false);
});

test('a report from an offline build is not sent, and one that fails is queued for the next batch', async () => {
  assert.deepEqual(await sdk({ intake: null }).reportBug({ note: 'x' }), { sent: false, reason: 'offline' });
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const gd = sdk();
  assert.deepEqual(await gd.reportBug({ note: 'later' }), { sent: false, reason: 'error' });
  // It waits as a batch of its own, with its batch_id, and the next flush sends it on its own request again.
  assert.equal(gd.retries.flatMap((b) => b.events).find((e) => e.type === 'bug_report')?.note, 'later');
  const sent = capture();
  gd.flush();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.find((r) => r.body.events[0].type === 'bug_report')?.body.events.map((e) => e.note), ['later']);
});

test('a screenshot is shrunk until it fits 200,000 characters, and kept as it is when it already does', async () => {
  const small = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  assert.equal(await fitScreenshot(small), small);
  canvases.length = 0;
  const big = await fitScreenshot('data:image/jpeg;base64,' + 'A'.repeat(MAX_SCREENSHOT + 1));
  assert.ok(big.length <= MAX_SCREENSHOT);
  // 960 × 540 at 0.7 and 800 × 450 at 0.6 are too big; 640 × 360 at 0.6 fits.
  assert.deepEqual([canvases[0].width, canvases[0].height], [640, 360]);
  assert.equal(await fitScreenshot('https://example.com/a.jpg'), null);
  assert.equal(await fitScreenshot(null), null);
});

test('the form holds keys, clicks and mouse movement back from the game while it is open', () => {
  const key = (k, extra = {}) => ({ type: 'keydown', key: k, code: k, ...extra });
  const closed = { open: false, hotkey: 'F8' };
  const open = { open: true, hotkey: 'F8' };
  assert.equal(route(key('F8'), closed), 'open');
  assert.equal(route(key('F8', { repeat: true }), closed), 'pass');
  assert.equal(route(key('KeyA'), closed), 'pass');
  assert.equal(route({ type: 'click' }, closed), 'pass');
  assert.equal(route(key('F8'), { open: false, hotkey: null }), 'pass');
  assert.equal(route(key('F8'), open), 'cancel');
  assert.equal(route(key('Escape'), open), 'cancel');
  assert.equal(route(key('Enter', { ctrlKey: true }), open), 'send');
  assert.equal(route(key('Enter', { metaKey: true }), open), 'send');
  assert.equal(route(key('Enter'), { ...open, inForm: true }), 'block');
  assert.equal(route(key('KeyA'), { ...open, inForm: true }), 'block');
  assert.equal(route({ type: 'click' }, { ...open, inForm: true, button: 'send' }), 'send');
  assert.equal(route({ type: 'click' }, { ...open, inForm: true, button: 'cancel' }), 'cancel');
  for (const type of ['pointerdown', 'mousemove', 'wheel', 'touchstart', 'contextmenu']) assert.equal(route({ type }, open), 'block');
});
