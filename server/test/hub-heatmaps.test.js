// Heatmaps of a place with no levels (places.js, maps.js): a hub such as Roblox Starlift's lobby, where players walk
// between zones (setZone) without a level. A positions panel and the Heatmaps view show one level, one zone or the
// whole game; maps belong to a place the same way; and a background can be uploaded with no SDK code (PUT /v1/maps),
// on every store, and seen through a share link only where its board draws that place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { buildContext, heatmap, heatmapPlaces, heatmapPlace } from '../src/analytics.js';
import { validateBoard, evaluateBoard, pathPlaces } from '../src/board.js';
import { placeOf, pickMap, mapSortKey, mapId } from '../src/places.js';
import { mapUpload, MapError } from '../src/maps.js';
import { STORES } from './helpers/stores.js';
import { png, jpeg, svg } from './helpers/images.js';

const NOW = Date.now();
const START = NOW - 2 * 3_600_000;
const ctxOf = (events, service = 'hub') => buildContext(events, { service, from: START - 60_000, to: NOW, type: 'all' });

// Players walk the hall (x 0..9, z 0) and the garden (x 50..59, z 20), with no level; two die in the garden; one
// session also plays a puzzle level, whose positions and death carry the level.
function hubGame({ service = 'hub', sessions = 4 } = {}) {
  const out = [];
  for (let i = 0; i < sessions; i++) {
    const base = { service, env: 'prod', version: '1.0.0', session_id: `hub_${i}`, player_id: `hub_${i}` };
    const ts = START + i * 60_000;
    out.push({ ...base, type: 'session_start', ts, level: null });
    out.push({ ...base, type: 'pos', ts: ts + 1000, level: null, zone: 'hall', pts: Array.from({ length: 10 }, (_, k) => [ts + 1000 + k, k + 0.5, 1, 0.5]) });
    out.push({ ...base, type: 'pos', ts: ts + 2000, level: null, zone: 'garden', pts: Array.from({ length: 5 }, (_, k) => [ts + 2000 + k, 50 + k + 0.5, 1, 20.5]) });
    if (i < 2) out.push({ ...base, type: 'death', ts: ts + 3000, level: null, zone: 'garden', x: 52.5, y: 1, z: 20.5, cause: 'thorns' });
    if (i === 0) {
      out.push({ ...base, type: 'level_start', ts: ts + 4000, level: 'puzzle-1', zone: 'hall' });
      out.push({ ...base, type: 'pos', ts: ts + 5000, level: 'puzzle-1', pts: [[ts + 5000, 100.5, 1, 100.5]] });
      out.push({ ...base, type: 'death', ts: ts + 6000, level: 'puzzle-1', x: 100.5, y: 1, z: 100.5, cause: 'spikes' });
    }
  }
  return out;
}

test('a positions panel shows one zone, or with neither level nor zone every position and death in the game', () => {
  const ctx = ctxOf(hubGame());
  const board = validateBoard({ panels: [{ type: 'positions', zone: 'hall', show: 'path', bin: 1 }, { type: 'positions', zone: 'garden', show: 'both', bin: 1 }, { type: 'positions', show: 'both', bin: 1 }, { type: 'positions', level: 'puzzle-1', bin: 1 }] });
  assert.deepEqual(board.panels.map((p) => [p.level, p.zone]), [[undefined, 'hall'], [undefined, 'garden'], [undefined, undefined], ['puzzle-1', undefined]]);
  const [hall, garden, all, puzzle] = evaluateBoard(ctx, board);
  assert.equal(hall.title, 'Where players went in hall');
  assert.equal(garden.title, 'Where players went and died in garden');
  assert.equal(all.title, 'Where players went and died');
  assert.equal(puzzle.title, 'Where players died on puzzle-1');

  assert.equal(hall.zone, 'hall');
  assert.equal(hall.level, undefined);
  assert.equal(hall.axis, 'xz', 'the hub is seen from above: positions leave z = 0');
  assert.equal(hall.path.samples, 40, "only the hall's samples");
  assert.ok(hall.path.cells.every(([a]) => a < 10));
  assert.equal(garden.total, 2);
  assert.deepEqual(garden.deaths, [[52.5, 20.5, 2]]);
  assert.equal(garden.path.samples, 20);
  // The whole game: both zones, the level's samples and every death.
  assert.equal(all.level, undefined);
  assert.equal(all.zone, undefined);
  assert.equal(all.path.samples, 61);
  assert.equal(all.total, 3);
  assert.equal(puzzle.total, 1);
  assert.equal(JSON.stringify([hall, garden, all]).includes('hub_'), false, 'no session or player ids');

  // Nothing there says where it looked.
  const [none, noZone] = evaluateBoard(ctx, { panels: [{ type: 'positions', zone: 'roof' }, { type: 'positions', zone: 'roof', show: 'path' }] });
  assert.deepEqual([none.empty, none.why], [true, 'No deaths in roof in this window.']);
  assert.equal(noZone.why, 'No positions in roof in this window: the game sends them with setPosition.');
  const [empty] = evaluateBoard(ctxOf([]), { panels: [{ type: 'positions', show: 'both' }] });
  assert.equal(empty.why, 'No deaths or positions in this window.');

  // A store reads paths apart per place.
  assert.deepEqual(pathPlaces(board.panels.length ? board : null), [{ zone: 'hall' }, { zone: 'garden' }, {}]);
  assert.throws(() => validateBoard({ panels: [{ type: 'positions', level: 'puzzle-1', zone: 'hall' }] }), /one level or one zone/);
});

test("maps belong to a place: a level's (even one captured in a zone), a zone's or the whole game's; an upload outranks a capture", () => {
  const map = (o) => ({ type: 'map', axis: 'xz', bounds: { min: [0, 0], max: [60, 30] }, image: `data:image/png;base64,${Buffer.from(JSON.stringify(o)).toString('base64')}`, ...o });
  const level = map({ level: 'puzzle-1', zone: 'hall', version: '1.0.0', ts: 1 });
  const hall = map({ zone: 'hall', version: '1.0.0', ts: 2 });
  const hallNew = map({ zone: 'hall', version: '1.1.0', ts: 3 });
  const whole = map({ version: '1.0.0', ts: 4 });
  const upload = map({ zone: 'hall', uploaded: true, version: null, ts: 0 });
  const maps = [level, hall, hallNew, whole];
  assert.deepEqual(placeOf(level), { level: 'puzzle-1' }, 'the SDK stamps the zone it was captured in: still the level\'s');
  assert.equal(pickMap(maps, { level: 'puzzle-1' }), level);
  assert.equal(pickMap(maps, { zone: 'hall' }, '1.0.0'), hall, 'the capture from this version');
  assert.equal(pickMap(maps, { zone: 'hall' }, '2.0.0'), hallNew, 'else the newest');
  assert.equal(pickMap(maps, {}), whole);
  assert.equal(pickMap(maps, { zone: 'garden' }), whole, "a zone without a map of its own is drawn over the whole game's");
  assert.equal(pickMap([level, hall], { zone: 'garden' }), null);
  assert.equal(pickMap([whole], { level: 'puzzle-2' }), null, 'a level never borrows: it has a world of its own');
  assert.equal(pickMap([...maps, upload], { zone: 'hall' }, '1.0.0'), upload, 'an upload, whatever the version');
  assert.deepEqual([level, hall, whole, upload].map(mapSortKey), ['puzzle-1#1.0.0', '~zone~hall#1.0.0', '~all~#1.0.0', '~zone~hall#~upload']);

  // The panel names its background's address, never the picture; the Heatmaps view draws the picture itself.
  const ctx = ctxOf(hubGame());
  const [p] = evaluateBoard(ctx, { panels: [{ type: 'positions', zone: 'hall', show: 'path' }] }, { maps: [...maps, upload] });
  assert.deepEqual(p.background, { url: `/v1/maps/image?service=hub&id=${mapId(upload)}`, id: mapId(upload), size: null, uploaded: true });
  assert.deepEqual(p.bounds, upload.bounds);
  assert.equal(JSON.stringify(p).includes('base64'), false, 'a game polls this');
  const h = heatmap(ctx, { zone: 'hall' }, [...maps, upload]);
  assert.equal(h.map.image, upload.image);
  assert.equal(h.map.uploaded, true);
});

test('the Heatmaps view lists levels and zones and shows the first level, else the whole game', () => {
  const ctx = ctxOf(hubGame());
  assert.deepEqual(heatmapPlaces(ctx, [{ zone: 'roof' }]), { levels: ['puzzle-1'], zones: ['garden', 'hall', 'roof'], no_level: true });
  assert.equal(heatmapPlaces(ctxOf(hubGame().filter((e) => e.level)), []).no_level, false, 'a game whose players always have a level');
  const params = (o) => new URLSearchParams(o);
  assert.deepEqual(heatmapPlace(ctx, [], params({})), { level: 'puzzle-1' });
  assert.deepEqual(heatmapPlace(ctx, [], params({ zone: 'hall' })), { zone: 'hall' });
  assert.deepEqual(heatmapPlace(ctx, [], params({ all: '1' })), {});
  // A hub with no levels at all opens on the whole game.
  const hubOnly = ctxOf(hubGame().filter((e) => !e.level));
  assert.deepEqual(heatmapPlace(hubOnly, [], params({})), {});

  const garden = heatmap(ctx, { zone: 'garden' }, []);
  assert.equal(garden.zone, 'garden');
  assert.equal(garden.level, null);
  assert.equal(garden.density.samples, 20);
  assert.equal(garden.deaths.length, 2);
  assert.equal(garden.hotspots[0].top_cause, 'thorns');
  assert.deepEqual(garden.stats, { zone: 'garden', sessions: 4, deaths: 2, deaths_per_session: 0.5, rage_quits: 0, rage_quit_pct: 0 });
  const all = heatmap(ctx, {}, []);
  assert.equal(all.density.samples, 61);
  assert.equal(all.deaths.length, 3);
  assert.equal(heatmap(ctx, 'puzzle-1', []).stats.level, 'puzzle-1', 'a level still has its funnel row');
});

test('an upload is a picture checked by its content, with a place, an axis and world bounds', () => {
  const q = (o) => new URLSearchParams({ min: '-120,-80', max: '120,80', ...o });
  const m = mapUpload('hub', q({ zone: 'hall' }), png(64, 32), 123);
  assert.deepEqual({ ...m, image: m.image.slice(0, 22) }, { type: 'map', service: 'hub', zone: 'hall', axis: 'xz', bounds: { min: [-120, -80], max: [120, 80] }, size: [64, 32], image: 'data:image/png;base64,', uploaded: true, version: null, env: null, ts: 123 });
  assert.equal(mapUpload('hub', q({ axis: 'xy' }), jpeg(800, 400)).image.startsWith('data:image/jpeg;base64,'), true);
  assert.equal(mapUpload('hub', q({}), png()).level, undefined, 'neither: the whole game');
  const status = (params, bytes) => {
    try {
      mapUpload('hub', params, bytes);
    } catch (err) {
      assert.ok(err instanceof MapError);
      return [err.status, err.message];
    }
    return [200];
  };
  assert.equal(status(q({ level: 'a', zone: 'b' }), png())[0], 400);
  assert.match(status(q({ axis: 'yz' }), png())[1], /axis is xz/);
  assert.match(status(new URLSearchParams({ min: '0,0' }), png())[1], /max is the largest/);
  assert.match(status(q({ max: '-200,80' }), png())[1], /max must be above min/);
  assert.match(status(q({ min: '1,2,3' }), png())[1], /min is the smallest/);
  assert.equal(status(q({}), svg)[0], 415);
  assert.equal(status(q({}), Buffer.alloc(0))[0], 400);
  assert.equal(status(q({}), png(4, 4, { pad: 256 * 1024 + 1 }))[0], 413);
  assert.equal(status(q({}), png(5000, 10))[0], 400);
});

const SHARE = { id: 'share-1', service: 'hub', page: 'lobby' };
const readers = {
  writer: { projectId: 'p1', scopes: ['read', 'dashboard'] },
  reader: { projectId: 'p1', scopes: ['read'] },
  other: { projectId: 'p2', scopes: ['read', 'dashboard'] },
  share: { projectId: 'p1', scopes: ['read'], share: SHARE, keyId: 'share', rps: 1000 },
};
const auth = {
  resolveIngest() {
    return { projectId: 'p1' };
  },
  resolveReader(req) {
    const r = readers[req.headers['x-test-reader']];
    if (!r) throw new AuthError(401, 'no key');
    return r;
  },
};

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a background is uploaded for a zone, drawn by its panel, listed, shown through a share link of that board only, and deleted`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, reader, body, raw = false) => {
      const res = await fetch(base + p, { method, headers: { 'x-test-reader': reader }, ...(body ? { body } : {}) });
      return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: raw ? Buffer.from(await res.arrayBuffer()) : await res.json() };
    };
    try {
      // The hub's play, through intake, and a map event an SDK sent for the garden (it can't call itself an upload).
      const events = hubGame();
      for (const id of new Set(events.map((e) => e.session_id))) {
        const mine = events.filter((e) => e.session_id === id).map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e);
        await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service: 'hub', env: 'prod', version: '1.0.0', session_id: id, player_id: id, events: mine }) });
      }
      const captured = `data:image/png;base64,${png(8, 8, { rgb: [1, 2, 3] }).toString('base64')}`;
      await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service: 'hub', env: 'prod', version: '1.0.0', session_id: 'hub_9', player_id: 'hub_9', events: [{ type: 'map', ts: NOW - 60_000, zone: 'garden', axis: 'xz', bounds: { min: [40, 10], max: [70, 30] }, image: captured, uploaded: true }] }) });
      await settle?.();

      const picture = png(64, 32);
      const put = (reader, query, body = picture) => call('PUT', `/v1/maps?service=hub&${query}`, reader, body);
      assert.equal((await put('reader', 'zone=hall&min=-1,-1&max=11,3')).status, 403, 'uploading needs the dashboard scope');
      const up = await put('writer', 'zone=hall&min=-1,-1&max=11,3');
      assert.equal(up.status, 201);
      assert.deepEqual([up.body.map.zone, up.body.map.axis, up.body.map.size, up.body.map.uploaded], ['hall', 'xz', [64, 32], true]);
      assert.equal((await put('writer', 'zone=hall&min=0,0&max=1,1', svg)).status, 415);
      assert.equal((await put('writer', 'zone=hall&min=0,0&max=1,1', png(4, 4, { pad: 300 * 1024 }))).status, 413);
      assert.equal((await put('writer', 'zone=hall&level=x&min=0,0&max=1,1')).status, 400);

      const list = await call('GET', '/v1/maps?service=hub', 'reader');
      assert.equal(list.status, 200);
      const byZone = Object.fromEntries(list.body.maps.map((m) => [m.zone, m]));
      assert.equal(byZone.hall.uploaded, true);
      assert.equal(byZone.garden.uploaded, false, "a game's map event is a capture, whatever it says");
      assert.equal(JSON.stringify(list.body).includes('base64'), false, 'the list names pictures, never carries them');
      assert.equal((await call('GET', '/v1/maps?service=hub', 'other')).body.maps.length, 0, "another project never sees this game's maps");

      // The picture at its address: its own type, kept for good.
      const img = await call('GET', byZone.hall.url, 'reader', null, true);
      assert.equal(img.status, 200);
      assert.equal(img.type, 'image/png');
      assert.match(img.cache, /immutable/);
      assert.ok(img.body.equals(picture));
      assert.equal((await call('GET', '/v1/maps/image?service=hub&id=0123456789abcdef', 'reader')).status, 404);

      // A board: the hall's path over its upload, the garden's deaths over its capture.
      const panels = [{ type: 'positions', zone: 'hall', show: 'path', bin: 1 }, { type: 'positions', zone: 'garden', bin: 1 }];
      assert.equal((await call('PUT', '/v1/dashboard?service=hub', 'writer', JSON.stringify({ pages: [{ id: 'lobby', title: 'Lobby', panels }, { id: 'other', title: 'Other', panels: [{ type: 'positions', show: 'both' }] }] }))).status, 200);
      const range = `from=${START - 3_600_000}&to=${NOW + 1}`;
      const board = (await call('GET', `/v1/query/board?service=hub&${range}&page=lobby`, 'reader')).body.board;
      const [hall, garden] = board.panels;
      assert.equal(hall.path.samples, 40, `${kind}: every hall position`);
      assert.deepEqual(hall.bounds, { min: [-1, -1], max: [11, 3] });
      assert.equal(hall.background.url, byZone.hall.url);
      assert.equal(garden.total, 2);
      assert.equal(garden.background.url, byZone.garden.url);
      assert.equal(garden.background.uploaded, false);

      // The Heatmaps view: the zones, the hall over its upload, the whole game over nothing.
      const hm = (await call('GET', `/v1/query/heatmap?service=hub&${range}&zone=hall`, 'reader')).body;
      assert.deepEqual([hm.zone, hm.level, hm.zones, hm.levels], ['hall', null, ['garden', 'hall'], ['puzzle-1']]);
      assert.equal(hm.density.samples, 40, `${kind}: the heatmap reads the hall's positions`);
      assert.equal(hm.map.uploaded, true);
      const all = (await call('GET', `/v1/query/heatmap?service=hub&${range}&all=1`, 'reader')).body;
      assert.equal(all.density.samples, 61);
      assert.equal(all.map, null);

      // A share link of the lobby board sees its places' pictures and no other.
      const shared = (await call('GET', `/v1/query/board?${range}`, 'share')).body.board;
      assert.equal(shared.panels[0].background.url, byZone.hall.url, 'a shared positions panel keeps its background');
      assert.equal(shared.panels[0].zone, 'hall');
      assert.equal((await call('GET', byZone.hall.url, 'share', null, true)).status, 200);
      assert.equal((await call('GET', byZone.garden.url, 'share', null, true)).status, 200);
      // A level's picture isn't on the lobby board; the whole game's is, as a zone's fallback.
      const upLevel = await put('writer', 'level=puzzle-1&min=0,0&max=200,200', png(16, 16, { rgb: [9, 9, 9] }));
      assert.equal(upLevel.status, 201);
      assert.equal((await call('GET', upLevel.body.map.url, 'share', null, true)).status, 404, "a level's picture isn't on the shared board");
      assert.equal((await call('GET', upLevel.body.map.url, 'reader', null, true)).status, 200);
      const upWhole = await put('writer', 'min=0,0&max=200,200', png(16, 16, { rgb: [7, 7, 7] }));
      assert.equal((await call('GET', upWhole.body.map.url, 'share', null, true)).status, 200, "a zone with no picture of its own draws the whole game's");
      assert.equal((await call('PUT', '/v1/maps?service=hub&min=0,0&max=1,1', 'share', picture)).status, 403);

      // Deleting the upload goes back to the capture, and to nothing where there was none.
      assert.equal((await call('DELETE', '/v1/maps?service=hub&zone=garden', 'writer')).status, 404, 'the garden has no upload to delete');
      assert.equal((await call('DELETE', '/v1/maps?service=hub&zone=hall', 'writer')).status, 200);
      const after = (await call('GET', `/v1/query/board?service=hub&${range}&page=lobby`, 'reader')).body.board.panels;
      assert.equal(after[1].background.url, byZone.garden.url);
      assert.deepEqual((await call('GET', '/v1/maps?service=hub', 'reader')).body.maps.map((m) => m.level ?? m.zone ?? 'all').sort(), ['all', 'garden', 'puzzle-1']);
      // With no upload and no capture of its own, the hall is drawn over the whole game's picture.
      assert.equal(after[0].background.url, upWhole.body.map.url);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
