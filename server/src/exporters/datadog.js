// Forwards Glitchless telemetry into a real Datadog org with nothing but an API key:
//   • frame times → Datadog *distribution* metric (server-side DDSketch, so p95 across all players is exact)
//   • game KPIs   → gauges / counts tagged service, env, version, level, gpu_tier, browser
//   • gameplay + errors → Logs (errors carry error.kind/message/stack, so they land in Error Tracking)
//   • first sighting of a version → Event (shows as a deployment marker on dashboards)

import { LOG_TYPES, SessionContext, describe, errorType, slug, chunk } from './events.js';

export class DatadogExporter {
  constructor({ apiKey, site = 'datadoghq.com', fetch = globalThis.fetch, logger = console }) {
    this.kind = 'datadog';
    this.apiKey = apiKey;
    this.site = site;
    this.fetch = fetch;
    this.logger = logger;
    this.sessions = new SessionContext();
    this.seenVersions = new Set();
    this.stats = { metrics: 0, logs: 0, events: 0, failures: 0, lastError: null, lastSuccessAt: null, lastFailureAt: null };
  }

  get enabled() {
    return !!this.apiKey;
  }

  async export(events) {
    if (!this.enabled || !events.length) return;
    const series = [];
    const distributions = [];
    const logs = [];
    const versionEvents = [];
    for (const e of events) {
      this.sessions.observe(e);
      if (e.type === 'session_start') {
        const vkey = `${e.service}@${e.version}`;
        if (!this.seenVersions.has(vkey)) {
          this.seenVersions.add(vkey);
          versionEvents.push(e);
        }
      }
      const tags = this.tags(e);
      const ts = Math.floor(e.ts / 1000);
      switch (e.type) {
        case 'frame_window': {
          if (e.ft?.b) distributions.push({ metric: 'glitchless.frame.time', points: [[ts, expandSketch(e.ft)]], tags, type: 'distribution' });
          gauge(series, 'glitchless.frame.fps', ts, e.fps, tags);
          gauge(series, 'glitchless.frame.p95', ts, e.ft_p95, tags);
          gauge(series, 'glitchless.render.draw_calls', ts, e.draw_calls, tags);
          gauge(series, 'glitchless.render.triangles', ts, e.triangles, tags);
          gauge(series, 'glitchless.render.cpu_ms', ts, e.render_ms, tags);
          gauge(series, 'glitchless.memory.geometries', ts, e.geometries, tags);
          gauge(series, 'glitchless.memory.textures', ts, e.textures, tags);
          gauge(series, 'glitchless.memory.heap_mb', ts, e.heap_mb, tags);
          count(series, 'glitchless.frame.hitches', ts, e.hitches || 0, tags);
          count(series, 'glitchless.frame.count', ts, e.frames || 0, tags);
          for (const [k, v] of Object.entries(e.ctx || {})) gauge(series, `glitchless.context.${slug(k)}`, ts, v, tags);
          break;
        }
        case 'session_start':
          count(series, 'glitchless.sessions', ts, 1, tags);
          break;
        case 'level_start':
          count(series, 'glitchless.level.starts', ts, 1, tags);
          break;
        case 'level_complete':
          count(series, 'glitchless.level.completes', ts, 1, tags);
          gauge(series, 'glitchless.level.duration', ts, e.duration_s, tags);
          break;
        case 'level_fail':
          count(series, 'glitchless.level.fails', ts, 1, tags);
          break;
        case 'death':
          count(series, 'glitchless.deaths', ts, 1, [...tags, `cause:${slug(e.cause)}`]);
          break;
        case 'error':
          count(series, 'glitchless.errors', ts, 1, [...tags, `error_kind:${e.kind}`]);
          break;
        case 'load':
          if (e.ttff_ms != null) gauge(series, 'glitchless.load.time_to_first_frame', ts, e.ttff_ms, tags);
          break;
      }
      if (LOG_TYPES.has(e.type)) logs.push(this.toLog(e, tags));
    }
    await Promise.allSettled([
      series.length && this.post(`https://api.${this.site}/api/v2/series`, { series }, 'metrics', series.length),
      distributions.length && this.post(`https://api.${this.site}/api/v1/distribution_points`, { series: distributions }, 'metrics', distributions.length),
      ...chunk(logs, 500).map((batch) => this.post(`https://http-intake.logs.${this.site}/api/v2/logs`, batch, 'logs', batch.length)),
      ...versionEvents.map((e) =>
        this.post(
          `https://api.${this.site}/api/v1/events`,
          {
            title: `${e.service} ${e.version} is live`,
            text: `First Glitchless session from ${e.service} ${e.version} (${e.env}).`,
            tags: [`service:${e.service}`, `env:${e.env}`, `version:${e.version}`, 'source:glitchless'],
            source_type_name: 'glitchless',
            alert_type: 'info',
          },
          'events',
          1,
        ),
      ),
    ]);
  }

  tags(e) {
    const s = this.sessions.get(e.session_id);
    const tags = [`service:${e.service}`, `env:${e.env}`, `version:${e.version}`, 'source:glitchless'];
    if (e.level) tags.push(`level:${slug(e.level)}`);
    if (s.gpu_tier) tags.push(`gpu_tier:${s.gpu_tier}`);
    if (s.browser) tags.push(`browser:${slug(s.browser)}`);
    if (s.session_type) tags.push(`session_type:${s.session_type}`);
    return tags;
  }

  toLog(e, tags) {
    const { service, env, version, received, ft, ...rest } = e;
    const log = {
      ddsource: 'glitchless',
      service,
      hostname: 'browser',
      ddtags: tags.join(','),
      message: describe(e),
      status: e.type === 'error' ? 'error' : e.type === 'hitch' ? 'warn' : 'info',
      date: e.ts,
      game: { event: e.type, level: e.level, session_id: e.session_id, player_id: e.player_id },
      session_id: e.session_id,
      usr: { id: e.player_id },
      ...rest,
    };
    if (e.type === 'error') {
      // Standard error attributes → Datadog Error Tracking groups these as issues.
      log.error = { kind: errorType(e), message: e.message, stack: e.stack, fingerprint: e.fingerprint };
    }
    return log;
  }

  async post(url, body, kind, n) {
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'DD-API-KEY': this.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      this.stats[kind] += n;
      this.stats.lastSuccessAt = Date.now();
    } catch (err) {
      this.stats.failures++;
      this.stats.lastError = `${kind}: ${err.message}`;
      this.stats.lastFailureAt = Date.now();
      if (this.stats.failures <= 3 || this.stats.failures % 100 === 0) this.logger.warn(`[datadog] ${kind} forward failed: ${err.message}`);
    }
  }

  status() {
    return {
      kind: this.kind,
      target: this.site,
      signals: ['metrics', 'logs', 'events'],
      sent: { metrics: this.stats.metrics, logs: this.stats.logs, events: this.stats.events },
      failures: this.stats.failures,
      last_error: this.stats.lastError,
      last_success_at: this.stats.lastSuccessAt,
      last_failure_at: this.stats.lastFailureAt,
    };
  }

  async shutdown() {}
}

// Turn a client sketch back into representative samples (each bin's midpoint, repeated by count).
// Datadog re-sketches them server-side; error stays within the client sketch's 2%.
export function expandSketch(ft) {
  const gamma = (1 + ft.a) / (1 - ft.a);
  const values = [];
  for (const [k, c] of Object.entries(ft.b)) {
    const v = Math.round(((2 * Math.pow(gamma, Number(k))) / (gamma + 1)) * 100) / 100;
    for (let i = 0; i < Math.min(c, 2000); i++) values.push(v);
  }
  for (let i = 0; i < (ft.z || 0); i++) values.push(0);
  return values;
}

function gauge(series, metric, ts, value, tags) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  series.push({ metric, type: 3, points: [{ timestamp: ts, value }], tags });
}

function count(series, metric, ts, value, tags) {
  series.push({ metric, type: 1, points: [{ timestamp: ts, value }], tags });
}
