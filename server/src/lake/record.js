// Firehose records: one per beacon batch, not per event. A record is one JSON line holding the envelope
// once and the events without it:
//
//   {"p":"<project>","plan":"free","o":[<arrival ms>,<seq>,<writer>],"env":{service, env, version, session_id,
//    player_id, sdk, received},"events":[{type, ts, level, …}, …]}\n
//
// `p` is what Firehose partitions on (its JQ query is `{project: .p}`). `o` orders records that arrive in
// the same millisecond and, with an event's position in its record, names every event uniquely (`writer`
// is random per server process), so the compactor can tell an event it has already seen. The compactor
// puts the envelope back on every event (fromRecord), so events come out as the intake normalized them.

import crypto from 'node:crypto';

export const ENVELOPE = ['service', 'env', 'version', 'session_id', 'player_id', 'sdk', 'received'];
// Firehose takes records up to 1,000 KiB; keep a margin for the envelope and escaping.
export const MAX_RECORD_BYTES = 900_000;

let seq = 0;
const writer = crypto.randomBytes(4).readUInt32BE(0);

// Events of one put() → record lines. Events normally share one envelope (one intake payload); if not,
// each envelope gets its own record.
export function toRecords(projectId, plan, events, now = Date.now()) {
  const groups = new Map();
  for (const e of events) {
    const env = {};
    for (const k of ENVELOPE) if (k in e) env[k] = e[k];
    const key = JSON.stringify(ENVELOPE.map((k) => (k in e ? e[k] : '\u0000')));
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { env, events: [] }));
    const rest = {};
    for (const [k, v] of Object.entries(e)) if (k !== 'project_id' && !Object.hasOwn(env, k)) rest[k] = v;
    g.events.push(rest);
  }
  const lines = [];
  for (const { env, events: list } of groups.values()) {
    const encode = (part) => JSON.stringify({ p: projectId, plan, o: [now, seq++, writer], env, events: part }) + '\n';
    const split = (part) => {
      const line = encode(part);
      if (Buffer.byteLength(line) <= MAX_RECORD_BYTES || part.length <= 1) return lines.push(line);
      const mid = Math.ceil(part.length / 2);
      split(part.slice(0, mid));
      split(part.slice(mid));
    };
    split(list);
  }
  return lines;
}

// One record (parsed) → events with their envelope and project, plus its arrival order.
export function fromRecord(r) {
  const events = (r.events || []).map((ev) => ({ ...ev, ...r.env, project_id: r.p }));
  return { project: r.p, plan: r.plan, order: r.o || [0, 0], events };
}
