import { Sketch } from './sketch.js';
import { collectDevice, anonymizeDevice } from './device.js';
import { Overlay } from './overlay.js';
import { DatadogBridge } from './datadog.js';
import { WebMCPBridge } from './webmcp.js';
import { fingerprint as fingerprintOf } from './fingerprint.js';
import { BugReportForm, snapshot, sendReport } from './bugreport.js';
import { readSteam, withSteam, steamVersion } from './steam.js';
import { Counter } from './counts.js';
import { MAX_PROPS, propKeyProblem, propValue, gameAttrs } from './props.js';
import { GROUP_KINDS, validGroupId, hashGroupId, newRunId } from './groups.js';
import { NetWindow, DISCONNECT_REASONS, readLink } from './net.js';

export const SDK_VERSION = '0.7.0';
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
const STREAM_PER_SECOND = 20; // a name tracked more often than this is a stream: count() is for those
const NET_SAMPLE_GAP_MS = 900; // about one network sample a second
const MAX_DISCONNECTS = 20; // disconnect events a session
const MAX_HELD_COUNTS = 120; // counts events waiting to hear whether the server reads them

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
  properties: null, // what holds for the session in the game's words ({ mode: 'squads', region: 'eu' }); see setProperties
  hashGroupIds: true, // match and party IDs are hashed before they are sent (groups.js); false sends them as they are
  optIn: false, // true: off on a device until setEnabled(true), for a game that asks the player first (SPEC §4d)
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
    // The player's own switch (setEnabled, SPEC §4d), saved on the device: off sends nothing at all from the start.
    this.playerOff = !(loadChoice() ?? !this.opts.optIn);
    this.gen = 0; // which run of sending a request belongs to: turning off makes the answers to earlier ones moot
    this.loadOff = this.playerOff; // the load event is only true of a page measured from its start
    this.offLevel = null; // the attempt going when the player turned Glitchless off: not part of the next session
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
    this.stats = { sent: 0, failed: 0, errors: 0, hitches: 0, deaths: 0, lastStatus: this.playerOff ? 'off' : 'idle' };
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
    this.zone = null; // where the player is in an open world (setZone), stamped on events like the level
    this.groups = {}; // kind → the ID sent: the match, party and run the session's events belong to (setGroup)
    this.groupAttrs = {}; // kind → its attributes, said again in a new session
    this.props = {}; // the session's properties now (setProperties)
    this.sentProps = {}; // what the server has been told: session_start.props, then each props event
    this.propKeys = new Set(); // every key set this session (at most 12)
    this.propsChangedAt = 0;
    this.counter = new Counter(); // count() entries for the current window
    this.heldCounts = []; // counts events waiting to hear the server reads them (/v1/health features)
    this.features = null; // what the server says it reads, once /v1/health has answered
    this.trackRate = new Map(); // name → [second, calls], for the warning that names count()
    this.warned = new Set();
    this.net = { connected: false, since: 0, lastSample: 0, transport: null, host: false, last: null, disconnects: 0, disconnectedAt: 0, leftLevel: null };
    this.win = this.newWindow();
    this.datadog = this.opts.datadog && !this.playerOff ? new DatadogBridge(this.opts) : null; // not even its script while off
    if (this.opts.properties) this.setProperties(this.opts.properties);

    if (typeof window === 'undefined') return;
    this.checkFeatures();
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

  // `attrs` describe the attempt in the game's words ({ mode: 'ranked', tier: 'pit_80', party_size: 3 }), with a
  // custom event's rules (SPEC §2 level_start); the level's outcome and deaths are paired with it on the server.
  levelStart(levelId, attrs) {
    // Frames, positions, hitches and counts so far belong to the level that is ending: close their window now,
    // so a short level (a 6 s wave, a quick retry) keeps its own frames instead of handing them to the next.
    this.closeWindowIfAny();
    this.level = String(levelId);
    this.levelStartedAt = Date.now();
    this.levelOpen = true;
    this.leftLevel = null;
    this.offLevel = null;
    this.net.leftLevel = null;
    const a = gameAttrs(attrs);
    this.push({ type: 'level_start', ...(a ? { attrs: a } : {}) });
    this.remember('level_start');
    this.datadog?.levelStart(this.level);
  }

  // Where the player is in an open world: an MMO region, a metroidvania room. Unlike a level it has no start or end:
  // every event and window carries it as `zone` until the next call, and null clears it. A new zone closes the frame
  // window, as a level start does, so frames and counts keep their zone.
  setZone(name) {
    const zone = name == null || name === '' ? null : String(name).slice(0, 64);
    if (zone === this.zone) return;
    this.closeWindowIfAny();
    this.zone = zone;
  }

  levelComplete(levelId, { durationS, score } = {}) {
    const level = String(levelId ?? this.level);
    if (level === this.offLevel) return;
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
  // attempt has its outcome. So does one that ends it in its own disconnect handler, after disconnect().
  outcomeSent(level) {
    if (level === this.offLevel) return true; // started before the player turned Glitchless off and on: no start to pair with
    if (!this.net.connected && this.net.leftLevel != null && level === this.net.leftLevel) return true;
    return !!this.ended && this.leftLevel != null && level === this.leftLevel;
  }

  death({ x = 0, y = 0, z = 0, cause = 'unknown' } = {}) {
    if (this.playerOff) return;
    this.stats.deaths++;
    // Death places are positions: only sent when positions are on (full mode, or positions: true).
    const where = this.positionsOn ? { x: round(x, 2), y: round(y, 2), z: round(z, 2) } : {};
    this.push({ type: 'death', ...where, cause });
    this.remember(`death:${cause}`);
    this.datadog?.action('death', { cause, ...where, level: this.level });
  }

  track(name, attrs = {}) {
    if (this.playerOff) return;
    this.push({ type: 'custom', name, attrs });
    this.remember(name);
    this.datadog?.action(name, { ...attrs, level: this.level });
    this.watchStream(name);
  }

  // A stream of events (shots, hits, kills, gold, taps): adds to the current window's count for this name and group
  // instead of queueing an event (counts.js). The string and boolean attributes are the group, numbers are added up
  // (count('gold', { source: 'loot', amount: 35 })), and `n` adds to the count.
  count(name, attrs = {}, n = 1) {
    if (this.playerOff) return;
    this.counter.add(name, attrs, n);
  }

  // What holds for this session, in the game's words: { mode: 'squads', rank: 'gold', region: 'eu' }. null removes a
  // key. Sent with the session in every privacy mode, so props.js drops keys and values that would say who the
  // player is, and the SDK keeps nothing between sessions. Changes go out at most once a window (SPEC §2 props).
  setProperties(values = {}) {
    let changed = false;
    for (const [key, value] of Object.entries(values || {})) {
      const problem = propKeyProblem(key);
      if (problem) {
        this.warnOnce(`prop:${key}`, `setProperties: "${key}" was dropped: ${problem}`);
        continue;
      }
      if (value === null || value === undefined) {
        if (key in this.props) {
          delete this.props[key];
          changed = true;
        }
        continue;
      }
      const v = propValue(value);
      if (v === undefined) {
        this.warnOnce(`propvalue:${key}`, `setProperties: the value of "${key}" was dropped: send a short word, a boolean or a whole number, never an ID, an email address, a link or a phone number`);
        continue;
      }
      if (!this.propKeys.has(key) && this.propKeys.size >= MAX_PROPS) {
        this.warnOnce(`propmax:${key}`, `setProperties: "${key}" was dropped: a session has at most ${MAX_PROPS} properties`);
        continue;
      }
      this.propKeys.add(key);
      if (this.props[key] !== v) {
        this.props[key] = v;
        changed = true;
      }
    }
    if (changed) this.propsChangedAt = Date.now();
  }

  // Marks the session's next events as one match, party or run (SPEC §2 group). Match and party IDs come from the
  // game's server, shared by everyone in that match or party (never an account, guild or friends-list ID), and are
  // hashed before they are sent unless hashGroupIds is false. setGroup('run') makes a run ID; setGroup('run', saved)
  // carries on a saved run in install and full mode, and starts a new one in anonymous mode, so nothing ties two
  // launches together (the group event says resumed either way). null ends the group. Returns the ID sent, or null.
  setGroup(kind, id, attrs) {
    if (!GROUP_KINDS.includes(kind)) {
      this.warnOnce(`group:${kind}`, `setGroup: "${kind}" isn't a group: use match, party or run`);
      return null;
    }
    if (id === null) {
      if (!this.groups[kind]) return null;
      this.closeWindowIfAny();
      delete this.groups[kind];
      delete this.groupAttrs[kind];
      this.push({ type: 'group', kind, id: null });
      return null;
    }
    let sent;
    let resumed = false;
    if (id === undefined) {
      if (kind !== 'run') {
        this.warnOnce(`groupid:${kind}`, `setGroup: a ${kind} needs the ID the game's server made for it`);
        return null;
      }
      sent = newRunId(randomId);
    } else if (!validGroupId(String(id))) {
      this.warnOnce(`groupid:${kind}`, `setGroup: "${id}" was dropped: IDs are 8 to 64 characters of A-Z, a-z, 0-9, _ . : -`);
      return null;
    } else if (kind === 'run') {
      resumed = true;
      sent = this.privacy === 'anonymous' ? newRunId(randomId) : String(id);
    } else {
      sent = this.opts.hashGroupIds === false ? String(id) : hashGroupId(this.opts.service, String(id));
    }
    this.closeWindowIfAny();
    this.groups[kind] = sent;
    const a = gameAttrs(attrs);
    if (a) this.groupAttrs[kind] = a;
    else delete this.groupAttrs[kind];
    this.push({ type: 'group', kind, id: sent, ...(a ? { attrs: a } : {}), ...(resumed ? { resumed: true } : {}) });
    return sent;
  }

  // One network sample from the game's own netcode, about once a second while connected: { rtt_ms, loss_pct,
  // jitter_ms }, and where the game knows them in_kbps, out_kbps, transport ('ws', 'socket.io', 'colyseus'…) and
  // host (true for the player hosting the game). Each frame window then carries `net` (SPEC §2). A WebRTC game can
  // use instrumentNet() (net.js) instead.
  netSample(sample = {}) {
    if (this.playerOff) return;
    const now = Date.now();
    if (!this.net.connected) {
      this.net.connected = true;
      this.net.since = now;
    }
    this.win.netOn = true;
    if (sample.transport) this.net.transport = String(sample.transport).slice(0, 32);
    if (sample.host != null) this.net.host = !!sample.host;
    if (now - this.net.lastSample < NET_SAMPLE_GAP_MS) return;
    this.net.lastSample = now;
    this.win.net.add(sample);
  }

  // The connection dropped: reason is timeout, connection_lost, kicked, server_closed, failed_to_connect or other.
  // With a level going, the attempt ends as an abandon with reason 'disconnect', never a fail; reconnect() and playing
  // on in the same level takes it back.
  disconnect({ reason = 'other' } = {}) {
    const now = Date.now();
    const numbers = this.win.net.samples ? this.win.net.summary() : this.net.last;
    if (this.net.disconnects < MAX_DISCONNECTS) {
      this.net.disconnects++;
      this.push({
        type: 'disconnect',
        reason: DISCONNECT_REASONS.has(reason) ? reason : 'other',
        connected_s: this.net.connected ? round((now - this.net.since) / 1000, 1) : 0,
        rtt_p95: numbers?.rtt_p95 ?? null,
        loss_pct: numbers?.loss_pct ?? null,
      });
      this.remember('disconnect');
    }
    this.net.connected = false;
    this.net.disconnectedAt = now;
    if (this.levelOpen && this.level != null) {
      this.net.leftLevel = this.level;
      this.abandon(this.level, 'disconnect');
    }
  }

  // Back in the game after a disconnect. A level the disconnect abandoned is open again, so the player can finish it.
  reconnect() {
    if (this.net.connected || !this.net.disconnectedAt) return;
    const now = Date.now();
    this.push({ type: 'reconnect', after_s: round((now - this.net.disconnectedAt) / 1000, 1) });
    this.remember('reconnect');
    this.net.connected = true;
    this.net.since = now;
    this.win.netOn = true;
    if (this.net.leftLevel != null && this.net.leftLevel === this.level) this.levelOpen = true;
    this.net.leftLevel = null;
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
    if (this.playerOff) return;
    if (this.render?.captureMap) return this.render.captureMap(levelId, opts);
    this.log('captureMap ignored: no engine adapter installed');
  }

  // A player's bug report: `note` is what they typed. Sends a screenshot (screenshot: false leaves it out), where
  // they are and what just happened. Resolves { sent: true }, or { sent: false, reason: 'offline' | 'error' }.
  async reportBug({ note = '', screenshot = true } = {}) {
    if (this.playerOff) return { sent: false, reason: 'off' };
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
    if (typeof window === 'undefined' || this.playerOff) return;
    if (!this.bugForm) this.bugForm = new BugReportForm(this, { hotkey: null, ...(typeof this.opts.bugReports === 'object' ? this.opts.bugReports : {}) });
    this.bugForm.open();
  }

  // The player's "share performance data" setting (SPEC §4d), saved on the device so it holds from the start of the
  // next visit. Off stops measuring and sending at once, drops what's waiting and ends the session without a
  // session_end: after the player says no, nothing more goes out. On again starts a new session. A call that changes
  // nothing does nothing, so a game can pass its own saved setting every time it starts.
  setEnabled(on) {
    const off = !on;
    saveChoice(!off);
    if (off === this.playerOff) return;
    this.playerOff = off;
    if (off) this.stop();
    else this.restart();
    this.log(off ? 'turned off by the player' : 'turned on by the player', { session: this.sessionId });
  }

  // Whether Glitchless is on: it has somewhere to send and the player hasn't turned it off.
  isEnabled() {
    return !this.playerOff && !!this.opts.intake;
  }

  // Nothing more is measured or sent, and what was waiting goes: the queue, the open window with its counts and
  // positions, hitches waiting for their causes, counts waiting for /v1/health and batches waiting to go again. What
  // the game has said (its level, properties, groups, zone and gauges) stays, for a session started later.
  stop() {
    this.gen++;
    this.queue = [];
    this.retries = [];
    this.heldCounts = [];
    this.pendingHitches = [];
    this.posBuffer = [];
    this.counter = new Counter();
    this.win = this.newWindow();
    this.loadOff = true;
    this.skipFrame();
    this.stats.lastStatus = 'off';
    this.datadog?.setEnabled(false);
  }

  // Back on: a new session, as a new page load would start, with the properties and groups still set. The attempt
  // that was going isn't part of it (offLevel), and the load event isn't sent again.
  restart() {
    this.sessionId = 's_' + randomId(16);
    this.startedAt = Date.now();
    this.sessionStartSent = false;
    this.ended = false;
    this.leftLevel = null;
    if (this.levelOpen && this.level != null) {
      this.offLevel = this.level;
      this.levelOpen = false;
    }
    this.recent = [];
    this.history = [];
    this.errorCounts.clear();
    this.sentProps = {};
    this.propsChangedAt = 0;
    this.propKeys = new Set(Object.keys(this.props));
    this.net.disconnects = 0;
    this.net.leftLevel = null;
    this.win = this.newWindow();
    this.skipFrame();
    this.stats.lastStatus = 'idle';
    for (const kind of GROUP_KINDS) {
      if (this.groups[kind]) this.push({ type: 'group', kind, id: this.groups[kind], ...(this.groupAttrs[kind] ? { attrs: this.groupAttrs[kind] } : {}) });
    }
    if (this.opts.datadog && !this.datadog) this.datadog = new DatadogBridge(this.opts);
    else this.datadog?.setEnabled(true);
    if (typeof window !== 'undefined') this.checkFeatures();
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
    if (this.playerOff) return Promise.resolve('Glitchless is turned off on this device (setEnabled(false), the player\'s setting), so it measures nothing. setEnabled(true) turns it back on.');
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
      net: new NetWindow(),
      netOn: this.net.connected, // connected at some point in the window: it carries `net`
    };
  }

  // levelStart, setZone and setGroup close the window, so what it holds keeps its level, zone and groups.
  closeWindowIfAny() {
    if (this.win.frames || this.posBuffer.length || this.counter.size || this.counter.dropped) this.closeWindow();
  }

  // The fields every event carries besides `level`: the zone and groups, while they are set.
  stamps() {
    const s = {};
    if (this.zone != null) s.zone = this.zone;
    for (const kind of GROUP_KINDS) if (this.groups[kind]) s[kind] = this.groups[kind];
    return s;
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
    if (this.playerOff) return;
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
        ...this.stamps(),
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
    if (this.playerOff) return;
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
    if (this.ended || this.playerOff) return;
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
      if (!this.firstInputAt && this.firstFrameAt && !this.loadOff) {
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
    if (!this.position || document.hidden || this.playerOff) return;
    const [x, y, z] = this.position;
    this.posBuffer.push([Date.now(), round(x, 2), round(y, 2), round(z, 2)]);
  }

  // ───────────────────────────── transport ─────────────────────────────

  push(event) {
    if (this.playerOff) return;
    const e = { ts: Date.now(), level: this.level, ...this.stamps(), ...event };
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
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    // The properties set so far go with the start; later changes go in props events (closeWindow).
    this.sentProps = { ...this.props };
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
      ...(Object.keys(this.sentProps).length ? { props: { ...this.sentProps } } : {}),
    };
  }

  // The keys that changed since the server last heard, with null for a key removed: one props event a window at most.
  propsChange() {
    const at = this.propsChangedAt;
    if (!this.sessionStartSent || !at) return null;
    const props = {};
    for (const [k, v] of Object.entries(this.props)) if (this.sentProps[k] !== v) props[k] = v;
    for (const k of Object.keys(this.sentProps)) if (!(k in this.props)) props[k] = null;
    this.propsChangedAt = 0;
    if (!Object.keys(props).length) return null;
    this.sentProps = { ...this.props };
    return { type: 'props', ts: at, props };
  }

  closeWindow() {
    const w = this.win;
    this.win = this.newWindow();
    if (this.playerOff) return;
    const stamps = this.stamps();
    const props = this.propsChange();
    if (props) this.push(props);
    if (w.frames > 0) {
      const mem = this.render?.memory?.() || {};
      const s = w.sketch;
      const net = w.netOn ? this.netWindow(w.net) : null;
      this.queue.push({
        type: 'frame_window',
        ts: w.startedAt,
        level: this.level,
        ...stamps,
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
        ...(net ? { net } : {}),
      });
      this.datadog?.frameWindow(this.queue[this.queue.length - 1]);
      this.recentWindows.push({ ts: w.startedAt, level: this.level, fps: round(w.frames / ((Date.now() - w.startedAt) / 1000), 1), p95: round(s.quantile(0.95), 2) });
      if (this.recentWindows.length > 12) this.recentWindows.shift();
    }
    if (w.net.samples) this.net.last = w.net.summary();
    if (this.posBuffer.length) {
      this.queue.push({ type: 'pos', ts: this.posBuffer[0][0], level: this.level, ...stamps, pts: this.posBuffer });
      this.posBuffer = [];
    }
    const counted = this.counter.drain();
    if (counted) {
      this.queue.push({ type: 'counts', ts: w.startedAt, level: this.level, ...stamps, duration_s: round((Date.now() - w.startedAt) / 1000, 2), dropped: counted.dropped, counts: counted.counts });
    }
    this.resolveHitches();
  }

  // A window's network numbers (SPEC §2 frame_window.net): its samples, the library and the kind of connection.
  netWindow(win) {
    return { ...win.summary(), transport: this.net.transport, link: readLink(), host: this.net.host };
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
    if (this.playerOff) return;
    if (beacon) this.closeWindow(); // page hide/close: ship the partial window too
    this.lastFlushAt = Date.now();
    if (!this.sessionStartSent && (this.render || Date.now() - this.startedAt > 3000 || beacon)) {
      this.queue.unshift(this.sessionStartEvent());
      this.sessionStartSent = true;
      if (this.firstFrameAt && !this.loadOff) this.queue.push({ type: 'load', ts: this.firstFrameWall, level: this.level, ttff_ms: Math.round(this.firstFrameAt), assets: this.render?.assetStats?.() || null });
    }
    if ((!this.queue.length && !this.retries.length) || !this.sessionStartSent) return;
    if (!this.opts.intake || !this.sampled) {
      this.queue = [];
      this.retries = [];
      this.stats.lastStatus = this.opts.intake ? 'unsampled' : 'offline';
      return;
    }
    const events = this.gateCounts(this.queue);
    this.queue = [];
    if (!events.length && !this.retries.length) return;
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
    const gen = this.gen;
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
      // Turned off while the batch was being compressed: it doesn't go at all.
      .then((payload) => (gen !== this.gen ? null : fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' }, keepalive: (payload.byteLength ?? payload.length) < BEACON_LIMIT })))
      .then((r) => {
        if (gen !== this.gen || !r) return false; // the player turned Glitchless off meanwhile: what it was is gone
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
        if (gen !== this.gen) return false;
        this.stats.failed += events.length;
        this.stats.lastStatus = 'error';
        this.log('send failed', err.message);
        const waiting = this.retries.reduce((n, b) => n + b.events.length, 0);
        if (waiting + events.length <= MAX_RETRY_EVENTS) this.retries.push({ id, events, big: events.length === 1 && (events[0].type === 'map' || events[0].type === 'bug_report') });
        return false;
      });
  }

  // Counters go only to a server that reads them (SPEC §2 counts): an older one would drop them and show half the
  // game's numbers. Until /v1/health has said, they wait; a server without "counts" gets none, and a warning says so.
  gateCounts(events) {
    if (this.hasFeature('counts')) {
      const held = this.heldCounts;
      this.heldCounts = [];
      return held.length ? [...held, ...events] : events;
    }
    if (!events.some((e) => e.type === 'counts')) return events;
    if (this.features) {
      this.warnOnce('counts', 'count(): this Glitchless server does not read counters yet, so they are not sent. Update the server.');
    } else {
      this.heldCounts.push(...events.filter((e) => e.type === 'counts'));
      if (this.heldCounts.length > MAX_HELD_COUNTS) this.heldCounts.splice(0, this.heldCounts.length - MAX_HELD_COUNTS);
      this.checkFeatures();
    }
    return events.filter((e) => e.type !== 'counts');
  }

  hasFeature(name) {
    return !!this.features?.has(name);
  }

  // Asks the server what it reads (GET /v1/health → features): once, and again a minute after a failed try.
  checkFeatures() {
    if (this.playerOff || this.features || this.featuresAsked > Date.now() - 60_000 || !this.opts.intake || !this.sampled) return;
    this.featuresAsked = Date.now();
    this.featuresCheck = Promise.resolve()
      .then(() => {
        if (!this.playerOff) return fetch(`${this.opts.intake}/v1/health`);
        this.featuresAsked = 0; // turned off before it went: asked again once back on
        return null;
      })
      .then((r) => (r?.ok ? r.json() : null))
      .then((health) => {
        if (!health) return;
        this.features = featureSet(health.features);
      })
      .catch(() => {});
  }

  // Calls a game makes so often that they'd crowd out everything else: warns once, outside prod, naming count().
  watchStream(name) {
    if (this.opts.env === 'prod' && !this.opts.debug) return;
    const second = Math.floor(Date.now() / 1000);
    const rate = this.trackRate.get(name);
    if (!rate || rate[0] !== second) {
      this.trackRate.set(name, [second, 1]);
      if (this.trackRate.size > 200) this.trackRate.clear();
      return;
    }
    if (++rate[1] > STREAM_PER_SECOND) this.warnOnce(`stream:${name}`, `track('${name}') is called more than ${STREAM_PER_SECOND} times a second. Use glitchless.count('${name}', attrs) for a stream like this: it sends one total a window instead of an event per call.`);
  }

  // A mistake in the game's calls, said once in the console outside prod (or with debug on).
  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (this.opts.env !== 'prod' || this.opts.debug) console.warn('[glitchless]', message);
  }

  log(...args) {
    if (this.opts.debug) console.debug('[glitchless]', ...args);
  }
}

// /v1/health's features, as a list of names or an object of flags.
function featureSet(features) {
  if (Array.isArray(features)) return new Set(features.map(String));
  if (features && typeof features === 'object') return new Set(Object.keys(features).filter((k) => features[k]));
  return new Set();
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

// The player's switch (SPEC §4d): 'on' or 'off', kept once the game has called setEnabled; null before that. Without
// localStorage it lasts the page load, and the game passes its own setting.
function loadChoice() {
  try {
    const v = localStorage.getItem('glitchless.enabled');
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

function saveChoice(on) {
  try {
    localStorage.setItem('glitchless.enabled', on ? 'on' : 'off');
  } catch {}
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
export function topFrame(stack) {
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
