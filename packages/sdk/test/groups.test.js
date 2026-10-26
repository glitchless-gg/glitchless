// Groups, level attributes and zones (SPEC §2 group, level_start, zone; design A7 and decision 6): match and party IDs
// hashed the same way in every SDK, runs made here and resumed only outside anonymous mode, the fields every event and
// window carries. (The adapters passing level attributes through is checked in phaser.test.js and babylon.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5183', pathname: '/' };

const { sha1Hex, hashGroupId, validGroupId } = await import('../src/groups.js');
const { Glitchless } = await import('../src/core.js');

function sdk(opts = {}) {
  const gd = new Glitchless({ service: 'zoomies', version: '1.0.0', intake: null, ...opts });
  gd.warnOnce = () => {};
  return gd;
}
const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
const of = (gd, type) => gd.queue.filter((e) => e.type === type);

test('the SDK\'s own SHA-1 matches Node\'s, for any length and any characters', () => {
  for (const s of ['', 'abc', 'zoomies:match-0001', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'é😀ü'.repeat(50)]) assert.equal(sha1Hex(s), sha1(s), `${s.length} chars`);
});

test('match and party IDs are "h_" and 24 hex of SHA-1("<service>:<id>"), the service in lower case, as every SDK sends them', () => {
  assert.equal(hashGroupId('Zoomies', 'match-0001'), 'h_' + sha1('zoomies:match-0001').slice(0, 24));
  assert.equal(hashGroupId('zoomies', 'm_8f2c91d04ab7'), 'h_d8a6ac978165726ac21a722b', 'the test vector Unity, Unreal and GameMaker check');
  assert.ok(validGroupId(hashGroupId('zoomies', 'x'.repeat(64))), 'a hashed ID passes the ID rule itself');
  for (const bad of ['short', 'x'.repeat(65), 'has space!', 'ümlaut-id-1', 12345678]) assert.equal(validGroupId(bad), false, String(bad));
});

test('setGroup stamps every later event and window with the group, until it ends', () => {
  const gd = sdk();
  const id = gd.setGroup('match', 'm-8f2c-4410', { mode: 'squads', players: 100 });
  assert.equal(id, hashGroupId('zoomies', 'm-8f2c-4410'));
  const party = gd.setGroup('party', 'party-77a1');
  gd.levelStart('island');
  gd.track('landed', { zone: 'docks' });
  gd.tick(1000);
  gd.tick(1016);
  gd.closeWindow();
  gd.setGroup('match', null);
  gd.track('lobby');
  const [setMatch, setParty, endMatch] = of(gd, 'group');
  assert.deepEqual([setMatch.kind, setMatch.id, setMatch.attrs], ['match', id, { mode: 'squads', players: 100 }]);
  assert.deepEqual([setParty.kind, setParty.id], ['party', party]);
  assert.deepEqual([endMatch.kind, endMatch.id, endMatch.match], ['match', null, undefined]);
  const landed = of(gd, 'custom')[0];
  assert.deepEqual([landed.match, landed.party, landed.level], [id, party, 'island']);
  assert.equal(of(gd, 'frame_window')[0].match, id);
  assert.equal(of(gd, 'level_start')[0].match, id);
  const lobby = of(gd, 'custom')[1];
  assert.deepEqual([lobby.match, lobby.party], [undefined, party]);
});

test('hashGroupIds: false sends the game\'s own IDs, to match them against its server logs', () => {
  const gd = sdk({ hashGroupIds: false });
  assert.equal(gd.setGroup('match', 'm-8f2c-4410'), 'm-8f2c-4410');
  assert.equal(of(gd, 'group')[0].id, 'm-8f2c-4410');
});

test('setGroup("run") makes a run ID; a saved run carries on in install and full mode and starts again in anonymous mode', () => {
  const fresh = sdk().setGroup('run');
  assert.match(fresh, /^r_[a-z0-9]{12}$/);
  for (const privacy of ['install', 'full']) {
    const gd = sdk({ privacy });
    assert.equal(gd.setGroup('run', 'r_savedrun0001'), 'r_savedrun0001', privacy);
    assert.equal(of(gd, 'group')[0].resumed, true);
  }
  const anon = sdk();
  const swapped = anon.setGroup('run', 'r_savedrun0001');
  assert.match(swapped, /^r_[a-z0-9]{12}$/);
  assert.notEqual(swapped, 'r_savedrun0001');
  assert.deepEqual([of(anon, 'group')[0].id, of(anon, 'group')[0].resumed], [swapped, true], 'nothing ties two launches together');
});

test('a bad kind, a match without an ID or an ID that breaks the rule is dropped, and nothing is stamped', () => {
  const gd = sdk();
  assert.equal(gd.setGroup('guild', 'guild-0001'), null);
  assert.equal(gd.setGroup('match'), null);
  assert.equal(gd.setGroup('match', 'abc'), null);
  assert.equal(gd.setGroup('party', 'sam@example.com'), null);
  assert.equal(gd.setGroup('match', null), null, 'ending a group that was never set sends nothing');
  gd.track('x');
  assert.equal(of(gd, 'group').length, 0);
  assert.deepEqual(Object.keys(gd.queue[0]).sort(), ['attrs', 'level', 'name', 'ts', 'type']);
});

test('levelStart(id, attrs) carries the attempt\'s attributes, lists included; a level without any has none', () => {
  const gd = sdk();
  gd.levelStart('nmd_ghoa', { tier: 'pit_80', party_size: 3, build: ['blood_surge', 'corpse_explosion', 'army_of_the_dead'] });
  gd.levelStart('town');
  const [a, b] = of(gd, 'level_start');
  assert.deepEqual(a.attrs, { tier: 'pit_80', party_size: 3, build: ['blood_surge', 'corpse_explosion', 'army_of_the_dead'] });
  assert.equal('attrs' in b, false);
});

test('a zone stamps events and windows like the level, and a new zone closes the window', () => {
  const gd = sdk();
  gd.levelStart('world');
  gd.setZone('westfall');
  let t = 1000;
  for (let i = 0; i < 60; i++) gd.tick((t += 16.7));
  gd.track('quest', { id: 'q1' });
  gd.setZone('elwynn');
  for (let i = 0; i < 60; i++) gd.tick((t += 16.7));
  gd.setZone(null);
  gd.track('menu');
  gd.closeWindow();
  assert.deepEqual(of(gd, 'frame_window').map((w) => [w.level, w.zone, w.frames]), [['world', 'westfall', 59], ['world', 'elwynn', 60]], 'the first tick only starts the clock');
  assert.deepEqual(of(gd, 'custom').map((e) => e.zone), ['westfall', undefined]);
  gd.setZone('x'.repeat(80));
  assert.equal(gd.zone.length, 64);
});
