// Network quality and disconnects (SPEC §1 netSample, disconnect, reconnect, instrumentNet; §2 frame_window.net;
// design A8): samples summarised per frame window, the disconnect outcome for a level, and a WebRTC connection's own
// statistics read once a second from a stand-in RTCPeerConnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { hidden: false, referrer: '', addEventListener() {}, createElement: () => ({ getContext: () => null }) };
globalThis.location = { origin: 'http://localhost:5184', pathname: '/' };
Object.defineProperty(globalThis, 'navigator', { value: { connection: { type: 'wifi' } }, configurable: true });

const { Glitchless } = await import('../src/core.js');
const { instrumentNet, readStats, NET_ALPHA } = await import('../src/net.js');
const { Sketch } = await import('../src/sketch.js');

function sdk(opts = {}) {
  return new Glitchless({ service: 'net', version: '1.0.0', intake: null, ...opts });
}
const of = (gd, type) => gd.queue.filter((e) => e.type === type);
let clock = 1000;
function frames(gd, n = 30) {
  for (let i = 0; i < n; i++) gd.tick((clock += 16.7));
}
// Samples a second apart without waiting a second each.
function sample(gd, s) {
  gd.net.lastSample -= 1000;
  gd.netSample(s);
}

test('a window while connected carries net: a 5% round-trip sketch, percentiles, means, the library and the link', () => {
  const gd = sdk();
  frames(gd);
  gd.closeWindow();
  for (const [rtt, loss, jitter] of [[38, 0, 4], [41, 1, 6], [36, 0, 5], [74, 0.5, 9], [40, 0, 6]]) sample(gd, { rtt_ms: rtt, loss_pct: loss, jitter_ms: jitter, in_kbps: 90, out_kbps: 30, transport: 'ws' });
  frames(gd);
  gd.closeWindow();
  const [before, during] = of(gd, 'frame_window');
  assert.equal('net' in before, false, 'not connected yet: no net');
  const net = during.net;
  assert.deepEqual(Object.keys(net).sort(), ['host', 'in_kbps', 'jitter_ms', 'link', 'loss_pct', 'out_kbps', 'rtt', 'rtt_max', 'rtt_p50', 'rtt_p95', 'samples', 'transport']);
  assert.equal(net.rtt.a, NET_ALPHA);
  assert.equal(net.rtt.n, 5);
  assert.ok(Math.abs(net.rtt_p50 - 40) <= 2.5, `p50 ${net.rtt_p50}`);
  assert.equal(Sketch.from(net.rtt).quantile(0.95), Sketch.from(net.rtt).quantile(0.95), 'the server can merge it');
  assert.equal(net.rtt_max, 74);
  assert.deepEqual([net.loss_pct, net.jitter_ms, net.in_kbps, net.out_kbps, net.samples], [0.3, 6, 90, 30, 5]);
  assert.deepEqual([net.transport, net.link, net.host], ['ws', 'wifi', false]);
});

test('samples closer than about a second are left out; a connected window without samples still says so', () => {
  const gd = sdk();
  for (let i = 0; i < 10; i++) gd.netSample({ rtt_ms: 50 });
  frames(gd);
  gd.closeWindow();
  frames(gd);
  gd.closeWindow();
  const [a, b] = of(gd, 'frame_window');
  assert.equal(a.net.samples, 1);
  assert.deepEqual([b.net.samples, b.net.rtt, b.net.rtt_p95], [0, null, null], 'connected, nothing measured: seconds connected still count');
});

test('a disconnect carries the reason and the last numbers, and ends a level as an abandon, never a fail', () => {
  const gd = sdk();
  gd.levelStart('rift');
  sample(gd, { rtt_ms: 240, loss_pct: 12 });
  gd.net.since -= 612_000;
  gd.disconnect({ reason: 'timeout' });
  gd.levelFail('rift', { cause: 'defeat' }); // the game's own disconnect handler, after the SDK's
  gd.levelAbandon('rift');
  const [d] = of(gd, 'disconnect');
  assert.deepEqual(Object.keys(d).sort(), ['connected_s', 'level', 'loss_pct', 'reason', 'rtt_p95', 'ts', 'type']);
  assert.deepEqual([d.reason, d.rtt_p95, d.loss_pct, d.level], ['timeout', 240, 12, 'rift']);
  assert.ok(d.connected_s >= 612);
  const outcomes = gd.queue.filter((e) => e.type.startsWith('level_') && e.type !== 'level_start');
  assert.deepEqual(outcomes.map((e) => [e.type, e.reason ?? e.cause]), [['level_abandon', 'disconnect']]);
  gd.disconnect({ reason: 'a reason we never heard of' });
  assert.equal(of(gd, 'disconnect')[1].reason, 'other');
});

test("a disconnect uses the last window's numbers when this one has no samples yet", () => {
  const gd = sdk();
  sample(gd, { rtt_ms: 80, loss_pct: 2 });
  frames(gd);
  gd.closeWindow();
  gd.disconnect({ reason: 'connection_lost' });
  assert.deepEqual([of(gd, 'disconnect')[0].rtt_p95, of(gd, 'disconnect')[0].loss_pct], [80, 2]);
});

test('reconnecting says how long it took and opens the level again, so the player can still finish it', () => {
  const gd = sdk();
  gd.levelStart('arena_7');
  sample(gd, { rtt_ms: 60 });
  gd.disconnect({ reason: 'connection_lost' });
  gd.net.disconnectedAt -= 9000;
  gd.reconnect();
  gd.reconnect(); // already connected: nothing
  assert.deepEqual(of(gd, 'reconnect').map((e) => e.after_s), [9]);
  assert.equal(gd.levelOpen, true);
  gd.levelComplete('arena_7');
  const outcomes = gd.queue.filter((e) => e.type.startsWith('level_') && e.type !== 'level_start');
  assert.deepEqual(outcomes.map((e) => [e.type, e.reason ?? null]), [['level_abandon', 'disconnect'], ['level_complete', null]], 'the server takes the abandon back');
});

test('at most 20 disconnect events a session', () => {
  const gd = sdk();
  for (let i = 0; i < 30; i++) {
    gd.netSample({ rtt_ms: 30 });
    gd.disconnect({ reason: 'timeout' });
  }
  assert.equal(of(gd, 'disconnect').length, 20);
});

test('netSample({ host: true }) marks the player who hosts the game', () => {
  const gd = sdk();
  sample(gd, { rtt_ms: 0, host: true, transport: 'webrtc' });
  frames(gd);
  gd.closeWindow();
  assert.deepEqual([of(gd, 'frame_window')[0].net.host, of(gd, 'frame_window')[0].net.transport], [true, 'webrtc']);
});

// A stand-in RTCPeerConnection: getStats() answers what Chrome does for a data channel and an audio stream.
function peer() {
  const p = {
    connectionState: 'connected',
    t: 0,
    bytesIn: 0,
    bytesOut: 0,
    lost: 0,
    received: 0,
    async getStats() {
      return new Map([
        ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' }],
        ['CP1', { id: 'CP1', type: 'candidate-pair', timestamp: p.t, currentRoundTripTime: 0.042, bytesReceived: p.bytesIn, bytesSent: p.bytesOut, state: 'succeeded' }],
        ['CP2', { id: 'CP2', type: 'candidate-pair', timestamp: p.t, currentRoundTripTime: 0.3 }],
        ['IA', { id: 'IA', type: 'inbound-rtp', packetsLost: p.lost, packetsReceived: p.received, jitter: 0.006 }],
        ['LC', { id: 'LC', type: 'local-candidate', address: '192.168.1.20', port: 50000 }],
      ]);
    },
  };
  return p;
}

test('readStats takes the selected pair\'s round trip and bytes and the RTP loss, never an address', async () => {
  const p = peer();
  p.bytesIn = 1000;
  const s = readStats(await p.getStats());
  assert.deepEqual(s, { ts: 0, rtt_ms: 42, bytes_in: 1000, bytes_out: 0, lost: 0, received: 0, jitter_ms: 6 });
  assert.ok(!JSON.stringify(s).includes('192.168'));
});

test('instrumentNet samples a peer connection once a second; failing is a disconnect, coming back a reconnect, closing stops it', async () => {
  const gd = sdk();
  const p = peer();
  const net = instrumentNet(gd, { peer: p, intervalMs: 10 });
  const wait = () => new Promise((r) => setTimeout(r, 25));
  await wait();
  p.t = 1000;
  p.bytesIn = 12_500;
  p.bytesOut = 5_000;
  p.lost = 2;
  p.received = 98;
  gd.net.lastSample = 0;
  await wait();
  frames(gd);
  gd.closeWindow();
  const w = of(gd, 'frame_window')[0].net;
  assert.equal(w.transport, 'webrtc');
  assert.equal(w.rtt_max, 42);
  assert.equal(w.in_kbps, 100, '12,500 bytes in a second');
  assert.equal(w.out_kbps, 40);
  assert.equal(w.loss_pct, 2, '2 of 100 packets');
  p.connectionState = 'failed';
  await wait();
  await wait();
  assert.deepEqual(of(gd, 'disconnect').map((e) => e.reason), ['connection_lost'], 'once');
  p.connectionState = 'connected';
  await wait();
  assert.equal(of(gd, 'reconnect').length, 1);
  p.connectionState = 'closed';
  await wait();
  const queued = gd.queue.length;
  p.connectionState = 'failed';
  await wait();
  assert.equal(gd.queue.length, queued, 'stopped once closed');
  net.stop();
});
