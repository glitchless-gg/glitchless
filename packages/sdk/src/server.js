// The Node server SDK (`glitchless/server`, SPEC §1): a JavaScript game server (ws, Socket.IO, Colyseus, geckos.io)
// reports its own side of a multiplayer game. Every 5 s a server_window says how long its ticks took against the
// target rate, how many players were connected and the round trips it saw; errors, crashes, maps, matches and the
// game's own events go as from a player's session. Batches carry role: "server", and intake files them under the
// game's companion service, "<service>.server", so no player number ever takes in a server (SPEC §2).
//
// About players it sends how many there are and their round trips, nothing else: no IDs, names, chat or addresses.
// About the machine, its OS, cores, memory and the region the game names, never its address or host name. And it
// sends nothing at all to a Glitchless server whose /v1/health doesn't list "server_mode", so its sessions can never
// land among players' on an older one. No dependencies: instrumentWs, instrumentSocketIO and glitchlessRoom only call
// what the game's own server objects have.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Sketch } from './sketch.js';
import { Counter } from './counts.js';
import { gameAttrs } from './props.js';
import { GROUP_KINDS, validGroupId, hashGroupId, newRunId } from './groups.js';
import { NET_ALPHA } from './net.js';
import { fingerprint } from './fingerprint.js';
import { SDK_VERSION, scrubUrls, topFrame } from './core.js';

const SDK = `glitchless-node/${SDK_VERSION}`;
const MAX_QUEUE = 2000;
const MAX_RETRY_EVENTS = MAX_QUEUE / 2;
const MAX_BATCH_EVENTS = 400; // intake takes 500 a batch
const MAX_ERRORS_PER_FINGERPRINT = 25;
const SESSION_MAX_MS = 6 * 3600_000; // a server session is cut every 6 hours
const PENDING_MAX_AGE_MS = 6 * 86_400_000; // batches saved at a crash, sent on the next start

const DEFAULTS = {
  service: 'unknown-game', // the game's own service: intake files this server under "<service>.server"
  version: '0.0.0',
  env: 'dev',
  intake: null,
  clientToken: 'gl_pub_dev',
  tickHz: null, // the target tick rate: a tick over 1000 / tickHz ms is late
  maxPlayers: null,
  region: null, // in the game's own words ('eu-west')
  build: 'dedicated', // or 'headless'
  sessionType: 'user', // 'synthetic' for a load test
  sessionPerMatch: false, // one session per match, for a server that hosts one at a time
  hashGroupIds: true, // match and party IDs are hashed as the player SDKs hash them (groups.js)
  windowMs: 5000,
  flushIntervalMs: 15000,
  timers: true, // false: the game (or a test) calls closeWindow() and flush() itself
  crashes: true, // report uncaught errors and send what's queued when the process dies
  crashDir: path.join(os.tmpdir(), 'glitchless'), // where batches wait when they couldn't go as the process died
  debug: false,
};

let instance = null;

export class GlitchlessServer {
  static init(options = {}) {
    if (!instance) instance = new GlitchlessServer(options);
    return instance;
  }

  static get instance() {
    return instance;
  }

  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.opts.intake = this.opts.intake ? String(this.opts.intake).replace(/\/$/, '') : null;
    this.sdk = SDK;
    this.queue = [];
    this.sealed = []; // { session, events } of sessions ended since the last send
    this.retries = [];
    this.features = null; // what the Glitchless server reads, once /v1/health has answered
    this.disabled = false; // a server without server_mode: nothing is sent
    this.warned = new Set();
    this.errorCounts = new Map();
    this.stats = { sent: 0, failed: 0, lastStatus: 'idle' };
    this.level = null;
    this.groups = {};
    this.ctx = {};
    this.players = 0;
    this.netObjects = null;
    this.traffic = { in_kbps: null, out_kbps: null };
    this.counters = new Map([['', new Counter()]]); // '' is the session's; a match handle has its own
    this.cpu = process.cpuUsage();
    this.cpuAt = performance.now();
    this.lastFlushAt = 0;
    this.newSession();
    if (this.opts.crashes) this.installCrashHooks();
    if (this.opts.timers) {
      this.windowTimer = setInterval(() => this.onWindow(), this.opts.windowMs);
      this.windowTimer.unref?.(); // never keeps the process alive
    }
    if (this.opts.intake) this.checkFeatures().then(() => this.sendPending());
  }

  // ───────────────────────────── the game's calls ─────────────────────────────

  // One tick of the game's simulation took `ms`. measureTick() wraps a tick function to time it.
  tick(ms) {
    if (!(ms >= 0)) return;
    const w = this.win;
    w.ticks++;
    w.tick.add(ms);
    if (ms > w.max) w.max = ms;
    if (this.opts.tickHz > 0 && ms > 1000 / this.opts.tickHz) w.late++;
  }

  // Wraps the game's tick (setInterval(server.measureTick(update), 1000 / 30)); a tick that returns a promise is timed
  // until it settles.
  measureTick(fn) {
    const server = this;
    return function measured(...args) {
      const t0 = performance.now();
      let out;
      try {
        out = fn.apply(this, args);
        return out;
      } finally {
        if (out && typeof out.then === 'function') {
          const done = () => server.tick(performance.now() - t0);
          out.then(done, done);
        } else server.tick(performance.now() - t0);
      }
    };
  }

  setPlayers(n) {
    const players = Math.max(0, Math.round(Number(n) || 0));
    this.players = players;
    if (players > this.win.playersMax) this.win.playersMax = players;
  }

  // A connected player's round trip as the server sees it (a WebSocket ping, a heartbeat): rtt_p95 in each window.
  playerPing(ms) {
    if (ms >= 0) this.win.rtt.add(ms);
  }

  // Numeric gauges, highest per window. net_objects, in_kbps and out_kbps have fields of their own in server_window.
  setContext(values = {}) {
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (k === 'net_objects') this.netObjects = v;
      else if (k === 'in_kbps' || k === 'out_kbps') this.traffic[k] = v;
      else {
        this.ctx[k] = v;
        this.win.ctx[k] = Math.max(this.win.ctx[k] ?? -Infinity, v);
      }
    }
  }

  track(name, attrs = {}) {
    this.push({ type: 'custom', name, attrs });
  }

  count(name, attrs = {}, n = 1) {
    this.counters.get('').add(name, attrs, n);
  }

  // The map the server runs. Like a player's level, it closes the window so ticks keep their map.
  levelStart(levelId, attrs) {
    this.closeWindowIfAny();
    this.level = String(levelId);
    this.levelStartedAt = Date.now();
    const a = gameAttrs(attrs);
    this.push({ type: 'level_start', ...(a ? { attrs: a } : {}) });
  }

  levelComplete(levelId, { durationS, score } = {}) {
    this.push({ type: 'level_complete', level: String(levelId ?? this.level), duration_s: round(durationS ?? (Date.now() - this.levelStartedAt) / 1000, 2), score: score ?? null });
  }

  levelFail(levelId, { cause } = {}) {
    this.push({ type: 'level_fail', level: String(levelId ?? this.level), cause: cause ?? null });
  }

  levelAbandon(levelId) {
    this.push({ type: 'level_abandon', level: String(levelId ?? this.level), duration_s: round((Date.now() - this.levelStartedAt) / 1000, 2) });
  }

  error(err, attrs = {}) {
    this.reportError({ kind: 'manual', error: err, attrs });
  }

  // The match, party or run the server's next events belong to, for a server that hosts one match at a time (a
  // server hosting several at once uses match()). IDs are the ones the game's server made and hands its players, hashed
  // as every player SDK hashes them, so the server's side and its players' sides join up. With sessionPerMatch, each
  // match is a session of its own. Returns the ID sent, or null.
  setGroup(kind, id, attrs) {
    if (!GROUP_KINDS.includes(kind)) return this.warnOnce(`group:${kind}`, `setGroup: "${kind}" isn't a group: use match, party or run`), null;
    if (id === null) {
      if (!this.groups[kind]) return null;
      this.closeWindowIfAny();
      delete this.groups[kind];
      this.push({ type: 'group', kind, id: null });
      if (kind === 'match' && this.opts.sessionPerMatch) this.rotate('match_end');
      return null;
    }
    const sent = id === undefined && kind === 'run' ? newRunId(randomId) : this.groupId(kind, id);
    if (!sent) return null;
    if (kind === 'match' && this.opts.sessionPerMatch && this.hadMatch) this.rotate('match_end');
    this.closeWindowIfAny();
    this.groups[kind] = sent;
    if (kind === 'match') this.hadMatch = true;
    const a = gameAttrs(attrs);
    this.push({ type: 'group', kind, id: sent, ...(a ? { attrs: a } : {}) });
    return sent;
  }

  // A match among several the process hosts at once (a Colyseus room, a Socket.IO room): a handle whose events carry
  // the match, with its own map and counters. end() closes it; its group event names the match it ends, since others
  // are still open. Ticks and players stay the process's own.
  match(id, attrs) {
    const sent = this.groupId('match', id);
    if (!sent) return NO_MATCH;
    const server = this;
    const stamp = { match: sent };
    const counter = new Counter();
    this.counters.set(sent, counter);
    let level = null;
    let startedAt = Date.now();
    let ended = false;
    const a = gameAttrs(attrs);
    this.push({ type: 'group', kind: 'match', id: sent, ...(a ? { attrs: a } : {}) }, stamp);
    const push = (event) => !ended && server.push({ level, ...event }, stamp);
    return {
      id: sent,
      track: (name, attrs = {}) => push({ type: 'custom', name, attrs }),
      count: (name, attrs = {}, n = 1) => !ended && counter.add(name, attrs, n),
      levelStart(levelId, attrs) {
        level = String(levelId);
        startedAt = Date.now();
        const la = gameAttrs(attrs);
        push({ type: 'level_start', ...(la ? { attrs: la } : {}) });
      },
      levelComplete: (levelId, { durationS, score } = {}) => push({ type: 'level_complete', level: String(levelId ?? level), duration_s: round(durationS ?? (Date.now() - startedAt) / 1000, 2), score: score ?? null }),
      levelFail: (levelId, { cause } = {}) => push({ type: 'level_fail', level: String(levelId ?? level), cause: cause ?? null }),
      error: (err, attrs = {}) => !ended && server.reportError({ kind: 'manual', error: err, attrs, stamp: { level, ...stamp } }),
      end() {
        if (ended) return;
        push({ type: 'group', kind: 'match', id: null, ended: sent });
        ended = true;
        counter.closed = true; // drained at the next window, then let go
      },
    };
  }

  // Sends what's queued, then ends the session. Call it on a graceful shutdown (the game's SIGTERM handler).
  async close(reason = 'shutdown') {
    clearInterval(this.windowTimer);
    this.removeCrashHooks();
    if (!this.ended) this.end(reason);
    await this.flush();
  }

  // ───────────────────────────── windows and sessions ─────────────────────────────

  newWindow() {
    return { startedAt: Date.now(), ticks: 0, tick: new Sketch(), max: 0, late: 0, playersMax: this.players ?? 0, rtt: new Sketch(NET_ALPHA), ctx: {} };
  }

  newSession() {
    this.sessionId = 's_' + randomId(16);
    this.startedAt = Date.now();
    this.ended = false;
    this.hadMatch = false;
    this.win = this.newWindow();
    this.queue.push(this.sessionStartEvent());
  }

  sessionStartEvent() {
    const o = this.opts;
    return {
      type: 'session_start',
      ts: this.startedAt,
      level: null,
      session_type: o.sessionType === 'synthetic' ? 'synthetic' : 'user',
      privacy: 'anonymous', // a server has no player
      engine: { name: 'node', version: process.versions.node },
      server: {
        tick_hz: o.tickHz ?? null,
        max_players: o.maxPlayers ?? null,
        build: o.build === 'headless' ? 'headless' : 'dedicated',
        region: o.region == null ? null : String(o.region).slice(0, 64),
        host: { os: osName(), cores: os.availableParallelism?.() ?? os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30) },
      },
    };
  }

  // Every windowMs: the window's numbers, a new session every 6 hours, and a send every flushIntervalMs.
  onWindow() {
    this.closeWindow();
    if (Date.now() - this.startedAt >= SESSION_MAX_MS) this.rotate('max_duration');
    if (Date.now() - this.lastFlushAt >= this.opts.flushIntervalMs - 250) this.flush();
  }

  closeWindowIfAny() {
    if (this.win.ticks || [...this.counters.values()].some((c) => c.size || c.dropped)) this.closeWindow();
  }

  closeWindow() {
    const w = this.win;
    this.win = this.newWindow();
    const now = Date.now();
    const seconds = Math.max(0.001, (now - w.startedAt) / 1000);
    const cpu = process.cpuUsage(this.cpu);
    const cpuNow = performance.now();
    const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, cpuNow - this.cpuAt)) * 100;
    this.cpu = process.cpuUsage();
    this.cpuAt = cpuNow;
    const t = w.tick;
    this.push({
      type: 'server_window',
      ts: w.startedAt,
      duration_s: round(seconds, 2),
      ticks: w.ticks,
      tick_hz: round(w.ticks / seconds, 1),
      tick: t.toJSON(),
      tick_p50: t.n ? round(t.quantile(0.5), 2) : null,
      tick_p95: t.n ? round(t.quantile(0.95), 2) : null,
      tick_max: t.n ? round(w.max, 2) : null,
      late: this.opts.tickHz > 0 ? w.late : null,
      players: this.players,
      players_max: Math.max(w.playersMax, this.players),
      net_objects: this.netObjects,
      in_kbps: this.traffic.in_kbps,
      out_kbps: this.traffic.out_kbps,
      cpu_pct: round(cpuPct, 1),
      mem_mb: round(process.memoryUsage.rss() / 1048576, 1),
      rtt_p95: w.rtt.n ? round(w.rtt.quantile(0.95), 1) : null,
      ctx: w.ctx,
    });
    for (const [match, counter] of this.counters) {
      const counted = counter.drain();
      if (counted) this.push({ type: 'counts', ts: w.startedAt, duration_s: round(seconds, 2), dropped: counted.dropped, counts: counted.counts }, match ? { match } : {});
      if (counter.closed) this.counters.delete(match);
    }
  }

  // Ends this session (session_end) without sending. A crash keeps its last window, the players it had; a match's end
  // right after the window closed for it adds no empty one.
  end(reason) {
    if (reason === 'match_end' && Date.now() - this.win.startedAt < 1000) this.closeWindowIfAny();
    else this.closeWindow();
    this.push({ type: 'session_end', reason, duration_s: round((Date.now() - this.startedAt) / 1000, 1) });
    this.ended = true;
  }

  // A new session in the same process: every 6 hours, or per match with sessionPerMatch. Open groups carry over.
  rotate(reason) {
    this.end(reason);
    this.sealed.push({ session: this.sessionId, events: this.queue });
    this.queue = [];
    this.newSession();
    for (const [kind, id] of Object.entries(this.groups)) if (!(kind === 'match' && reason === 'match_end')) this.push({ type: 'group', kind, id });
  }

  // ───────────────────────────── errors and crashes ─────────────────────────────

  reportError({ kind, error, attrs, stamp }) {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : error?.message ?? error ?? 'Unknown error';
    const message = scrub(String(raw).slice(0, 500)) || 'Unknown error';
    const stack = scrub(String(error?.stack ?? '').slice(0, 4000));
    // The game's own frame: Node's internals (node:…) are left out.
    const top = topFrame(stack.split('\n').filter((l) => !/\(node:|^\s*at node:/.test(l)).join('\n'));
    const fp = fingerprint(kind, message, top?.fn ?? '');
    const count = (this.errorCounts.get(fp) || 0) + 1;
    this.errorCounts.set(fp, count);
    if (count > MAX_ERRORS_PER_FINGERPRINT) return;
    this.push({ type: 'error', kind, message, stack, source: top?.file ?? null, line: top?.line ?? null, col: top?.col ?? null, fn: top?.fn ?? null, fingerprint: fp, attrs: attrs && Object.keys(attrs).length ? attrs : null }, stamp);
  }

  // Uncaught errors are watched (uncaughtExceptionMonitor), never caught: the process dies as it would without
  // Glitchless. As it dies, the queue goes out from a short-lived child process (the dying one can't wait for a reply);
  // if that fails it waits in crashDir for the next start. A process that keeps going because the game handles
  // uncaughtException reports the error as an exception instead.
  installCrashHooks() {
    this.onUncaught = (err, origin) => {
      const kind = origin === 'unhandledRejection' ? 'promise' : 'exception';
      if (process.listenerCount('uncaughtException') > 0) return this.reportError({ kind, error: err, attrs: { origin } });
      this.reportError({ kind: 'crash', error: err, attrs: { origin } });
      this.removeCrashHooks();
      if (!this.ended) this.end('crash');
      this.sendBeforeExit();
    };
    this.onExit = () => {
      if (this.ended) return;
      this.end('exit');
      this.sendBeforeExit();
    };
    process.on('uncaughtExceptionMonitor', this.onUncaught);
    process.on('exit', this.onExit);
  }

  removeCrashHooks() {
    if (this.onUncaught) process.off('uncaughtExceptionMonitor', this.onUncaught);
    if (this.onExit) process.off('exit', this.onExit);
    this.onUncaught = this.onExit = null;
  }

  // Sends the queue synchronously, as the process goes.
  sendBeforeExit() {
    clearInterval(this.windowTimer);
    if (!this.opts.intake || this.disabled || (this.features && !this.features.has('server_mode'))) return;
    const bodies = this.batches().map((b) => this.body(b.events, b.id, b.session));
    if (!bodies.length) return;
    if (this.features) {
      const child = spawnSync(process.execPath, ['-e', SEND_AND_EXIT], { input: JSON.stringify({ url: this.intakeUrl(), bodies }), timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
      if (child.status === 0) return;
    }
    // Not sent (no answer, or /v1/health hadn't answered yet): the next start sends it, once the server says it reads it.
    if (!this.opts.crashDir) return;
    try {
      fs.mkdirSync(this.opts.crashDir, { recursive: true });
      fs.writeFileSync(path.join(this.opts.crashDir, `${pendingPrefix(this.opts.service)}${this.sessionId}.json`), JSON.stringify({ saved: Date.now(), bodies }));
    } catch {}
  }

  // Batches a crash saved, sent once /v1/health says this server reads server sessions.
  sendPending() {
    if (!this.features?.has('server_mode')) return Promise.resolve();
    return (this.pendingSend ??= this.sendPendingFiles());
  }

  async sendPendingFiles() {
    const dir = this.opts.crashDir;
    if (!dir) return;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith(pendingPrefix(this.opts.service)) && f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const { saved, bodies } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.now() - saved < PENDING_MAX_AGE_MS) {
          for (const body of bodies) if (!(await this.post(body))) throw new Error('not sent');
        }
        fs.unlinkSync(file);
      } catch {}
    }
  }

  // ───────────────────────────── transport ─────────────────────────────

  groupId(kind, id) {
    if (!validGroupId(String(id ?? ''))) {
      this.warnOnce(`groupid:${kind}`, `setGroup: "${id}" was dropped: IDs are 8 to 64 characters of A-Z, a-z, 0-9, _ . : -`);
      return null;
    }
    return kind !== 'run' && this.opts.hashGroupIds !== false ? hashGroupId(this.opts.service, String(id)) : String(id);
  }

  push(event, stamp = {}) {
    const e = { ts: Date.now(), level: this.level, ...this.stamps(), ...event, ...stamp };
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  stamps() {
    const s = {};
    for (const kind of GROUP_KINDS) if (this.groups[kind]) s[kind] = this.groups[kind];
    return s;
  }

  // Asks the Glitchless server what it reads (GET /v1/health → features), once; again on the next send after a
  // failed try.
  checkFeatures() {
    if (this.features || !this.opts.intake) return Promise.resolve();
    this.featuresCheck ??= fetch(`${this.opts.intake}/v1/health`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((health) => {
        if (!health) return;
        this.features = featureSet(health.features);
        if (!this.features.has('server_mode')) {
          this.disabled = true;
          this.queue = [];
          this.sealed = [];
          this.warnOnce('server_mode', `${this.opts.intake} doesn't read server sessions yet, so this server sends nothing. Update the Glitchless server.`);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.featuresCheck = null;
      });
    return this.featuresCheck;
  }

  // Sends the queue, and batches that failed before. Until /v1/health has answered, everything waits.
  async flush() {
    this.lastFlushAt = Date.now();
    if (!this.opts.intake || this.disabled) {
      this.queue = [];
      this.sealed = [];
      this.retries = [];
      this.stats.lastStatus = this.opts.intake ? 'disabled' : 'offline';
      return;
    }
    if (!this.features) await this.checkFeatures();
    if (!this.features || this.disabled) return;
    const batches = this.batches();
    await Promise.all(batches.map((b) => this.send(b)));
  }

  // The queue cut into batches, after the ones waiting to go again; a batch holds one session's events. Counters go
  // only to a server that reads them.
  batches() {
    const sessions = [...this.sealed, { session: this.sessionId, events: this.queue }];
    this.sealed = [];
    this.queue = [];
    const counts = !this.features?.has('counts');
    if (counts && sessions.some((s) => s.events.some((e) => e.type === 'counts')) && this.features) this.warnOnce('counts', "count(): this Glitchless server doesn't read counters yet, so they are not sent.");
    const batches = this.retries;
    this.retries = [];
    for (const { session, events } of sessions) {
      const kept = counts ? events.filter((e) => e.type !== 'counts') : events;
      for (let i = 0; i < kept.length; i += MAX_BATCH_EVENTS) batches.push({ id: batchId(), session, events: kept.slice(i, i + MAX_BATCH_EVENTS) });
    }
    return batches;
  }

  async send(batch) {
    const ok = await this.post(this.body(batch.events, batch.id, batch.session));
    if (ok === null) {
      const waiting = this.retries.reduce((n, b) => n + b.events.length, 0);
      if (waiting + batch.events.length <= MAX_RETRY_EVENTS) this.retries.push(batch);
    }
    return ok;
  }

  body(events, id, session = this.sessionId) {
    return JSON.stringify({
      service: this.opts.service,
      env: this.opts.env,
      version: this.opts.version,
      session_id: session,
      player_id: null,
      role: 'server',
      sdk: this.sdk,
      batch_id: id,
      events,
    });
  }

  intakeUrl() {
    return `${this.opts.intake}/v1/intake?token=${encodeURIComponent(this.opts.clientToken)}`;
  }

  // true once intake took it, false when it turned it away for good, null when it's worth another try.
  async post(body) {
    const n = (body.match(/"type":/g) || []).length;
    try {
      const r = await fetch(this.intakeUrl(), { method: 'POST', body: gzipSync(body), headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(10_000) });
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        this.stats.failed += n;
        this.stats.lastStatus = `rejected ${r.status}`;
        return false;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.stats.sent += n;
      this.stats.lastStatus = 'ok';
      return true;
    } catch (err) {
      this.stats.failed += n;
      this.stats.lastStatus = 'error';
      this.log('send failed', err.message);
      return null;
    }
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn('[glitchless]', message);
  }

  log(...args) {
    if (this.opts.debug) console.debug('[glitchless]', ...args);
  }
}

const NO_MATCH = { id: null, track() {}, count() {}, levelStart() {}, levelComplete() {}, levelFail() {}, error() {}, end() {} };

// ───────────────────────────── helpers for the common servers ─────────────────────────────

// How a player's connection ended, from the server's side, as a `player_left` counter: left (closed normally),
// timeout, connection_lost, kicked, server_closed or other.
const WS_CLOSE = { 1000: 'left', 1001: 'left', 1005: 'left', 1006: 'connection_lost', 1012: 'server_closed', 1008: 'kicked' };
const SOCKET_IO_REASONS = {
  'client namespace disconnect': 'left',
  'ping timeout': 'timeout',
  'transport close': 'connection_lost',
  'transport error': 'connection_lost',
  'server namespace disconnect': 'kicked',
  'server shutting down': 'server_closed',
};

// A `ws` WebSocketServer: players connected, how their connections end, server errors, and each player's round trip
// from a WebSocket ping every `pingMs` (its own ping payload, so a game's heartbeat pings don't mix in).
export function instrumentWs(server, wss, { pingMs = 5000 } = {}) {
  const sentAt = new WeakMap();
  let seq = 0;
  const players = () => server.setPlayers(wss.clients?.size ?? 0);
  const onConnection = (ws) => {
    players();
    ws.on('pong', (data) => {
      const sent = sentAt.get(ws);
      if (sent && String(data) === sent.tag) {
        server.playerPing(performance.now() - sent.at);
        sentAt.delete(ws);
      }
    });
    ws.on('close', (code) => {
      players();
      server.count('player_left', { reason: WS_CLOSE[code] ?? 'other' });
    });
  };
  const onError = (err) => server.error(err, { source: 'ws' });
  wss.on('connection', onConnection);
  wss.on('error', onError);
  const timer = pingMs > 0 ? setInterval(() => {
    for (const ws of wss.clients ?? []) {
      if (ws.readyState !== 1) continue;
      const tag = `gl${++seq}`;
      sentAt.set(ws, { tag, at: performance.now() });
      try {
        ws.ping(tag);
      } catch {}
    }
  }, pingMs) : null;
  timer?.unref?.();
  players();
  return {
    stop() {
      clearInterval(timer);
      wss.off?.('connection', onConnection);
      wss.off?.('error', onError);
    },
  };
}

// A Socket.IO Server: players connected, how their connections end, and each player's round trip from Engine.IO's own
// heartbeat (the server's ping to the client's pong, every pingInterval).
export function instrumentSocketIO(server, io) {
  const players = () => server.setPlayers(io.engine?.clientsCount ?? io.sockets?.sockets?.size ?? 0);
  const onConnection = (socket) => {
    players();
    let pingAt = 0;
    socket.conn?.on?.('packetCreate', (p) => {
      if (p?.type === 'ping') pingAt = performance.now();
    });
    socket.conn?.on?.('packet', (p) => {
      if (p?.type === 'pong' && pingAt) {
        server.playerPing(performance.now() - pingAt);
        pingAt = 0;
      }
    });
    socket.on('disconnect', (reason) => {
      server.count('player_left', { reason: SOCKET_IO_REASONS[reason] ?? 'other' });
      setImmediate(players);
    });
  };
  io.on('connection', onConnection);
  players();
  return {
    stop() {
      io.off?.('connection', onConnection);
    },
  };
}

// A Colyseus room class, measured: gameServer.define('battle', glitchlessRoom(server, BattleRoom)). Each room is a
// match (its roomId, hashed), its simulation interval is the tick, its clients count toward the players, and errors
// Colyseus hands to the room's onUncaughtException (where the room defines one) are reported as the match's.
export function glitchlessRoom(server, Base) {
  const players = (server.roomPlayers ??= new Map());
  const update = () => server.setPlayers([...players.values()].reduce((a, b) => a + b, 0));
  class GlitchlessRoom extends Base {
    get glitchless() {
      if (!this._glitchless && this.roomId) this._glitchless = server.match(this.roomId, this.roomName ? { room: String(this.roomName) } : undefined);
      return this._glitchless ?? NO_MATCH;
    }

    onCreate(...args) {
      void this.glitchless;
      return super.onCreate?.(...args);
    }

    setSimulationInterval(callback, delay) {
      return super.setSimulationInterval(typeof callback === 'function' ? server.measureTick(callback) : callback, delay);
    }

    async onJoin(...args) {
      const out = await super.onJoin?.(...args);
      players.set(this, (players.get(this) ?? 0) + 1);
      update();
      return out;
    }

    onLeave(...args) {
      players.set(this, Math.max(0, (players.get(this) ?? 0) - 1));
      update();
      return super.onLeave?.(...args);
    }

    onDispose(...args) {
      players.delete(this);
      update();
      this.glitchless.end();
      return super.onDispose?.(...args);
    }
  }
  // Defining onUncaughtException makes Colyseus catch errors it would otherwise let through, so it's only wrapped
  // where the game's room already has one.
  if (typeof Base.prototype.onUncaughtException === 'function') {
    GlitchlessRoom.prototype.onUncaughtException = function (error, methodName) {
      this.glitchless.error(error, { method: methodName });
      return Base.prototype.onUncaughtException.call(this, error, methodName);
    };
  }
  return GlitchlessRoom;
}

// ───────────────────────────── helpers ─────────────────────────────

// The child process that sends a dying server's last batches: reads { url, bodies } on stdin, posts each, exits.
const SEND_AND_EXIT = `let d='';process.stdin.on('data',(c)=>(d+=c)).on('end',async()=>{const{url,bodies}=JSON.parse(d);let ok=true;for(const body of bodies){try{const r=await fetch(url,{method:'POST',body,headers:{'Content-Type':'text/plain'},signal:AbortSignal.timeout(2500)});if(r.status>=500)ok=false}catch{ok=false}}process.exit(ok?0:1)})`;

function pendingPrefix(service) {
  return `pending-${String(service).toLowerCase().replace(/[^a-z0-9_.-]/g, '_')}-`;
}

// Error text without query strings or the user and password in a connection string (postgres://user:pass@host).
function scrub(text) {
  return scrubUrls(text)
    .replace(/(\b(?!https?:)[a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]+)[?#][^\s)'"]*/gi, '$1')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

function featureSet(features) {
  if (Array.isArray(features)) return new Set(features.map(String));
  if (features && typeof features === 'object') return new Set(Object.keys(features).filter((k) => features[k]));
  return new Set();
}

function osName() {
  return { linux: 'linux', win32: 'windows', darwin: 'macos', freebsd: 'freebsd' }[process.platform] ?? process.platform;
}

function randomId(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(n), (b) => chars[b % chars.length]).join('');
}

function batchId() {
  return 'b_' + randomId(16);
}

function round(v, d) {
  if (v == null || Number.isNaN(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
