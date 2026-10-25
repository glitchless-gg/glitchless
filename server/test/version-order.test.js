// Versions are compared in release order whatever the range (SPEC §3 versions): by the store's first sighting of each
// version (versionsFirstSeen), else by version number, else as the range first saw them. A range that starts after a
// release, while players of the version before it still play, often sees the new version first: the release finding,
// the versions query (what glitchless_compare_versions and the Versions view compare), the alerts' release rule and
// the weekly summary must all still compare the new version against the old one, not the other way round. The
// versions here are commit hashes, so only the store's first sighting can put them in order. Every store runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { createApp } from '../src/app.js';
import { buildContext, versions } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { measure, evaluate, weeklySummary, weekStart } from '../src/alerts.js';
import { STORES } from './helpers/stores.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const P = 'proj_versions';
const OLD = 'c4e1a9f';
const NEW = '9b2d6e0';
// The end of the week the weekly summary reads (the last Monday, 00:00 UTC), and of the day the alerts check reads.
const R = weekStart(Date.now());

// A three-minute session on one level, sent as one batch when it ends. A session that stutters has two frames over
// 50 ms in every 5-second window (24 hitches a minute).
function session(service, version, n, start, stutter) {
  const base = { service, env: 'prod', version, session_id: `s_${service}_${version}_${n}`, player_id: `p_${service}_${version}_${n}`, sdk: 'glitchless-godot/0.3.0' };
  const end = start + 2000 + 36 * 5000;
  const events = [];
  const at = (ts, e) => events.push({ level: null, ...e, ...base, ts, received: end + 1000 });
  at(start, { type: 'session_start', session_type: 'user', device: { browser: 'Godot', os: 'Windows', mobile: false, gpu_tier: 'high' } });
  at(start + 1000, { type: 'level_start', level: 'dock' });
  for (let w = 0; w < 36; w++) {
    const sk = new Sketch();
    for (let f = 0; f < 300; f++) sk.add(stutter && f < 2 ? 120 : 16.6);
    at(start + 2000 + w * 5000, { type: 'frame_window', level: 'dock', duration_s: 5, frames: 300, budget_ms: 16.67, ft: sk.toJSON(), hitches: stutter ? 2 : 0 });
  }
  at(end, { type: 'session_end', level: 'dock', reason: 'quit', duration_s: Math.round((end - start) / 1000) });
  return events;
}

// OLD came out nine days before R and NEW eight days before it; players of OLD keep playing. Inside both the week
// before R and its last day, NEW's first session comes before OLD's first, so ordering by the range would compare
// OLD as the newer one. `worse` names the version that stutters.
function play(service, worse) {
  const out = [];
  const add = (version, starts) => starts.forEach((t) => out.push(session(service, version, out.length, t, version === worse)));
  add(OLD, [0, 1, 2, 3, 4].map((i) => R - 9 * DAY + i * HOUR));
  add(NEW, [R - 8 * DAY + HOUR, R - 7 * DAY + 10 * MINUTE, R - 5 * DAY]);
  add(OLD, [R - 6 * DAY, R - 4 * DAY]);
  add(NEW, Array.from({ length: 24 }, (_, i) => R - DAY + 5 * MINUTE + i * 55 * MINUTE));
  add(OLD, Array.from({ length: 22 }, (_, i) => R - 23 * HOUR + i * 60 * MINUTE));
  // In the order they arrive, as the intake stores them.
  return out.sort((a, b) => a[0].received - b[0].received);
}

async function serve(store) {
  const auth = { resolveIngest: () => ({ projectId: P }), resolveReader: () => ({ projectId: P, scopes: ['read'] }) };
  const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (name, params) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams(params)}`)).json();
  return { get, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}

const release = { rules: { crashes: false, new_error: false, release: true, quiet: false, store: false, plan: false } };

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind}: a range that starts after a release compares the new version against the old one`, async () => {
    const made = await make();
    const app = await serve(made.store);
    try {
      for (const batch of [...play('better', OLD), ...play('worse', NEW)]) await made.store.put(P, batch, {});
      await made.settle?.();
      const day = { service: 'better', from: R - DAY, to: R - 1 };

      // The versions query (glitchless_compare_versions and the Versions view compare its last two).
      const { versions: list } = await app.get('versions', day);
      assert.deepEqual(
        list.map((v) => v.version),
        [OLD, NEW],
      );
      const [old, cur] = list;
      assert.ok(cur.first_seen < old.first_seen, 'the day saw NEW first');
      assert.deepEqual([old.first_seen_ever, cur.first_seen_ever], [R - 9 * DAY, R - 8 * DAY + HOUR], 'when each came out, not its first session of the day');
      assert.ok(cur.hitches_per_min < old.hitches_per_min);

      // The release finding: NEW against OLD, and better.
      const { findings: found } = await app.get('findings', day);
      const f = found.find((x) => x.category === 'release');
      assert.equal(f.id, `version-${OLD}-${NEW}`);
      assert.match(f.title, new RegExp(`^${NEW} vs ${OLD}: improved`));

      // The alerts' release rule: a release that made things better never fires; one that made them worse does.
      const better = await measure(made.store, P, { service: 'better', now: R });
      assert.deepEqual([better.release.prev.version, better.release.cur.version], [OLD, NEW]);
      const quiet = evaluate({ now: R, release: better.release, settings: release }).signals.find((s) => s.rule === 'release');
      assert.equal(quiet.key, `release-${OLD}-${NEW}`);
      assert.equal(quiet.holds, false, 'a release that stutters less is not "worse"');
      const worse = await measure(made.store, P, { service: 'worse', now: R });
      const fires = evaluate({ now: R, release: worse.release, settings: release }).signals.find((s) => s.rule === 'release');
      assert.equal(fires.key, `release-${OLD}-${NEW}`);
      assert.equal(fires.holds, true);
      assert.deepEqual(
        fires.worse.map((w) => w.measure),
        ['stutter'],
      );

      // The weekly summary of the week before R lists a release only when it made things worse, under the new version.
      const weekBetter = await weeklySummary(made.store, P, { service: 'better', now: R + HOUR });
      assert.deepEqual(
        weekBetter.fixes.filter((x) => x.id.startsWith('version-')),
        [],
      );
      const weekWorse = await weeklySummary(made.store, P, { service: 'worse', now: R + HOUR });
      const fix = weekWorse.fixes.find((x) => x.id.startsWith('version-'));
      assert.equal(fix.id, `version-${OLD}-${NEW}`);
      assert.equal(fix.text, `${NEW} does worse than ${OLD} for players.`);
    } finally {
      await app.close();
      await made.close?.();
    }
  });
}

// The same day without a store: no first sightings (a context built from raw events).
const lastDay = (version) => play('better', OLD).flat().filter((e) => e.ts >= R - DAY && e.ts < R).map((e) => ({ ...e, version: version(e.version) }));
const q = { service: 'better', from: R - DAY, to: R - 1, type: 'all' };

test('without first sightings, versions that read as version numbers go in version order', () => {
  const ctx = buildContext(lastDay((v) => (v === OLD ? '1.9.2' : '1.10.0')), q);
  assert.deepEqual(
    versions(ctx).map((v) => v.version),
    ['1.9.2', '1.10.0'],
  );
  assert.equal(versions(ctx)[0].first_seen_ever, null);
  assert.equal(findings(ctx).find((f) => f.category === 'release').id, 'version-1.9.2-1.10.0');
  const pre = (a, b) => versions(buildContext(lastDay((v) => (v === OLD ? a : b)), q)).map((v) => v.version);
  assert.deepEqual(pre('2.0.0-beta.10', '2.0.0'), ['2.0.0-beta.10', '2.0.0'], 'a pre-release before its release');
  assert.deepEqual(pre('2.0.0-beta.10', '2.0.0-beta.9'), ['2.0.0-beta.9', '2.0.0-beta.10'], 'pre-release numbers as numbers');
  assert.deepEqual(pre('v1.2', '1.1.7'), ['1.1.7', 'v1.2']);
  // Commit hashes can't be told apart that way: they stay in the order the range first saw them.
  assert.deepEqual(
    versions(buildContext(lastDay((v) => v), q)).map((v) => v.version),
    [NEW, OLD],
  );
});

test("first sightings decide; versions the store has none of came before its index began, so they go first", () => {
  const ctx = buildContext(lastDay((v) => v), q);
  ctx.versionsFirstSeen = new Map([
    [OLD, R - 9 * DAY],
    [NEW, R - 8 * DAY],
  ]);
  assert.deepEqual(
    versions(ctx).map((v) => [v.version, v.first_seen_ever]),
    [
      [OLD, R - 9 * DAY],
      [NEW, R - 8 * DAY],
    ],
  );
  // A hotfix of the old line that shipped after the new version is the newest.
  const hotfix = buildContext(lastDay((v) => (v === OLD ? '2.0.0' : '1.9.3')), q);
  hotfix.versionsFirstSeen = new Map([
    ['2.0.0', R - 9 * DAY],
    ['1.9.3', R - 8 * DAY],
  ]);
  assert.deepEqual(
    versions(hotfix).map((v) => v.version),
    ['2.0.0', '1.9.3'],
  );
  ctx.versionsFirstSeen = new Map([[NEW, R - 8 * DAY]]);
  assert.deepEqual(
    versions(ctx).map((v) => v.version),
    [OLD, NEW],
  );
});
