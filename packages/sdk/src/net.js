// Network quality (SPEC §1 netSample, §2 frame_window.net): the round trip, loss, jitter and throughput of a multiplayer
// game's connection, summarised per frame window like frame times. A WebSocket has no round trip of its own, so a game
// on ws, Socket.IO or Colyseus passes the ping it measures to glitchless.netSample(); instrumentNet() reads a WebRTC
// peer connection's own statistics once a second. Nothing about the other end is read or sent: no addresses, no
// candidates, no host names.
import { Sketch } from './sketch.js';

export const NET_ALPHA = 0.05; // the round-trip sketch's relative accuracy
export const DISCONNECT_REASONS = new Set(['timeout', 'connection_lost', 'kicked', 'server_closed', 'failed_to_connect', 'other']);

// One window's samples.
export class NetWindow {
  constructor() {
    this.rtt = new Sketch(NET_ALPHA);
    this.samples = 0;
    this.sums = { jitter_ms: [0, 0], loss_pct: [0, 0], in_kbps: [0, 0], out_kbps: [0, 0] };
  }

  add(sample) {
    this.samples++;
    if (num(sample.rtt_ms) != null) this.rtt.add(num(sample.rtt_ms));
    for (const [k, acc] of Object.entries(this.sums)) {
      const v = num(sample[k]);
      if (v == null) continue;
      acc[0] += v;
      acc[1]++;
    }
  }

  // The numbers a window (or a disconnect) carries.
  summary() {
    const r = this.rtt;
    const mean = ([sum, n], d) => (n ? round(sum / n, d) : null);
    return {
      rtt: r.n ? r.toJSON() : null,
      rtt_p50: r.n ? round(r.quantile(0.5), 1) : null,
      rtt_p95: r.n ? round(r.quantile(0.95), 1) : null,
      rtt_max: r.n ? round(r.max, 1) : null,
      jitter_ms: mean(this.sums.jitter_ms, 1),
      loss_pct: mean(this.sums.loss_pct, 2),
      in_kbps: mean(this.sums.in_kbps, 1),
      out_kbps: mean(this.sums.out_kbps, 1),
      samples: this.samples,
    };
  }
}

// The kind of connection where the browser says (Chrome on Android): wifi, cellular, wired, or null. Never more.
export function readLink() {
  const type = typeof navigator !== 'undefined' ? navigator.connection?.type : undefined;
  return type === 'wifi' ? 'wifi' : type === 'cellular' ? 'cellular' : type === 'ethernet' ? 'wired' : null;
}

// Reads an RTCPeerConnection's getStats() once a second into glitchless.netSample(): the selected candidate pair's
// round trip and bytes, and the inbound RTP streams' loss and jitter (a game on data channels only has no RTP, so its
// loss stays null). The connection failing is a disconnect (connection_lost), and coming back from that a reconnect.
// Returns { stop() }; closing the connection stops it too.
export function instrumentNet(glitchless, { peer, host, intervalMs = 1000 } = {}) {
  if (!peer?.getStats) {
    glitchless?.log?.('instrumentNet: no RTCPeerConnection given');
    return { stop() {} };
  }
  let prev = null;
  let failed = false;
  let busy = false;
  const poll = async () => {
    if (busy) return;
    const state = peer.connectionState;
    if (state === 'closed') return handle.stop();
    if (state === 'failed') {
      if (!failed) glitchless.disconnect({ reason: 'connection_lost' });
      failed = true;
      return;
    }
    if (state !== 'connected') return;
    if (failed) {
      failed = false;
      glitchless.reconnect();
    }
    busy = true;
    try {
      const now = readStats(await peer.getStats());
      glitchless.netSample({ ...rates(prev, now), rtt_ms: now.rtt_ms, jitter_ms: now.jitter_ms, transport: 'webrtc', host });
      prev = now;
    } catch (err) {
      glitchless.log?.('instrumentNet: getStats failed', err?.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(poll, intervalMs);
  const handle = {
    stop() {
      clearInterval(timer);
    },
  };
  return handle;
}

// What one getStats() report says, as totals: rates come from two reports in a row.
export function readStats(report) {
  const stats = [];
  report.forEach((s) => stats.push(s));
  const byId = new Map(stats.map((s) => [s.id, s]));
  const transport = stats.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const pair =
    (transport && byId.get(transport.selectedCandidatePairId)) ||
    stats.find((s) => s.type === 'candidate-pair' && s.selected) ||
    stats.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
  const rtp = stats.filter((s) => s.type === 'inbound-rtp');
  const jitters = rtp.map((s) => num(s.jitter)).filter((v) => v != null);
  return {
    ts: num(pair?.timestamp) ?? Date.now(),
    rtt_ms: num(pair?.currentRoundTripTime) != null ? pair.currentRoundTripTime * 1000 : null,
    bytes_in: num(pair?.bytesReceived),
    bytes_out: num(pair?.bytesSent),
    lost: rtp.length ? rtp.reduce((n, s) => n + (num(s.packetsLost) ?? 0), 0) : null,
    received: rtp.length ? rtp.reduce((n, s) => n + (num(s.packetsReceived) ?? 0), 0) : null,
    jitter_ms: jitters.length ? (Math.max(...jitters) * 1000) : null,
  };
}

function rates(prev, now) {
  if (!prev) return {};
  const seconds = (now.ts - prev.ts) / 1000;
  const out = {};
  if (seconds > 0 && now.bytes_in != null && prev.bytes_in != null) out.in_kbps = ((now.bytes_in - prev.bytes_in) * 8) / 1000 / seconds;
  if (seconds > 0 && now.bytes_out != null && prev.bytes_out != null) out.out_kbps = ((now.bytes_out - prev.bytes_out) * 8) / 1000 / seconds;
  if (now.lost != null && prev.lost != null) {
    const lost = Math.max(0, now.lost - prev.lost);
    const total = lost + Math.max(0, now.received - prev.received);
    out.loss_pct = total ? (lost / total) * 100 : 0;
  }
  return out;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function round(v, d) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
