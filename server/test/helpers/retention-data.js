// The players of the retention tests (retention.test.js, and any store's own): 44 days of short sessions, players
// first seen on different days, and the cohorts the raw events give.
import http from 'node:http';
import { Sketch } from '../../../packages/sdk/src/sketch.js';
import { createApp } from '../../src/app.js';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const D0 = Math.floor(Date.now() / DAY) * DAY - 50 * DAY;
export const P = 'proj_r';
export const SERVICE = 'starlift';
export const DECK = { browser: 'Godot', browser_version: '4.5.1', os: 'Linux', mobile: false, gpu_tier: 'low', steam_deck: true };
export const DESK = { browser: 'Godot', browser_version: '4.5.1', os: 'Windows', mobile: false, gpu_tier: 'high' };

// One short session: a start, a frame window, a custom event, an end. `player` null is an anonymous session (ingest
// files it under its session ID).
export function session(id, player, ts, { device = DESK, version = '1.0.0' } = {}) {
  const sk = new Sketch();
  for (let i = 0; i < 300; i++) sk.add(device.steam_deck ? 22 + (i % 7) : 8 + (i % 5));
  const base = { service: SERVICE, env: 'prod', version, session_id: id, player_id: player ?? id, sdk: 'glitchless-godot/0.2.0', level: null };
  return [
    { ...base, type: 'session_start', ts, session_type: 'user', privacy: player ? 'install' : 'anonymous', device },
    { ...base, type: 'frame_window', ts: ts + 1000, level: 'voyage_1', frames: 300, duration_s: 5, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0 },
    { ...base, type: 'custom', ts: ts + 60_000, name: 'play', attrs: { mode: 'endless' } },
    { ...base, type: 'session_end', ts: ts + 3 * MINUTE, reason: 'quit', duration_s: 180 },
  ];
}

// 40 install players first seen on days 1 to 36, coming back on some of the 1st, 2nd, 7th and 30th days after; two
// full-mode players; a veteran first seen on day 0 who plays again later; anonymous sessions every day, some on a
// Deck. Sessions run 10:00 to 16:00 UTC, so none crosses midnight or a range boundary at 07:00.
export const sessions = [];
let n = 0;
const at = (day, k) => D0 + day * DAY + 10 * HOUR + (k % 6) * HOUR + (k % 7) * MINUTE;
const play = (player, day, opts) => sessions.push(session(`s_${n++}`, player, at(day, n), opts));
for (let i = 0; i < 40; i++) {
  const first = 1 + ((i * 7) % 36);
  const id = `p_${String(i).padStart(12, '0')}`;
  const deck = i % 4 === 0 ? { device: DECK } : {};
  play(id, first, deck);
  if (i % 2 === 0) play(id, first + 1, deck);
  if (i % 4 === 1) play(id, first + 2, deck);
  if (i % 3 === 0) play(id, first + 7, deck);
  if (i % 5 === 0 && first + 30 < 44) play(id, first + 30, deck);
}
for (const [id, days] of [
  ['p_full00000001', [3, 4, 10]],
  ['p_full00000002', [3]],
  ['p_veteran00000', [0, 5, 6, 12]],
]) {
  for (const d of days) play(id, d);
}
for (let d = 0; d < 44; d++) for (let k = 0; k < 2; k++) play(null, d, k ? { device: DECK } : {});
export const events = sessions.flat().sort((a, b) => a.ts - b.ts);

// Retention as the definition reads, from the raw events: a player's first day is the day of their first event of
// all; they belong to that day's cohort when a session of theirs in the range started on it; Dn counts those with an
// event on day n after it, shown once that day has ended inside [lo, hi).
export function expected(lo, hi) {
  const real = (e) => e.player_id !== e.session_id;
  const first = new Map();
  for (const e of events) if (real(e) && !(first.get(e.player_id) <= e.ts)) first.set(e.player_id, e.ts);
  const inRange = events.filter((e) => e.ts >= lo && e.ts < hi);
  const startedOn = new Map();
  const activeOn = new Map();
  for (const e of inRange) {
    if (!real(e)) continue;
    const day = Math.floor(e.ts / DAY) * DAY;
    if (e.type === 'session_start') (startedOn.get(e.player_id) || startedOn.set(e.player_id, new Set()).get(e.player_id)).add(day);
    (activeOn.get(e.player_id) || activeOn.set(e.player_id, new Set()).get(e.player_id)).add(day);
  }
  const rows = new Map();
  for (const [id, ts] of first) {
    const day = Math.floor(ts / DAY) * DAY;
    if (day < lo || day >= hi || !startedOn.get(id)?.has(day)) continue;
    const r = rows.get(day) || rows.set(day, { players: 0, back: [0, 0, 0] }).get(day);
    r.players++;
    [1, 7, 30].forEach((k, j) => activeOn.get(id).has(day + k * DAY) && r.back[j]++);
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return [...rows]
    .sort((a, b) => a[0] - b[0])
    .map(([day, r]) => {
      const row = { day: new Date(day).toISOString().slice(0, 10), players: r.players };
      const returned = {};
      [1, 7, 30].forEach((k, j) => {
        const ended = day + (k + 1) * DAY <= hi;
        row[`d${k}`] = ended ? pct(r.back[j], r.players) : null;
        returned[`d${k}`] = ended ? r.back[j] : null;
      });
      return { ...row, returned };
    });
}

// An app over `store`, every request read as project P.
export async function serve(store) {
  const auth = { resolveIngest: () => ({ projectId: P }), resolveReader: () => ({ projectId: P, scopes: ['read', 'dashboard'] }) };
  const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (name, params) => (await fetch(`${base}/v1/query/${name}?${new URLSearchParams({ service: SERVICE, ...params })}`)).json(),
    put: (p, body) => fetch(base + p, { method: 'PUT', body: JSON.stringify(body) }),
    close: () => server.close(),
  };
}

// A 31-day range starting at 07:00 on day 2, so day 2 is not a whole day of it, and one of 44 whole days.
export const MONTH = { from: D0 + 2 * DAY + 7 * HOUR, to: D0 + 33 * DAY + 7 * HOUR - 1 };
export const LONG = { from: D0, to: D0 + 44 * DAY - 1 };
