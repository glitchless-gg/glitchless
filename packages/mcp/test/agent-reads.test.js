// Reads an agent can hold, against a real Glitchless server on a file store, from Lucky Twice's first full playtest
// (November 2026): glitchless_session's full answer for a 10-minute session was 89,000 characters and
// glitchless_events' 56,000. A session is a summary by default, level by level, with its timeline on request; events
// list each attribute's top values; the funnel and the session say where each rage input happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../server/src/app.js';
import { FileStore } from '../../../server/src/stores/file.js';
import { Sketch } from '../../sdk/src/sketch.js';

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-reads-'));
delete process.env.GLITCHLESS_API_KEY;

const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-mcp-reads-store-')));
const api = http.createServer(createApp({ store, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read'] }) }, logger: { warn() {}, error() {} } }));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;
process.env.GLITCHLESS_URL = base;
process.env.GLITCHLESS_SERVICE = 'kay-and-tee';

const { createServer } = await import('../src/context.js');
await import('../src/tools/core.js');
await import('../src/tools/analytics.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: 'test', version: '0' });
await client.connect(b);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return r.content[0].text;
};
const json = (text) => JSON.parse(text.slice(text.indexOf('\n\n') + 2));

const MOMENTS = ['switch', 'lift', 'send', 'call', 'cowrie', 'bless'];
const T0 = Date.now() - 20 * 60_000;
// Ten rooms of a minute each: a start, a dozen moments, three falls, four hitches, counters and frame windows every
// 5 s, positions 4 times a second, room_done and the clear. A rage input on room 3 and an error on room 7.
function playtest(id, player, at = T0, rooms = 10) {
  const evs = [{ type: 'session_start', ts: at, session_type: 'user', device: { browser: 'Chrome', browser_version: '142', os: 'macOS', gpu: 'Apple M3', gpu_tier: 'high' }, props: { input: 'keyboard', coop: 'no' } }];
  for (let r = 0; r < rooms; r++) {
    const room = `day${1 + Math.floor(r / 2)}-room${1 + (r % 2)}`;
    const t = at + 2000 + r * 60_000;
    evs.push({ type: 'level_start', ts: t, level: room, attrs: { visit: 'first', week: 1 } });
    for (let i = 0; i < 12; i++) evs.push({ type: 'custom', ts: t + 3000 + i * 4000, level: room, name: MOMENTS[i % 6], attrs: { room, twin: i % 2 ? 'kay' : 'tee' } });
    for (let i = 0; i < 3; i++) evs.push({ type: 'death', ts: t + 10_000 + i * 12_000, level: room, cause: i ? 'thorns' : 'fell', x: 10 + i, y: 2, z: 0 });
    for (let i = 0; i < 4; i++) evs.push({ type: 'hitch', ts: t + 7000 + i * 11_000, level: room, duration_ms: 70 + i * 40 + r, causes: i % 2 ? ['gc'] : ['script'], draw_calls: 120, recent: MOMENTS.slice(0, 5).map((name, k) => ({ type: 'custom', name, ts: t + k * 100 })), loaf: [{ source: 'Game.Update', fn: 'Room.Step', ms: 40 }] });
    for (let w = 0; w < 12; w++) {
      const ws = t + w * 5000;
      const sk = new Sketch();
      for (let k = 0; k < 300; k++) sk.add(16.6 + (k % 7));
      evs.push({ type: 'frame_window', ts: ws + 5000, level: room, duration_s: 5, frames: 300, fps: 60, budget_ms: 16.67, ft: sk.toJSON(), ft_p50: 16.6, ft_p95: 22.4, ft_max: 31, hitches: w % 3 ? 0 : 1, draw_calls: 120, ctx: { twins_apart: 3 + (w % 4), plants: w } });
      evs.push({ type: 'counts', ts: ws, level: room, duration_s: 5, counts: [{ name: 'step', attrs: { twin: 'kay' }, n: 40, first_ts: ws + 10 }] });
      evs.push({ type: 'pos', ts: ws + 5000, level: room, pts: Array.from({ length: 20 }, (_, k) => [ws + k * 250, 3 + w + k * 0.1, 1, 0]) });
    }
    if (r === 2) evs.push({ type: 'custom', ts: t + 30_100, level: room, name: 'rage_input', attrs: { key: 'Space', count: 6 } });
    if (r === 6) evs.push({ type: 'error', ts: t + 20_000, level: room, kind: 'exception', message: 'NullReferenceException: Object reference not set', fingerprint: 'ab12cd34', stack: 'at Room.Step ()\nat Game.Update ()' });
    evs.push({ type: 'custom', ts: t + 58_000, level: room, name: 'room_done', attrs: { room, mode: 'solo', seconds: 41 + r * 3.7, tries: 1 + (r % 3), switches: 4 + r, lifts: r, sends: 2 * r, calls: r % 4, blessings: r % 2, cowries: r, first_send_s: 5.5 + r, first_bless_s: 9.25 + r } });
    evs.push({ type: 'level_complete', ts: t + 59_000, level: room, duration_s: 57 });
  }
  evs.push({ type: 'session_end', ts: at + 2000 + rooms * 60_000 + 1000, reason: 'pagehide' });
  return { service: 'kay-and-tee', env: 'prod', version: '0.3.0', session_id: id, player_id: player, sdk: 'glitchless-unity/0.6.4', events: evs };
}

const send = async (p) => assert.ok((await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify(p) })).ok);
const main = playtest('s_owner', 'p_owner');
for (let i = 0; i < main.events.length; i += 400) await send({ ...main, events: main.events.slice(i, i + 400) });
for (let i = 0; i < 6; i++) await send(playtest(`s_${i}`, `p_${i}`, T0 + 1000 * i, 2));
const timelineEvents = main.events.filter((e) => !['frame_window', 'pos'].includes(e.type)).length;

test.after(() => api.close());

test('a 10-minute session is a summary an agent can hold, level by level, with the timeline on request', async (t) => {
  // What the tool answered before: the first 150 events and 120 frame windows, as indented JSON.
  const d = await (await fetch(`${base}/v1/query/session?service=kay-and-tee&id=s_owner`)).json();
  const old = JSON.stringify({ session: d.session, timeline: d.timeline.slice(0, 150), frames: d.frames.map(({ ctx, ...f }) => ({ ...f, ...ctx })).slice(0, 120) }, null, 2);
  const text = await call('glitchless_session', { session_id: 's_owner' });
  t.diagnostic(`${timelineEvents} timeline events: the summary is ${text.length} characters, the old answer ${old.length}`);
  assert.ok(timelineEvents >= 300, `${timelineEvents} events`);
  assert.ok(old.length > 60_000, `the old answer is ${old.length}`);
  assert.ok(text.length < 8_000, `the summary is ${text.length} characters`);
  assert.match(text, /^Session s_owner: 10 level\(s\), 60\d s, last on day5-room2\. \d+ events in all/);
  const s = json(text);
  assert.equal(s.levels.length, 10);
  const room3 = s.levels[2];
  assert.equal(room3.level, 'day2-room1');
  assert.deepEqual([room3.tries, room3.completed, room3.deaths, room3.causes, room3.hitches, room3.outcome], [1, 1, 3, { fell: 1, thorns: 2 }, 4, 'completed']);
  assert.equal(room3.events.room_done, 1);
  assert.equal(room3.events.step, 480, 'counters by their n');
  assert.ok(Math.abs(room3.time_s - 59) < 0.5, `${room3.time_s}`);
  assert.deepEqual(room3.rage_inputs, [{ at_s: 152.1, key: 'Space', presses: 6, x: 9, y: 1, z: 0 }]);
  assert.deepEqual(s.rage_inputs.map((r) => r.level), ['day2-room1']);
  assert.equal(s.errors[0].fingerprint, 'ab12cd34');
  assert.equal(s.levels[6].errors, 1);
  assert.equal(s.session.player_id, 'p_owner');
  assert.equal(s.hitches.count, 40);
  assert.deepEqual(s.levels[0].frames, { windows: 12, fps: 60, p95_ms: 22.4, worst_ms: 31 });

  // The events themselves: one level's, some types', every one.
  const room = json(await call('glitchless_session', { session_id: 's_owner', level: 'day2-room1' }));
  assert.ok(room.events.every((e) => e.level === 'day2-room1'));
  assert.equal(room.events.find((e) => e.name === 'rage_input').x, 9, 'the rage input where the player stood');
  const deaths = json(await call('glitchless_session', { session_id: 's_owner', types: 'death' }));
  assert.equal(deaths.total, 30);
  assert.ok(deaths.events.every((e) => e.type === 'death' && e.at_s > 0));
  const done = json(await call('glitchless_session', { session_id: 's_owner', types: 'room_done', limit: 3 }));
  assert.deepEqual([done.total, done.events.length], [10, 3]);
  const all = await call('glitchless_session', { session_id: 's_owner', view: 'timeline' });
  assert.match(all, /: \d+ event\(s\), the first 150 \(limit gives more\)/);
  t.diagnostic(`the timeline's first 150 events: ${all.length} characters, a line each`);
});

test('without a session id, glitchless_session lists the latest sessions with their players', async () => {
  const text = await call('glitchless_session', { limit: 3 });
  assert.match(text, /^7 session\(s\) of kay-and-tee in the last 24h, the latest 3 \(limit gives more\)/);
  const rows = json(text);
  assert.equal(rows.length, 3);
  const owner = json(await call('glitchless_session', { limit: 10 })).find((r) => r.session_id === 's_owner');
  assert.deepEqual([owner.player_id, owner.session_type, owner.levels, owner.completed, owner.deaths], ['p_owner', 'user', 10, 10, 30]);
});

test('glitchless_events lists the top values of each attribute by default, every value with detail', async (t) => {
  const full = await call('glitchless_events', { detail: true });
  const text = await call('glitchless_events');
  t.diagnostic(`events: ${text.length} characters by default, ${full.length} with detail`);
  assert.ok(text.length * 2 < full.length, `${text.length} against ${full.length}`);
  const { events, properties } = json(text);
  const done = events.find((e) => e.name === 'room_done');
  assert.deepEqual(Object.keys(done.attrs.room.top).length, 5);
  assert.equal(done.attrs.room.more_values, 5);
  assert.deepEqual(Object.keys(done.attrs.seconds).sort(), ['avg', 'p50', 'p90', 'p99', 'values']);
  assert.ok(properties.find((p) => p.key === 'input').top.keyboard >= 1);
  assert.match(text, /detail: true gives them all/);
  assert.ok(json(full).events.find((e) => e.name === 'room_done').attrs.find((a) => a.key === 'room').values.length === 10);
});

test('the funnel lists rage inputs with their level, time and place', async () => {
  const f = json(await call('glitchless_player_funnel'));
  assert.equal(f.kpis.rage_inputs, 1);
  assert.deepEqual(f.recent_rage_inputs.map(({ at, ...r }) => r), [{ session_id: 's_owner', version: '0.3.0', level: 'day2-room1', key: 'Space', presses: 6, x: 9, y: 1, z: 0 }]);
  assert.equal(f.recent_rage_inputs[0].at, new Date(T0 + 2000 + 2 * 60_000 + 30_100).toISOString());
});
