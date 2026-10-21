// Deterministic, varied play sessions for store and rollup tests: several versions, envs, levels,
// devices and frame budgets, frame windows every 5 s with sketches and renderer stats, plus hitches,
// errors, deaths, positions and custom events, with awkward fractional values in the summed fields.
import { Sketch } from '../../../packages/sdk/src/sketch.js';

export function gameSessions({ service = 'zoomies', start, spanMs = 3 * 3_600_000, sessions = 30, seed = 7, prefix = 's' }) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let n = 0; n < sessions; n++) {
    const base = {
      service,
      env: pick(['prod', 'prod', 'dev']),
      version: pick(['1.0.0', '1.0.1', '1.1.0']),
      session_id: `${prefix}_${n}`,
      player_id: `p_${Math.floor(rnd() * 12)}`,
      sdk: pick(['glitchless-browser/0.1.0', 'glitchless-godot/0.1.0']),
    };
    const budget = pick([16.67, 16.67, 8.33, 6.94]);
    let ts = start + Math.floor(rnd() * spanMs);
    const events = [];
    const push = (e) => events.push({ level: null, ...e, ...base, ts: (ts += Math.floor(rnd() * 4000) + 1) });
    push({ type: 'session_start', session_type: pick(['user', 'user', 'synthetic']), device: { gpu_tier: pick(['high', 'mid', 'low']), browser: pick(['Chrome', 'Safari']), gpu: pick(['M3', 'RTX 4070', 'UHD 620']) } });
    push({ type: 'load', ttff_ms: 400 + Math.floor(rnd() * 900) });
    let geometries = 40 + Math.floor(rnd() * 20);
    for (const level of ['level-1', 'level-2', 'level-3'].slice(0, 1 + Math.floor(rnd() * 3))) {
      push({ type: 'level_start', level });
      const windows = 3 + Math.floor(rnd() * 30);
      for (let w = 0; w < windows; w++) {
        const sk = new Sketch();
        const frames = 120 + Math.floor(rnd() * 200);
        let hitches = 0;
        for (let f = 0; f < frames; f++) {
          const v = rnd() < 0.03 ? 40 + rnd() * 200 : budget * (0.6 + rnd() * 0.8);
          if (v > 50) hitches++;
          sk.add(v);
        }
        geometries += Math.floor(rnd() * 6);
        push({
          type: 'frame_window',
          level,
          duration_s: Math.round((4.5 + rnd()) * 100) / 100,
          frames,
          budget_ms: budget,
          ft: sk.toJSON(),
          hitches,
          frozen: rnd() < 0.01 ? 1 : 0,
          render_ms: Math.round(rnd() * 900) / (rnd() < 0.5 ? 100 : 1000),
          draw_calls: 20 + Math.floor(rnd() * 400),
          draw_calls_max: 400 + Math.floor(rnd() * 300),
          triangles: 10_000 + Math.floor(rnd() * 90_000),
          geometries,
          heap_mb: rnd() < 0.2 ? null : Math.round((40 + rnd() * 200) * 10) / 10,
          ctx: { particles: Math.floor(rnd() * 500), entities: Math.floor(rnd() * 40) },
        });
        if (hitches) push({ type: 'hitch', level, duration_ms: 60 + Math.floor(rnd() * 300), causes: [pick(['script', 'gc', 'shader_compile'])], ctx: { particles: Math.floor(rnd() * 900) }, recent: [pick(['bone_collected', 'enemy_spawn'])] });
        if (rnd() < 0.3) push({ type: 'pos', level, pts: [[ts, rnd() * 50, 0, rnd() * 50]] });
        if (rnd() < 0.4) push({ type: 'custom', level, name: pick(['bone_collected', 'enemy_spawn']) });
        if (rnd() < 0.05) push({ type: 'error', level, kind: pick(['js', 'manual']), message: 'TypeError: boom', fingerprint: pick(['f1', 'f2']) });
        if (rnd() < 0.06) push({ type: 'death', level, x: rnd() * 50, y: 0, z: rnd() * 50, cause: pick(['fell', 'squirrel']) });
      }
      push({ type: rnd() < 0.7 ? 'level_complete' : 'level_fail', level });
    }
    if (rnd() < 0.8) push({ type: 'session_end', reason: 'pagehide' });
    out.push(events);
  }
  return out;
}

// Cut sessions into SDK-sized batches and interleave them, as many clients sending at once would.
export function shuffledBatches(sessions, seed = 11) {
  const rnd = mulberry32(seed);
  const batches = [];
  for (const events of sessions) for (let i = 0; i < events.length; i += 6) batches.push(events.slice(i, i + 6));
  for (let i = batches.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [batches[i], batches[j]] = [batches[j], batches[i]];
  }
  return batches;
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
