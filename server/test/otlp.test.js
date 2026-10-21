import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { createExporters, exporterSettingsFromEnv, ExporterSet } from '../src/exporters/index.js';
import { OtlpExporter, parseHeaders, exponentialBuckets, bucketIndex, addSketch, emptyHistogram, MAX_SCALE, MAX_BUCKETS } from '../src/exporters/otlp.js';
import { createForwarder } from '../src/config.js';
import { createApp } from '../src/app.js';
import { validateMetricsRequest, validateLogsRequest } from './otlp-spec.js';

const T0 = 1_760_000_000_000;
const BASE = { service: 'zoomies', env: 'prod', version: '1.2.0' };

// Records every request an exporter makes; `replies` are used in order, then 200 {}.
function fakeFetch(replies = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift() || { status: 200, body: {} };
    if (r.throw) throw new Error(r.throw);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  };
  return { fetch, calls, to: (path) => calls.filter((c) => c.url.endsWith(path)).map((c) => c.body) };
}

const quiet = { warn() {}, error() {}, log() {} };

function otlp(settings = {}, replies) {
  const f = fakeFetch(replies);
  const x = new OtlpExporter({ endpoint: 'http://collector:4318', retryBaseMs: 1, fetch: f.fetch, logger: quiet, ...settings });
  return { x, ...f };
}

function sketchOf(values) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return sk.toJSON();
}

function session(id, { tier = 'low', browser = 'Chrome', events = [] } = {}) {
  const env = { ...BASE, session_id: id, player_id: `p_${id}`, received: T0 + 60_000 };
  return [{ type: 'session_start', ts: T0, level: null, session_type: 'user', device: { gpu_tier: tier, browser, gpu: 'Intel UHD 620', os: 'Windows' } }, ...events].map((e) => ({ level: null, ...e, ...env }));
}

const frameWindow = (level, values, extra = {}) => ({ type: 'frame_window', ts: T0 + 5000, level, duration_s: 5, frames: values.length, slow: values.filter((v) => v > 25).length, hitches: values.filter((v) => v > 50).length, ft: sketchOf(values), ...extra });
const err = { type: 'error', ts: T0 + 7000, level: 'level-3', kind: 'js', message: "TypeError: Cannot read properties of undefined (reading 'x')", stack: "TypeError: Cannot read properties of undefined (reading 'x')\n    at spawnEnemy (main.js:120:9)", fingerprint: 'f_spawn', fn: 'spawnEnemy', breadcrumbs: [{ t: -1.2, e: 'level_start' }] };
const death = { type: 'death', ts: T0 + 9000, level: 'level-3', x: 12.5, y: -3, cause: 'fell' };

// Bucket i at scale s holds (b^i, b^(i+1)]; read it back at its relative-error midpoint.
function quantileFromPoint(dp, q) {
  const base = 2 ** (2 ** -dp.scale);
  const count = Number(dp.count);
  const rank = q * (count - 1);
  let acc = Number(dp.zeroCount);
  if (acc > rank) return 0;
  for (const [j, c] of dp.positive.bucketCounts.entries()) {
    acc += Number(c);
    if (acc > rank) return (2 * base ** (dp.positive.offset + j + 1)) / (base + 1);
  }
  return dp.max;
}

const metric = (req, name) => req.resourceMetrics.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics)).find((m) => m.name === name);
const attr = (list, key) => {
  const v = list.find((a) => a.key === key)?.value;
  return v && Object.values(v)[0];
};
const records = (req) => req.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));

test('the OTLP JSON check itself catches malformed requests', () => {
  const bad = validateMetricsRequest({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'a', value: { stringValue: 'x', intValue: '1' } }, { key: 'a', value: { stringValue: 'y' } }] },
        scope_metrics: [],
        scopeMetrics: [
          {
            scope: { name: 'glitchless' },
            metrics: [
              { name: 'c', sum: { aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA', isMonotonic: true, dataPoints: [{ timeUnixNano: 1, asInt: 3 }] } },
              { name: 'h', exponentialHistogram: { aggregationTemporality: 2, dataPoints: [{ timeUnixNano: '2', startTimeUnixNano: '3', count: '5', zeroCount: '0', scale: 5, positive: { offset: 0, bucketCounts: ['1', '1'] } }] } },
            ],
          },
        ],
      },
    ],
  });
  for (const problem of ['unknown ResourceMetrics field "scope_metrics"', 'exactly one of', 'duplicate attribute key', 'aggregationTemporality must be', 'timeUnixNano: 64-bit integer', 'asInt: 64-bit integer', 'starts after it ends', 'count 5 != zeroCount + buckets']) {
    assert.ok(bad.some((e) => e.includes(problem)), problem);
  }
  const badLog = validateLogsRequest({ resourceLogs: [{ resource: {}, scopeLogs: [{ scope: { name: 'g' }, logRecords: [{ time_unix_nano: '1', timeUnixNano: '1', severityNumber: 'INFO' }] }] }] });
  assert.equal(badLog.length, 2);
});

test('OTLP metrics: valid OTLP JSON, frame time as an exponential histogram, counters with game attributes', async () => {
  const { x, to } = otlp();
  await x.export(session('s1', { events: [{ type: 'level_start', ts: T0 + 1000, level: 'level-3' }, frameWindow('level-3', [16.6, 16.7, 16.8, 33.4, 70]), err, death] }));
  const [req] = to('/v1/metrics');
  assert.deepEqual(validateMetricsRequest(req), []);

  const resource = req.resourceMetrics[0].resource.attributes;
  assert.equal(attr(resource, 'service.name'), 'zoomies');
  assert.equal(attr(resource, 'service.version'), '1.2.0');
  assert.equal(attr(resource, 'deployment.environment.name'), 'prod');
  assert.ok(attr(resource, 'service.instance.id'));
  assert.equal(req.resourceMetrics[0].scopeMetrics[0].scope.name, 'glitchless');

  const ft = metric(req, 'glitchless.frame.time');
  assert.equal(ft.unit, 'ms');
  assert.equal(ft.exponentialHistogram.aggregationTemporality, 2);
  const dp = ft.exponentialHistogram.dataPoints[0];
  assert.equal(dp.count, '5');
  assert.equal(dp.scale, MAX_SCALE);
  assert.equal(dp.min, 16.6);
  assert.equal(dp.max, 70);
  assert.equal(attr(dp.attributes, 'game.level'), 'level-3');
  assert.equal(attr(dp.attributes, 'game.gpu_tier'), 'low');
  assert.equal(attr(dp.attributes, 'user_agent.name'), 'chrome');
  assert.equal(attr(dp.attributes, 'game.session_type'), 'user');
  assert.equal(attr(dp.attributes, 'session.id'), undefined, 'no per-session metric streams');

  for (const [name, value] of [['glitchless.frame.count', '5'], ['glitchless.frame.slow', '2'], ['glitchless.frame.hitches', '1'], ['glitchless.sessions', '1'], ['glitchless.level.starts', '1'], ['glitchless.deaths', '1'], ['glitchless.errors', '1']]) {
    const m = metric(req, name);
    assert.ok(m, name);
    assert.equal(m.sum.isMonotonic, true, name);
    assert.equal(m.sum.dataPoints[0].asInt, value, name);
  }
  assert.equal(attr(metric(req, 'glitchless.deaths').sum.dataPoints[0].attributes, 'game.cause'), 'fell');
  assert.equal(attr(metric(req, 'glitchless.errors').sum.dataPoints[0].attributes, 'error.type'), 'js');
});

test('frame time histogram keeps the sketch percentiles across players (within 4%)', async () => {
  const { x, to } = otlp();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const all = [];
  const events = [];
  for (const id of ['a', 'b', 'c']) {
    const windows = [];
    for (let w = 0; w < 20; w++) {
      const values = Array.from({ length: 300 }, () => {
        const r = rand();
        return r < 0.9 ? 16.7 + (rand() - 0.5) * 2 : r < 0.98 ? 33.3 + rand() * 4 : 50 + rand() * 250;
      });
      all.push(...values);
      windows.push(frameWindow('level-1', values));
    }
    events.push(...session(id, { tier: 'mid' }).concat(windows.map((w) => ({ ...w, ...BASE, session_id: id }))));
  }
  await x.export(events);
  const dp = metric(to('/v1/metrics')[0], 'glitchless.frame.time').exponentialHistogram.dataPoints;
  assert.equal(dp.length, 1, 'three players, one stream');
  const [p] = dp;
  assert.equal(Number(p.count), all.length);
  const sorted = all.sort((a, b) => a - b);
  for (const q of [0.5, 0.9, 0.95, 0.99]) {
    const truth = sorted[Math.floor(q * (sorted.length - 1))];
    const got = quantileFromPoint(p, q);
    assert.ok(Math.abs(got - truth) / truth < 0.04, `p${q * 100}: ${got.toFixed(2)} vs ${truth.toFixed(2)}`);
  }
  const trueSum = all.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(p.sum - trueSum) / trueSum < 0.001);
});

test('wide histograms are downscaled to fit 160 buckets without losing counts', () => {
  const values = [0.01, 0.5, 1, 4, 16.7, 33, 100, 1000, 60_000];
  const h = addSketch(emptyHistogram(), sketchOf(values));
  const { scale, offset, bucketCounts } = exponentialBuckets(h.bins);
  assert.ok(bucketCounts.length <= MAX_BUCKETS);
  assert.ok(scale < MAX_SCALE);
  assert.equal(bucketCounts.reduce((a, b) => a + b, 0), values.length);
  for (const v of values) assert.ok(bucketCounts[bucketIndex(v, scale) - offset] > 0, `${v} lands in a filled bucket`);
  // bucket i holds (base^i, base^(i+1)]: exact powers of two close a bucket
  assert.equal(bucketIndex(2, 0), 0);
  assert.equal(bucketIndex(2.001, 0), 1);
  assert.equal(bucketIndex(1, MAX_SCALE), -1);
});

test('delta temporality: each export has only what is new, over back-to-back intervals', async () => {
  let now = T0 + 100_000;
  const { x, to } = otlp({ temporality: 'delta', now: () => now });
  await x.export(session('s1', { events: [death, death] }));
  now += 5000;
  await x.export(session('s1', { events: [death] }).slice(1));
  const [a, b] = to('/v1/metrics').map((r) => metric(r, 'glitchless.deaths').sum);
  assert.equal(a.aggregationTemporality, 1);
  assert.equal(a.dataPoints[0].asInt, '2');
  assert.equal(b.dataPoints[0].asInt, '1');
  assert.equal(b.dataPoints[0].startTimeUnixNano, a.dataPoints[0].timeUnixNano);
  assert.equal(metric(to('/v1/metrics')[1], 'glitchless.sessions'), undefined, 'untouched streams are not re-sent');
});

test('cumulative temporality: totals keep growing from one start time', async () => {
  let now = T0 + 100_000;
  const { x, to } = otlp({ now: () => now });
  await x.export(session('s1', { events: [death, death] }));
  now += 5000;
  await x.export(session('s1', { events: [death] }).slice(1));
  const [a, b] = to('/v1/metrics').map((r) => metric(r, 'glitchless.deaths').sum.dataPoints[0]);
  assert.equal(a.asInt, '2');
  assert.equal(b.asInt, '3');
  assert.equal(a.startTimeUnixNano, b.startTimeUnixNano);
  assert.ok(BigInt(b.timeUnixNano) > BigInt(a.timeUnixNano));
});

test('OTEL_METRIC_EXPORT_INTERVAL batches metrics; shutdown flushes them', async () => {
  const { x, to } = otlp({ intervalMs: 60_000 });
  await x.export(session('s1', { events: [death] }));
  await x.export(session('s2', { events: [death] }));
  assert.equal(to('/v1/metrics').length, 0);
  assert.equal(to('/v1/logs').length, 2, 'logs are not held back');
  await x.shutdown();
  const reqs = to('/v1/metrics');
  assert.equal(reqs.length, 1);
  assert.equal(metric(reqs[0], 'glitchless.deaths').sum.dataPoints[0].asInt, '2');
});

test('OTLP logs: gameplay and errors, exception.* on errors, the session as session.id', async () => {
  const { x, to } = otlp();
  await x.export(session('s1', { tier: 'high', browser: 'Firefox', events: [err, death, { type: 'hitch', ts: T0 + 8000, level: 'level-3', duration_ms: 180, causes: ['shader_compile'] }, frameWindow('level-3', [16.7])] }));
  const [req] = to('/v1/logs');
  assert.deepEqual(validateLogsRequest(req), []);
  assert.equal(attr(req.resourceLogs[0].resource.attributes, 'service.name'), 'zoomies');
  const recs = records(req);
  assert.deepEqual(recs.map((r) => r.eventName), ['glitchless.session_start', 'glitchless.error', 'glitchless.death', 'glitchless.hitch'], 'frame windows are metrics, not logs');

  const e = recs[1];
  assert.equal(e.severityNumber, 17);
  assert.equal(e.severityText, 'ERROR');
  assert.equal(e.timeUnixNano, `${T0 + 7000}000000`);
  assert.equal(e.observedTimeUnixNano, `${T0 + 60_000}000000`);
  assert.equal(e.body.stringValue, err.message);
  assert.equal(attr(e.attributes, 'exception.type'), 'TypeError');
  assert.equal(attr(e.attributes, 'exception.message'), err.message);
  assert.equal(attr(e.attributes, 'exception.stacktrace'), err.stack);
  assert.equal(attr(e.attributes, 'error.type'), 'js');
  assert.equal(attr(e.attributes, 'game.error.fingerprint'), 'f_spawn');
  assert.equal(attr(e.attributes, 'game.fn'), 'spawnEnemy');
  assert.equal(attr(e.attributes, 'session.id'), 's1');
  assert.equal(attr(e.attributes, 'user.id'), 'p_s1');
  assert.equal(attr(e.attributes, 'game.gpu_tier'), 'high', 'device context from session_start');
  assert.equal(attr(e.attributes, 'user_agent.name'), 'firefox');
  assert.ok(attr(e.attributes, 'game.breadcrumbs').values.length);
  assert.equal(attr(e.attributes, 'game.message'), undefined, 'error fields are not repeated under game.*');

  const d = recs[2];
  assert.equal(d.severityNumber, 9);
  assert.equal(attr(d.attributes, 'game.cause'), 'fell');
  assert.equal(attr(d.attributes, 'game.x'), 12.5);
  assert.equal(attr(d.attributes, 'game.level'), 'level-3');
  assert.equal(attr(d.attributes, 'exception.type'), undefined);
  assert.equal(recs[3].severityText, 'WARN');
});

test('env vars: with nothing configured, no exporter runs and nothing is sent', async () => {
  assert.deepEqual(exporterSettingsFromEnv({}), []);
  const set = createForwarder({});
  assert.equal(set.enabled, false);
  assert.deepEqual(set.status(), []);
  const real = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => (sent++, new Response('{}'));
  try {
    await set.forward(session('s1', { events: [death, err] }));
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent, 0);
});

test('env vars: OTLP runs alongside or instead of Datadog, from the standard OTEL_* variables', () => {
  const kinds = (env) => exporterSettingsFromEnv(env).map((s) => s.kind);
  assert.deepEqual(kinds({ DD_API_KEY: 'k' }), ['datadog']);
  assert.deepEqual(kinds({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }), ['otlp']);
  assert.deepEqual(kinds({ DATADOG_KEY: 'k', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }), ['datadog', 'otlp']);
  assert.deepEqual(kinds({ DD_API_KEY: 'k', GLITCHLESS_DATADOG: 'off', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' }), ['otlp']);
  assert.deepEqual(kinds({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', GLITCHLESS_OTLP: 'off' }), []);
  assert.deepEqual(kinds({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_SDK_DISABLED: 'true' }), []);
  assert.deepEqual(kinds({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }), []);

  const [s] = exporterSettingsFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.com/otlp/',
    OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc%3D%3D, Authorization=Basic%20dXNlcjpwYXNz ,broken',
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'Delta',
    OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=games,team=arcade',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  });
  assert.deepEqual(s.headers, { 'x-honeycomb-team': 'abc==', Authorization: 'Basic dXNlcjpwYXNz' });
  assert.deepEqual(s.signals, ['metrics']);
  assert.equal(s.intervalMs, 10_000);
  const x = new OtlpExporter({ ...s, logger: quiet });
  assert.equal(x.urls.metrics, 'https://otlp.example.com/otlp/v1/metrics');
  assert.equal(x.urls.logs, null);
  assert.equal(x.status().temporality, 'delta');
  assert.equal(x.resource(BASE)['team'], 'arcade');
  assert.equal(x.resource(BASE)['service.name'], 'zoomies', 'the game names the service');

  // A signal-specific endpoint is used as-is, and only that signal is sent.
  const [only] = exporterSettingsFromEnv({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example.com/ingest' });
  const y = new OtlpExporter({ ...only, logger: quiet });
  assert.deepEqual(y.urls, { metrics: null, logs: 'https://logs.example.com/ingest' });
  assert.deepEqual(parseHeaders(''), {});
});

test('status reports each exporter without secrets', () => {
  const set = createExporters(
    [
      { kind: 'datadog', apiKey: 'dd-secret-key', site: 'datadoghq.eu' },
      { kind: 'otlp', endpoint: 'https://user:hunter2@otlp.example.com/v1?token=qs-secret', headers: { 'api-key': 'header-secret' } },
    ],
    { logger: quiet },
  );
  const status = set.status();
  assert.deepEqual(status.map((s) => s.kind), ['datadog', 'otlp']);
  assert.equal(status[0].target, 'datadoghq.eu');
  assert.equal(status[1].target, 'https://otlp.example.com/v1');
  assert.deepEqual(status[1].headers, ['api-key']);
  const text = JSON.stringify(status);
  for (const secret of ['dd-secret-key', 'hunter2', 'qs-secret', 'header-secret']) assert.ok(!text.includes(secret), secret);
});

test('OTLP sends its headers, retries 429/5xx, gives up on 4xx and counts partial success', async () => {
  const { x, calls } = otlp({ headers: { 'api-key': 'k1' }, signals: ['logs'] }, [{ status: 503 }, { status: 200, body: { partialSuccess: { rejectedLogRecords: '1', errorMessage: 'too old' } } }, { status: 400, body: { message: 'bad' } }]);
  await x.export(session('s1', { events: [death] }));
  assert.equal(calls.length, 2, 'one retry after a 503');
  assert.equal(calls[1].headers['api-key'], 'k1');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  let st = x.status();
  assert.deepEqual(st.sent, { metrics: 0, logs: 1 });
  assert.equal(st.rejected.logs, 1);
  assert.match(st.last_error, /too old/);
  assert.equal(st.failures, 0);

  await x.export(session('s2', { events: [death] }));
  assert.equal(calls.length, 3, 'no retry after a 400');
  st = x.status();
  assert.equal(st.failures, 1);
  assert.match(st.last_error, /^logs: 400/);
});

test('one failing exporter does not stop the others', async () => {
  const got = [];
  const set = new ExporterSet([{ kind: 'broken', export: async () => { throw new Error('boom'); } }, { kind: 'ok', export: async (events) => got.push(...events) }], { logger: quiet });
  await set.forward([death]);
  assert.equal(got.length, 1);
});

test('Datadog exporter still sends distributions, tagged counts, error logs and version events', async () => {
  const f = fakeFetch();
  const set = createExporters([{ kind: 'datadog', apiKey: 'k', site: 'datadoghq.com' }], { fetch: f.fetch, logger: quiet });
  await set.forward(session('s1', { events: [frameWindow('level-3', [16.7, 33.3]), err, death] }));
  const [dist] = f.to('/api/v1/distribution_points');
  assert.equal(dist.series[0].metric, 'glitchless.frame.time');
  assert.equal(dist.series[0].points[0][1].length, 2);
  const series = f.to('/api/v2/series')[0].series;
  const deaths = series.find((s) => s.metric === 'glitchless.deaths');
  assert.ok(deaths.tags.includes('cause:fell') && deaths.tags.includes('gpu_tier:low') && deaths.tags.includes('version:1.2.0'));
  const logs = f.to('/api/v2/logs')[0];
  const error = logs.find((l) => l.status === 'error');
  assert.deepEqual(error.error, { kind: 'TypeError', message: err.message, stack: err.stack, fingerprint: 'f_spawn' });
  assert.equal(f.to('/api/v1/events').length, 1);
  assert.equal(f.calls[0].headers['DD-API-KEY'], 'k');
  const [st] = set.status();
  assert.equal(st.sent.events, 1);
  assert.equal(st.failures, 0);
});

test('/v1/health lists each exporter and its status', async () => {
  const set = createExporters([{ kind: 'otlp', endpoint: 'http://collector:4318', headers: { 'api-key': 'secret' } }], { logger: quiet, fetch: fakeFetch().fetch });
  const server = http.createServer(createApp({ store: { kind: 'test' }, forwarder: set, logger: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.exporters.length, 1);
    assert.equal(h.exporters[0].kind, 'otlp');
    assert.equal(h.exporters[0].target, 'http://collector:4318/');
    assert.ok(!JSON.stringify(h).includes('secret'));
  } finally {
    server.close();
  }
});
