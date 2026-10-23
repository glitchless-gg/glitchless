// Privacy levels and the ID install and full mode keep on the device (PRIVACY.md, SPEC §4b), and the Steam Deck tag.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSteamDeck, anonymizeDevice } from '../src/device.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const { Glitchless } = await import('../src/core.js');

const sdk = (privacy) => new Glitchless({ service: 'zoomies', version: '1.0.0', privacy });

beforeEach(() => storage.clear());

test('anonymous mode sends no player ID and keeps none', () => {
  storage.set('glitchless.pid', 'p_left0by0full00');
  assert.equal(sdk().playerId, null);
  assert.equal(sdk('anonymous').playerId, null);
  assert.deepEqual([...storage.keys()], [], 'the ID another build left is removed');
});

test('install mode makes one random p_ ID, keeps it in localStorage and sends it from then on', () => {
  const first = sdk('install');
  assert.match(first.playerId, /^p_[a-z0-9]{12}$/);
  assert.equal(first.privacy, 'install');
  assert.deepEqual([...storage], [['glitchless.pid', first.playerId]]);
  assert.equal(sdk('install').playerId, first.playerId, 'the next launch sends the same ID');
});

test('install mode sends what anonymous mode sends about the device, and no positions', () => {
  const gd = sdk('install');
  gd._device = { browser: 'Chrome', browser_version: '141.0.1', os: 'Linux', mobile: false, gpu: 'AMD Custom GPU 0405 (vangogh', gpu_vendor: 'AMD', gpu_tier: 'unknown', webgl: 'webgl2', cores: 8, memory_gb: 16, screen: [1280, 800], dpr: 1, steam_deck: true };
  globalThis.location = { origin: 'http://localhost:5173', pathname: '/' };
  globalThis.document = { referrer: '' };
  globalThis.performance ??= {};
  const start = gd.sessionStartEvent();
  assert.equal(start.privacy, 'install');
  assert.deepEqual(start.device, anonymizeDevice(gd._device));
  assert.equal(gd.positionsOn, false);
  gd.death({ x: 1, y: 2, cause: 'fell' });
  assert.ok(!('x' in gd.queue.at(-1)), 'a death without its place');
});

test('install and full mode share the one stored ID, so a game that moves between them keeps its players', () => {
  const install = sdk('install').playerId;
  assert.equal(sdk('full').playerId, install);
  assert.equal(sdk('install').playerId, install);
  assert.deepEqual([...storage.keys()], ['glitchless.pid']);
});

test('resetInstallId forgets the ID: this session keeps its own, the next gets a new one', () => {
  const gd = sdk('install');
  const before = gd.playerId;
  gd.resetInstallId();
  assert.equal(gd.playerId, before, 'the session in progress is not split');
  assert.equal(storage.has('glitchless.pid'), false);
  const next = sdk('install').playerId;
  assert.match(next, /^p_/);
  assert.notEqual(next, before);
});

test('an unknown privacy level is anonymous', () => {
  assert.equal(sdk('everything').privacy, 'anonymous');
  assert.equal(sdk('everything').playerId, null);
});

test('without localStorage, install mode still sends an ID for this page load', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  try {
    assert.match(sdk('install').playerId, /^p_[a-z0-9]{12}$/);
  } finally {
    globalThis.localStorage = saved;
  }
});

// What browsers on a Steam Deck report (desktop mode Chrome and Firefox, and the OLED model's GPU).
test('steam_deck: from the Deck GPU or a user agent that names it, nothing when unsure', () => {
  const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  assert.equal(isSteamDeck({ userAgent: linuxChrome, gpu: 'AMD Custom GPU 0405 (vangogh' }), true, 'Chrome, LCD');
  assert.equal(isSteamDeck({ userAgent: linuxChrome, gpu: 'AMD Custom GPU 0932 (radeonsi, vangogh, LLVM 17.0.6, DRM 3.57)' }), true, 'Chrome, OLED');
  assert.equal(isSteamDeck({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Valve Steam Client SteamDeck/1' }), true);
  assert.equal(isSteamDeck({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', gpu: 'Radeon R9 200 Series, or similar' }), false, 'Firefox hides the GPU');
  assert.equal(isSteamDeck({ userAgent: linuxChrome, gpu: 'AMD Radeon RX 7900 XTX' }), false);
  assert.equal(isSteamDeck({}), false);
  assert.deepEqual(anonymizeDevice({ browser: 'Chrome', browser_version: '141.0', os: 'Linux', steam_deck: true }).steam_deck, true, 'anonymous mode keeps the tag');
  assert.ok(!('steam_deck' in anonymizeDevice({ browser: 'Chrome', browser_version: '141.0', os: 'Linux' })), 'and adds nothing when it is not one');
});
