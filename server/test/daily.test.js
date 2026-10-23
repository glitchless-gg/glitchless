// Daily rollups (daily.js) and the sketches they keep. A store that builds per-day rollups answers ranges of more
// than 31 days from them (SPEC §7); these check the parts that need no store: what a day keeps, and that sketches
// are exact while small and close past their caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexSessions } from '../src/analytics.js';
import { sessionDay, foldDay, CAPS } from '../src/daily.js';
import { Distinct, Sample, QMap, repeatedIds } from '../src/sketches.js';
import { gameSessions } from './helpers/game-data.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const D0 = Math.floor(Date.now() / DAY) * DAY - 12 * DAY;
const SERVICE = 'zoomies';
const json = (x) => JSON.parse(JSON.stringify(x));

// Sessions that retry a level and keep dying at one spot on it; every other one quits right after a
// death (a rage quit): a difficulty spike.
function spikeSessions(start, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let ts = start + i * 97 * MINUTE;
    const base = { service: SERVICE, env: 'prod', version: '1.0.1', session_id: `k_${i}`, player_id: `p_${i % 5}`, sdk: 'glitchless-browser/0.1.0', level: null };
    const events = [];
    const push = (e) => events.push({ ...base, ...e, ts: (ts += 1500) });
    push({ type: 'session_start', session_type: 'user', device: { gpu_tier: 'low', browser: 'Chrome', gpu: 'UHD 620' } });
    for (let a = 0; a < 3; a++) {
      push({ type: 'level_start', level: 'level-2' });
      push({ type: 'death', level: 'level-2', x: 10 + ((a + i) % 3) * 0.5, y: 0, z: 5, cause: 'fell' });
      if (a < 2 || i % 2 === 0) push({ type: 'level_fail', level: 'level-2', cause: 'fell' });
    }
    if (i % 2) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Two days of play, and the spike's rage quits.
const sessions = [...gameSessions({ start: D0 + 20 * MINUTE, spanMs: 2 * DAY - HOUR, sessions: 100, seed: 21 }), ...spikeSessions(D0 + HOUR, 30)];

test('a day keeps the newest sessions and rage quits of each env and version', () => {
  const day = D0 + DAY;
  const events = sessions.flat().filter((e) => e.ts < D0 + 2 * DAY).sort((x, y) => x.ts - y.ts);
  const states = [...indexSessions(events).values()];
  const d = foldDay(day, { sessions: states }, { ...CAPS, recent: 2, rageQuits: 1 });
  for (const g of d.groups.values()) {
    const mine = states.filter((s) => sessionDay(s) === day && s.env === g.env && s.version === g.version);
    const newest = mine.map((s) => s.start ?? s.first_ts).sort((a, b) => b - a);
    assert.deepStrictEqual(
      g.recent.map(([start]) => start),
      newest.slice(0, 2),
    );
    const rage = mine.filter((s) => s.rage_quit).map((s) => s.last_ts).sort((a, b) => b - a);
    assert.deepStrictEqual(
      g.rq.map(([ts]) => ts),
      rage.slice(0, 1),
    );
  }
  assert.ok([...d.groups.values()].some((g) => g.n > 2), 'some group has more sessions than it keeps');
});

test('sketches are exact while small and close past their caps', () => {
  const d = new Distinct(256, 10);
  for (let i = 0; i < 200; i++) d.add(`p${i}`);
  assert.equal(Distinct.from(json(d)).count(), 200);
  assert.equal(Distinct.from(json(d)).approx, false);
  for (const n of [5000, 50_000]) {
    const h = new Distinct(256, 10);
    for (let i = 0; i < n; i++) h.add(`x${i}`);
    const est = Distinct.from(json(h)).count();
    assert.ok(Math.abs(est / n - 1) < 0.1, `HyperLogLog ${n}: ${est}`);
  }
  // Exact sets merged at query time stay exact, however many.
  const u = new Distinct(Infinity);
  for (let day = 0; day < 30; day++) {
    const one = new Distinct(256, 10);
    for (let i = 0; i < 200; i++) one.add(`d${day}-${i}`);
    u.merge(Distinct.from(json(one)));
  }
  assert.equal(u.count(), 6000);
  assert.equal(u.approx, false);
  // Returning ids from day samples: exact while small, estimated past the cap.
  const days = (k) =>
    [0, 1, 2].map((d) => {
      const s = new Sample(k);
      for (let i = 0; i < 2000; i++) s.add(`q${d * 1600 + i}`);
      return s;
    });
  assert.deepStrictEqual(repeatedIds(days(Infinity)), { ids: 5200, repeat: 800, approx: false });
  const est = repeatedIds(days(512).map((s) => Sample.from(json(s))));
  assert.ok(est.approx && Math.abs(est.repeat / est.ids - 800 / 5200) < 0.05, JSON.stringify(est));
  // Quantile maps: exact (as quantile() rounds) while small, then a few significant digits.
  const m = new QMap(512);
  const values = [...Array(20_000).keys()].map((i) => ((i * 7919) % 360_000) / 100);
  for (const v of values) m.add(v);
  const sorted = [...values].sort((a, b) => a - b);
  const exact = sorted[Math.floor(0.5 * sorted.length)];
  assert.ok(m.approx && Math.abs(m.quantile(0.5) / exact - 1) < 0.02, `${m.quantile(0.5)} vs ${exact}`);
  const small = new QMap(512);
  for (const v of [3, 1, 2, 2.345, -1.234]) small.add(v);
  assert.equal(small.quantile(0.5), 2);
  assert.equal(QMap.from(json(small)).quantile(0.95), 3);
});
