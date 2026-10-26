// Counters for frequent events (docs/design/genre-coverage.md A5; SPEC §2 counts): a window's counts fold into cells
// and sessions the way n custom events would, so every panel reads a counter by its name. Each answer is checked
// against the same play sent as one track() per event, and every store answers as the raw events do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, customEvents, eventFunnel, parseFunnel, crumbsOf } from '../src/analytics.js';
import { rollup, cellList, mergeCell, newCell } from '../src/rollups.js';
import { parsePayload, normalize, FEATURES } from '../src/ingest.js';
import { validateBoard, evaluateBoard } from '../src/board.js';
import { findings } from '../src/findings.js';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = Math.floor((NOW - 3 * 3_600_000) / 60_000) * 60_000;
const q = { service: 'farm', from: START - 60_000, to: NOW, type: 'all' };

// A seeded ARPG: sessions on two levels, each 5 s window counting kills by monster and gold by source (summed), with a
// crit flag. `asTracked` sends the same play as one custom event per kill and per pickup instead.
function farm({ sessions = 24, asTracked = false, seed = 3, windows = 8 } = {}) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const base = { service: 'farm', env: 'prod', version: n % 3 ? '1.1' : '1.0', session_id: `s_${n}`, player_id: `s_${n}` };
    let ts = START + n * 400_000 + Math.floor(rnd() * 60_000);
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base });
    push({ type: 'session_start', ts, session_type: 'user', device: { os: n % 2 ? 'Windows' : 'macOS', gpu_tier: 'high' } });
    for (const level of ['nmd_ghoa', 'pit_80']) {
      push({ type: 'level_start', ts: (ts += 1000), level });
      for (let w = 0; w < windows; w++) {
        const start = (ts += 5000);
        const burst = level === 'pit_80' && w % 3 === 0;
        const kills = { elite: 2 + Math.floor(rnd() * 4) + (burst ? 300 : 0), imp: 10 + Math.floor(rnd() * 20) };
        const golds = [5 + Math.floor(rnd() * 30), 1 + Math.floor(rnd() * 10)];
        const sk = new Sketch();
        for (let f = 0; f < 300; f++) sk.add(burst && f < 150 ? 80 : 16 + rnd());
        push({ type: 'frame_window', ts: start, level, duration_s: 5, frames: 300, budget_ms: 16.67, ft: sk.toJSON(), hitches: burst ? 150 : 0 });
        if (asTracked) {
          let t = start;
          for (const [monster, k] of Object.entries(kills)) for (let i = 0; i < k; i++) push({ type: 'custom', ts: ++t, level, name: 'kill', attrs: { monster, crit: i % 4 === 0 } });
          for (const amount of golds) push({ type: 'custom', ts: ++t, level, name: 'gold', attrs: { source: 'loot', amount } });
        } else {
          const entries = [];
          for (const [monster, k] of Object.entries(kills)) {
            const crit = Math.ceil(k / 4);
            entries.push({ name: 'kill', attrs: { monster, crit: true }, n: crit, first_ts: start + 1 });
            if (k - crit) entries.push({ name: 'kill', attrs: { monster, crit: false }, n: k - crit, first_ts: start + 2 });
          }
          entries.push({ name: 'gold', attrs: { source: 'loot' }, n: golds.length, sums: { amount: golds[0] + golds[1] }, first_ts: start + 3 });
          push({ type: 'counts', ts: start, level, duration_s: 5, dropped: 0, counts: entries });
        }
      }
      push({ type: 'level_complete', ts: (ts += 1000), level, duration_s: 41 });
    }
    push({ type: 'custom', ts: (ts += 500), name: 'stash', attrs: {} });
    push({ type: 'session_end', ts: (ts += 500) });
    out.push(events);
  }
  return out;
}

const counted = farm();
const tracked = farm({ asTracked: true });
const flat = (list) => list.flat().sort((a, b) => a.ts - b.ts);
const ctxOf = (list) => buildContext(flat(list), q);

test('intake keeps counts, drops broken entries, and says it folds them in /v1/health', () => {
  assert.ok(FEATURES.includes('counts'));
  const { events } = parsePayload({
    service: 'Farm',
    session_id: 's_x',
    events: [
      { type: 'counts', ts: NOW, duration_s: 5, dropped: 3, counts: [{ name: 'kill', attrs: { monster: 'elite', crit: true, tags: ['a'], hp: 3 }, n: 37, first_ts: NOW + 1 }, { name: '', n: 4 }, { name: 'gold', n: 0 }, { name: 'gold', n: 2, sums: { amount: 70, bad: 'x' } }] },
      { type: 'counts', ts: NOW, counts: [{ n: 4 }] },
    ],
  });
  const stored = normalize({ envelope: { service: 'farm', session_id: 's_x', player_id: 's_x', env: 'dev', version: '1' }, events }, NOW);
  assert.equal(stored.length, 1, 'a counts event with nothing left is dropped');
  assert.deepEqual(stored[0].counts, [
    { name: 'kill', attrs: { monster: 'elite', crit: true }, n: 37, first_ts: NOW + 1 },
    { name: 'gold', attrs: {}, n: 2, sums: { amount: 70 }, first_ts: NOW },
  ]);
  assert.equal(stored[0].dropped, 3);
});

test('a counter folds into cells as n custom events would: counts, values, sums and flags', () => {
  const a = newCell();
  for (const { c } of cellList(rollup(flat(counted)))) mergeCell(a, c);
  const b = newCell();
  for (const { c } of cellList(rollup(flat(tracked)))) mergeCell(b, c);
  // A tracked number also counts each value it was sent with; a counter's were added up, so it has none of those.
  const words = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.includes('\u0001amount\u0001')));
  for (const k of ['ev', 'evs', 'evx', 'evb']) assert.deepStrictEqual(sorted(a[k]), sorted(b[k]), k);
  assert.deepStrictEqual(sorted(a.evv), sorted(words(b.evv)), 'evv');
  assert.equal(a.evq, undefined, 'a counter has no distribution: its numbers were added up on the device');
  assert.deepEqual(a.evk, { kill: a.ev.kill, gold: a.ev.gold });
  assert.equal(b.evk, undefined);
});

test('every panel reads a counter by its name, as it reads the same events sent one by one', () => {
  const panels = validateBoard({
    panels: [
      { type: 'stat', event: 'kill', per: '$hours' },
      { type: 'stat', event: 'kill:monster=elite', per: '$hours' },
      { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
      { type: 'stat', event: 'gold', avg: 'amount' },
      { type: 'stat', event: 'kill', rate: 'crit' },
      { type: 'stat', event: 'kill', per: '$sessions' },
      { type: 'breakdown', event: 'kill', by: 'monster' },
      { type: 'breakdown', event: 'kill', by: 'monster', rate: 'crit', min: 1 },
      { type: 'breakdown', event: 'kill', by: '$level', per: '$hours' },
      { type: 'breakdown', event: 'kill', by: '$platform' },
      { type: 'breakdown', event: 'kill', by: '$platform', rate: 'crit', min: 1 },
      { type: 'breakdown', event: 'gold', by: 'source', sum: 'amount' },
      { type: 'series', event: 'kill', by: 'monster' },
      { type: 'funnel', steps: 'kill,gold,stash' },
    ],
  });
  const a = evaluateBoard(ctxOf(counted), panels);
  const b = evaluateBoard(ctxOf(tracked), panels);
  for (let i = 0; i < a.length; i++) assert.deepStrictEqual(a[i], b[i], `${a[i].title}`);
  assert.ok(a.every((p) => !p.empty), a.filter((p) => p.empty).map((p) => p.why).join('; '));
  // Over time by platform, a counter's events go in its windows (a tracked event past a session's 16 kept is spread).
  const [overTime] = evaluateBoard(ctxOf(counted), validateBoard({ panels: [{ type: 'series', event: 'kill', by: '$platform' }] }));
  const total = flat(counted).filter((e) => e.type === 'counts').flatMap((e) => e.counts).filter((c) => c.name === 'kill').reduce((n, c) => n + c.n, 0);
  assert.equal(overTime.series.flatMap((x) => x.values).reduce((n, v) => n + v, 0), total);
  const [trackedOverTime] = evaluateBoard(ctxOf(tracked), validateBoard({ panels: [{ type: 'series', event: 'kill', by: '$platform' }] }));
  assert.ok(overTime.spread < trackedOverTime.spread, `a kept counter entry places its whole window of events: ${overTime.spread} spread, against ${trackedOverTime.spread} sent one by one`);
});

test('a filtered counter split by its session reads the occurrences, each weighed by the events it stands for', () => {
  const panels = validateBoard({ panels: [{ type: 'breakdown', event: 'kill:monster=elite', by: '$platform', rate: 'crit', min: 1 }, { type: 'breakdown', event: 'kill:monster=elite', by: 'crit' }] });
  // Fewer counter entries than a session keeps occurrences of (3 windows of 4 kill entries), so it is exact.
  const small = farm({ windows: 3 }).map((events) => events.filter((e) => e.level !== 'pit_80'));
  const a = evaluateBoard(ctxOf(small), panels);
  assert.equal(a[0].from, 'occurrences');
  assert.equal(a[0].estimated, undefined);
  const elite = flat(small).filter((e) => e.type === 'counts').flatMap((e) => e.counts.map((c) => ({ ...c, os: e.session_id }))).filter((c) => c.name === 'kill' && c.attrs.monster === 'elite');
  const os = (sid) => (Number(sid.slice(2)) % 2 ? 'Windows' : 'macOS');
  const want = ['macOS', 'Windows'].map((v) => {
    const mine = elite.filter((c) => os(c.os) === v);
    const n = mine.reduce((k, c) => k + c.n, 0);
    return [v, n, Math.round((mine.filter((c) => c.attrs.crit).reduce((k, c) => k + c.n, 0) / n) * 1000) / 10];
  });
  assert.deepStrictEqual(a[0].rows.map((r) => [r.value, r.events, r.rate]).sort(), want.sort());
  assert.deepStrictEqual(a[1].rows.map((r) => [r.value, r.count]).sort(), [['false', elite.filter((c) => !c.attrs.crit).reduce((k, c) => k + c.n, 0)], ['true', elite.filter((c) => c.attrs.crit).reduce((k, c) => k + c.n, 0)]].sort());
});

test('the events query marks a counter `counted`; a funnel step a counter reaches is reached at its first one', () => {
  const ctx = ctxOf(counted);
  const ev = customEvents(ctx);
  assert.equal(ev.events.find((e) => e.name === 'kill').counted, true);
  assert.equal(ev.events.find((e) => e.name === 'stash').counted, undefined);
  const funnel = eventFunnel(ctx, parseFunnel('kill:monster=elite,gold,stash'));
  assert.deepEqual(funnel.map((s) => s.sessions), [counted.length, counted.length, counted.length]);
  const s = ctx.sessions.get('s_0');
  const firstKill = flat([counted[0]]).find((e) => e.type === 'counts').counts[0].first_ts;
  assert.equal(s.ev.kill.o[0][0], firstKill);
  assert.equal(s.ev.kill.k, s.ev.kill.n);
  assert.ok(s.last_play >= flat([counted[0]]).filter((e) => e.type === 'counts').at(-1).ts, 'counters count as play');
});

test('breadcrumbs show a window of counters once: "kill ×37"', () => {
  const events = flat([counted[0]]);
  const counts = events.find((e) => e.type === 'counts');
  const crumbs = crumbsOf(events, 's_0', counts.ts);
  assert.match(crumbs.at(-1).name, /^kill ×\d+, gold ×2$/);
});

test('finding 13: hitches that come in windows with a burst of a counter say so', () => {
  const f = findings(ctxOf(counted)).find((x) => x.id === 'perf-level-pit_80');
  assert.ok(f, 'pit_80 stutters');
  assert.equal(f.evidence.counter_bursts[0].name, 'kill');
  assert.ok(f.evidence.counter_bursts[0].during >= 300 && f.evidence.counter_bursts[0].otherwise < 60);
  assert.match(f.summary, /hitches come in windows with \d+ or so `kill` \(a calm window: \d+\)/);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: counters answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    const BOARD = [
      { type: 'stat', event: 'kill', per: '$hours' },
      { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
      { type: 'breakdown', event: 'kill', by: 'monster', rate: 'crit', min: 1 },
      { type: 'breakdown', event: 'kill', by: '$platform' },
      { type: 'funnel', steps: 'kill,gold,stash' },
    ];
    try {
      assert.ok((await call('GET', '/v1/health')).features.includes('counts'));
      for (const list of counted) {
        const { service, env, version, session_id, player_id } = list[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.equal(res.status, 202);
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=farm', { pages: [{ id: 'farm', title: 'Farm', panels: BOARD }] });
      const range = `service=farm&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board } = await call('GET', `/v1/query/board?${range}&page=farm`);
      const raw = buildContext(flat(counted).filter((e) => e.ts >= meta.from && e.ts <= meta.to), { ...q, from: meta.from, to: meta.to });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(board.panels)), JSON.parse(JSON.stringify(evaluateBoard(raw, validateBoard({ panels: BOARD })))));
      const ev = await call('GET', `/v1/query/events?${range}&name=kill`);
      assert.equal(ev.events[0].counted, true);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}


function sorted(o) {
  return Object.fromEntries(Object.entries(o || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
