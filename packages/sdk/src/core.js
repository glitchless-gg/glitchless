import { Sketch } from './sketch.js';
import { collectDevice, anonymizeDevice } from './device.js';
import { Overlay } from './overlay.js';
import { DatadogBridge } from './datadog.js';
import { WebMCPBridge } from './webmcp.js';
import { fingerprint as fingerprintOf } from './fingerprint.js';
import { BugReportForm, snapshot, sendReport } from './bugreport.js';
import { readSteam, withSteam, steamVersion } from './steam.js';

export const SDK_VERSION = '0.5.0';
const SDK = `glitchless-browser/${SDK_VERSION}`;

const HITCH_MS = 50; // a single frame over 50ms is a visible stutter (LoAF threshold)
const JANK_MS = 33.4; // missed two 60Hz vsyncs
const FROZEN_MS = 700; // Android vitals "frozen frame"
const MAX_ERRORS_PER_FINGERPRINT = 25;
const RAGE_INPUT_COUNT = 4; // same key ≥4 times within 1s ≈ a game's "rage click"
const RAGE_INPUT_WINDOW_MS = 1000;
const MAX_QUEUE = 2000;
const MAX_HITCH_EVENTS_PER_WINDOW = 3; // detail events; frame_window.hitches still counts every hitch
const BEACON_LIMIT = 60_000;
const MAX_RETRY_EVENTS = MAX_QUEUE / 2; // events in batches waiting to be sent again

const DEFAULTS = {
  service: 'unknown-game',
  version: '0.0.0',
  env: 'dev',
  intake: null,
  clientToken: 'gl_pub_dev',
  overlay: undefined, // default: on outside prod, like WebMCP
  sampleRate: 1,
  positionHz: 4,
  windowMs: 5000, // frame stats are summarised per window; the dashboard's time resolution
  flushIntervalMs: 15000, // how often batches are sent; sends happen on a window boundary
  privacy: 'anonymous', // 'install' adds a random player ID kept on the device, for retention; 'full' that and detailed device fields and positions (see PRIVACY.md)
  positions: undefined, // default: on in 'full' mode; set true to send positions in anonymous or install mode
  datadog: null,
  webmcp: undefined, // default: on outside prod. true | false | { bridge, standard, position }
  dashboardUrl: null,
  sessionType: 'user', // 'synthetic' for bots / autoplay, so they can be filtered out of player metrics
  bugReports: null, // { hotkey: 'F8' } (or true): players open a form in the game to send a bug report (see reportBug)
  steam: null, // an Electron game's steamworks.js client (what steamworks.init() returned): Steam facts per session (steam.js)
  debug: false,
};

let instance = null;

export class Glitchless {
  static init(options = {}) {
    if (instance) return instance;
    instance = new Glitchless(options);
    if (typeof window !== 'undefined') window.__GLITCHLESS__ = instance;
    return instance;
  }

  static get instance() {
    return instance;
  }

  constructor(options) {
    this.opts = { ...DEFAULTS, ...options };
    // Steam facts, read once from the game's own steamworks.js client. Without a version, the Steam build is it.
    this.steam = readSteam(this.opts.steam);
    if (!options.version && steamVersion(this.steam)) this.opts.version = steamVersion(this.steam);
    this.opts.intake = this.opts.intake ? String(this.opts.intake).replace(/\/$/, '') : null;
    this.sessionId = 's_' + randomId(16); // per page load, kept in memory only
    this.sdk = SDK; // engine adapters name themselves here (glitchless-phaser/…), so fix advice fits the engine
    this.engine = null; // { name, version, renderer }, set by an engine adapter
    this.privacy = PRIVACY_LEVELS.includes(this.opts.privacy) ? this.opts.privacy : 'anonymous';
    this.positionsOn = this.opts.positions ?? this.privacy === 'full';
    this.playerId = storedId(this.privacy);
    this.lastFlushAt = 0;
    this.sampled = Math.random() < this.opts.sampleRate;
    this.startedAt = Date.now();
    this.level = null;
    this.levelStartedAt = 0;
    this.levelOpen = false; // a level started and not yet completed, failed or abandoned
    this.leftLevel = null; // the level abandoned for the game as the page went (end())
    this.ctx = {};
    this.recent = [];
    this.queue = [];
    this.retries = []; // batches whose send failed, kept whole with their batch_id to send again
    this.stats = { sent: 0, failed: 0, errors: 0, hitches: 0, deaths: 0, lastStatus: 'idle' };
    this.errorCounts = new Map();
    this.position = null;
    this.posBuffer = [];
    this.pendingHitches = [];
    this.loafEntries = [];
    this.render = null; // filled by instrumentThree
    this.sessionStartSent = false;
    this.firstFrameAt = 0;
    this.firstFrameWall = 0; // Date.now() at the first frame: the load event's ts
    this.firstInputAt = 0;
    this.keyHistory = new Map();
    this.history = []; // recent gameplay events, for agents (WebMCP) and the overlay
    this.errorLog = new Map(); // fingerprint → grouped error, for agents
    this.recentHitches = [];
    this.recentWindows = []; // fps and p95 of the last frame windows, for bug reports
    this.customTools = [];
    this.probes = new Set();
    this.ring = new Float32Array(240);
    this.ringIdx = 0;
    this.ringCount = 0;
    this.budgetMs = 1000 / 60;
    this.hz = 60;
    this.frameId = 0;
    this.lastFrameAt = 0;
    this.refreshDeltas = []; // frame times for the refresh-rate guess (frame budget)
    this.win = this.newWindow();
    this.datadog = this.opts.datadog ? new DatadogBridge(this.opts) : null;

    if (typeof window === 'undefined') return;
    this.installFrameLoop();
    this.installErrorHandlers();
    this.installLifecycle();
    this.installObservers();
    // Before the input tracking (and the game's own listeners): the form holds input back from them while open.
    if (this.opts.bugReports) this.bugForm = new BugReportForm(this, this.opts.bugReports === true ? {} : this.opts.bugReports);
    this.installInputTracking();
    // One timer: close a frame window every windowMs, and send when flushIntervalMs has passed (or
    // straight away for the first batch, so a session shows up within one window).
    this.windowTimer = setInterval(() => {
      this.closeWindow();
      if (!this.sessionStartSent || Date.now() - this.lastFlushAt >= this.opts.flushIntervalMs - 250) this.flush();
    }, this.opts.windowMs);
    if (this.positionsOn) this.posTimer = setInterval(() => this.samplePosition(), 1000 / this.opts.positionHz);
    if (this.opts.overlay ?? this.opts.env !== 'prod') this.overlay = new Overlay(this);
    const webmcp = this.opts.webmcp ?? this.opts.env !== 'prod';
    if (webmcp) this.webmcp = new WebMCPBridge(this, typeof webmcp === 'object' ? webmcp : {});
    this.log('init', { session: this.sessionId, sampled: this.sampled, intake: this.opts.intake });
  }

  // ───────────────────────────── game semantic API ─────────────────────────────

  levelStart(levelId) {
    // Frames, positions and hitches so far belong to the level that is ending: close their window now,
    // so a short level (a 6 s wave, a quick retry) keeps its own frames instead of handing them to the next.
    if (this.win.frames || this.posBuffer.length) this.closeWindow();
    this.level = String(levelId);
    this.levelStartedAt = Date.now();
    this.levelOpen = true;
    this.leftLevel = null;
    this.push({ type: 'level_start' });
    this.remember('level_start');
    this.datadog?.levelStart(this.level);
  }

  levelComplete(levelId, { durationS, score } = {}) {
    const level = String(levelId ?? this.level);
    const duration_s = durationS ?? (Date.now() - this.levelStartedAt) / 1000;
    this.levelOpen = false;
    this.push({ type: 'level_complete', level, duration_s: round(duration_s, 2), score: score ?? null });
    this.remember('level_complete');
    this.datadog?.levelComplete(level, { duration_s, score });
  }

  // The player lost the level (died, ran out of time). Leaving it is levelAbandon.
  levelFail(levelId, { cause } = {}) {
    const level = String(levelId ?? this.level);
    if (this.outcomeSent(level)) return;
    this.levelOpen = false;
    this.push({ type: 'level_fail', level, cause: cause ?? null });
    this.remember('level_fail');
    this.datadog?.levelFail(level, cause);
  }

  // The player left the level before it ended: went to the menu, restarted it, closed the tab. Never counted as a
  // fail. The page going away mid-level sends one by itself (SPEC §2 level_abandon).
  levelAbandon(levelId) {
    const level = String(levelId ?? this.level);
    if (this.outcomeSent(level)) return;
    this.abandon(level);
  }

  abandon(level, reason = null) {
    this.levelOpen = false;
    this.push({ type: 'level_abandon', level, duration_s: round((Date.now() - this.levelStartedAt) / 1000, 2), ...(reason ? { reason } : {}) });
    this.remember('level_abandon');
    this.datadog?.action('level_abandon', { level, reason });
  }

  // A game that ends its level as the page goes (in its own pagehide handler) does it after the SDK's abandon: that
  // attempt has its outcome.
  outcomeSent(level) {
    return !!this.ended && this.leftLevel != null && level === this.leftLevel;
  }

  death({ x = 0, y = 0, z = 0, cause = 'unknown' } = {}) {
    this.stats.deaths++;
    // Death places are positions: only sent when positions are on (full mode, or positions: true).
    const where = this.positionsOn ? { x: round(x, 2), y: round(y, 2), z: round(z, 2) } : {};
    this.push({ type: 'death', ...where, cause });
    this.remember(`death:${cause}`);
    this.datadog?.action('death', { cause, ...where, level: this.level });
  }

  track(name, attrs = {}) {
    this.push({ type: 'custom', name, attrs });
    this.remember(name);
    this.datadog?.action(name, { ...attrs, level: this.level });
  }

  setPosition(p) {
    if (!p) return;
    this.position = [p.x || 0, p.y || 0, p.z || 0];
  }

  setContext(values = {}) {
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'number') continue;
      this.ctx[k] = v;
      this.win.ctx[k] = Math.max(this.win.ctx[k] ?? -Infinity, v);
      for (const p of this.probes) p.ctxMax[k] = Math.max(p.ctxMax[k] ?? -Infinity, v);
    }
  }

  error(err, attrs = {}) {
    this.reportError({ kind: 'manual', error: err, attrs });
  }

  // Implemented by the engine adapter (see three.js). Kept here so games can call it unconditionally.
  captureMap(levelId, opts) {
    if (this.render?.captureMap) return this.render.captureMap(levelId, opts);
    this.log('captureMap ignored: no engine adapter installed');
  }

  // A player's bug report: `note` is what they typed. Sends a screenshot (screenshot: false leaves it out), where
  // they are and what just happened. Resolves { sent: true }, or { sent: false, reason: 'offline' | 'error' }.
  async reportBug({ note = '', screenshot = true } = {}) {
    return sendReport(this, await snapshot(this, { screenshot }), note);
  }

  // Forgets the player ID kept on the device (install and full mode), for a game's "reset my ID" setting. This session
  // keeps sending the ID it started with; the next one (the next page load) makes a new ID, so nothing joins the two.
  resetInstallId() {
    forgetPlayerId();
  }

  // Opens the bug report form (bugReports in init adds a hotkey and an overlay button for it), for a game's own
  // "Report a bug" menu item.
  openBugReport() {
    if (typeof window === 'undefined') return;
    if (!this.bugForm) this.bugForm = new BugReportForm(this, { hotkey: null, ...(typeof this.opts.bugReports === 'object' ? this.opts.bugReports : {}) });
    this.bugForm.open();
  }

  // Expose a game-specific tool to coding agents over WebMCP, e.g. "load_level" or "spawn_enemy",
  // so an agent can reproduce a bug and measure it. handler(args) → string | object.
  registerTool(name, description, inputSchema, handler) {
    const tool = { name, description, inputSchema: inputSchema || { type: 'object', properties: {} }, execute: handler };
    this.customTools.push(tool);
    this.webmcp?.add(tool);
  }

  // Frame stats over the next `seconds` — the A/B primitive agents use before/after a fix.
  measure(seconds = 5) {
    const before = this.render?.memory?.() || {};
    const probe = { sketch: new Sketch(), renderSketch: new Sketch(), updateSketch: new Sketch(), frames: 0, max: 0, hitches: [], calls: 0, callsMax: 0, tris: 0, renderFrames: 0, ctxMax: {}, errors: this.stats.errors, level: this.level };
    this.probes.add(probe);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.probes.delete(probe);
        const after = this.render?.memory?.() || {};
        const s = probe.sketch;
        if (!probe.frames) {
          resolve('No frames were rendered — the game tab is probably hidden or paused. Bring it to the foreground and try again.');
          return;
        }
        resolve({
          seconds,
          level_start: probe.level,
          level_end: this.level,
          frames: probe.frames,
          fps: Math.round((probe.frames / seconds) * 10) / 10,
          frame_budget_ms: round(this.budgetMs, 2),
          frame_ms: { p50: round(s.quantile(0.5), 2), p95: round(s.quantile(0.95), 2), p99: round(s.quantile(0.99), 2), worst: round(probe.max, 1) },
          pct_frames_over_budget: round(s.fractionAbove(this.budgetMs * 1.15) * 100, 1),
          // CPU time spent inside renderer.render(): rises with scene cost even when vsync hides it in frame time.
          render_cpu_ms: { p50: round(probe.renderSketch.quantile(0.5), 2), p95: round(probe.renderSketch.quantile(0.95), 2), share_of_budget_pct: round(((probe.renderSketch.quantile(0.5) || 0) / this.budgetMs) * 100, 0) },
          hitches: probe.hitches.slice(0, 10),
          hitch_count: probe.hitches.length,
          draw_calls: { avg: probe.renderFrames ? Math.round(probe.calls / probe.renderFrames) : null, max: probe.callsMax || null },
          triangles_avg: probe.renderFrames ? Math.round(probe.tris / probe.renderFrames) : null,
          // CPU time in the game's update code, where an engine adapter can see it (Phaser's scene updates).
          ...(probe.updateSketch.n ? { update_cpu_ms: { p50: round(probe.updateSketch.quantile(0.5), 2), p95: round(probe.updateSketch.quantile(0.95), 2) } } : {}),
          peak_context: probe.ctxMax,
          memory_delta: memoryDelta(before, after),
          new_errors: this.stats.errors - probe.errors,
        });
      }, seconds * 1000);
    });
  }

  device() {
    if (!this._device) this._device = collectDevice(this.render?.gl || null);
    return this._device;
  }

  // ───────────────────────────── frame timing ─────────────────────────────

  newWindow() {
    return {
      startedAt: Date.now(),
      frames: 0,
      sketch: new Sketch(),
      max: 0,
      jank: 0,
      hitches: 0,
      frozen: 0,
      slow: 0,
      renderMs: 0,
      renderFrames: 0,
      updateMs: 0,
      updateFrames: 0,
      drawCalls: 0,
      drawCallsMax: 0,
      triangles: 0,
      ctx: {},
    };
  }

  installFrameLoop() {
    const raf = (now) => {
      if (this.externalClock) return; // an engine adapter drives tick() from the engine's own loop now
      this.tick(now);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    // Time in a background tab is not a frame. Neither is time without focus: iOS Control Center, a call
    // or Siri over Safari take focus without hiding the page, and no frames come until focus is back.
    // (On desktop that costs one frame per focus change.)
    document.addEventListener('visibilitychange', () => this.skipFrame());
    window.addEventListener('blur', () => this.skipFrame());
    window.addEventListener('focus', () => this.skipFrame());
  }

  // An engine adapter calls this once per game step instead of the SDK timing animation frames, so a
  // game with an fps limit (or a loop on setTimeout) is measured by the frames it actually draws.
  useFrameClock() {
    this.externalClock = true;
    this.lastFrameAt = 0;
  }

  // The frame that starts at `now` (a performance.now() time): times the one before it.
  tick(now) {
    this.frameId++;
    const last = this.lastFrameAt;
    if (last && !document.hidden) {
      const dt = now - last;
      // Browsers throttle rAF to ~1Hz for occluded windows that still report "visible". A single long
      // frame between normal ones is a real freeze; a run of long frames is throttling — drop those.
      if (dt >= 5000) this.pendingLong = null;
      else if (dt > FROZEN_MS) {
        if (this.pendingLong || this.throttled) {
          this.pendingLong = null;
          this.throttled = true;
        } else this.pendingLong = { dt, now, detail: this.render?.hitchDetail?.(dt) };
      } else {
        if (this.pendingLong) this.onFrame(this.pendingLong.dt, this.pendingLong.now, this.pendingLong.detail);
        this.pendingLong = null;
        this.throttled = false;
        this.onFrame(dt, now);
      }
      // Infer the refresh rate (60/120/144Hz) → frame budget. A frame can take longer than the display's
      // interval but never less, so the fast frames tell the rate: a busy start (shader compiles, loading)
      // at 30 fps must not set a 33 ms budget for the whole session. Checked again later, only ever faster.
      const deltas = this.refreshDeltas;
      if (dt < 100 && dt > 3.5) {
        deltas.push(dt);
        if (deltas.length === 120 || deltas.length === 600) this.setBudget(quantileOf(deltas, 0.2), deltas.length === 600);
        if (deltas.length >= 600) deltas.splice(0, 480); // check again every 480 frames
      }
    }
    this.lastFrameAt = now;
  }

  // The engine can't take frames for a while (paused, or its loop slept): the gap is not a frame.
  skipFrame() {
    this.lastFrameAt = 0;
    this.pendingLong = null;
  }

  setBudget(typicalDt, onlyFaster = false) {
    const rates = [30, 60, 75, 90, 100, 120, 144, 165, 240];
    const measured = 1000 / typicalDt;
    const hz = rates.reduce((best, r) => (Math.abs(r - measured) < Math.abs(best - measured) ? r : best), 60);
    if (onlyFaster && hz <= this.hz) return;
    this.hz = hz;
    this.budgetMs = 1000 / this.hz;
  }

  onFrame(dt, now, detail) {
    const w = this.win;
    w.frames++;
    w.sketch.add(dt);
    if (dt > w.max) w.max = dt;
    if (dt > this.budgetMs * 1.5) w.slow++;
    if (dt > JANK_MS) w.jank++;
    if (dt > FROZEN_MS) w.frozen++;
    this.ring[this.ringIdx] = dt;
    this.ringIdx = (this.ringIdx + 1) % this.ring.length;
    this.ringCount = Math.min(this.ringCount + 1, this.ring.length);

    const r = this.lastRender;
    const rendered = r && r.frameId >= this.frameId - 1;
    for (const p of this.probes) {
      p.frames++;
      p.sketch.add(dt);
      if (dt > p.max) p.max = dt;
      if (rendered) {
        p.renderFrames++;
        p.renderSketch.add(r.ms);
        p.calls += r.calls;
        p.tris += r.triangles;
        if (r.calls > p.callsMax) p.callsMax = r.calls;
      }
      if (rendered && r.updateMs != null) p.updateSketch.add(r.updateMs);
      if (dt > HITCH_MS && dt > 2 * (this.recentMedian || 0)) p.hitches.push({ ms: round(dt, 1), level: this.level, draw_calls: rendered ? r.calls : null, ctx: { ...this.ctx }, recent: this.recentWithin(1500) });
    }
    if (rendered) {
      w.renderMs += r.ms;
      w.renderFrames++;
      w.drawCalls += r.calls;
      w.triangles += r.triangles;
      if (r.calls > w.drawCallsMax) w.drawCallsMax = r.calls;
      if (r.updateMs != null) {
        w.updateMs += r.updateMs;
        w.updateFrames++;
      }
    }

    if (!this.firstFrameAt) {
      this.firstFrameAt = performance.now();
      this.firstFrameWall = Date.now();
    }

    if ((this.frameId & 15) === 0 && this.ringCount >= 30) this.recentMedian = median(this.frameHistory().slice(-60));
    // A hitch is a stutter: over 50ms *and* well above what this device normally does. A device that
    // is slow all the time shows up in the percentiles instead of firing a hitch every frame.
    if (dt > HITCH_MS && dt > 2 * (this.recentMedian || 0)) {
      w.hitches++;
      this.stats.hitches++;
      const mem = this.render?.memory?.() || {};
      const heap = heapMb();
      // What the engine saw in this frame: its own likely causes and timings (see phaser.js).
      const engine = detail ?? this.render?.hitchDetail?.(dt) ?? null;
      this.pendingHitches.push({
        type: 'hitch',
        ts: Date.now(),
        level: this.level,
        duration_ms: round(dt, 1),
        frozen: dt > FROZEN_MS,
        draw_calls: r?.calls ?? null,
        triangles: r?.triangles ?? null,
        programs: mem.programs ?? null,
        ctx: { ...this.ctx },
        recent: this.recentWithin(1500),
        _perfEnd: now,
        _programsBefore: this.prevPrograms,
        _heapBefore: this.prevHeap,
        _heapAfter: heap,
        _assetsInFlight: this.render?.assetsInFlight?.() || 0,
        _engine: engine,
      });
      this.prevPrograms = mem.programs;
    } else if ((this.frameId & 31) === 0) {
      this.prevPrograms = this.render?.memory?.().programs;
      this.prevHeap = heapMb();
    }
  }

  // Called by the engine adapter after each render call.
  onRender(ms, calls, triangles, updateMs = null) {
    if (this.lastRender && this.lastRender.frameId === this.frameId) {
      this.lastRender.ms += ms;
      this.lastRender.calls += calls;
      this.lastRender.triangles += triangles;
      if (updateMs != null) this.lastRender.updateMs = (this.lastRender.updateMs ?? 0) + updateMs;
    } else {
      this.lastRender = { frameId: this.frameId, ms, calls, triangles, updateMs };
    }
  }

  // Live numbers for the overlay.
  liveStats() {
    const n = this.ringCount;
    if (!n) return null;
    const arr = Array.from(this.ring.subarray(0, n));
    const recent = [];
    for (let i = 0; i < Math.min(60, n); i++) {
      recent.push(this.ring[(this.ringIdx - 1 - i + this.ring.length) % this.ring.length]);
    }
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    arr.sort((a, b) => a - b);
    return {
      fps: 1000 / avg,
      p50: arr[Math.floor(n * 0.5)],
      p95: arr[Math.min(n - 1, Math.floor(n * 0.95))],
      max: arr[n - 1],
      budget: this.budgetMs,
      hz: this.hz,
      render: this.lastRender,
      memory: this.render?.memory?.() || null,
      heap: heapMb(),
    };
  }

  frameHistory() {
    const out = [];
    for (let i = this.ringCount - 1; i >= 0; i--) {
      out.push(this.ring[(this.ringIdx - 1 - i + this.ring.length) % this.ring.length]);
    }
    return out;
  }

  // ───────────────────────────── errors ─────────────────────────────

  installErrorHandlers() {
    window.addEventListener('error', (e) => {
      if (e.error || e.message) this.reportError({ kind: 'js', error: e.error, message: e.message, source: e.filename, line: e.lineno, col: e.colno });
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.reportError({ kind: 'promise', error: e.reason instanceof Error ? e.reason : null, message: String(e.reason?.message ?? e.reason) });
    });
  }

  reportError({ kind, error, message, source, line, col, attrs }) {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : message ?? error?.message ?? error ?? 'Unknown error';
    const scrub = this.privacy === 'full' ? (t) => t : scrubUrls;
    const msg = scrub(String(raw).replace(/^Uncaught\s+/, '').slice(0, 500)) || 'Unknown error';
    const stack = scrub(String(error?.stack ?? '').slice(0, 4000));
    const top = topFrame(stack) || (source ? { file: basename(source), fn: '' } : null);
    const fingerprint = fingerprintOf(kind, scrubUrls(msg), top?.fn ?? ''); // scrubbed either way, so both modes group alike
    const count = (this.errorCounts.get(fingerprint) || 0) + 1;
    this.errorCounts.set(fingerprint, count);
    this.stats.errors++;
    this.remember(`error:${msg.slice(0, 40)}`);
    const logged = this.errorLog.get(fingerprint);
    if (logged) {
      logged.count = count;
      logged.last_seen = new Date().toISOString();
    } else {
      this.errorLog.set(fingerprint, {
        fingerprint,
        kind,
        message: msg,
        count,
        location: top ? `${top.fn} (${top.file}:${top.line}:${top.col})` : source ? basename(source) : null,
        stack: stack.split('\n').slice(0, 8).join('\n'),
        level: this.level,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        events_before: this.recent.slice(-6).map((e) => e.name),
      });
    }
    if (count > MAX_ERRORS_PER_FINGERPRINT) return;
    this.push({
      type: 'error',
      kind,
      message: msg,
      stack,
      source: source ? basename(source) : top?.file ?? null,
      line: line ?? top?.line ?? null,
      col: col ?? top?.col ?? null,
      fn: top?.fn ?? null,
      fingerprint,
      attrs: attrs || null,
    });
    this.datadog?.error(error || new Error(msg), { kind, fingerprint, level: this.level });
  }

  // ───────────────────────────── lifecycle, observers, input ─────────────────────────────

  installLifecycle() {
    window.addEventListener('pagehide', () => this.end('pagehide'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush({ beacon: true });
    });
  }

  end(reason) {
    if (this.ended) return;
    // An engine adapter sets the level to null back in a menu: then no level is going.
    if (this.levelOpen && this.level != null) {
      this.leftLevel = this.level;
      this.abandon(this.level, reason);
    }
    this.ended = true;
    this.push({ type: 'session_end', reason, duration_s: round((Date.now() - this.startedAt) / 1000, 1) });
    this.flush({ beacon: true });
  }

  installObservers() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      // Long Animation Frames (Chromium 123+) tell us *which script* blocked the frame.
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.loafEntries.push({
            start: e.startTime,
            end: e.startTime + e.duration,
            blocking: e.blockingDuration,
            scripts: (e.scripts || [])
              .map((s) => ({
                source: basename(s.sourceURL || s.invoker || ''),
                fn: s.sourceFunctionName || s.invoker || '',
                ms: round(s.duration, 1),
              }))
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 3),
          });
        }
        if (this.loafEntries.length > 100) this.loafEntries.splice(0, this.loafEntries.length - 100);
      });
      po.observe({ type: 'long-animation-frame', buffered: true });
      this.loafSupported = true;
    } catch {
      // Not supported (Firefox/Safari) — hitches still get engine-level attribution.
    }
  }

  installInputTracking() {
    const onInput = (code) => {
      if (this.bugForm?.isOpen) return; // typing a bug report is not playing
      const now = performance.now();
      if (!this.firstInputAt && this.firstFrameAt) {
        this.firstInputAt = now;
        this.push({ type: 'load', ttp_ms: Math.round(now) });
      }
      const hist = (this.keyHistory.get(code) || []).filter((t) => now - t < RAGE_INPUT_WINDOW_MS);
      hist.push(now);
      this.keyHistory.set(code, hist);
      if (hist.length === RAGE_INPUT_COUNT) {
        this.push({ type: 'custom', name: 'rage_input', attrs: { key: code, count: hist.length } });
        this.remember('rage_input');
      }
    };
    window.addEventListener('keydown', (e) => !e.repeat && onInput(e.code), { capture: true });
    window.addEventListener('pointerdown', () => onInput('pointer'), { capture: true });
  }

  samplePosition() {
    if (!this.position || document.hidden) return;
    const [x, y, z] = this.position;
    this.posBuffer.push([Date.now(), round(x, 2), round(y, 2), round(z, 2)]);
  }

  // ───────────────────────────── transport ─────────────────────────────

  push(event) {
    const e = { ts: Date.now(), level: this.level, ...event };
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (e.type !== 'map' && e.type !== 'session_end') {
      const { stack, ...slim } = e;
      this.history.push(slim);
      if (this.history.length > 300) this.history.shift();
    }
    this.overlay?.onEvent?.(e);
  }

  recentWithin(ms) {
    const cutoff = Date.now() - ms;
    return [...new Set(this.recent.filter((e) => e.ts >= cutoff).map((e) => e.name))];
  }

  remember(name) {
    this.recent.push({ name, ts: Date.now() });
    if (this.recent.length > 20) this.recent.shift();
  }

  sessionStartEvent() {
    const gl = this.render?.gl || null;
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    return {
      type: 'session_start',
      ts: this.startedAt,
      level: null,
      session_type: this.opts.sessionType,
      privacy: this.privacy,
      engine: this.engine,
      device: withSteam(this.privacy === 'full' ? this.device() : anonymizeDevice(this.device()), this.steam),
      page: { url: location.origin + location.pathname, referrer: originOf(document.referrer) },
      nav_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    };
  }

  closeWindow() {
    const w = this.win;
    this.win = this.newWindow();
    if (w.frames > 0) {
      const mem = this.render?.memory?.() || {};
      const s = w.sketch;
      this.queue.push({
        type: 'frame_window',
        ts: w.startedAt,
        level: this.level,
        duration_s: round((Date.now() - w.startedAt) / 1000, 2),
        frames: w.frames,
        fps: round(w.frames / ((Date.now() - w.startedAt) / 1000), 1),
        hz: this.hz,
        budget_ms: round(this.budgetMs, 2),
        ft: s.toJSON(),
        ft_p50: round(s.quantile(0.5), 2),
        ft_p95: round(s.quantile(0.95), 2),
        ft_p99: round(s.quantile(0.99), 2),
        ft_max: round(w.max, 1),
        slow: w.slow,
        jank: w.jank,
        hitches: w.hitches,
        frozen: w.frozen,
        render_ms: w.renderFrames ? round(w.renderMs / w.renderFrames, 2) : null,
        ...(w.updateFrames ? { process_ms: round(w.updateMs / w.updateFrames, 2) } : {}),
        draw_calls: w.renderFrames ? Math.round(w.drawCalls / w.renderFrames) : null,
        draw_calls_max: w.renderFrames ? w.drawCallsMax : null,
        triangles: w.renderFrames ? Math.round(w.triangles / w.renderFrames) : null,
        geometries: mem.geometries ?? null,
        textures: mem.textures ?? null,
        programs: mem.programs ?? null,
        heap_mb: heapMb(),
        ctx: w.ctx,
      });
      this.datadog?.frameWindow(this.queue[this.queue.length - 1]);
      this.recentWindows.push({ ts: w.startedAt, level: this.level, fps: round(w.frames / ((Date.now() - w.startedAt) / 1000), 1), p95: round(s.quantile(0.95), 2) });
      if (this.recentWindows.length > 12) this.recentWindows.shift();
    }
    if (this.posBuffer.length) {
      this.queue.push({ type: 'pos', ts: this.posBuffer[0][0], level: this.level, pts: this.posBuffer });
      this.posBuffer = [];
    }
    this.resolveHitches();
  }

  // Attach likely causes to hitches once LoAF entries for that frame have arrived.
  resolveHitches() {
    const worst = this.pendingHitches.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, MAX_HITCH_EVENTS_PER_WINDOW);
    for (const h of worst) {
      const loaf = this.loafEntries.find((l) => l.end >= h._perfEnd - h.duration_ms - 20 && l.start <= h._perfEnd + 20);
      const causes = [];
      if (h.programs != null && h._programsBefore != null && h.programs > h._programsBefore) causes.push('shader_compile');
      if (h._heapBefore != null && h._heapAfter != null && h._heapAfter < h._heapBefore - 2) causes.push('gc');
      if (h._assetsInFlight > 0) causes.push('asset_load');
      if (loaf?.scripts?.length) causes.push('script');
      for (const c of h._engine?.causes || []) if (!causes.includes(c)) causes.push(c);
      // Where the browser reports long animation frames (Chromium), a long frame without one didn't block the page's
      // main thread: the time went to the GPU, the compositor or the OS.
      if (!causes.length && this.loafSupported && !loaf) causes.push('gpu_or_os');
      if (h.frozen) causes.push('frozen');
      const { _perfEnd, _programsBefore, _heapBefore, _heapAfter, _assetsInFlight, _engine, ...rest } = h;
      const hitch = { ...rest, ...(_engine?.fields || {}), causes, loaf: loaf?.scripts || [] };
      this.queue.push(hitch);
      this.recentHitches.push(hitch);
      if (this.recentHitches.length > 20) this.recentHitches.shift();
    }
    this.pendingHitches = [];
  }

  flush({ beacon = false } = {}) {
    if (beacon) this.closeWindow(); // page hide/close: ship the partial window too
    this.lastFlushAt = Date.now();
    if (!this.sessionStartSent && (this.render || Date.now() - this.startedAt > 3000 || beacon)) {
      this.queue.unshift(this.sessionStartEvent());
      this.sessionStartSent = true;
      if (this.firstFrameAt) this.queue.push({ type: 'load', ts: this.firstFrameWall, level: this.level, ttff_ms: Math.round(this.firstFrameAt), assets: this.render?.assetStats?.() || null });
    }
    if ((!this.queue.length && !this.retries.length) || !this.sessionStartSent) return;
    if (!this.opts.intake || !this.sampled) {
      this.queue = [];
      this.retries = [];
      this.stats.lastStatus = this.opts.intake ? 'unsampled' : 'offline';
      return;
    }
    const events = this.queue;
    this.queue = [];
    // Batches that failed go again first, whole and under their own batch_id, so the server stores each once even
    // when an earlier try reached it and only the answer was lost.
    const batches = this.retries;
    this.retries = [];
    // Large events (map thumbnails, bug reports) go in their own request so batches stay under beacon limits.
    const big = events.filter((e) => e.type === 'map' || e.type === 'bug_report');
    const small = events.filter((e) => e.type !== 'map' && e.type !== 'bug_report');
    for (const chunk of chunkBySize(small, BEACON_LIMIT)) batches.push({ id: batchId(), events: chunk });
    for (const e of big) batches.push({ id: batchId(), events: [e], big: true });
    for (const b of batches) this.send(b.events, beacon && !b.big, b.id);
  }

  // Resolves true once the intake took the events (a beacon: once the browser queued it). `id` is the batch's own
  // ID (SPEC §2 batch_id), the same on every try of it.
  send(events, beacon, id = batchId()) {
    const body = JSON.stringify({
      service: this.opts.service,
      env: this.opts.env,
      version: this.opts.version,
      session_id: this.sessionId,
      player_id: this.playerId,
      sdk: this.sdk,
      batch_id: id,
      events,
    });
    const url = `${this.opts.intake}/v1/intake?token=${encodeURIComponent(this.opts.clientToken)}`;
    if (beacon && navigator.sendBeacon && body.length < BEACON_LIMIT) {
      const ok = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      if (ok) this.stats.sent += events.length;
      return Promise.resolve(ok);
    }
    // Regular sends are gzipped (about 5x smaller). Content-Type stays text/plain, a CORS-safelisted
    // value, so cross-origin intake needs no preflight request; the server spots gzip by its magic bytes.
    return gzip(body)
      .then((payload) => fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' }, keepalive: (payload.byteLength ?? payload.length) < BEACON_LIMIT }))
      .then((r) => {
        // Turned away (a bad payload, a revoked key): it would only be turned away again. 408 and 429 are worth another try.
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          this.stats.failed += events.length;
          this.stats.lastStatus = `rejected ${r.status}`;
          return false;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.stats.sent += events.length;
        this.stats.lastStatus = 'ok';
        return true;
      })
      .catch((err) => {
        this.stats.failed += events.length;
        this.stats.lastStatus = 'error';
        this.log('send failed', err.message);
        const waiting = this.retries.reduce((n, b) => n + b.events.length, 0);
        if (waiting + events.length <= MAX_RETRY_EVENTS) this.retries.push({ id, events, big: events.length === 1 && (events[0].type === 'map' || events[0].type === 'bug_report') });
        return false;
      });
  }

  log(...args) {
    if (this.opts.debug) console.debug('[glitchless]', ...args);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function delta(a, b) {
  return a == null || b == null ? null : b - a;
}

// The change in every engine count measure() saw at both ends (three.js: geometries, textures, programs).
function memoryDelta(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) out[k] = delta(before[k], after[k]);
  return out;
}

function chunkBySize(events, limit) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const e of events) {
    const s = JSON.stringify(e).length;
    if (cur.length && size + s > limit * 0.9) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// gzip with the browser's CompressionStream; falls back to the plain string where it's missing
// (very old browsers) or for tiny bodies, where gzip's header would outweigh the saving.
async function gzip(body) {
  if (typeof CompressionStream === 'undefined' || body.length < 1024) return body;
  try {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return body;
  }
}

// Install and full mode keep one random player ID in localStorage and send it as player_id (SPEC §4b), the same one,
// so a game that moves between them keeps its players. Anonymous mode keeps none, and removes one a build left.
const PRIVACY_LEVELS = ['anonymous', 'install', 'full'];

function storedId(privacy) {
  return privacy === 'anonymous' ? forgetPlayerId() : loadPlayerId();
}

function forgetPlayerId() {
  try {
    localStorage.removeItem('glitchless.pid');
  } catch {}
  return null;
}

function originOf(url) {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

// Query strings and fragments can carry tokens or personal data; keep scheme, host and path, and a
// stack frame's trailing :line:col (Vite serves "fx.js?t=1:45:12"), which topFrame() needs.
export function scrubUrls(text) {
  return String(text).replace(/(https?:\/\/[^\s?#)'"]+)[?#][^\s)'"]*?(?=(?::\d+){1,2}(?=[\s)'"]|$)|[\s)'"]|$)/gm, '$1');
}

// Without localStorage (blocked, or a private window that refuses writes) the ID lasts this page load.
function loadPlayerId() {
  try {
    let id = localStorage.getItem('glitchless.pid');
    if (!id?.startsWith('p_')) {
      id = 'p_' + randomId(12);
      localStorage.setItem('glitchless.pid', id);
    }
    return id;
  } catch {
    return 'p_' + randomId(12);
  }
}

function randomId(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(n);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function heapMb() {
  const m = typeof performance !== 'undefined' && performance.memory;
  return m ? round(m.usedJSHeapSize / 1048576, 1) : null;
}

function median(arr) {
  return quantileOf(arr, 0.5);
}

function quantileOf(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

function round(v, d) {
  if (v == null || Number.isNaN(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function basename(url) {
  if (!url) return '';
  return String(url).split(/[?#]/)[0].split('/').pop();
}

// Chrome: "    at spawnScorePopup (http://host/src/fx.js?t=1:45:12)"  Firefox: "spawnScorePopup@http://host/src/fx.js:45:12"
function topFrame(stack) {
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    let m = line.match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) m = line.match(/^(.*?)@(.+?):(\d+):(\d+)$/);
    if (m) {
      const file = basename(m[2]);
      if (file.startsWith('glitchless')) continue;
      return { fn: (m[1] || '<anonymous>').replace(/^Object\./, ''), file, line: Number(m[3]), col: Number(m[4]) };
    }
  }
  return null;
}


// A batch's own ID (SPEC §2 batch_id): random, the same on every try of the batch.
function batchId() {
  return 'b_' + randomId(16);
}
