// Steam facts from an Electron game's steamworks.js client (steam.js, SPEC §4c), with a fake client shaped like
// steamworks.js's: read once at init, only from the client the game passes, never a Steam ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSteam, withSteam, steamVersion } from '../src/steam.js';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { Glitchless } = await import('../src/core.js');

// What steamworks.init() returns, as far as the SDK reads it. `calls` records every call, to show nothing else
// (localplayer.getSteamId, apps.appOwner) is touched.
function fakeClient({ build = 18231, beta = null, deck = false, bigPicture = false, controllers = [], language = 'english', extra = {} } = {}) {
  const calls = [];
  const fn = (name, value) => () => {
    calls.push(name);
    if (value instanceof Error) throw value;
    return value;
  };
  const client = {
    apps: { appBuildId: fn('appBuildId', build), currentBetaName: fn('currentBetaName', beta), currentGameLanguage: fn('currentGameLanguage', language), appOwner: fn('appOwner', { steamId64: 76561197960287930n }), ...extra.apps },
    utils: { isSteamRunningOnSteamDeck: fn('isSteamRunningOnSteamDeck', deck), getAppId: fn('getAppId', 480), ...extra.utils },
    input: { getControllers: fn('getControllers', controllers) },
    localplayer: { getSteamId: fn('getSteamId', { steamId64: 76561197960287930n }), getName: fn('getName', 'Gabe') },
  };
  return { client, calls };
}

test('steamworks.js answers the build, branch, hardware, controller and language', () => {
  const { client, calls } = fakeClient({ beta: 'beta', deck: true, controllers: [{ getType: () => 'SteamDeckController' }, { getType: () => 'PS5Controller' }] });
  assert.deepStrictEqual(readSteam(client), { steam_build: 18231, steam_branch: 'beta', steam_hardware: 'deck', steam_controller: 'steam_deck', steam_language: 'english' });
  assert.ok(!calls.includes('getSteamId') && !calls.includes('appOwner') && !calls.includes('getName'), 'no Steam ID, owner or name is read');
});

test('the default branch is public, a non-Steam build sends no build, and missing calls are left out', () => {
  const { client } = fakeClient({ build: 0, controllers: [] });
  assert.deepStrictEqual(readSteam(client), { steam_branch: 'public', steam_hardware: 'none', steam_language: 'english' });
});

test('newer wrappers: Steam hardware, Proton, Big Picture, family sharing and timed trials when they are there', () => {
  const { client } = fakeClient({
    controllers: [{ getType: () => 'SomethingNew' }],
    extra: { utils: { isRunningOnSteamHardware: () => 2, isRunningUnderProton: () => true, isSteamInBigPictureMode: () => true }, apps: { isSubscribedFromFamilySharing: () => true, isTimedTrial: () => false } },
  });
  assert.deepStrictEqual(readSteam(client), { steam_build: 18231, steam_branch: 'public', steam_hardware: 'machine', proton: true, big_picture: true, family_shared: true, timed_trial: false, steam_controller: 'other', steam_language: 'english' });
  assert.equal(readSteam(fakeClient({ extra: { utils: { isRunningOnSteamHardware: () => 'SteamFrame' } } }).client).steam_hardware, 'frame');
});

test('a call that throws is left out, and anything that is not a client reads nothing', () => {
  const { client } = fakeClient({ beta: new Error('Steam client not initialized') });
  const facts = readSteam(client);
  assert.equal(facts.steam_branch, undefined);
  assert.equal(facts.steam_build, 18231);
  assert.equal(readSteam(null), null);
  assert.equal(readSteam({ init() {}, restartAppIfNecessary() {} }), null, 'the steamworks.js module itself, before init');
});

test('Steam hardware refines the Steam Deck tag, and the build is the version a game passes none', () => {
  assert.deepStrictEqual(withSteam({ os: 'Linux', gpu_tier: 'mid' }, { steam_hardware: 'deck' }), { os: 'Linux', gpu_tier: 'low', steam_hardware: 'deck', steam_deck: true });
  assert.deepStrictEqual(withSteam({ os: 'Windows' }, null), { os: 'Windows' });
  assert.equal(steamVersion({ steam_build: 42 }), 'steam-42');
  assert.equal(steamVersion({ steam_branch: 'public' }), null);
});

test('init with a steamworks.js client: session_start carries the facts, and versions default to steam-<build>', () => {
  globalThis.location = { origin: 'http://localhost:5173', pathname: '/' };
  globalThis.document = { referrer: '' };
  globalThis.performance ??= {};
  const { client } = fakeClient({ beta: 'nightly' });
  const gd = new Glitchless({ service: 'skyline', steam: client });
  gd._device = { browser: 'Chrome', browser_version: '141.0.1', os: 'Windows', mobile: false, gpu: 'RTX 4070', gpu_tier: 'high', webgl: 'webgl2', screen: [1920, 1080], dpr: 1 };
  assert.equal(gd.opts.version, 'steam-18231');
  const start = gd.sessionStartEvent();
  assert.equal(start.device.steam_build, 18231);
  assert.equal(start.device.steam_branch, 'nightly');
  assert.equal(start.device.gpu, undefined, 'anonymous mode still sends no GPU name');
  assert.ok(!JSON.stringify(start).includes('76561197960287930'), 'no Steam ID anywhere');
  assert.equal(new Glitchless({ service: 'skyline', version: '2.0.1', steam: client }).opts.version, '2.0.1', "the game's own version wins");
  const plain = new Glitchless({ service: 'skyline' });
  assert.equal(plain.opts.version, '0.0.0');
  assert.equal(plain.steam, null);
});
