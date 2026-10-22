// Time without focus is not a frame: iOS Control Center, a call or Siri over Safari take focus without
// hiding the page, and no animation frames come until focus is back. A real freeze still counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Map();
const fire = (name) => (listeners.get(name) || []).forEach((fn) => fn());
globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5175', pathname: '/' };
globalThis.requestAnimationFrame = () => 0;

const { Glitchless } = await import('../src/core.js');

// Made without `window` (no requestAnimationFrame loop or other browser listeners), then given just the
// frame loop's listeners, so the test drives tick() itself.
function sdk() {
  const gd = new Glitchless({ service: 'focus', version: '1.0.0', intake: null });
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) || []), fn]) };
  gd.installFrameLoop();
  delete globalThis.window;
  return gd;
}

function play(gd, t, frames) {
  for (let i = 0; i < frames; i++) gd.tick((t += 16.7));
  return t;
}

test('time out of focus is not a frame, so it is no freeze', () => {
  listeners.clear();
  const gd = sdk();
  let t = play(gd, 1000, 60);
  fire('blur');
  t += 1500; // Control Center is down: nothing is drawn
  fire('focus');
  play(gd, t, 60);
  assert.equal(gd.win.frozen, 0);
  assert.ok(gd.win.max < 100, `worst frame ${gd.win.max} ms`);
});

test('a real freeze, with focus all along, is still a frozen frame', () => {
  listeners.clear();
  const gd = sdk();
  let t = play(gd, 1000, 60);
  t += 1500;
  play(gd, t, 60);
  assert.equal(gd.win.frozen, 1);
  assert.ok(gd.win.max >= 1500, `worst frame ${gd.win.max} ms`);
});
