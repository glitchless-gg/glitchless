// Player and session properties (SPEC §1 setProperties, §2 props; design A6): what holds for a session, sent in every
// privacy mode, checked so it can never say who the player is, at most one props event a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5182', pathname: '/' };
globalThis.performance ??= {};

const { propKeyProblem, propValue, looksIdentifying, gameAttrs } = await import('../src/props.js');
const { Glitchless } = await import('../src/core.js');

function sdk(opts = {}) {
  const gd = new Glitchless({ service: 'props', version: '1.0.0', intake: null, ...opts });
  gd.warnOnce = () => {}; // the console stays quiet; the rules are checked by what gets through
  return gd;
}
const propsEvents = (gd) => gd.queue.filter((e) => e.type === 'props');

test('keys are short lower-case words, never a built-in split or a key that names a person or a device', () => {
  for (const ok of ['rank', 'class', 'level_band', 'region', 'mode', 'input', 'arena', 'spender', 'a1']) assert.equal(propKeyProblem(ok), null, ok);
  for (const bad of ['Rank', '1st', 'rank-tier', 'r'.repeat(33), '', 'with space']) assert.match(propKeyProblem(bad), /lower-case/, bad);
  for (const reserved of ['version', 'level', 'platform', 'device_tier', 'link', 'zone', 'match', 'steam_branch', 'hours']) assert.match(propKeyProblem(reserved), /built-in/, reserved);
  for (const who of ['name', 'email', 'user_id', 'steam_id', 'ip', 'device_id', 'idfa', 'age', 'gender', 'city']) assert.match(propKeyProblem(who), /who the player is/, who);
});

test('values are words, booleans or whole numbers; anything shaped like an ID, an address or a number to call is dropped', () => {
  assert.equal(propValue('  gold  '), 'gold');
  assert.equal(propValue('x'.repeat(80)), 'x'.repeat(64));
  assert.equal(propValue(true), true);
  assert.equal(propValue(31), 31);
  assert.equal(propValue(-1_000_000), -1_000_000);
  for (const kept of ['30-39', '3000-3499', 'summer_2026', 'corpse_explosion', 'eu-west', 'arena_7', 'pit_80', 'Diamond III']) assert.equal(propValue(kept), kept, kept);
  for (const dropped of [
    1.5, 1_000_001, NaN, Infinity, '', '   ', null, ['a'], { a: 1 },
    'sam@example.com', 'https://example.com/u/sam', 'www.example.com', '5551234567', '+1 555 123 4567', '(555) 123-4567', '555-123-4567',
    '123e4567-e89b-12d3-a456-426614174000', 'deadbeefcafebabe00', 'aGVsbG8Xd29ybGQ1', '76561198000000000',
  ]) assert.equal(propValue(dropped), undefined, String(dropped));
  assert.equal(looksIdentifying('PlayerOne'), false);
});

test('properties set before the first batch go in session_start, in every mode, and nothing is kept on the device', () => {
  for (const privacy of ['anonymous', 'install', 'full']) {
    const gd = sdk({ privacy, properties: { mode: 'squads', region: 'eu-west', email: 'a@b.co' } });
    gd.setProperties({ input: 'controller', rank: 'gold' });
    const start = gd.sessionStartEvent();
    assert.deepEqual(start.props, { mode: 'squads', region: 'eu-west', input: 'controller', rank: 'gold' }, privacy);
  }
  assert.equal(sdk().sessionStartEvent().props, undefined, 'no properties, no field');
});

test('a later change is one props event a window, with only the keys that changed and null for a key removed', () => {
  const gd = sdk({ properties: { rank: 'gold', play: 'solo', region: 'eu' } });
  gd.sessionStartEvent();
  gd.sessionStartSent = true;
  gd.closeWindow();
  assert.equal(propsEvents(gd).length, 0, 'nothing changed');
  gd.setProperties({ rank: 'platinum' });
  gd.setProperties({ rank: 'diamond', play: null, region: 'eu' });
  gd.closeWindow();
  const [change] = propsEvents(gd);
  assert.deepEqual(change.props, { rank: 'diamond', play: null }, 'the last value of each key; region did not change');
  assert.equal(typeof change.ts, 'number');
  gd.setProperties({ rank: 'diamond' });
  gd.setProperties({ rank: 'master' });
  gd.setProperties({ rank: 'diamond' });
  gd.closeWindow();
  assert.equal(propsEvents(gd).length, 1, 'changed and changed back: nothing to send');
});

test('a session has at most 12 property keys, removed ones included', () => {
  const gd = sdk();
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']));
  gd.setProperties(twelve);
  gd.setProperties({ k0: null });
  gd.setProperties({ k12: 'v', k1: 'changed' });
  assert.equal(Object.keys(gd.props).length, 11);
  assert.equal(gd.props.k1, 'changed');
  assert.equal('k12' in gd.props, false);
});

test('the game hears once, outside prod, why a property was dropped', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const gd = new Glitchless({ service: 'props', version: '1.0.0', intake: null });
    gd.setProperties({ steam_id: '7656', email: 'x' });
    gd.setProperties({ steam_id: '7656' });
    gd.setProperties({ rank: 'sam@example.com' });
    new Glitchless({ service: 'props', version: '1.0.0', env: 'prod' }).setProperties({ email: 'x' });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /steam_id.*who the player is/);
  assert.match(warnings[2], /value of "rank"/);
});

test("level and group attributes follow a custom event's rules: 12, strings to 64, lists of 16 distinct values", () => {
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`a${i}`, i]));
  assert.equal(Object.keys(gameAttrs(many)).length, 12);
  assert.deepEqual(gameAttrs({ tier: 'pit_80', party_size: 3, hard: true, build: ['a', 'b', 'a', 1, true, { x: 1 }], skip: { x: 1 }, nan: NaN, long: 'y'.repeat(70) }), {
    tier: 'pit_80',
    party_size: 3,
    hard: true,
    build: ['a', 'b', 1, true],
    long: 'y'.repeat(64),
  });
  assert.equal(gameAttrs(Array.from({ length: 1 }, () => ({}))[0]), null);
  assert.equal(gameAttrs({ list: Array.from({ length: 30 }, (_, i) => `c${i}`) }).list.length, 16);
});
