// Sends one game session through a fresh local Glitchless server with OTLP export on, and checks that a
// real OpenTelemetry Collector decodes the metrics and logs.
//
//   node server/test/otlp-collector.e2e.mjs           (npm run test:otlp)
//   node server/test/otlp-collector.e2e.mjs --local   a tiny local OTLP/HTTP receiver instead of Docker
//
// The Collector is otel/opentelemetry-collector in Docker with the debug exporter; the checks read its
// output. Without Docker running it falls back to the local receiver, which checks every request
// against the OTLP JSON encoding (server/test/otlp-spec.js). Datadog forwarding is off throughout.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { validateMetricsRequest, validateLogsRequest } from './otlp-spec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.OTELCOL_IMAGE || 'otel/opentelemetry-collector:0.162.0';
const SERVICE = 'glitchless-otlp-e2e';
const SESSION = `s_otlp_${Date.now().toString(36)}`;
const results = [];

const COLLECTOR_CONFIG = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, what, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function dockerRunning() {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
}

// The Collector in Docker: returns { url, output(), stop() }.
async function startCollector(dir) {
  const port = await freePort();
  const config = path.join(dir, 'collector.yaml');
  fs.writeFileSync(config, COLLECTOR_CONFIG);
  const name = `glitchless-otlp-e2e-${process.pid}`;
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:4318`, '-v', `${config}:/etc/otelcol/config.yaml:ro`, IMAGE, '--config=/etc/otelcol/config.yaml'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);
  const output = () => {
    const r = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.stdout + r.stderr;
  };
  const stop = () => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  try {
    // An empty export request is valid OTLP: a 200 means the receiver is up.
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok, 'the Collector');
  } catch (err) {
    console.error(output());
    stop();
    throw err;
  }
  return { url: `http://127.0.0.1:${port}`, output, stop };
}

// A tiny OTLP/HTTP JSON receiver that rejects anything that isn't valid OTLP JSON, like a Collector would.
async function startLocalReceiver() {
  const got = { metrics: [], logs: [], invalid: [], headers: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const signal = { '/v1/metrics': 'metrics', '/v1/logs': 'logs' }[req.url];
      let errors;
      try {
        const json = JSON.parse(body);
        errors = signal === 'metrics' ? validateMetricsRequest(json) : signal === 'logs' ? validateLogsRequest(json) : [`unknown path ${req.url}`];
        if (!errors.length && signal) got[signal].push(json);
      } catch (err) {
        errors = [err.message];
      }
      got.headers.push(req.headers);
      if (req.headers['content-type'] !== 'application/json') errors.push(`content-type ${req.headers['content-type']}`);
      got.invalid.push(...errors);
      res.writeHead(errors.length ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(errors.length ? JSON.stringify({ code: 3, message: errors.join('; ') }) : '{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, got, stop: () => server.close() };
}

async function startGlitchless(port, dataDir, otlpUrl) {
  // Only this test's exporter settings: nothing from the shell's OTEL_*/Datadog variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTEL_|DD_|DATADOG)/.test(k)));
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
    env: {
      ...env,
      PORT: String(port),
      GLITCHLESS_DATA_DIR: dataDir,
      GLITCHLESS_API_KEY: '',
      GLITCHLESS_CLIENT_TOKENS: 'gl_pub_dev',
      GLITCHLESS_DATADOG: 'off',
      GLITCHLESS_OTLP: 'on',
      OTEL_SDK_DISABLED: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: otlpUrl,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-glitchless-e2e=1',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.log = () => log;
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok, 'the Glitchless server', 10_000).catch((err) => {
    child.kill();
    throw new Error(`${err.message}\n${log}`);
  });
  return child;
}

function sessionPayload() {
  const t = Date.now() - 20_000;
  const sk = new Sketch();
  const frames = [...Array(280).fill(16.7), ...Array(15).fill(33.4), 70, 75, 90, 120, 240];
  frames.forEach((v) => sk.add(v));
  return {
    service: SERVICE,
    env: 'test',
    version: '1.0.0',
    session_id: SESSION,
    player_id: 'p_otlp_e2e',
    sdk: 'e2e',
    events: [
      { type: 'session_start', ts: t, session_type: 'synthetic', device: { gpu_tier: 'low', browser: 'Chrome', gpu: 'Intel UHD 620', os: 'Windows' } },
      { type: 'level_start', ts: t + 500, level: 'level-1' },
      { type: 'frame_window', ts: t + 1000, level: 'level-1', duration_s: 5, frames: frames.length, budget_ms: 16.67, ft: sk.toJSON(), slow: 20, jank: 5, hitches: 4, frozen: 0 },
      { type: 'hitch', ts: t + 3000, level: 'level-1', duration_ms: 240, causes: ['shader_compile'] },
      { type: 'error', ts: t + 4000, level: 'level-1', kind: 'js', message: "TypeError: Cannot read properties of undefined (reading 'x')", stack: "TypeError: Cannot read properties of undefined (reading 'x')\n    at spawnEnemy (main.js:120:9)", fingerprint: 'f_otlp', fn: 'spawnEnemy' },
      { type: 'death', ts: t + 5000, level: 'level-1', x: 42.5, y: -3, z: 0, cause: 'fell' },
      { type: 'level_fail', ts: t + 5100, level: 'level-1', cause: 'fell' },
      { type: 'session_end', ts: t + 9000, duration_s: 9, reason: 'pagehide' },
    ],
  };
}

function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-otlp-'));
const useDocker = !process.argv.includes('--local') && dockerRunning();
if (!useDocker && !process.argv.includes('--local')) console.log('Docker is not running: using the local OTLP receiver instead.\n');
let receiver;
let server;
try {
  receiver = useDocker ? await startCollector(tmp) : await startLocalReceiver();
  const port = await freePort();
  server = await startGlitchless(port, tmp, receiver.url);

  const res = await fetch(`http://127.0.0.1:${port}/v1/intake?token=gl_pub_dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionPayload()) });
  assert.equal(res.status, 202, `intake answered ${res.status}`);

  // Export runs after the intake reply; wait until the exporter reports both signals sent (or a failure).
  const health = await waitFor(async () => {
    const h = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
    const x = h.exporters?.[0];
    return x && (x.failures || (x.sent.metrics > 0 && x.sent.logs > 0)) ? h : null;
  }, 'the OTLP exporter to report', 20_000);
  const x = health.exporters[0];

  check('/v1/health lists the OTLP exporter and nothing else', () => {
    assert.deepEqual(health.exporters.map((e) => e.kind), ['otlp']);
    assert.equal(x.target, `${receiver.url}/`);
    assert.deepEqual(x.signals, ['metrics', 'logs']);
    assert.deepEqual(x.headers, ['x-glitchless-e2e']);
  });
  check('the receiver accepted every request', () => {
    assert.equal(x.failures, 0, x.last_error);
    assert.deepEqual(x.rejected, { metrics: 0, logs: 0 });
    assert.equal(x.sent.logs, 7);
  });

  if (useDocker) {
    // The debug exporter prints every decoded data point and record.
    const out = await waitFor(() => {
      const o = receiver.output();
      return /glitchless\.frame\.time/.test(o) && /exception\.stacktrace/.test(o) ? o : null;
    }, 'the Collector to print the data', 10_000).catch(() => receiver.output());
    const has = (re, label) => assert.match(out, re, `Collector output has no ${label}`);
    check('Collector: the game build is the resource', () => {
      has(/service\.name: Str\(glitchless-otlp-e2e\)/, 'service.name');
      has(/service\.version: Str\(1\.0\.0\)/, 'service.version');
      has(/deployment\.environment\.name: Str\(test\)/, 'deployment.environment.name');
      has(/ScopeMetrics SchemaURL:[\s\S]*?InstrumentationScope glitchless 0\.1\.0/, 'glitchless scope');
    });
    check('Collector: glitchless.frame.time is an exponential histogram of all 300 frames', () => {
      has(/Name: glitchless\.frame\.time\s+-> Description: [^\n]*\s+-> Unit: ms\s+-> DataType: ExponentialHistogram\s+-> AggregationTemporality: Cumulative/, 'frame time histogram');
      has(/ExponentialHistogramDataPoints #0[\s\S]*?Count: 300\b/, 'histogram count');
      has(/Bucket \(16\.[0-9]+, 1[67]\.[0-9]+\], Count: 280/, 'the 16.7 ms bucket');
    });
    check('Collector: deaths, errors and slow frames are cumulative counters with game attributes', () => {
      for (const name of ['glitchless.deaths', 'glitchless.errors', 'glitchless.frame.slow', 'glitchless.frame.hitches', 'glitchless.level.fails', 'glitchless.sessions']) {
        has(new RegExp(`Name: ${name.replace(/\./g, '\\.')}[\\s\\S]*?DataType: Sum\\s+-> IsMonotonic: true\\s+-> AggregationTemporality: Cumulative`), name);
      }
      has(/Name: glitchless\.frame\.slow[\s\S]*?Value: 20\b/, 'slow frame count');
      has(/game\.level: Str\(level-1\)/, 'game.level');
      has(/game\.gpu_tier: Str\(low\)/, 'game.gpu_tier');
      has(/user_agent\.name: Str\(chrome\)/, 'user_agent.name (browser)');
      has(/game\.cause: Str\(fell\)/, 'game.cause on deaths');
      has(/error\.type: Str\(js\)/, 'error.type on errors');
    });
    check('Collector: errors are ERROR log records with exception.* and the session', () => {
      has(/SeverityText: ERROR\s+SeverityNumber: Error\(17\)/, 'ERROR severity');
      has(/exception\.type: Str\(TypeError\)/, 'exception.type');
      has(/exception\.message: Str\(TypeError: Cannot read properties of undefined/, 'exception.message');
      has(/exception\.stacktrace: Str\(TypeError[^)]*\)?[\s\S]*?at spawnEnemy \(main\.js:120:9\)/, 'exception.stacktrace');
      has(new RegExp(`session\\.id: Str\\(${SESSION}\\)`), 'session.id');
      has(/EventName: glitchless\.death/, 'event names');
      has(/Body: Str\(Player died on level-1 at x=42\.5 \(fell\)\)/, 'death body');
    });
    check('Collector: no decode errors', () => assert.doesNotMatch(out, /\b(error|failed)\b.*(unmarshal|decode|invalid)/i));
  } else {
    const { got } = receiver;
    const metrics = got.metrics.flatMap((r) => r.resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((s) => s.metrics)));
    const logs = got.logs.flatMap((r) => r.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((s) => s.logRecords)));
    const attr = (list, key) => list.find((a) => a.key === key)?.value;
    check('local receiver: every request is valid OTLP JSON', () => assert.deepEqual(got.invalid, []));
    check('local receiver: headers from OTEL_EXPORTER_OTLP_HEADERS', () => assert.ok(got.headers.every((h) => h['x-glitchless-e2e'] === '1')));
    check('local receiver: frame time histogram and counters', () => {
      const ft = metrics.find((m) => m.name === 'glitchless.frame.time');
      assert.equal(ft.exponentialHistogram.dataPoints[0].count, '300');
      for (const name of ['glitchless.deaths', 'glitchless.errors', 'glitchless.frame.slow']) assert.ok(metrics.find((m) => m.name === name)?.sum.isMonotonic, name);
      assert.equal(metrics.find((m) => m.name === 'glitchless.frame.slow').sum.dataPoints[0].asInt, '20');
    });
    check('local receiver: error log with exception.* and the session', () => {
      const e = logs.find((r) => r.severityNumber === 17);
      assert.equal(attr(e.attributes, 'exception.type').stringValue, 'TypeError');
      assert.match(attr(e.attributes, 'exception.stacktrace').stringValue, /spawnEnemy/);
      assert.equal(attr(e.attributes, 'session.id').stringValue, SESSION);
    });
  }
} catch (err) {
  results.push(['FAIL', 'run', err.stack || err.message]);
  if (server) console.error(server.log());
} finally {
  server?.kill();
  receiver?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`OTLP export → ${useDocker ? IMAGE : 'local OTLP receiver'}\n`);
for (const [status, name, detail] of results) console.log(`${status === 'ok' ? '✔' : '✖'} ${name}${detail ? `\n    ${detail.replace(/\n/g, '\n    ')}` : ''}`);
const failed = results.filter(([s]) => s !== 'ok').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
