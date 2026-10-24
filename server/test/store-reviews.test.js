// Store reviews (reviews.js, SPEC §3f): store-neutral storage, the join by build (from a store's release history, the
// builds the game's sessions name, patch notes or versions), the board panels, the finding and the reviews query.
// Steam feeds them here through its adapter (steam.js) from a scenario; a store whose reviews name their version (as the
// App Store's and Google Play's will) feeds the same pipeline. Nothing calls a store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { createStoreData, reviewText } from '../src/reviews.js';
import { steamClient, syncKeyless, steamMarks } from '../src/steam.js';
import { validateDashboard } from '../src/board.js';
import { steamScenario, steamFetch, scenarioSessions, memoryKv, APP_ID } from './helpers/steam-data.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// One keyless Steam sync written as the cloud's sync writes it: reviews, players online, patch notes as marks, the score.
async function syncSteam(data, projectId, sc, now, { notes = true } = {}) {
  const run = await syncKeyless({ client: steamClient({ fetch: steamFetch(sc) }), appId: APP_ID, now });
  await data.write(projectId, 'steam', { reviews: run.reviews, players: run.players, summary: run.summary, ...(notes ? { notes: steamMarks({ news: run.news }).notes } : {}), syncedAt: now });
  return run;
}

test('stored reviews: overlapping syncs count each review once, a read gives the range, and long texts stay under the item limit', async () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const sc = steamScenario({ now });
  const kv = memoryKv();
  const data = createStoreData(kv);
  const run = await syncSteam(data, 'p1', sc, now);
  assert.equal(await data.write('p1', 'steam', { reviews: run.reviews.slice(0, 40), syncedAt: now }), 0, 'the overlap of the next run adds nothing');
  const read = await data.read('p1', 'steam', { from: now - 7 * DAY, to: now });
  assert.equal(read.store, 'steam');
  assert.equal(read.hours.reduce((n, h) => n + h[1] + h[2], 0), sc.reviews.filter((r) => r.timestamp_created * 1000 >= now - 30 * DAY - HOUR).length);
  assert.ok(read.reviews.every((r, i) => !i || read.reviews[i - 1].ts >= r.ts), 'newest first');
  assert.equal(read.reviews.length, sc.reviews.length, 'all within the last 62 days');
  assert.deepEqual(read.players.at(-1), [now, sc.players.at(-1)[1]]);
  assert.ok(read.notes.length === 2 && read.notes.every((n) => n.source === 'patch_notes'));
  assert.equal(read.summary.total, sc.reviews.length);
  assert.ok([...kv.items.values()].every((i) => !/^(R|RH|PL)#/.test(i.sk) || i.expiresAt > now / 1000 + 300 * 86400));
  assert.equal(JSON.stringify([...kv.items.values()]).includes('76561190'), false, 'no author IDs stored');
  assert.deepEqual(await data.stats('p1', 'steam'), { reviews: sc.reviews.length, syncedAt: now, summary: read.summary });

  // A day of 400 long reviews in Chinese: counted, but their texts kept only up to 300 KB of UTF-8 (DynamoDB's limit
  // is 400 KB an item, and a CJK character is three bytes).
  const day = Date.parse('2026-10-23T00:00:00Z');
  const long = Array.from({ length: 400 }, (_, i) => ({ store: 'steam', id: `cjk${i}`, ts: day + i * 1000, up: false, rating: null, lang: 'schinese', ...reviewText('游戏卡顿'.repeat(200)), version: null, device: null, steam: { deck: false } }));
  await data.write('p1', 'steam', { reviews: long, syncedAt: now });
  const item = await kv.get('STORE#p1#steam', 'R#2026-10-23');
  assert.ok(Buffer.byteLength(JSON.stringify(item.reviews)) <= 300_000);
  assert.ok(item.extra.length > 0);
  const day23 = await data.read('p1', 'steam', { from: day, to: day + DAY - 1 });
  assert.equal(day23.capped, true);
  assert.equal(day23.hours.filter(([h]) => h >= day && h < day + DAY).reduce((n, h) => n + h[2], 0), 400 + sc.reviews.filter((r) => r.timestamp_created * 1000 >= day && r.timestamp_created * 1000 < day + DAY && !r.voted_up).length, 'every one counted');
  assert.ok((await data.clear('p1', 'steam')) > 5);
  assert.equal(kv.items.size, 0);
});

// A game with telemetry and a Steam page, served by the core with a stores reader, as a host gives it. `steamBuild`:
// its sessions name their Steam build (the SDKs do, SPEC §4c); `notes: false` keeps patch notes out.
async function storeGame({ connect = true, steamBuild = false, notes = true, extra = null } = {}) {
  // The same minute past the hour every run: reviews, sessions and builds are made hour by hour, so a clock at a
  // different minute moves a build's first session against the reviews, and a borderline rise in or out.
  const now = Math.floor(Date.now() / HOUR) * HOUR - 20 * 60_000;
  const sc = steamScenario({ now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-store-reviews-'));
  const store = new FileStore(dir);
  const kv = memoryKv();
  const data = createStoreData(kv);
  await syncSteam(data, 'default', sc, now, { notes });
  // The hourly syncs of the last four weeks, each with Steam's count of players online.
  await data.write('default', 'steam', { players: sc.players, syncedAt: now });
  if (extra) await extra(data, sc);
  const read = async (projectId, service, range) => {
    const out = { steam: { app_id: APP_ID, keys: { publisher: false, financial: false }, ...(await data.read(projectId, 'steam', range)) } };
    for (const name of ['google_play', 'app_store']) if (await data.stats(projectId, name)) out[name] = { app_id: name === 'app_store' ? '6450000000' : 'gg.glitchless.caverun', keys: {}, ...(await data.read(projectId, name, range)) };
    return out;
  };
  const server = http.createServer(createApp({ store, stores: connect ? { read } : null, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const batch of scenarioSessions(sc, { days: 6, perHour: 2, steamBuild })) {
    const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(batch) });
    assert.equal(res.status, 202);
  }
  const get = async (name, params = {}) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: 'caverun', from: now - 7 * DAY, to: now, ...params })}`)).json();
  return { sc, now, base, get, store, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

test('the automatic dashboard gets a page per store: reviews by build, players next to measured sessions', async () => {
  const g = await storeGame();
  try {
    const dash = await g.get('dashboard');
    assert.deepEqual(dash.dashboard.pages.slice(0, 2).map((p) => p.id), ['overview', 'steam']);
    const { board } = await g.get('board', { page: 'steam' });
    assert.deepEqual(board.panels.map((p) => [p.type, p.store]), [['store_reviews', 'steam'], ['store_players', 'steam'], ['frame_time', undefined]]);
    const [reviews, players] = board.panels;
    assert.equal(reviews.title, 'Steam reviews by build');
    assert.equal(reviews.store_name, 'Steam');
    assert.equal(reviews.segment, 'Steam Deck');
    assert.equal(reviews.source, 'patch_notes');
    // Patch notes name the versions Glitchless saw: "Patch 1.4.2: the caves update", "Hotfix 1.4.1".
    assert.deepEqual(reviews.builds.map((b) => b.label), ['1.4.2', '1.4.1']);
    const [cur, old] = reviews.builds;
    assert.ok(cur.perf_pct > old.perf_pct + 15, `${cur.perf_pct} vs ${old.perf_pct}`);
    assert.ok(cur.frame_p95 > old.frame_p95, 'the build that players say stutters measured slower');
    assert.ok(cur.crash_free_pct < old.crash_free_pct);
    assert.equal(reviews.markers.length, 1);
    assert.equal(reviews.bucket_ms, DAY);
    assert.equal(reviews.total, reviews.series[0].values.reduce((a, b) => a + b, 0) + reviews.series[1].values.reduce((a, b) => a + b, 0));
    assert.equal(JSON.stringify(reviews).includes('stutters'), false, 'the panel shows counts, not what players wrote');
    assert.equal(players.title, 'On Steam now vs measured');
    assert.equal(players.series[0].label, 'On Steam');
    assert.ok(players.series[1].values.some((n) => n > 0), 'sessions measured at the sampled minutes');
    assert.ok(players.coverage_pct > 0 && players.coverage_pct < 100, String(players.coverage_pct));
    assert.ok(players.latest.store > 0);
    assert.deepEqual(validateDashboard({ pages: [{ title: 'Steam', panels: [{ type: 'store_sales', store: 'steam' }, { type: 'store_reviews' }] }] }).pages[0].panels, [{ type: 'store_sales', store: 'steam' }, { type: 'store_reviews' }]);
    assert.throws(() => validateDashboard({ pages: [{ title: 'x', panels: [{ type: 'store_reviews', store: 'itch' }] }] }), /store must be one of steam, google_play, app_store/);
  } finally {
    await g.close();
  }
});

test('the finding: negative reviews about stutter rose after 1.4.2, with what Glitchless measured on it', async () => {
  const g = await storeGame();
  try {
    const { findings } = await g.get('findings');
    const f = findings.find((x) => x.category === 'reviews');
    assert.ok(f, findings.map((x) => x.id).join(', '));
    assert.equal(f.id, 'store-reviews-steam-1.4.2');
    assert.equal(f.severity, 'high');
    assert.match(f.title, /^Steam reviews about stutter( and (crashes|fps))? rose after 1\.4\.2: \d+ of \d+ since it went live \(\d+(\.\d)?% before\)$/);
    const e = f.evidence;
    assert.equal(e.store, 'steam');
    assert.ok(e.perf_pct_after >= e.perf_pct_before + 10);
    assert.equal(e.release.version, '1.4.2');
    assert.equal(e.previous.version, '1.4.1');
    assert.ok(e.version.frame_p95 > e.previous_version.frame_p95);
    assert.ok(e.version.crash_free_pct < e.previous_version.crash_free_pct);
    assert.equal(e.segment.name, 'Steam Deck');
    assert.ok(e.segment.perf_negative > 0 && e.segment.pct > 0);
    assert.ok(e.devices.some((x) => x.value === 'NVIDIA GeForce GTX 1060 6GB'));
    assert.ok(e.examples.length && e.examples.every((x) => x.topics.length));
    assert.match(f.summary, /played mostly on Steam Deck/);
    assert.match(f.summary, /frame-time p95 [\d.]+ms \(1\.4\.1: [\d.]+ms\), crash-free sessions [\d.]+% \(1\.4\.1: [\d.]+%\)/);
    assert.match(f.suggestion, /glitchless_compare_versions/);
    assert.match(f.suggestion, /glitchless_store_reviews with store "steam", build "1\.4\.2"/);
    assert.deepEqual(f.link, { page: 'steam' });
    const triage = await g.get('overview');
    assert.ok(triage.findings.some((x) => x.id === f.id), 'in the overview, which glitchless_triage reads');
  } finally {
    await g.close();
  }
});

test('the reviews query filters by store, build, sentiment, keyword, Steam Deck and device', async () => {
  const g = await storeGame();
  try {
    const all = await g.get('store_reviews', { limit: 100 });
    assert.deepEqual([all.connected, all.store, all.store_name, all.app_id, all.stores], [true, 'steam', 'Steam', APP_ID, ['steam']]);
    assert.ok(all.matched > 30 && all.reviews.length <= 100);
    const stutter = await g.get('store_reviews', { store: 'steam', build: '1.4.2', sentiment: 'negative', keyword: 'stutter', limit: 100 });
    assert.ok(stutter.matched > 3);
    assert.ok(stutter.reviews.every((r) => !r.up && r.topics.includes('stutter') && r.ts >= g.sc.release && r.version === '1.4.2' && r.build === '1.4.2'));
    const deck = await g.get('store_reviews', { deck: '1', limit: 100 });
    assert.ok(deck.reviews.length && deck.reviews.every((r) => r.steam.deck));
    assert.equal(deck.segment.reviews, deck.matched);
    const gtx = await g.get('store_reviews', { device: '1060', limit: 100 });
    assert.ok(gtx.reviews.every((r) => r.device.gpu.includes('1060')));
    assert.equal(gtx.devices[0].value, 'NVIDIA GeForce GTX 1060 6GB');
    assert.equal((await g.get('store_reviews', { gpu: '1060', limit: 100 })).matched, gtx.matched, 'gpu= is device=');
    const text = await g.get('store_reviews', { keyword: 'caves-2' });
    assert.ok(text.reviews.every((r) => r.text.toLowerCase().includes('caves-2')));
    const none = await g.get('store_reviews', { build: '9.9.9' });
    assert.match(none.error, /no build or version "9\.9\.9" among this game's releases on Steam/);
    assert.deepEqual(none.releases, ['1.4.1', '1.4.2']);
    assert.match((await g.get('store_reviews', { store: 'google_play' })).why, /no Google Play connection/);
    assert.match((await g.get('store_reviews', { store: 'itch' })).why, /store is one of/);
  } finally {
    await g.close();
  }
});

test('builds the sessions name: with no build history or patch notes, releases are the Steam builds the SDK sent', async () => {
  const g = await storeGame({ steamBuild: true, notes: false });
  try {
    const { board } = await g.get('board', { page: 'steam' });
    const reviews = board.panels[0];
    assert.equal(reviews.source, 'sessions');
    assert.deepEqual(reviews.builds.map((b) => [b.label, b.version]).slice(0, 2), [['build 15873459 (1.4.2)', '1.4.2'], ['build 15790011 (1.4.1)', '1.4.1']]);
    const f = (await g.get('findings')).findings.find((x) => x.category === 'reviews');
    assert.equal(f.id, 'store-reviews-steam-15873459');
    assert.equal(f.evidence.release.build_id, '15873459');
    const q = await g.get('store_reviews', { build: '15873459', sentiment: 'negative' });
    assert.ok(q.matched > 0 && q.reviews.every((r) => r.build === 'build 15873459 (1.4.2)'));
  } finally {
    await g.close();
  }
});

test('a store whose reviews name their version feeds the same pipeline: its own page, and the query by version', async () => {
  // As the App Store and Google Play will: a star rating, the version reviewed, the device.
  const extra = async (data, sc) => {
    const reviews = Array.from({ length: 12 }, (_, i) => {
      const late = i % 2 === 0;
      const rating = late ? 2 : 5;
      return { store: 'app_store', id: `as${i}`, ts: sc.now - (i + 1) * 5 * HOUR, up: rating >= 4, rating, lang: 'en', ...reviewText(late ? 'Crashes since the update on my iPhone' : 'Great little game'), version: late ? '1.4.2' : '1.4.1', device: { model: 'iPhone15,2', os: 'iOS 26.1' } };
    });
    await data.write('default', 'app_store', { reviews, syncedAt: sc.now });
  };
  const g = await storeGame({ extra });
  try {
    const pages = (await g.get('dashboard')).dashboard.pages.map((p) => p.id);
    assert.deepEqual(pages.slice(0, 3), ['overview', 'steam', 'app-store']);
    const { board } = await g.get('board', { page: 'app-store' });
    assert.deepEqual(board.panels.map((p) => [p.type, p.store]), [['store_reviews', 'app_store'], ['store_vitals', 'app_store'], ['frame_time', undefined]], 'no players online on the App Store');
    assert.equal(board.panels[0].title, 'App Store reviews by build');
    assert.equal(board.panels[0].segment, null);
    const q = await g.get('store_reviews', { store: 'app_store', build: '1.4.2' });
    assert.deepEqual([q.store, q.matched], ['app_store', 6]);
    assert.ok(q.reviews.every((r) => r.version === '1.4.2' && r.rating === 2 && r.device.model === 'iPhone15,2'));
    assert.equal(q.segment, undefined);
    assert.deepEqual(q.devices, [{ value: 'iPhone15,2', count: 6 }]);
  } finally {
    await g.close();
  }
});

test('a game without stores: panels say so, and there is no store page or finding', async () => {
  const g = await storeGame({ connect: false });
  try {
    assert.equal((await g.get('dashboard')).dashboard.pages.some((p) => p.id === 'steam'), false);
    assert.equal((await g.get('findings')).findings.some((f) => f.category === 'reviews'), false);
    assert.equal((await g.get('store_reviews')).connected, false);
    const res = await fetch(`${g.base}/v1/dashboard?service=caverun`, { method: 'PUT', body: JSON.stringify({ pages: [{ title: 'Steam', panels: [{ type: 'store_reviews', store: 'steam' }, { type: 'store_sales' }] }] }) });
    assert.equal(res.status, 200);
    const { board } = await g.get('board', { page: 'steam' });
    assert.ok(board.panels.every((p) => p.empty && /no store connected/.test(p.why)));
  } finally {
    await g.close();
  }
});

test("store vitals next to what Glitchless measured, by version, with a line where they disagree", async () => {
  // Google Play's daily vitals by version code (a day read before the code's name was known has none), and the App Store's
  // by version, written as the cloud's syncs write them.
  const extra = async (data, sc) => {
    const days = [3, 2].map((d) => new Date(sc.now - d * DAY).toISOString().slice(0, 10));
    const vitals = days.flatMap((day, i) => [
      { metric: 'crash_rate', value: 0.6, day, build: '141', version: i ? '1.4.1' : null, users: 400, period: 'day' },
      { metric: 'crash_rate', value: 2.4, day, build: '142', version: '1.4.2', users: 300, period: 'day' },
      { metric: 'slow_rendering_20fps', value: 14, day, build: '142', version: '1.4.2', users: 300, period: 'day' },
      { metric: 'slow_rendering_20fps', value: 4, day, build: '141', version: '1.4.1', users: 400, period: 'day' },
    ]);
    await data.write('default', 'app_store', {
      reviews: [],
      vitals: [
        { metric: 'launch_time', value: 4200, version: '1.4.2', build: null, day: days[1], period: 'version', percentile: 'p50' },
        { metric: 'hang_rate', value: 4.1, version: '1.4.2', build: null, day: days[1], period: 'version', percentile: 'p50' },
      ],
      snapshots: { hangs: { day: days[1], build: '57', version: '1.4.2', signatures: [{ signature: 'ShaderCache::Compile', weight: 62 }] } },
      syncedAt: sc.now,
    });
    await data.write('default', 'google_play', { reviews: [], vitals, snapshots: { devices: { day: days[1], slow_rendering_by_gpu: [{ name: 'Mali-G52', rate: 21, users: 120 }] } }, syncedAt: sc.now });
  };
  const g = await storeGame({ extra: async (data, sc) => extra(data, sc) });
  try {
    const q = await g.get('store_vitals', { store: 'app_store' });
    assert.deepEqual([q.store, q.rows.length, q.rows[0].version], ['app_store', 1, '1.4.2']);
    assert.deepEqual(q.columns.map((c) => c.key), ['hang_rate:p50', 'launch_time:p50']);
    assert.equal(q.hangs.signatures[0].weight, 62);
    const m = q.rows[0].glitchless;
    assert.ok(m.sessions > 0 && m.frame_p95 > 0 && m.ttff_p50 == null, 'the scenario sends no time to first frame: no launch comparison');
    assert.deepEqual(q.rows[0].notes, []);
    const play = await g.get('store_vitals', { store: 'google_play' });
    assert.deepEqual(play.rows.map((r) => [r.version, r.build, r.store.crash_rate]), [['1.4.2', '142', 2.4], ['1.4.1', '141', 0.6]], 'by version code; 141 named by its later day');
    const notes = play.rows[0].notes;
    assert.deepEqual(notes.map((n) => n.metric).sort(), ['crash_rate', 'slow_rendering_20fps']);
    assert.match(notes.find((n) => n.metric === 'crash_rate').says, /^Glitchless recorded [\d.]+% of sessions crashing on 1\.4\.2, Google Play counts 2\.4% of users: Glitchless also counts a stopped game loop/);
    assert.match(notes.find((n) => n.metric === 'slow_rendering_20fps').says, /^Google Play counts 14% of users with slow rendering \(under 20 fps\) on 1\.4\.2, Glitchless measured [\d.]+% of sessions/);
    assert.deepEqual(play.devices.slow_rendering_by_gpu[0], { name: 'Mali-G52', rate: 21, users: 120 });
    assert.deepEqual((await g.get('store_vitals', { store: 'google_play', version: '1.4.1' })).rows.map((r) => r.version), ['1.4.1']);
    assert.match((await g.get('store_vitals', { store: 'steam' })).why, /Steam reports no vitals/);
  } finally {
    await g.close();
  }
});
