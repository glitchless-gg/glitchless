// Exports Glitchless telemetry over OTLP/HTTP with JSON bodies, so any OpenTelemetry backend can take it
// (a Collector, Grafana, Honeycomb, New Relic, Datadog's OTLP intake) without an OpenTelemetry SDK:
//   • frame times → glitchless.frame.time, an exponential histogram rebuilt from each player's sketch
//   • frames, slow frames, hitches, sessions, level starts/completes/fails, deaths, errors → counters
//   • gameplay + errors → log records; errors carry exception.type/message/stacktrace
// The game build is the resource (service.name, service.version, deployment.environment.name). Level,
// GPU tier, browser and session type are data point attributes. session.id and user.id go on log records
// only: one metric stream per session would blow up any backend's cardinality.
//
// Metrics are aggregated in this process and exported after each intake request (or every
// OTEL_METRIC_EXPORT_INTERVAL ms), the way an OpenTelemetry SDK would, with delta or cumulative
// temporality. A per-process service.instance.id keeps each server instance the single writer of its
// streams. Points carry the server's clock; log records keep the game's own timestamps.

import { randomUUID } from 'node:crypto';
import { LOG_TYPES, SessionContext, describe, errorType, chunk, redactUrl, levelOutcome } from './events.js';

export const SCOPE = { name: 'glitchless', version: '0.1.0' };
export const DELTA = 1;
export const CUMULATIVE = 2;
// Scale 5 is 32 buckets per doubling (~2.2% wide), so rebucketing the SDK's 2% sketch adds about 1% error.
export const MAX_SCALE = 5;
export const MAX_BUCKETS = 160; // the OpenTelemetry SDKs' default
export const ZERO_THRESHOLD = 1e-3; // the SDK sketch counts frames under 1 µs as zeros
const MAX_STREAMS = 10_000;
const MAX_LOGS_PER_REQUEST = 512;
const MAX_RETRIES = 2;
const RETRYABLE = new Set([429, 502, 503, 504]);

export const METRICS = {
  'glitchless.frame.time': { unit: 'ms', description: "Frame time, merged from every player's frame-time sketch", histogram: true },
  'glitchless.frame.count': { unit: '{frame}', description: 'Frames rendered' },
  'glitchless.frame.slow': { unit: '{frame}', description: "Frames slower than 1.5x the display's frame budget" },
  'glitchless.frame.hitches': { unit: '{hitch}', description: 'Frames over 50 ms and twice the recent median' },
  'glitchless.sessions': { unit: '{session}', description: 'Game sessions started' },
  'glitchless.level.starts': { unit: '{level}', description: 'Levels started' },
  'glitchless.level.completes': { unit: '{level}', description: 'Levels completed' },
  'glitchless.level.fails': { unit: '{level}', description: 'Levels failed' },
  'glitchless.level.abandons': { unit: '{level}', description: 'Levels left before they ended' },
  'glitchless.deaths': { unit: '{death}', description: 'Player deaths' },
  'glitchless.errors': { unit: '{error}', description: 'Errors caught by the game SDK' },
};

const COUNTERS = { session_start: 'glitchless.sessions', level_start: 'glitchless.level.starts', level_complete: 'glitchless.level.completes', level_fail: 'glitchless.level.fails', level_abandon: 'glitchless.level.abandons' };

export class OtlpExporter {
  constructor({
    endpoint = null,
    metricsEndpoint = null,
    logsEndpoint = null,
    headers = {},
    metricsHeaders = {},
    logsHeaders = {},
    signals = ['metrics', 'logs'],
    temporality = 'cumulative',
    timeoutMs = 10_000,
    intervalMs = 0,
    resourceAttributes = {},
    protocol = null,
    retryBaseMs = 500,
    fetch = globalThis.fetch,
    logger = console,
    now = Date.now,
  }) {
    this.kind = 'otlp';
    this.endpoint = endpoint;
    this.urls = {
      metrics: signals.includes('metrics') ? metricsEndpoint || signalUrl(endpoint, 'v1/metrics') : null,
      logs: signals.includes('logs') ? logsEndpoint || signalUrl(endpoint, 'v1/logs') : null,
    };
    this.headers = { metrics: { ...headers, ...metricsHeaders }, logs: { ...headers, ...logsHeaders } };
    this.temporality = ['delta', 'lowmemory'].includes(String(temporality).toLowerCase()) ? DELTA : CUMULATIVE;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this.resourceAttributes = resourceAttributes;
    this.retryBaseMs = retryBaseMs;
    this.fetch = fetch;
    this.logger = logger;
    this.now = now;
    this.instanceId = randomUUID();
    this.sessions = new SessionContext();
    this.aggregator = new Aggregator({ delta: this.temporality === DELTA, now, logger });
    this.timer = null;
    this.stats = { sent: { metrics: 0, logs: 0 }, rejected: { metrics: 0, logs: 0 }, failures: 0, lastError: null, lastSuccessAt: null, lastFailureAt: null };
    if (protocol && protocol !== 'http/json') logger.warn(`[otlp] Glitchless sends OTLP/HTTP JSON; protocol ${protocol} is ignored`);
  }

  get enabled() {
    return !!(this.urls.metrics || this.urls.logs);
  }

  async export(events) {
    if (!this.enabled || !events.length) return;
    const logs = [];
    for (const e of events) {
      const s = this.sessions.observe(e);
      if (this.urls.metrics) this.record(e, s);
      if (this.urls.logs && LOG_TYPES.has(e.type)) logs.push({ game: gameOf(e), record: logRecord(e, s, this.now()) });
    }
    const jobs = chunk(logs, MAX_LOGS_PER_REQUEST).map((batch) => this.send('logs', logsRequest(batch, { resource: (g) => this.resource(g) }), batch.length));
    if (this.urls.metrics) jobs.push(this.intervalMs > 0 ? this.schedule() : this.flush());
    await Promise.all(jobs);
  }

  record(e, s) {
    const game = gameOf(e);
    const attrs = pointAttributes(e, s);
    const agg = this.aggregator;
    switch (e.type) {
      case 'frame_window':
        if (e.ft) agg.addSketch(game, attrs, e.ft);
        agg.add(game, 'glitchless.frame.count', attrs, e.frames);
        agg.add(game, 'glitchless.frame.slow', attrs, e.slow);
        agg.add(game, 'glitchless.frame.hitches', attrs, e.hitches);
        break;
      case 'death':
        agg.add(game, 'glitchless.deaths', { ...attrs, 'game.cause': String(e.cause ?? 'unknown') }, 1);
        break;
      case 'error':
        agg.add(game, 'glitchless.errors', { ...attrs, 'error.type': String(e.kind ?? 'unknown') }, 1);
        break;
      default:
        if (COUNTERS[levelOutcome(e)]) agg.add(game, COUNTERS[levelOutcome(e)], attrs, 1);
    }
  }

  resource(game) {
    return {
      ...this.resourceAttributes,
      'service.name': game.service,
      'service.version': game.version,
      'deployment.environment.name': game.env,
      'service.instance.id': this.instanceId,
    };
  }

  schedule() {
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  // Export every metric stream that changed since the last flush.
  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const points = this.aggregator.collect();
    if (!points.length) return;
    await this.send('metrics', metricsRequest(points, { temporality: this.temporality, resource: (g) => this.resource(g) }), points.length);
  }

  async send(signal, request, n) {
    const body = JSON.stringify(request);
    let error = null;
    let wait = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      wait = this.retryBaseMs * 2 ** attempt;
      try {
        const res = await this.fetch(this.urls[signal], {
          method: 'POST',
          headers: { ...this.headers[signal], 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return this.accepted(signal, n, await res.json().catch(() => null));
        error = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim();
        if (!RETRYABLE.has(res.status)) break;
        const after = Number(res.headers.get('retry-after'));
        if (after > 0) wait = Math.min(after * 1000, 5000);
      } catch (err) {
        error = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
      }
    }
    this.stats.failures++;
    this.stats.lastError = `${signal}: ${error}`;
    this.stats.lastFailureAt = Date.now();
    if (this.stats.failures <= 3 || this.stats.failures % 100 === 0) this.logger.warn(`[otlp] ${signal} export failed: ${error}`);
  }

  // A 2xx can still carry a partial success: the receiver dropped some points or records.
  accepted(signal, n, reply) {
    const partial = reply?.partialSuccess;
    const rejected = Number(partial?.rejectedDataPoints ?? partial?.rejectedLogRecords ?? 0) || 0;
    this.stats.sent[signal] += n - rejected;
    this.stats.lastSuccessAt = Date.now();
    if (rejected || partial?.errorMessage) {
      this.stats.rejected[signal] += rejected;
      this.stats.lastError = `${signal}: ${rejected} rejected${partial.errorMessage ? ` (${partial.errorMessage})` : ''}`;
    }
  }

  status() {
    return {
      kind: this.kind,
      target: redactUrl(this.endpoint) || redactUrl(this.urls.metrics || this.urls.logs),
      protocol: 'http/json',
      signals: Object.keys(this.urls).filter((k) => this.urls[k]),
      endpoints: { metrics: redactUrl(this.urls.metrics), logs: redactUrl(this.urls.logs) },
      headers: [...new Set([...Object.keys(this.headers.metrics), ...Object.keys(this.headers.logs)])],
      temporality: this.temporality === DELTA ? 'delta' : 'cumulative',
      sent: { ...this.stats.sent },
      rejected: { ...this.stats.rejected },
      failures: this.stats.failures,
      last_error: this.stats.lastError,
      last_success_at: this.stats.lastSuccessAt,
      last_failure_at: this.stats.lastFailureAt,
    };
  }

  async shutdown() {
    await this.flush();
  }
}

// Settings from the standard OpenTelemetry env vars. Only signals with an endpoint are exported, so with
// no OTEL_EXPORTER_OTLP_*ENDPOINT set this returns null and nothing is sent.
export function otlpSettingsFromEnv(env = process.env) {
  if (env.GLITCHLESS_OTLP === 'off' || String(env.OTEL_SDK_DISABLED).toLowerCase() === 'true') return null;
  const signals = ['metrics', 'logs'].filter((s) => {
    const S = s.toUpperCase();
    return env[`OTEL_${S}_EXPORTER`] !== 'none' && (env.OTEL_EXPORTER_OTLP_ENDPOINT || env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]);
  });
  if (!signals.length) return null;
  return {
    kind: 'otlp',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    metricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || null,
    logsEndpoint: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || null,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    metricsHeaders: parseHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
    logsHeaders: parseHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
    signals,
    temporality: env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE || 'cumulative',
    timeoutMs: positive(env.OTEL_EXPORTER_OTLP_TIMEOUT) ?? 10_000,
    intervalMs: positive(env.OTEL_METRIC_EXPORT_INTERVAL) ?? 0,
    resourceAttributes: parseHeaders(env.OTEL_RESOURCE_ATTRIBUTES),
    protocol: env.OTEL_EXPORTER_OTLP_PROTOCOL || null,
  };
}

// "key1=value1,key2=value2", values percent-encoded: the format of OTEL_EXPORTER_OTLP_HEADERS and
// OTEL_RESOURCE_ATTRIBUTES.
export function parseHeaders(s) {
  const out = {};
  for (const part of String(s ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = decode(part.slice(0, i).trim());
    if (key) out[key] = decode(part.slice(i + 1).trim());
  }
  return out;
}

export function signalUrl(base, path) {
  return base ? `${base.replace(/\/+$/, '')}/${path}` : null;
}

// ─────────────────────────── metrics ───────────────────────────

// One stream per (game build, metric, attribute set), summed in this process between exports.
class Aggregator {
  constructor({ delta, now, logger }) {
    this.delta = delta;
    this.now = now;
    this.logger = logger;
    this.streams = new Map();
    this.startedAt = now();
    this.lastCollect = this.startedAt;
    this.dropped = 0;
  }

  stream(game, name, attrs) {
    const key = JSON.stringify([game.service, game.version, game.env, name, attrs]);
    let s = this.streams.get(key);
    if (!s) {
      // Cumulative streams live as long as the process; past the cap, new ones are dropped, not evicted,
      // so no stream ever restarts from zero without a new start time.
      if (this.streams.size >= MAX_STREAMS) {
        if (this.dropped++ === 0) this.logger.warn(`[otlp] over ${MAX_STREAMS} metric streams; dropping new ones`);
        return null;
      }
      s = { game, name, attrs, value: 0, hist: null, dirty: false };
      this.streams.set(key, s);
    }
    s.dirty = true;
    return s;
  }

  add(game, name, attrs, n) {
    if (!(n > 0)) return;
    const s = this.stream(game, name, attrs);
    if (s) s.value += n;
  }

  addSketch(game, attrs, ft) {
    const s = this.stream(game, 'glitchless.frame.time', attrs);
    if (s) s.hist = addSketch(s.hist ?? emptyHistogram(), ft);
  }

  // Delta: each point covers the time since the previous collect, and the stream starts over.
  // Cumulative: each point covers the time since this process started.
  collect() {
    const time = Math.max(this.now(), this.lastCollect + 1);
    const start = this.delta ? this.lastCollect : this.startedAt;
    const points = [];
    for (const [key, s] of this.streams) {
      if (!s.dirty) continue;
      points.push({ game: s.game, name: s.name, attrs: s.attrs, value: s.value, hist: s.hist, start, time });
      s.dirty = false;
      if (this.delta) this.streams.delete(key);
    }
    this.lastCollect = time;
    return points;
  }
}

export function emptyHistogram() {
  return { bins: new Map(), count: 0, zero: 0, sum: 0, min: Infinity, max: -Infinity };
}

// Fold one client sketch (packages/sdk/src/sketch.js, or its Godot port) into an exponential histogram.
// Each sketch bin goes, at its representative value, into the scale-5 bucket that contains it.
export function addSketch(h, ft) {
  const a = ft.a || 0.02;
  const gamma = (1 + a) / (1 - a);
  for (const [k, c] of Object.entries(ft.b || {})) {
    if (!(c > 0)) continue;
    const i = bucketIndex((2 * gamma ** Number(k)) / (gamma + 1));
    h.bins.set(i, (h.bins.get(i) || 0) + c);
    h.count += c;
  }
  if (ft.z > 0) {
    h.zero += ft.z;
    h.count += ft.z;
  }
  h.sum += ft.s || 0;
  if (ft.mn != null) h.min = Math.min(h.min, ft.mn);
  if (ft.mx != null) h.max = Math.max(h.max, ft.mx);
  return h;
}

// Bucket i at scale s holds values in (base^i, base^(i+1)], base = 2^(2^-s).
export function bucketIndex(v, scale = MAX_SCALE) {
  return Math.ceil(Math.log2(v) * 2 ** scale) - 1;
}

// Dense bucket counts, halving the resolution (scale - 1, index >> 1) until they fit in maxBuckets.
export function exponentialBuckets(bins, maxBuckets = MAX_BUCKETS) {
  if (!bins.size) return { scale: MAX_SCALE, offset: 0, bucketCounts: [] };
  const keys = [...bins.keys()];
  const lo = Math.min(...keys);
  const hi = Math.max(...keys);
  let shift = 0;
  while ((hi >> shift) - (lo >> shift) >= maxBuckets) shift++;
  const offset = lo >> shift;
  const bucketCounts = new Array((hi >> shift) - offset + 1).fill(0);
  for (const [i, c] of bins) bucketCounts[(i >> shift) - offset] += c;
  return { scale: MAX_SCALE - shift, offset, bucketCounts };
}

// ExportMetricsServiceRequest, in the OTLP JSON encoding.
export function metricsRequest(points, { temporality, resource }) {
  const byGame = new Map();
  for (const p of points) {
    const gkey = JSON.stringify(p.game);
    if (!byGame.has(gkey)) byGame.set(gkey, { game: p.game, metrics: new Map() });
    const metrics = byGame.get(gkey).metrics;
    if (!metrics.has(p.name)) metrics.set(p.name, metricShell(p.name, temporality));
    const m = metrics.get(p.name);
    (m.sum || m.exponentialHistogram).dataPoints.push(dataPoint(p));
  }
  return {
    resourceMetrics: [...byGame.values()].map(({ game, metrics }) => ({
      resource: { attributes: keyValues(resource(game)) },
      scopeMetrics: [{ scope: SCOPE, metrics: [...metrics.values()] }],
    })),
  };
}

function metricShell(name, temporality) {
  const { unit, description, histogram } = METRICS[name];
  return histogram
    ? { name, unit, description, exponentialHistogram: { aggregationTemporality: temporality, dataPoints: [] } }
    : { name, unit, description, sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: [] } };
}

function dataPoint(p) {
  const point = { attributes: keyValues(p.attrs), startTimeUnixNano: nanos(p.start), timeUnixNano: nanos(p.time) };
  if (!p.hist) return { ...point, asInt: String(Math.round(p.value)) };
  const h = p.hist;
  const { scale, offset, bucketCounts } = exponentialBuckets(h.bins);
  return {
    ...point,
    count: String(h.count),
    sum: Math.round(h.sum * 1000) / 1000,
    scale,
    zeroCount: String(h.zero),
    zeroThreshold: ZERO_THRESHOLD,
    positive: { offset, bucketCounts: bucketCounts.map(String) },
    ...(Number.isFinite(h.min) ? { min: h.min, max: h.max } : {}),
  };
}

function pointAttributes(e, s) {
  const attrs = {};
  if (e.level) attrs['game.level'] = String(e.level);
  if (s.gpu_tier) attrs['game.gpu_tier'] = s.gpu_tier;
  if (s.browser) attrs['user_agent.name'] = s.browser;
  if (s.session_type) attrs['game.session_type'] = s.session_type;
  return attrs;
}

// ─────────────────────────── logs ───────────────────────────

const SEVERITY = { error: [17, 'ERROR'], hitch: [13, 'WARN'] };

export function logRecord(e, s = {}, observedAt = Date.now()) {
  let { service, env, version, received, ft, type, ts, level, session_id, player_id, ...rest } = e;
  const attrs = {
    'game.event': type,
    'session.id': session_id,
    'user.id': player_id,
    'game.level': level,
    'game.gpu_tier': s.gpu_tier,
    'user_agent.name': s.browser,
    'game.session_type': s.session_type,
  };
  if (type === 'error') {
    const { kind, message, stack, fingerprint, ...more } = rest;
    rest = more;
    Object.assign(attrs, { 'exception.type': errorType(e), 'exception.message': message, 'exception.stacktrace': stack, 'error.type': kind, 'game.error.fingerprint': fingerprint });
  }
  // Everything else the event carries (cause, x/y, durations, hitch causes, custom attrs) goes under game.*.
  for (const [k, v] of Object.entries(rest)) attrs[`game.${k}`] ??= v;
  const [severityNumber, severityText] = SEVERITY[type] || [9, 'INFO'];
  return {
    timeUnixNano: nanos(ts),
    observedTimeUnixNano: nanos(received ?? observedAt),
    severityNumber,
    severityText,
    eventName: `glitchless.${type}`,
    body: { stringValue: describe(e) },
    attributes: keyValues(attrs),
  };
}

// ExportLogsServiceRequest, in the OTLP JSON encoding.
export function logsRequest(entries, { resource }) {
  const byGame = new Map();
  for (const { game, record } of entries) {
    const gkey = JSON.stringify(game);
    if (!byGame.has(gkey)) byGame.set(gkey, { game, records: [] });
    byGame.get(gkey).records.push(record);
  }
  return {
    resourceLogs: [...byGame.values()].map(({ game, records }) => ({
      resource: { attributes: keyValues(resource(game)) },
      scopeLogs: [{ scope: SCOPE, logRecords: records }],
    })),
  };
}

// ─────────────────────────── encoding ───────────────────────────

export function keyValues(obj, depth = 0) {
  const out = [];
  for (const [key, v] of Object.entries(obj || {})) {
    const value = anyValue(v, depth);
    if (value) out.push({ key, value });
  }
  return out;
}

// Numbers are always doubles, so an attribute never flips type between records (x=10 vs x=10.5).
export function anyValue(v, depth = 0) {
  if (v == null || depth > 4) return undefined;
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { doubleValue: v } : undefined;
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => anyValue(x, depth + 1)).filter(Boolean) } };
  if (typeof v === 'object') return { kvlistValue: { values: keyValues(v, depth + 1) } };
  return undefined;
}

function nanos(ms) {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function gameOf(e) {
  return { service: e.service, version: e.version, env: e.env };
}

function positive(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
