#!/usr/bin/env node
// Load test: the same synthetic play sessions through the current DynamoDB store and the hosted lake
// store (Firehose → S3, compactor, DynamoDB summaries), counting every request and byte each would send
// to AWS, priced at us-east-1 list prices. Runs locally on a virtual clock: the in-memory DynamoDB and the
// local Firehose meter what AWS bills; the compactor is the real code with DuckDB.
//
//   node scripts/lake-loadtest.js                         # 1,000 ten-minute sessions, dense and sparse
//   node scripts/lake-loadtest.js --sessions 200 --buffer 900 --scenario sparse --json out.json
//   node scripts/lake-loadtest.js --sdk legacy                 # the earlier SDK: 5 s batches, positions
//   node scripts/lake-loadtest.js --scenario dense --sessions 7200 --long 365 [--serve 7799]
//                                   # long ranges: a full day of the dense game through the lake until its
//                                   # daily rollups are built, then copied back over 365 days; prices the
//                                   # day build and times 90-day and 365-day queries (--serve: then serve
//                                   # that game's API and the built dashboard on a port)
//
// Sessions follow the browser SDK: a frame window every 5 s with pickups, hitches, deaths and level
// events, about 40 events per player-minute, sent as a gzipped batch every 15 s (--sdk legacy: a plain
// batch every 5 s, with 4 Hz positions). Scenarios: dense = one game with 50 players at a time; sparse = 100 games with one
// player each at a time (Firehose objects and compactor items are per game, so small games cost more).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance as perf } from 'node:perf_hooks';
import { Sketch } from '../packages/sdk/src/sketch.js';
import { parsePayload, normalize } from '../server/src/ingest.js';
import { DynamoStore } from '../server/src/stores/dynamo.js';
import { FakeDynamo } from '../server/test/helpers/fake-dynamo.js';
import { lakeSim } from '../server/test/helpers/lake-sim.js';
import { overview, performance, players, customEvents, eventFunnel, parseFunnel, sessionsList, buildContext } from '../server/src/analytics.js';
import { findings } from '../server/src/findings.js';
import { autoBoard, evaluateBoard } from '../server/src/board.js';
import { createApp } from '../server/src/app.js';
import { dailyPk, dailySk, summaryPk } from '../server/src/lake/layout.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const SESSIONS = Number(flag('sessions', 1000));
const MINUTES = Number(flag('minutes', 10));
const BUFFER_S = Number(flag('buffer', 300));
const EVERY_MIN = Number(flag('every', 2));
const PARTITIONING = flag('partitioning', 'project');
const SCENARIOS = { both: ['dense', 'sparse'], none: [] }[flag('scenario', 'both')] || [flag('scenario')];
// The browser SDK closes a frame window every 5 s. The current SDK sends them in a gzipped batch every
// 15 s and is anonymous by default (no player id, no positions, deaths without coordinates); --sdk legacy
// is the earlier one: a plain JSON batch every 5 s with positions.
const SDK = flag('sdk', 'current');
const WINDOW_MS = 5000;
const BATCH_MS = Number(flag('batch', SDK === 'legacy' ? 5 : 15)) * 1000;
const POSITIONS = args.includes('--positions') || SDK === 'legacy';
const GZIP = SDK !== 'legacy';

// us-east-1 list prices, October 2026 (aws.amazon.com/{lambda,firehose,s3,dynamodb}/pricing).
export const PRICES = {
  webRequest: 0.3 / 1e6, // Lambda Web Functions, per request
  webVcpuSecond: 0.0000276944, // Web Functions active vCPU (Arm), per vCPU-second
  firehoseGB: 0.029, // Direct PUT ingestion, per GB in 5 KB steps per record
  dpGB: 0.02, // dynamic partitioning, per GB processed
  dpObject: 0.005 / 1000, // dynamic partitioning, per S3 object delivered
  jqHour: 0.07, // dynamic partitioning JQ, per processing hour
  s3Put: 0.005 / 1000, // PUT, COPY, POST, LIST
  s3Get: 0.0004 / 1000,
  s3GBMonth: 0.023,
  ddbWru: 0.625 / 1e6,
  ddbRru: 0.125 / 1e6,
  ddbGBMonth: 0.25,
  lambdaGBSecond: 0.0000133334, // event function, Arm
  lambdaRequest: 0.2 / 1e6,
};
const GB = 1024 ** 3;

// ── sessions ──

function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (v) => Math.round(v * 100) / 100;
const TIERS = [
  ['high', 'Chrome', 'NVIDIA GeForce RTX 4070'],
  ['mid', 'Safari', 'Apple M2'],
  ['mid', 'Chrome', 'Intel Iris Xe'],
  ['low', 'Chrome', 'Intel UHD 620'],
  ['low', 'Chrome', 'Adreno (TM) 650'],
];

// One session's beacons: [{ at, payload, wire }], as the SDK sends them (wire: bytes on the wire).
function session({ project, id, start, minutes, rnd }) {
  const [tier, browser, gpu] = TIERS[Math.floor(rnd() * TIERS.length)];
  const envelope = {
    service: `game-${project}`,
    env: 'prod',
    version: rnd() < 0.5 ? '1.4.0' : '1.4.1',
    session_id: `s_${project}_${id}`,
    player_id: POSITIONS ? `p_${project}_${Math.floor(rnd() * 1e6)}` : null,
    sdk: 'glitchless-browser/0.1.0',
  };
  const end = start + minutes * 60_000;
  let level = 1;
  let x = 0;
  const beacons = [];
  let events = [
    {
      type: 'session_start',
      ts: start,
      level: null,
      session_type: 'user',
      device: {
        browser,
        browser_version: '141',
        os: 'Windows',
        mobile: false,
        gpu,
        gpu_vendor: gpu.split(' ')[0],
        gpu_tier: tier,
        webgl: 'webgl2',
        cores: 8,
        memory_gb: 16,
        screen: [1920, 1080],
        dpr: 1,
      },
      page: { url: 'https://game.example/', referrer: '' },
    },
    { type: 'load', ts: start + 400, level: null, ttff_ms: 1500 + Math.floor(rnd() * 2500), assets: { count: 14, failed: 0, ms: 1200, slowest: [{ url: 'level.glb', ms: 600 }] } },
    { type: 'level_start', ts: start + 500, level: `level-${level}` },
  ];
  let sent = start;
  for (let t = start + WINDOW_MS; t <= end; t += WINDOW_MS) {
    const lvl = `level-${level}`;
    const sk = new Sketch();
    const frames = Math.round(5 * (56 + rnd() * 6));
    let hitches = 0;
    for (let f = 0; f < frames; f++) {
      const v = rnd() < 0.0012 ? 50 + rnd() * 120 : 16.7 + (rnd() - 0.5) * 4 * (tier === 'low' ? 2 : 1);
      if (v > 50) hitches++;
      sk.add(v);
    }
    const ft = sk.toJSON();
    events.push({
      type: 'frame_window',
      ts: t - 1,
      level: lvl,
      duration_s: 5,
      frames,
      fps: r2(frames / 5),
      hz: 60,
      budget_ms: 16.67,
      ft,
      ft_p50: r2(sk.quantile(0.5)),
      ft_p95: r2(sk.quantile(0.95)),
      ft_p99: r2(sk.quantile(0.99)),
      ft_max: ft.mx,
      slow: hitches,
      jank: hitches,
      hitches,
      frozen: 0,
      render_ms: r2(1 + rnd() * 3),
      draw_calls: 80 + Math.floor(rnd() * 120),
      draw_calls_max: 240,
      triangles: 40000 + Math.floor(rnd() * 30000),
      geometries: 120 + level * 8,
      textures: 22,
      programs: 14,
      heap_mb: r2(60 + rnd() * 40),
      ctx: { particles: Math.floor(rnd() * 300), entities: Math.floor(rnd() * 12) },
    });
    x += 16;
    if (POSITIONS) {
      // 4 Hz, minus the samples the SDK drops while the player stands still.
      const pts = [];
      for (let k = 0; k < 16; k++) pts.push([t - WINDOW_MS + k * 312, r2(x - 16 + k), rnd() < 0.8 ? 0 : r2(rnd() * 2), 0]);
      events.push({ type: 'pos', ts: pts[0][0], level: lvl, pts });
    }
    for (let n = rnd() < 0.6 ? 1 : rnd() < 0.5 ? 2 : 0; n > 0; n--)
      events.push({ type: 'custom', ts: t - Math.floor(rnd() * WINDOW_MS), level: lvl, name: rnd() < 0.8 ? 'bone_collected' : 'powerup', attrs: { golden: rnd() < 0.1 } });
    if (hitches)
      events.push({
        type: 'hitch',
        ts: t - 2000,
        level: lvl,
        duration_ms: r2(55 + rnd() * 100),
        frozen: false,
        draw_calls: 210,
        triangles: 58000,
        programs: 23,
        ctx: { particles: Math.floor(rnd() * 900), entities: 2 },
        recent: ['bone_collected'],
        causes: [rnd() < 0.5 ? 'gc' : 'shader_compile'],
        loaf: [],
      });
    if (rnd() < 0.05) events.push({ type: 'death', ts: t - 1500, level: lvl, ...(POSITIONS ? { x: r2(x), y: 0, z: 0 } : {}), cause: rnd() < 0.6 ? 'fell' : 'squirrel' });
    if (rnd() < 0.004)
      events.push({
        type: 'error',
        ts: t - 800,
        level: lvl,
        kind: 'js',
        message: "TypeError: Cannot read properties of undefined (reading 'position')",
        stack: 'TypeError: Cannot read properties of undefined\n    at spawnScorePopup (popups.js:46:11)\n    at collectBone (main.js:234:10)',
        source: 'popups.js',
        line: 46,
        col: 11,
        fn: 'spawnScorePopup',
        fingerprint: '6eaab9da',
        attrs: null,
      });
    if (rnd() < 0.02) {
      events.push({ type: 'level_complete', ts: t - 400, level: lvl, duration_s: 120, score: 900 });
      level++;
      x = 0;
      events.push({ type: 'level_start', ts: t - 300, level: `level-${level}` });
    }
    const last = t + WINDOW_MS > end;
    if (last) events.push({ type: 'session_end', ts: t, level: lvl, reason: 'pagehide', duration_s: minutes * 60 });
    if (!last && t - sent < BATCH_MS) continue;
    events.sort((a, b) => a.ts - b.ts);
    const payload = JSON.stringify({ ...envelope, events });
    // The close-of-page beacon goes as plain JSON (sendBeacon), the others gzipped.
    const wire = GZIP && !last ? zlib.gzipSync(payload).length : Buffer.byteLength(payload);
    beacons.push({ project, at: t + 200 + Math.floor(rnd() * 300), payload, wire });
    events = [];
    sent = t;
  }
  return beacons;
}

function scenario(name) {
  const rnd = rng(name === 'dense' ? 11 : 23);
  const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 12 * 3_600_000;
  const length = MINUTES * 60_000;
  const beacons = [];
  if (name === 'dense') {
    // One game, 50 players at a time: sessions start every length / 50.
    for (let i = 0; i < SESSIONS; i++) beacons.push(...session({ project: 'dense', id: i, start: start + Math.floor((i * length) / 50) + Math.floor(rnd() * 1000), minutes: MINUTES, rnd }));
  } else {
    // 100 games, one player each at a time, back to back with a minute between.
    const games = Math.min(100, SESSIONS);
    for (let i = 0; i < SESSIONS; i++) {
      const game = i % games;
      const slot = Math.floor(i / games);
      beacons.push(...session({ project: `g${game}`, id: slot, start: start + slot * (length + 60_000) + game * 3_700, minutes: MINUTES, rnd }));
    }
  }
  return { start, beacons: beacons.sort((a, b) => a.at - b.at) };
}

// ── stores ──

const dynamoKind = (pk) => (/#R#/.test(pk) ? 'rollups' : /#SVC$/.test(pk) ? 'services' : /#META$/.test(pk) ? 'meta' : /#MAP#/.test(pk) ? 'maps' : 'events');
const lakeKind = (pk) =>
  /#L#/.test(pk) ? 'summaries' : /#X#/.test(pk) ? 'session index' : /#SVC$/.test(pk) ? 'services' : /^LAKE#/.test(pk) ? 'compactor lease and watermark' : /#MAP#/.test(pk) ? 'maps' : 'other';

async function runDynamo({ start, beacons }) {
  const doc = new FakeDynamo({ pageSize: 1e9, kindOf: dynamoKind });
  const store = new DynamoStore({ table: 'glitchless-selfhost-events', doc, rollupsSince: 0 });
  let cpu = 0;
  for (const b of beacons) {
    const t = perf.now();
    const events = normalize(parsePayload(b.payload, { projectId: b.project }), b.at);
    await store.put(b.project, events);
    cpu += perf.now() - t;
  }
  const writes = structuredClone(doc.meter);
  // One dashboard load (overview, performance, findings) over the last day of one game.
  const before = { ...doc.meter };
  const service = beacons[0] && JSON.parse(beacons[0].payload).service;
  const project = beacons[0].project;
  const q = { service, from: start, to: start + 24 * 3_600_000, type: 'all' };
  const raw = await store.query(project, q);
  const rollups = await store.rollups(project, q);
  for (const fn of [overview, performance]) fn(buildContext(raw, q, rollups));
  findings(buildContext(raw, q, rollups), []);
  return { writes, dashboard: { rru: doc.meter.rru - before.rru }, storedBytes: doc.storedBytes(), ingestMs: cpu };
}

async function runLake({ start, beacons }) {
  const sim = lakeSim({
    start: start - 60_000,
    bufferMs: BUFFER_S * 1000,
    everyMs: EVERY_MIN * 60_000,
    deliveryDelayMs: BUFFER_S * 1500 + 60_000,
    partitionByProject: PARTITIONING === 'project',
    pageSize: 1e9,
  });
  sim.doc.kindOf = lakeKind;
  let compactMs = 0;
  let compactRuns = 0;
  const run = sim.compactor.run.bind(sim.compactor);
  sim.compactor.run = async () => {
    const t = perf.now();
    const out = await run();
    compactMs += perf.now() - t;
    compactRuns++;
    return out;
  };
  let cpu = 0;
  for (const b of beacons) {
    await sim.advance(b.at);
    const t = perf.now();
    const events = normalize(parsePayload(b.payload, { projectId: b.project }), b.at);
    await sim.store.put(b.project, events);
    cpu += perf.now() - t;
  }
  await sim.settle(4 * 3_600_000);
  const writes = { firehose: { ...sim.firehose.meter }, s3: { ...sim.bucket.meter }, ddb: structuredClone(sim.doc.meter) };
  // What an idle compactor run costs (nothing arrived, nothing due): measured over an idle hour.
  const idleBefore = { s3: { ...sim.bucket.meter }, ddb: structuredClone(sim.doc.meter), runs: compactRuns, ms: compactMs };
  await sim.settle(3_600_000);
  const idle = {
    runs: compactRuns - idleBefore.runs,
    ms: compactMs - idleBefore.ms,
    puts: sim.bucket.meter.put - idleBefore.s3.put,
    lists: sim.bucket.meter.list - idleBefore.s3.list,
    gets: sim.bucket.meter.get - idleBefore.s3.get,
    wru: sim.doc.meter.wru - idleBefore.ddb.wru,
    rru: sim.doc.meter.rru - idleBefore.ddb.rru,
  };
  const stored = {};
  for (const { key, size } of await sim.bucket.list('')) {
    const top = key.split('/')[0];
    stored[top] = (stored[top] || 0) + size;
  }
  // The same dashboard load.
  const s3Before = { ...sim.bucket.meter };
  const ddbBefore = { ...sim.doc.meter };
  const service = JSON.parse(beacons[0].payload).service;
  const project = beacons[0].project;
  const q = { service, from: start, to: start + 24 * 3_600_000, type: 'all', env: null, version: null, sessions: null };
  overview(await sim.store.context(project, q, 'overview'));
  performance(await sim.store.context(project, q, 'performance'));
  findings(await sim.store.context(project, q, 'findings'), []);
  const dashboard = { rru: sim.doc.meter.rru - ddbBefore.rru, gets: sim.bucket.meter.get - s3Before.get };
  const sessions = (await sim.bucket.list('sessions/')).length;
  const out = { writes, idle, dashboard, stored, ddbStoredBytes: sim.doc.storedBytes(), compactMs: idleBefore.ms, compactRuns: idleBefore.runs, sessions, ingestMs: cpu };
  sim.close();
  return out;
}

// ── report ──

function stats(beacons) {
  let events = 0;
  let stored = 0;
  let wire = 0;
  const byType = {};
  for (const b of beacons) {
    wire += b.wire;
    const evs = normalize(parsePayload(b.payload, { projectId: b.project }), b.at);
    events += evs.length;
    for (const e of evs) stored += Buffer.byteLength(JSON.stringify(e));
    for (const e of JSON.parse(b.payload).events) {
      const t = (byType[e.type] ||= { n: 0, bytes: 0 });
      t.n++;
      t.bytes += Buffer.byteLength(JSON.stringify(e));
    }
  }
  const playerMinutes = SESSIONS * MINUTES;
  return {
    requests: beacons.length,
    events,
    perPlayerMinute: { events: events / playerMinutes, storedKB: stored / 1024 / playerMinutes, wireKB: wire / 1024 / playerMinutes },
    eventBytes: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v.bytes / v.n)])),
    perBeacon: { events: events / beacons.length, wireBytes: Math.round(wire / beacons.length) },
  };
}

function price(name, load, d, l) {
  const per = 1000 / SESSIONS;
  const web = load.requests * PRICES.webRequest;
  const dynamo = Object.fromEntries(Object.entries(d.writes.byKind).map(([k, v]) => [`DynamoDB ${k}`, v.wru * PRICES.ddbWru]));
  const fh = l.writes.firehose;
  const objects = fh.objects;
  const lake = {
    'Firehose ingest (5 KB steps)': (fh.billedBytes / GB) * PRICES.firehoseGB,
    ...(PARTITIONING === 'project' ? { 'Firehose partitioning (GB)': (fh.bytes / GB) * PRICES.dpGB, 'Firehose partitioning (objects)': objects * PRICES.dpObject } : {}),
    // Puts include the objects Firehose delivers (the local Firehose writes through the same bucket).
    'S3 requests (Firehose + compactor)': (l.writes.s3.put + l.writes.s3.list) * PRICES.s3Put + l.writes.s3.get * PRICES.s3Get,
    ...Object.fromEntries(Object.entries(l.writes.ddb.byKind).map(([k, v]) => [`DynamoDB ${k}`, v.wru * PRICES.ddbWru + v.rru * PRICES.ddbRru])),
    // Measured on this machine; Lambda arm64 is taken as 2× slower, at 2 GB.
    'Compactor Lambda (2 GB)': ((l.compactMs * 2) / 1000) * 2 * PRICES.lambdaGBSecond + l.compactRuns * PRICES.lambdaRequest,
  };
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  // What the compactor's runs would have cost with nothing to do (listing, lease, watermark): a fixed
  // cost of the service, reported per month below, not per session.
  const idleRun =
    ((l.idle.puts + l.idle.lists) * PRICES.s3Put + l.idle.gets * PRICES.s3Get + l.idle.wru * PRICES.ddbWru + l.idle.rru * PRICES.ddbRru + ((l.idle.ms * 2) / 1000) * 2 * PRICES.lambdaGBSecond) /
      (l.idle.runs || 1) +
    PRICES.lambdaRequest;
  const fixed = l.compactRuns * idleRun;
  const monthDays = 30;
  const lakeStoredGB = ((l.stored.events || 0) + (l.stored.sessions || 0)) / GB;
  const storage = {
    dynamo: (d.storedBytes / GB) * PRICES.ddbGBMonth,
    lake: lakeStoredGB * PRICES.s3GBMonth + ((l.stored.raw || 0) / GB) * PRICES.s3GBMonth * (3 / monthDays) + (l.ddbStoredBytes / GB) * PRICES.ddbGBMonth,
  };
  const scale = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v * per]));
  return {
    scenario: name,
    perThousand: {
      web: web * per,
      dynamo: scale(dynamo),
      dynamoTotal: (sum(dynamo) + web) * per,
      lake: scale(lake),
      lakeTotal: (sum(lake) + web) * per,
      lakeFixedShare: fixed * per,
      lakeVariable: (sum(lake) - fixed + web) * per,
      storagePerMonth: { dynamo: storage.dynamo * per, lake: storage.lake * per },
      jqAt1msPerRecord: PARTITIONING === 'project' ? ((fh.records * 0.001) / 3600) * PRICES.jqHour * per : 0,
    },
    // A compactor that finds nothing to do, every EVERY_MIN minutes for a month (shared by all games).
    idlePerMonth: ((30 * 24 * 60) / EVERY_MIN) * idleRun,
    counts: {
      requests: load.requests,
      dynamo: { wru: d.writes.wru, wruByKind: Object.fromEntries(Object.entries(d.writes.byKind).map(([k, v]) => [k, v.wru])), storedMB: d.storedBytes / 1e6 },
      lake: {
        firehoseRecords: fh.records,
        firehoseMB: fh.bytes / 1e6,
        firehoseBilledMB: fh.billedBytes / 1e6,
        s3Objects: objects,
        s3Puts: l.writes.s3.put,
        s3Gets: l.writes.s3.get,
        s3Lists: l.writes.s3.list,
        ddbWru: l.writes.ddb.wru,
        ddbWruByKind: Object.fromEntries(Object.entries(l.writes.ddb.byKind).map(([k, v]) => [k, v.wru])),
        idleRun: { ...l.idle, ms: undefined, msPerRun: l.idle.ms / (l.idle.runs || 1) },
        ddbRru: l.writes.ddb.rru,
        storedMB: Object.fromEntries(Object.entries(l.stored).map(([k, v]) => [k, v / 1e6])),
        ddbStoredMB: l.ddbStoredBytes / 1e6,
        compactorRuns: l.compactRuns,
        compactorSeconds: l.compactMs / 1000,
        sessionFiles: l.sessions,
      },
    },
    dashboard: { dynamoRru: d.dashboard.rru, lakeRru: l.dashboard.rru, lakeGets: l.dashboard.gets },
  };
}

const usd = (v) => `$${v.toFixed(v < 0.01 ? 4 : 3)}`;
const results = [];
for (const name of SCENARIOS) {
  const sc = scenario(name);
  const load = stats(sc.beacons);
  console.log(
    `\n${name}: ${SESSIONS} sessions × ${MINUTES} min, ${load.requests} beacons, ${load.perPlayerMinute.events.toFixed(1)} events and ${load.perPlayerMinute.storedKB.toFixed(1)} KB stored (${load.perPlayerMinute.wireKB.toFixed(1)} KB on the wire) per player-minute`,
  );
  console.log(`  average event bytes ${JSON.stringify(load.eventBytes)}; per beacon ${JSON.stringify(load.perBeacon)}`);
  const t0 = Date.now();
  const d = await runDynamo(sc);
  console.log(`  dynamodb store done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const t1 = Date.now();
  const l = await runLake(sc);
  console.log(`  lake store done in ${((Date.now() - t1) / 1000).toFixed(1)} s (compactor ${l.compactRuns} runs, ${(l.compactMs / 1000).toFixed(1)} s)`);
  const p = price(name, load, d, l);
  results.push({ ...p, load });
  const k = p.perThousand;
  console.log(`  per 1,000 sessions:  web function requests ${usd(k.web)} (both stores)`);
  console.log(
    `    dynamodb store     ${usd(k.dynamoTotal)}  = requests + ${Object.entries(k.dynamo)
      .map(([a, v]) => `${a} ${usd(v)}`)
      .join(' + ')}`,
  );
  console.log(
    `    lake store         ${usd(k.lakeTotal)}  = requests + ${Object.entries(k.lake)
      .map(([a, v]) => `${a} ${usd(v)}`)
      .join(' + ')}`,
  );
  console.log(`      of which ${usd(k.lakeFixedShare)} is ${p.counts.lake.compactorRuns} compactor runs' fixed cost; per session: ${usd(k.lakeVariable)}`);
  console.log(`    storage per month kept: dynamodb ${usd(k.storagePerMonth.dynamo)}, lake ${usd(k.storagePerMonth.lake)}; JQ at 1 ms/record would add ${usd(k.jqAt1msPerRecord)}`);
  console.log(`    an idle compactor costs ${usd(p.idlePerMonth)} a month (once for the whole service)`);
  console.log(`  counts: ${JSON.stringify(p.counts)}`);
  console.log(`  one dashboard load (overview + performance + findings, 24 h): dynamodb ${p.dashboard.dynamoRru} RRU; lake ${p.dashboard.lakeRru} RRU + ${p.dashboard.lakeGets} S3 GETs`);
}
// ── long ranges: daily rollups ──

// A full day of the dense game (50 players at a time: 7,200 ten-minute sessions fill a day) through the
// lake until the compactor has built its daily rollups, then that day copied back over `days` days: what a
// day build costs, what a day keeps, and how long long-range queries take and what they read.
async function runLong(days) {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const day = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
  const length = MINUTES * 60_000;
  const rnd = rng(31);
  const beacons = [];
  for (let i = 0; i < SESSIONS; i++) beacons.push(...session({ project: 'dense', id: i, start: day + Math.floor((i * length) / 50) + Math.floor(rnd() * 1000), minutes: MINUTES, rnd }));
  beacons.sort((a, b) => a.at - b.at);
  const sim = lakeSim({ start: day - HOUR, bufferMs: BUFFER_S * 1000, everyMs: EVERY_MIN * 60_000, deliveryDelayMs: BUFFER_S * 1500 + 60_000, partitionByProject: PARTITIONING === 'project', pageSize: 1e9 });
  sim.doc.kindOf = lakeKind;
  const build = { days: 0, ms: 0, wru: 0, rru: 0, items: 0 };
  const buildDay = sim.compactor.buildDay.bind(sim.compactor);
  sim.compactor.buildDay = async (d, run) => {
    const before = { ...sim.doc.meter };
    const t = perf.now();
    const n = await buildDay(d, run);
    build.ms += perf.now() - t;
    build.wru += sim.doc.meter.wru - before.wru;
    build.rru += sim.doc.meter.rru - before.rru;
    build.items += n;
    if (n) build.days++;
    return n;
  };
  const t0 = Date.now();
  for (const b of beacons) {
    await sim.advance(b.at);
    await sim.store.put(b.project, normalize(parsePayload(b.payload, { projectId: b.project }), b.at));
  }
  await sim.advance(Math.floor(beacons.at(-1).at / DAY) * DAY + DAY + 5 * HOUR);
  console.log(`\nlong ranges: ${SESSIONS} sessions in one day through the lake in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const service = JSON.parse(beacons[0].payload).service;
  const items = [...(sim.doc.tables.get(dailyPk('dense', service, day))?.values() || [])].filter((it) => Number(it.sk.split('#')[1]) === day);
  const dayBytes = items.reduce((n, it) => n + it.b.length, 0);
  const latestBytes = items.filter((it) => it.sk.startsWith('R#')).reduce((n, it) => n + it.b.length, 0);
  const hourBytes = [...(sim.doc.tables.get(summaryPk('dense', service, day))?.values() || [])].reduce((n, it) => n + (it.b?.length || 0), 0);
  // The day copied back over `days` days, and the days with rollups starting at the first copy.
  for (let k = 1; k < days; k++) {
    const d = day - k * DAY;
    for (const it of items) {
      const [family, , run, chunk] = it.sk.split('#');
      sim.doc.put({ ...it, pk: dailyPk('dense', service, d), sk: dailySk(d, run, Number(chunk), family) });
    }
  }
  sim.doc.put({ ...sim.doc.get('LAKE#META', 'watermark'), df: day - (days - 1) * DAY });
  sim.store.mark = null;
  const to = sim.clock;
  const queries = {
    board: (ctx) => evaluateBoard(ctx, autoBoard(ctx)),
    events: (ctx) => [customEvents(ctx), eventFunnel(ctx, parseFunnel('bone_collected,powerup'))],
    overview: (ctx) => [overview(ctx), findings(ctx, [])],
    players: (ctx) => players(ctx),
    performance: (ctx) => performance(ctx),
  };
  const timings = [];
  for (const span of [...new Set([90, days])]) {
    for (const [name, fn] of Object.entries({ ...queries, sessions: (ctx) => sessionsList(ctx) })) {
      for (const pass of ['cold', 'warm']) {
        const q = { service, from: to - span * DAY, to, env: null, version: null, type: 'all', sessions: null };
        const before = { ...sim.doc.meter, gets: sim.bucket.meter.get };
        const t = perf.now();
        const ctx = await sim.store.context('dense', q, name);
        const readMs = perf.now() - t;
        fn(ctx);
        timings.push({ span, name, pass, ms: Math.round(perf.now() - t), readMs: Math.round(readMs), rru: sim.doc.meter.rru - before.rru, pages: sim.doc.meter.reads - before.reads, s3Gets: sim.bucket.meter.get - before.gets, approximate: ctx.meta?.approximate || [] });
      }
    }
  }
  const perDay = {
    sessions: SESSIONS,
    rollupKB: dayBytes / 1024,
    latestSessionsKB: latestBytes / 1024,
    rollupItems: items.length,
    hourSummariesKB: hourBytes / 1024,
    build: { ...build, msPerDay: build.ms / (build.days || 1), wruPerDay: build.wru / (build.days || 1), rruPerDay: build.rru / (build.days || 1) },
    // Lambda arm64 taken as 2× slower than this machine, at 2 GB, as for the compactor above.
    buildUsd: (build.wru * PRICES.ddbWru + build.rru * PRICES.ddbRru + ((build.ms * 2) / 1000) * 2 * PRICES.lambdaGBSecond) / (build.days || 1),
    storageUsdPerMonth: { 90: ((90 * dayBytes) / GB) * PRICES.ddbGBMonth, 400: ((400 * dayBytes) / GB) * PRICES.ddbGBMonth },
  };
  console.log(`  a day of ${SESSIONS} sessions: daily rollups ${perDay.rollupKB.toFixed(0)} KB in ${items.length} items, ${perDay.latestSessionsKB.toFixed(0)} KB of it the latest sessions (its hour summaries: ${perDay.hourSummariesKB.toFixed(0)} KB)`);
  console.log(
    `  building a day: ${perDay.build.msPerDay.toFixed(0)} ms, ${perDay.build.rruPerDay.toFixed(0)} RRU, ${perDay.build.wruPerDay.toFixed(0)} WRU = ${usd(perDay.buildUsd)} a day (${usd((perDay.buildUsd * 1000) / SESSIONS)} per 1,000 sessions); keeping 90 days of rollups ${usd(perDay.storageUsdPerMonth[90])} a month, 400 days ${usd(perDay.storageUsdPerMonth[400])}`,
  );
  for (const x of timings) console.log(`  ${String(x.span).padStart(3)} days ${x.name.padEnd(11)} ${x.pass}: ${String(x.ms).padStart(5)} ms (reading ${x.readMs} ms), ${x.rru} RRU in ${x.pages} pages = ${usd(x.rru * PRICES.ddbRru)}, ${x.s3Gets} S3 GETs${x.approximate.length ? `; approximate: ${x.approximate.join(', ')}` : ''}`);
  console.log(`  without daily rollups a 90-day query would read about ${((90 * hourBytes) / 1e6).toFixed(0)} MB of hour summaries (${Math.round((90 * hourBytes) / 8192)} RRU)`);
  const serve = Number(flag('serve', 0));
  if (serve) {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const auth = { resolveIngest: () => ({ projectId: 'dense' }), resolveReader: () => ({ projectId: 'dense', scopes: ['read'], plan: 'studio' }) };
    http.createServer(createApp({ store: sim.store, auth, staticRoutes: [{ prefix: '/', dir: path.join(root, 'apps/dashboard/dist'), spa: true }] })).listen(serve, () => console.log(`  serving ${days} days of ${service} on http://localhost:${serve} (Ctrl-C stops)`));
  } else sim.close();
  return { perDay, timings };
}

const LONG = Number(flag('long', 0));
if (LONG) results.push({ long: await runLong(LONG) });

const out = flag('json', null);
if (out) fs.writeFileSync(out, JSON.stringify({ prices: PRICES, settings: { SESSIONS, MINUTES, BUFFER_S, EVERY_MIN, PARTITIONING, SDK, BATCH_MS, POSITIONS, GZIP }, results }, null, 2));
