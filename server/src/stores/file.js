// Local store: append-only JSONL files per day + an in-memory index per project.
// Zero dependencies, survives restarts, and good for hundreds of thousands of events on a laptop.
//
// Every store (this one and DynamoStore) has the same methods, and every method takes the projectId the
// auth hooks resolved, so one project can never see another's events, maps, services or rollups:
//
//   put(projectId, events)                      stores events (and `map` thumbnails) under the project
//   query(projectId, { service, from, to })     raw events, sorted by ts
//   rollups(projectId, { service, from, to })   → { lo, hi, minutes }: rollup cells (see rollups.js) for
//                                               every minute in [lo, hi), the whole minutes of the range
//                                               the store has complete rollups for (lo >= hi: none)
//   getMaps(projectId, service)
//   services(projectId)
//   clear(projectId, service)
//
// Lines written before projects existed have no project_id; they belong to `legacyProject` (the
// open-source server's single project), so existing data keeps working without a migration.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROJECT, isProjectId } from '../auth.js';
import { rollup, minuteOf, MINUTE } from '../rollups.js';

const RETENTION_DAYS = 14;

export class FileStore {
  constructor(dir, { legacyProject = DEFAULT_PROJECT } = {}) {
    this.dir = dir;
    this.legacyProject = legacyProject;
    this.projects = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  get kind() {
    return 'file';
  }

  // Every project's events (for the startup log).
  get events() {
    return [...this.projects.values()].flatMap((p) => p.events);
  }

  load() {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          const p = this.ownerOf(e);
          if (p && e.ts >= cutoff) p.events.push(e);
        } catch {
          // skip torn writes
        }
      }
    }
    for (const p of this.projects.values()) {
      p.events.sort((a, b) => a.ts - b.ts);
      for (const e of p.events) rollup([e], minutesOf(p, e.service));
    }
    const mapsFile = path.join(this.dir, 'maps.json');
    if (fs.existsSync(mapsFile)) {
      for (const m of JSON.parse(fs.readFileSync(mapsFile, 'utf8'))) this.ownerOf(m)?.maps.set(mapKey(m), m);
    }
  }

  async put(projectId, events) {
    const p = this.project(projectId);
    const byDay = new Map();
    let added = 0;
    let maps = false;
    for (const raw of events) {
      const e = { ...raw, project_id: projectId };
      if (e.type === 'map') {
        p.maps.set(mapKey(e), e);
        maps = true;
        continue;
      }
      p.events.push(e);
      added++;
      rollup([e], minutesOf(p, e.service));
      const day = new Date(e.ts).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(e));
    }
    // Most batches arrive in order; keep the array sorted cheaply.
    const n = p.events.length;
    for (let i = Math.max(1, n - added); i < n; i++) {
      if (p.events[i - 1].ts <= p.events[i].ts) continue;
      p.events.sort((a, b) => a.ts - b.ts);
      break;
    }
    for (const [day, lines] of byDay) {
      await fs.promises.appendFile(path.join(this.dir, `events-${day}.jsonl`), lines.join('\n') + '\n');
    }
    if (maps) await this.saveMaps();
  }

  async query(projectId, { service, from, to }) {
    const events = this.project(projectId).events;
    const lo = lowerBound(events, from);
    const out = [];
    for (let i = lo; i < events.length; i++) {
      const e = events[i];
      if (e.ts > to) break;
      if (!service || e.service === service) out.push(e);
    }
    return out;
  }

  // Rollups are rebuilt from the event files at startup and kept up to date by put(), so they always
  // cover everything this store holds.
  async rollups(projectId, { service, from, to }) {
    const lo = Math.ceil(from / MINUTE) * MINUTE;
    const hi = minuteOf(to + 1);
    const all = this.project(projectId).rollups.get(service);
    const minutes = new Map();
    if (all) for (let m = lo; m < hi; m += MINUTE) if (all.has(m)) minutes.set(m, all.get(m));
    return { lo, hi, minutes };
  }

  async getMaps(projectId, service) {
    return [...this.project(projectId).maps.values()].filter((m) => m.service === service);
  }

  async services(projectId) {
    const by = new Map();
    for (const e of this.project(projectId).events) {
      let s = by.get(e.service);
      if (!s) by.set(e.service, (s = { service: e.service, versions: new Set(), envs: new Set(), last_seen: 0, events: 0 }));
      s.versions.add(e.version);
      s.envs.add(e.env);
      s.events++;
      if (e.ts > s.last_seen) s.last_seen = e.ts;
    }
    return [...by.values()].map((s) => ({ ...s, versions: [...s.versions].sort(semverCompare), envs: [...s.envs] }));
  }

  async clear(projectId, service) {
    const p = this.project(projectId);
    p.events = p.events.filter((e) => e.service !== service);
    p.rollups.delete(service);
    for (const [k, m] of p.maps) if (m.service === service) p.maps.delete(k);
    const mine = (e) => this.ownerOf(e) === p && e.service === service;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^events-.*\.jsonl$/.test(f)) continue;
      const file = path.join(this.dir, f);
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !mine(parse(l)));
      fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
    }
    await this.saveMaps();
  }

  async saveMaps() {
    const all = [...this.projects.values()].flatMap((p) => [...p.maps.values()]);
    await fs.promises.writeFile(path.join(this.dir, 'maps.json'), JSON.stringify(all));
  }

  project(projectId) {
    if (!isProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
    let p = this.projects.get(projectId);
    if (!p) this.projects.set(projectId, (p = { events: [], maps: new Map(), rollups: new Map() }));
    return p;
  }

  // The project a stored line belongs to, or null for legacy lines when there is no legacy project.
  ownerOf(e) {
    const id = e?.project_id ?? this.legacyProject;
    return isProjectId(id) ? this.project(id) : null;
  }
}

function minutesOf(p, service) {
  let minutes = p.rollups.get(service);
  if (!minutes) p.rollups.set(service, (minutes = new Map()));
  return minutes;
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function mapKey(m) {
  return `${m.service}|${m.level}|${m.version}`;
}

function lowerBound(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function semverCompare(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (isNaN(x) ? x : Number(x)));
  const pb = String(b).split(/[.-]/).map((x) => (isNaN(x) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
