// Local store: append-only JSONL files per day + an in-memory index per project.
// Zero dependencies, survives restarts, and good for hundreds of thousands of events on a laptop.
//
// Every store (this one, or a host's own: SPEC §7) has the same methods, and every method takes the projectId the
// auth hooks resolved, so one project can never see another's events, maps, services or rollups:
//
//   put(projectId, events)                      stores events (and `map` thumbnails, bug reports) under the project
//   query(projectId, { service, from, to })     raw events, sorted by ts
//   rollups(projectId, { service, from, to })   → { lo, hi, minutes }: rollup cells (see rollups.js) for
//                                               every minute in [lo, hi), the whole minutes of the range
//                                               the store has complete rollups for (lo >= hi: none)
//   getMaps(projectId, service)
//   reports(projectId, service, { from, to })   bug reports, newest first, without screenshots (reports.js)
//   getReport(projectId, service, id)           one with its screenshot
//   deleteReport(projectId, service, id)        deletes one and its screenshot
//   getDashboard(projectId, service)            the game's saved dashboard (board.js), or null
//   putDashboard(projectId, service, dashboard) saves it; null goes back to the automatic dashboard
//   getBrand(projectId, service)                the game's branding (brand.js): accent, banner position, and what each
//                                               image is; or null. putBrand(projectId, service, brand) saves it (null:
//                                               none). Optional: a store without them has no branding (501)
//   getBrandImage(projectId, service, kind)     the logo's or banner's bytes, or null; putBrandImage(…, kind, bytes)
//                                               saves them in an item (here a file) of their own, null deletes them
//   putSourcemap, getSourcemap, sourcemaps, deleteSourcemaps   a web build's source maps (sourcemaps.js)
//   cohorts(projectId, service, from, to)       players first seen on each UTC day starting in [from, to]: day → Set of
//                                               ids (retention, analytics.js), over everything the store holds
//   versionsFirstSeen(projectId, service)       version → the time of its earliest event, over everything the store
//                                               has: the order versions are compared in (analytics.js releaseOrder)
//   services(projectId)
//   clear(projectId, service)
//   claimBatch(projectId, service, id)          true the first time a batch ID comes (SPEC §2 batch_id), false for
//                                               a repeat within BATCH_KEEP_MS; releaseBatch() forgets one whose
//                                               events could not be stored. Optional: without them every batch is kept
//
// Lines written before projects existed have no project_id; they belong to `legacyProject` (the
// open-source server's single project), so existing data keeps working without a migration.
//
// Batch IDs the store took are kept in batches.jsonl, one line each ({p, s, b, at}, or with `del` once released),
// and rewritten without the expired ones at startup.
//
// Bug reports are kept apart from the events: their records in reports.jsonl, each screenshot as an image file in
// reports/ (<id>.jpg), read only when one report is opened. Source maps are files too:
// sourcemaps/<project>/<service>/<version>/<file>.map, each part one path segment (sourcemaps.js keySeg). A game's
// branding is in brands.json, like dashboards in dashboards.json, and each of its images a file in
// brand/<project>/<service>.<kind>.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROJECT, isProjectId } from '../auth.js';
import { rollup, minuteOf, MINUTE } from '../rollups.js';
import { splitReport, decodeScreenshot, encodeScreenshot, MAX_REPORTS } from '../reports.js';
import { keySeg, fromKeySeg } from '../sourcemaps.js';
import { BATCH_KEEP_MS } from '../ingest.js';

const RETENTION_DAYS = 14;

export class FileStore {
  constructor(dir, { legacyProject = DEFAULT_PROJECT } = {}) {
    this.dir = dir;
    this.legacyProject = legacyProject;
    this.projects = new Map();
    this.batches = new Map(); // batchKey() → when it was taken
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
          // Lines older than the cutoff stay on disk, and still say when their version was first seen.
          if (p) noteVersion(p, e);
          if (p && e.ts >= cutoff) p.events.push(e);
        } catch {
          // skip torn writes
        }
      }
    }
    for (const p of this.projects.values()) {
      p.events.sort((a, b) => a.ts - b.ts);
      for (const e of p.events) {
        rollup([e], minutesOf(p, e.service));
        noteFirstSeen(p, e);
      }
    }
    const mapsFile = path.join(this.dir, 'maps.json');
    if (fs.existsSync(mapsFile)) {
      for (const m of JSON.parse(fs.readFileSync(mapsFile, 'utf8'))) this.ownerOf(m)?.maps.set(mapKey(m), m);
    }
    this.loadReports(cutoff);
    this.loadBatches();
    const brandsFile = path.join(this.dir, 'brands.json');
    if (fs.existsSync(brandsFile)) {
      for (const [projectId, brands] of Object.entries(JSON.parse(fs.readFileSync(brandsFile, 'utf8')))) {
        if (isProjectId(projectId)) for (const [service, brand] of Object.entries(brands)) this.project(projectId).brands.set(service, brand);
      }
    }
    const dashboardsFile = path.join(this.dir, 'dashboards.json');
    if (fs.existsSync(dashboardsFile)) {
      for (const [projectId, dashboards] of Object.entries(JSON.parse(fs.readFileSync(dashboardsFile, 'utf8')))) {
        if (isProjectId(projectId)) for (const [service, dashboard] of Object.entries(dashboards)) this.project(projectId).dashboards.set(service, dashboard);
      }
    }
  }

  // Reports younger than `cutoff`; older ones are dropped, with their screenshots.
  loadReports(cutoff) {
    const file = path.join(this.dir, 'reports.jsonl');
    if (!fs.existsSync(file)) return;
    let dropped = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const r = line && parse(line);
      const p = r && this.ownerOf(r);
      if (!p) continue;
      if (r.ts < cutoff) {
        dropped = true;
        if (r.screenshot_file) fs.rmSync(path.join(this.dir, 'reports', r.screenshot_file), { force: true });
        continue;
      }
      p.reports.set(r.id, r);
    }
    if (dropped) this.saveReports();
  }

  loadBatches() {
    const file = path.join(this.dir, 'batches.jsonl');
    if (!fs.existsSync(file)) return;
    const since = Date.now() - BATCH_KEEP_MS;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const b = line && parse(line);
      if (!b || !isProjectId(b.p)) continue;
      const key = batchKey(b.p, b.s, b.b);
      if (b.del || b.at < since) this.batches.delete(key);
      else this.batches.set(key, b.at);
    }
    this.saveBatches();
  }

  saveBatches() {
    const lines = [...this.batches].map(([key, at]) => {
      const [p, s, b] = JSON.parse(key);
      return JSON.stringify({ p, s, b, at });
    });
    fs.writeFileSync(path.join(this.dir, 'batches.jsonl'), lines.length ? lines.join('\n') + '\n' : '');
  }

  async claimBatch(projectId, service, id) {
    this.project(projectId);
    const key = batchKey(projectId, service, id);
    const now = Date.now();
    const at = this.batches.get(key);
    if (at != null && at >= now - BATCH_KEEP_MS) return false;
    this.batches.set(key, now);
    if (this.batches.size % 10_000 === 0) for (const [k, t] of this.batches) if (t < now - BATCH_KEEP_MS) this.batches.delete(k);
    await fs.promises.appendFile(path.join(this.dir, 'batches.jsonl'), JSON.stringify({ p: projectId, s: service, b: id, at: now }) + '\n');
    return true;
  }

  async releaseBatch(projectId, service, id) {
    if (!this.batches.delete(batchKey(projectId, service, id))) return;
    await fs.promises.appendFile(path.join(this.dir, 'batches.jsonl'), JSON.stringify({ p: projectId, s: service, b: id, del: 1 }) + '\n');
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
      if (e.type === 'bug_report') {
        await this.putReport(p, projectId, e);
        continue;
      }
      p.events.push(e);
      added++;
      rollup([e], minutesOf(p, e.service));
      noteFirstSeen(p, e);
      noteVersion(p, e);
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

  async cohorts(projectId, service, from, to) {
    const out = new Map();
    for (const [id, ts] of this.project(projectId).firstSeen.get(service) || []) {
      const day = utcDay(ts);
      if (day >= from && day <= to) (out.get(day) || out.set(day, new Set()).get(day)).add(id);
    }
    return out;
  }

  async versionsFirstSeen(projectId, service) {
    return new Map(this.project(projectId).versions.get(service) || []);
  }

  // A report's record goes to reports.jsonl and its screenshot to reports/<id>.<ext>. One sent again is skipped.
  async putReport(p, projectId, e) {
    const { record, screenshot } = splitReport(projectId, e);
    if (p.reports.has(record.id)) return;
    const shot = decodeScreenshot(screenshot);
    if (shot) {
      record.screenshot_file = `${record.id}.${shot.ext}`;
      record.screenshot_type = shot.type;
      await fs.promises.mkdir(path.join(this.dir, 'reports'), { recursive: true });
      await fs.promises.writeFile(path.join(this.dir, 'reports', record.screenshot_file), shot.bytes);
    } else record.has_screenshot = false;
    p.reports.set(record.id, record);
    await fs.promises.appendFile(path.join(this.dir, 'reports.jsonl'), JSON.stringify(record) + '\n');
  }

  async reports(projectId, service, { from, to }) {
    return [...this.project(projectId).reports.values()]
      .filter((r) => r.service === service && r.ts >= from && r.ts <= to)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_REPORTS);
  }

  async deleteReport(projectId, service, id) {
    const p = this.project(projectId);
    const r = p.reports.get(id);
    if (!r || r.service !== service) return false;
    p.reports.delete(id);
    if (r.screenshot_file) fs.rmSync(path.join(this.dir, 'reports', r.screenshot_file), { force: true });
    this.saveReports();
    return true;
  }

  async getReport(projectId, service, id) {
    const r = this.project(projectId).reports.get(id);
    if (!r || r.service !== service) return null;
    let screenshot = null;
    if (r.screenshot_file) {
      try {
        screenshot = encodeScreenshot(r.screenshot_type, await fs.promises.readFile(path.join(this.dir, 'reports', r.screenshot_file)));
      } catch {
        // deleted by hand: the report without its picture
      }
    }
    return { ...r, screenshot };
  }

  async getDashboard(projectId, service) {
    return this.project(projectId).dashboards.get(service) ?? null;
  }

  sourcemapDir(projectId, service, version = null) {
    this.project(projectId);
    return path.join(this.dir, 'sourcemaps', projectId, keySeg(service), ...(version == null ? [] : [keySeg(version)]));
  }

  async putSourcemap(projectId, service, version, file, text) {
    const dir = this.sourcemapDir(projectId, service, version);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${keySeg(file)}.map`);
    await fs.promises.writeFile(`${target}.tmp`, text);
    await fs.promises.rename(`${target}.tmp`, target);
  }

  async getSourcemap(projectId, service, version, file) {
    try {
      return await fs.promises.readFile(path.join(this.sourcemapDir(projectId, service, version), `${keySeg(file)}.map`), 'utf8');
    } catch {
      return null;
    }
  }

  async sourcemaps(projectId, service) {
    const root = this.sourcemapDir(projectId, service);
    const out = [];
    for (const v of await fs.promises.readdir(root).catch(() => [])) {
      for (const f of await fs.promises.readdir(path.join(root, v)).catch(() => [])) {
        if (!f.endsWith('.map')) continue;
        const st = await fs.promises.stat(path.join(root, v, f)).catch(() => null);
        if (st) out.push({ version: fromKeySeg(v), file: fromKeySeg(f.slice(0, -4)), size: st.size, uploaded_at: Math.round(st.mtimeMs) });
      }
    }
    return out;
  }

  async deleteSourcemaps(projectId, service, version) {
    await fs.promises.rm(this.sourcemapDir(projectId, service, version), { recursive: true, force: true });
  }

  async putDashboard(projectId, service, dashboard) {
    const p = this.project(projectId);
    if (dashboard) p.dashboards.set(service, dashboard);
    else p.dashboards.delete(service);
    const all = Object.fromEntries([...this.projects].filter(([, q]) => q.dashboards.size).map(([id, q]) => [id, Object.fromEntries(q.dashboards)]));
    await fs.promises.writeFile(path.join(this.dir, 'dashboards.json'), JSON.stringify(all));
  }

  async getBrand(projectId, service) {
    return this.project(projectId).brands.get(service) ?? null;
  }

  async putBrand(projectId, service, brand) {
    const p = this.project(projectId);
    if (brand) p.brands.set(service, brand);
    else p.brands.delete(service);
    const all = Object.fromEntries([...this.projects].filter(([, q]) => q.brands.size).map(([id, q]) => [id, Object.fromEntries(q.brands)]));
    await fs.promises.writeFile(path.join(this.dir, 'brands.json'), JSON.stringify(all));
  }

  brandFile(projectId, service, kind) {
    this.project(projectId);
    return path.join(this.dir, 'brand', projectId, `${keySeg(service)}.${kind}`);
  }

  async getBrandImage(projectId, service, kind) {
    return fs.promises.readFile(this.brandFile(projectId, service, kind)).catch(() => null);
  }

  async putBrandImage(projectId, service, kind, bytes) {
    const file = this.brandFile(projectId, service, kind);
    if (!bytes) return fs.promises.rm(file, { force: true });
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, bytes);
    await fs.promises.rename(`${file}.tmp`, file);
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
    p.firstSeen.delete(service);
    p.versions.delete(service);
    for (const [k, m] of p.maps) if (m.service === service) p.maps.delete(k);
    for (const [id, r] of p.reports) {
      if (r.service !== service) continue;
      p.reports.delete(id);
      if (r.screenshot_file) fs.rmSync(path.join(this.dir, 'reports', r.screenshot_file), { force: true });
    }
    this.saveReports();
    fs.rmSync(this.sourcemapDir(projectId, service), { recursive: true, force: true });
    const mine = (e) => this.ownerOf(e) === p && e.service === service;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^events-.*\.jsonl$/.test(f)) continue;
      const file = path.join(this.dir, f);
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !mine(parse(l)));
      fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
    }
    await this.saveMaps();
  }

  saveReports() {
    const lines = [...this.projects.values()].flatMap((p) => [...p.reports.values()].map((r) => JSON.stringify(r)));
    fs.writeFileSync(path.join(this.dir, 'reports.jsonl'), lines.length ? lines.join('\n') + '\n' : '');
  }

  async saveMaps() {
    const all = [...this.projects.values()].flatMap((p) => [...p.maps.values()]);
    await fs.promises.writeFile(path.join(this.dir, 'maps.json'), JSON.stringify(all));
  }

  project(projectId) {
    if (!isProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
    let p = this.projects.get(projectId);
    // firstSeen: service → Map(player id → the first time this store saw them), for cohorts(); versions: service →
    // Map(version → the time of its earliest event), for versionsFirstSeen().
    if (!p) this.projects.set(projectId, (p = { events: [], maps: new Map(), reports: new Map(), rollups: new Map(), dashboards: new Map(), brands: new Map(), firstSeen: new Map(), versions: new Map() }));
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

// Players with an ID of their own (install or full mode; ingest files an anonymous session under its session ID).
function noteFirstSeen(p, e) {
  if (e.player_id == null || e.player_id === e.session_id) return;
  let seen = p.firstSeen.get(e.service);
  if (!seen) p.firstSeen.set(e.service, (seen = new Map()));
  const was = seen.get(e.player_id);
  if (was === undefined || e.ts < was) seen.set(e.player_id, e.ts);
}

function noteVersion(p, e) {
  if (e.version == null) return;
  let seen = p.versions.get(e.service);
  if (!seen) p.versions.set(e.service, (seen = new Map()));
  if (!(seen.get(e.version) <= e.ts)) seen.set(e.version, e.ts);
}

function utcDay(ts) {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function batchKey(projectId, service, id) {
  return JSON.stringify([projectId, service, id]);
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
