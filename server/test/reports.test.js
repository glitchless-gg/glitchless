// Player bug reports (SPEC §2 bug_report): every store keeps them apart from the events, lists them newest first
// without their screenshots, gives one back with its screenshot, and forgets them with the game's data. They show
// in the session's timeline, in findings once a level has three, and on boards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';
import { DynamoStore } from '../src/stores/dynamo.js';
import { validateDashboard, evaluateBoard } from '../src/board.js';
import { buildContext } from '../src/analytics.js';
import { lifecycleRules } from '../src/lake/layout.js';
import { splitReport, reportSummary } from '../src/reports.js';
import { findings, gameEngine } from '../src/findings.js';
import { FakeDynamo } from './helpers/fake-dynamo.js';
import { liveLake, hasDuckDB } from './helpers/lake-sim.js';
import { gameSessions } from './helpers/game-data.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-reports-'));
const now = Date.now();
const [session] = gameSessions({ start: now - 1_800_000, spanMs: 60_000, sessions: 1, seed: 3, prefix: 'rep' });
const last = Math.max(...session.map((e) => e.ts));
const shot = (text) => 'data:image/jpeg;base64,' + Buffer.from(`jpeg bytes: ${text}`).toString('base64');
const REPORTS = [
  { type: 'bug_report', ts: last + 1000, level: 'level-2', note: 'Fell through the floor by the ramp', screenshot: shot('one'), x: 12.5, y: -3, z: 0, recent: [{ ts: last, type: 'death', level: 'level-2', cause: 'fell' }], frames: [{ ts: last - 5000, level: 'level-2', fps: 58.1, p95: 19.2 }], device: { browser: 'Firefox', browser_version: '140', os: 'Linux', gpu_tier: 'mid' } },
  { type: 'bug_report', ts: last + 2000, level: 'level-2', note: 'stuck   behind the crate', screenshot: shot('two') },
  { type: 'bug_report', ts: last + 3000, level: 'level-2', note: '' },
  { type: 'bug_report', ts: last + 4000, level: 'level-1', note: 'music cut out' },
];

function payload(events) {
  const { service, env, version, session_id, player_id, sdk } = session[0];
  return { service, env, version, session_id, player_id, sdk, events: events.map(({ service, env, version, session_id, player_id, sdk, ...e }) => e) };
}

async function serve(store) {
  const server = http.createServer(createApp({ store, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (events) => fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(payload(events)) });
  const get = async (name, params = {}) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: 'zoomies', from: now - 3_600_000, to: now + 60_000, ...params })}`)).json();
  return { base, send, get, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

const stores = {
  file: () => ({ store: new FileStore(tmpdir()) }),
  dynamodb: () => ({ store: new DynamoStore({ table: 't', doc: new FakeDynamo(), rollupsSince: 0 }) }),
  ...(hasDuckDB ? { lake: () => liveLake() } : {}),
};

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: reports are listed newest first, opened with their screenshot, and found on their level`, async () => {
    const made = make();
    const app = await serve(made.store);
    try {
      assert.equal((await app.send(session)).status, 202);
      // No reports yet: no Bug Reports page on the automatic dashboard.
      assert.equal((await app.get('dashboard')).dashboard.pages.some((p) => p.view === 'reports'), false);

      const tail = await fetch(`${app.base}/v1/live?service=zoomies`);
      const reader = tail.body.getReader();
      assert.equal((await app.send(REPORTS)).status, 202);
      // A retried batch stores nothing twice.
      assert.equal((await app.send(REPORTS.slice(0, 2))).status, 202);

      // The live tail shows the note, never the screenshot.
      let seen = '';
      while (!seen.includes('music cut out')) seen += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      assert.equal(seen.includes('data:image'), false);

      const { reports } = await app.get('reports');
      assert.deepEqual(
        reports.map((r) => [r.level, r.note, r.has_screenshot]),
        [
          ['level-1', 'music cut out', false],
          ['level-2', '', false],
          ['level-2', 'stuck   behind the crate', true],
          ['level-2', 'Fell through the floor by the ramp', true],
        ],
      );
      const first = reports[3];
      assert.deepEqual(first.position, { x: 12.5, y: -3, z: 0 });
      assert.equal(first.session_id, 'rep_0');
      assert.equal(first.version, session[0].version);
      assert.equal(first.device, 'Firefox 140 · Linux (mid)');
      // Without a device of its own, a report shows its session's.
      const start = session.find((e) => e.type === 'session_start');
      assert.equal(reports[2].device, `${start.device.browser} · ${start.device.gpu} (${start.device.gpu_tier})`);
      assert.equal(reports[2].position, null);
      assert.ok(reports.every((r) => !('screenshot' in r) && !('recent' in r)), 'the list leaves screenshots and recent events out');

      const { report } = await app.get('report', { id: first.id });
      assert.equal(report.screenshot, REPORTS[0].screenshot);
      assert.deepEqual(report.recent, REPORTS[0].recent);
      assert.deepEqual(report.frames, REPORTS[0].frames);
      assert.equal(report.note, REPORTS[0].note);
      assert.equal('screenshot' in (await app.get('report', { id: first.id, screenshot: '0' })).report, false);
      assert.equal((await app.get('report', { id: reports[0].id })).report.screenshot, null);
      assert.equal((await app.get('report', { id: 'r_nope' })).error, 'report not found');
      // Reports answer for the range asked and the filters.
      assert.equal((await app.get('reports', { from: last + 2500 })).reports.length, 2);
      assert.equal((await app.get('reports', { version: 'other' })).reports.length, 0);

      // Three on level-2 make a finding, quoting what players wrote; one on level-1 doesn't.
      const { findings } = await app.get('findings');
      const f = findings.find((x) => x.category === 'reports');
      assert.equal(f.id, 'reports-level-2');
      assert.equal(f.title, '3 bug reports on level-2');
      assert.match(f.summary, /They wrote: "stuck behind the crate"; "Fell through the floor by the ramp"\./);
      assert.deepEqual(f.evidence.latest.map((r) => r.id), reports.slice(1).map((r) => r.id));
      assert.deepEqual(f.link, { page: 'reports', level: 'level-2' });
      assert.equal(findings.filter((x) => x.category === 'reports').length, 1);

      // The automatic dashboard gets its Bug Reports page; the session's replay shows where each was sent.
      assert.ok((await app.get('dashboard')).dashboard.pages.some((p) => p.id === 'reports' && p.view === 'reports' && p.icon === 'bug'));
      const detail = await app.get('session', { id: 'rep_0' });
      const marks = detail.timeline.filter((e) => e.type === 'bug_report');
      assert.deepEqual(marks.map((e) => e.note), REPORTS.map((r) => r.note));
      assert.ok(detail.timeline.every((e, i, all) => !i || all[i - 1].ts <= e.ts));

      // Reports never reach the events, rollups or summaries.
      const events = await made.store.query('default', { service: 'zoomies', from: now - 3_600_000, to: now + 60_000 });
      assert.equal(events.some((e) => e.type === 'bug_report'), false);

      // One report can go on its own, screenshot and all (a player asked).
      const del = (id, service = 'zoomies') => fetch(`${app.base}/v1/report?service=${service}&id=${id}`, { method: 'DELETE' });
      const shots = async () => (kind === 'lake' ? (await made.bucket.list('reports/')).length : kind === 'file' ? fs.readdirSync(path.join(made.store.dir, 'reports')).length : null);
      const before = await shots();
      assert.equal((await del(first.id, 'other-game')).status, 404);
      assert.equal((await del(first.id)).status, 200);
      assert.equal((await del(first.id)).status, 404);
      assert.deepEqual((await app.get('reports')).reports.map((r) => r.id), reports.slice(0, 3).map((r) => r.id));
      assert.equal((await app.get('report', { id: first.id })).error, 'report not found');
      if (before != null) assert.equal(await shots(), before - 1);

      if (kind !== 'dynamodb') {
        assert.equal((await fetch(`${app.base}/v1/data?service=zoomies`, { method: 'DELETE' })).status, 200);
        assert.deepEqual((await app.get('reports')).reports ?? [], []);
        assert.equal(await made.store.getReport('default', 'zoomies', reports[1].id), null);
        if (kind === 'lake') assert.deepEqual(await made.bucket.list('reports/'), []);
        if (kind === 'file') assert.deepEqual(fs.readdirSync(path.join(made.store.dir, 'reports')), []);
      }
    } finally {
      await app.close();
      made.close?.();
    }
  });
}

test('file store: reports and their screenshots survive a restart, and expire with the events', async () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  const old = { ...session[0], ...REPORTS[1], ts: now - 20 * 86_400_000 };
  await store.put('default', [{ ...session[0], ...REPORTS[0] }, old]);
  assert.equal(fs.readdirSync(path.join(dir, 'reports')).length, 2);
  const again = new FileStore(dir);
  const list = await again.reports('default', 'zoomies', { from: 0, to: now + 60_000 });
  assert.deepEqual(list.map((r) => r.note), [REPORTS[0].note]);
  assert.equal((await again.getReport('default', 'zoomies', list[0].id)).screenshot, REPORTS[0].screenshot);
  // The 20-day-old report went with its screenshot.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'reports')), [`${list[0].id}.jpg`]);
  assert.equal(await again.getReport('default', 'other-game', list[0].id), null);
});

test('a report record is bounded: recent events, frame windows and the note are capped', () => {
  const e = { ...session[0], type: 'bug_report', ts: now, note: 'x'.repeat(5000), recent: Array.from({ length: 100 }, (_, i) => ({ ts: i, type: 'custom', name: `e${i}` })).concat([{ huge: 'y'.repeat(2000) }]), frames: Array.from({ length: 50 }, (_, i) => ({ ts: i, fps: 60, p95: 17 })), device: 'not an object' };
  const { record, screenshot } = splitReport('default', e);
  assert.equal(record.note.length, 2000);
  assert.equal(record.recent.length, 30);
  assert.equal(record.recent.at(-1).name, 'e99');
  assert.equal(record.frames.length, 12);
  assert.equal(record.device, null);
  assert.equal(screenshot, null);
  assert.equal(record.has_screenshot, false);
  assert.equal(splitReport('other', e).record.id === record.id, false, 'ids differ per project');
});

test('boards: a reports panel lists the latest reports, a dashboard can have a Bug Reports page', () => {
  const spec = validateDashboard({ pages: [{ title: 'Playtest', panels: [{ type: 'reports', limit: 2 }] }, { view: 'reports' }] });
  assert.deepEqual(spec.pages[1], { id: 'reports', title: 'Bug Reports', view: 'reports' });
  assert.throws(() => validateDashboard({ pages: [{ title: 'x', panels: [{ type: 'reports', limit: 50 }] }] }), /limit must be 1 to 20/);
  const ctx = buildContext(session, { service: 'zoomies', from: now - 3_600_000, to: now, type: 'all' });
  ctx.reports = REPORTS.map((r) => splitReport('default', { ...session[0], ...r }).record).reverse();
  const [panel] = evaluateBoard(ctx, spec.pages[0]);
  assert.equal(panel.title, 'Bug reports');
  assert.deepEqual(panel.reports.map((r) => r.note), ['music cut out', '']);
  assert.equal(panel.total, 4);
  // Its finding quotes the notes, but a share link (anyone may hold one) only says how many.
  const findings = { panels: [{ type: 'findings' }] };
  const finding = (shared) => evaluateBoard(ctx, findings, { shared })[0].findings.find((f) => f.category === 'reports');
  assert.match(finding(false).summary, /Fell through the floor/);
  assert.equal(JSON.stringify(finding(true)).includes('Fell through'), false, 'a shared board quotes a player note');
  assert.equal(finding(true).summary, '3 bug reports from 1 session on level-2.');
  ctx.reports = [];
  assert.equal(evaluateBoard(ctx, spec.pages[0])[0].why, 'No bug reports in this window.');
});

test('lake: a screenshot S3 refuses costs the picture, not the report', { skip: !hasDuckDB && 'needs the optional dependency @duckdb/node-api' }, async () => {
  const lake = liveLake();
  const put = lake.bucket.put.bind(lake.bucket);
  lake.bucket.put = async (key, ...rest) => {
    if (key.startsWith('reports/')) throw new Error('AccessDenied');
    return put(key, ...rest);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await lake.store.put('default', [{ ...session[0], ...REPORTS[0] }]);
  } finally {
    console.warn = warn;
  }
  const [r] = await lake.store.reports('default', 'zoomies', { from: 0, to: now + 60_000 });
  assert.equal(r.note, REPORTS[0].note);
  assert.equal(r.has_screenshot, false);
  assert.equal((await lake.store.getReport('default', 'zoomies', r.id)).screenshot, null);
  lake.close();
});

test('lake: report screenshots expire with each plan', () => {
  const rules = lifecycleRules();
  for (const plan of ['free', 'indie', 'studio']) {
    const events = rules.find((r) => r.ID === `events-${plan}`);
    assert.deepEqual(rules.find((r) => r.ID === `reports-${plan}`), { ...events, ID: `reports-${plan}`, Prefix: `reports/plan=${plan}/` });
  }
});

test('Godot, Unity and Unreal games: the reports finding says how to reproduce there, and the reports query names the engine', async () => {
  const cases = [
    ['glitchless-godot/0.1.1', 'godot', /reproduce it on level-2 \(run the game from the Godot editor/],
    ['glitchless-unity/0.1.0', 'unity', /reproduce it on level-2 \(enter Play mode in the Unity Editor/],
    ['glitchless-unreal/0.1.0', 'unreal', /reproduce it on level-2 \(play it in the editor with Play In Editor, .*Glitchless Toolset and Unreal MCP, Measure there\), fix it/],
    ['glitchless-phaser/0.2.0', 'phaser', /over WebMCP/],
    [session[0].sdk, 'web', /over WebMCP/],
  ];
  for (const [sdk, engine, advice] of cases) {
    const events = session.map((e) => ({ ...e, sdk }));
    const ctx = buildContext(events, { service: 'zoomies', from: now - 3_600_000, to: now + 60_000, type: 'all' });
    ctx.reports = REPORTS.map((r) => splitReport('default', { ...events[0], ...r }).record).reverse();
    assert.equal(gameEngine(ctx), engine);
    assert.match(findings(ctx).find((f) => f.category === 'reports').suggestion, advice, sdk);
  }
  // What the Godot and Unity SDKs send as the report's device, as the list shows it.
  const device = (d) => reportSummary({ ...REPORTS[0], device: d }).device;
  assert.equal(device({ browser: 'Godot', browser_version: '4.7.2', os: 'macOS', mobile: false, device_tier: 'high', gpu_tier: 'high', renderer: 'mobile' }), 'Godot 4.7.2 · macOS (high)');
  assert.equal(device({ browser: 'Unity', browser_version: '2022.3.62f3', os: 'iOS', gpu_tier: 'mid', model: 'iPhone15,2' }), 'Unity 2022.3.62f3 · iPhone15,2 · iOS (mid)');
  // And what the Unreal plugin sends: anonymous, then full mode on a Steam Deck.
  assert.equal(device({ browser: 'Unreal', browser_version: '5.8.4', os: 'macOS', mobile: false, device_tier: 'high', gpu_tier: 'high', renderer: 'deferred', driver: 'Metal', steam_deck: false }), 'Unreal 5.8.4 · macOS (high)');
  assert.equal(device({ browser: 'Unreal', browser_version: '5.8.4', os: 'SteamOS', gpu_tier: 'low', steam_deck: true, model: 'Steam Deck OLED', gpu: 'AMD Custom GPU 0932' }), 'Unreal 5.8.4 · Steam Deck OLED · SteamOS · AMD Custom GPU 0932 (low)');

  // The Bug Reports view's empty state reads the engine from the reports query.
  const app = await serve(new FileStore(tmpdir()));
  try {
    const body = { ...payload(session), sdk: 'glitchless-godot/0.1.1' };
    assert.equal((await fetch(`${app.base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify(body) })).status, 202);
    const listed = await app.get('reports');
    assert.deepEqual(listed.reports, []);
    assert.equal(listed.engine, 'godot');
  } finally {
    await app.close();
  }
});
