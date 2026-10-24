// What e2e.mjs (the game packaged for this computer) and ios.mjs (the game on an iPhone) share: packaging
// the test game, a fresh local Glitchless server, a recorder in front of it that keeps every batch as the
// plugin sent it, the server's query API, and the checks on the scripted run (-autoplay).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Sketch } from '../../packages/sdk/src/sketch.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROJECT = path.join(ROOT, 'unreal/test/GlitchlessTest/GlitchlessTest.uproject');
export const SERVICE = 'glitchless-unreal-test';
export const SDK = 'glitchless-unreal/0.2.0';
export const WINDOWS = process.platform === 'win32';
export const UE_ROOT = process.env.UE_ROOT || (WINDOWS ? 'C:/Program Files/Epic Games/UE_5.8' : '/Users/Shared/Epic Games/UE_5.8');
// SERVER_ROOT: another checkout whose server to play against (one with newer server work than this one).
const SERVER_ROOT = process.env.SERVER_ROOT || ROOT;

export function requireEngine() {
  if (!fs.existsSync(UE_ROOT)) {
    console.error(`Unreal Engine not found at ${UE_ROOT}. Install 5.8 or set UE_ROOT.`);
    process.exit(2);
  }
}

// A Development build of the test game, cooked and staged (and packaged, with -package).
export function packageGame(platform, log, extra = []) {
  const uat = path.join(UE_ROOT, 'Engine/Build/BatchFiles', WINDOWS ? 'RunUAT.bat' : 'RunUAT.sh');
  console.log(`packaging a ${platform} Development build (log: ${log})…`);
  const args = ['BuildCookRun', `-project=${PROJECT}`, `-platform=${platform}`, '-clientconfig=Development', '-build', '-cook', '-stage', '-pak', '-nop4', '-utf8output', '-unattended', '-nocompileeditor', ...extra];
  // Windows runs a .bat only through cmd (Node refuses otherwise), as one command line with its paths quoted.
  const opts = { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3 * 3600_000 };
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const r = WINDOWS ? spawnSync([uat, ...args].map(q).join(' '), { ...opts, shell: true }) : spawnSync(uat, args, opts);
  fs.writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) {
    console.error(`${r.stdout}`.split('\n').filter((l) => /error/i.test(l)).slice(0, 30).join('\n'));
    throw new Error(`packaging failed with ${r.status} (log: ${log})`);
  }
}

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, 'server/src/local.js')], {
    env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_OTLP: 'off', GLITCHLESS_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Glitchless server did not start');
}

// Sits in front of the server, keeping every batch as the plugin sent it, then passes it on: the
// server drops event types it doesn't know yet, and these tests check what the plugin sends too.
// host 0.0.0.0 lets a phone on the network reach it.
export function startRecorder(port, serverPort, batches, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString('utf8') : body.toString('utf8');
      try {
        batches.push({ gzip: body[0] === 0x1f, json: JSON.parse(text) });
      } catch {
        batches.push({ gzip: body[0] === 0x1f, bad: text.slice(0, 200) });
      }
      try {
        const r = await fetch(`http://127.0.0.1:${serverPort}${req.url}`, { method: 'POST', body, headers: { 'content-type': req.headers['content-type'] || 'text/plain' } });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(await r.text());
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

export async function query(port, name, params = {}) {
  const qs = new URLSearchParams({ service: SERVICE, from: '0', ...params });
  const res = await fetch(`http://127.0.0.1:${port}/v1/query/${name}?${qs}`);
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  return res.json();
}

export function checker() {
  const results = [];
  return {
    results,
    check(name, fn) {
      try {
        fn();
        results.push(['ok', name]);
      } catch (err) {
        results.push(['FAIL', name, err.message]);
      }
    },
    // Prints the results and exits with 1 if any failed.
    finish(label, logs) {
      let failed = 0;
      for (const [status, name, why] of results) {
        console.log(`${status === 'ok' ? '✓' : '✗'} ${name}${why ? `\n    ${why}` : ''}`);
        if (status !== 'ok') failed++;
      }
      console.log(`\n${results.length - failed}/${results.length} passed (${label}; logs in ${logs})`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export const events = (batches) => batches.flatMap((b) => (b.json?.events || []).map((e) => ({ ...e, _sid: b.json.session_id, _sdk: b.json.sdk })));

// The scripted run (-autoplay, GlitchlessTestScript): what each of its steps must have sent.
export function checkAutoplay(check, batches, run) {
  check('every batch is the plugin\'s, gzipped when large', () => {
    assert.ok(batches.length >= 2, `${batches.length} batches`);
    for (const b of batches) {
      assert.ok(b.json, `a batch that isn't JSON: ${b.bad}`);
      assert.equal(b.json.sdk, SDK);
      assert.equal(b.json.service, SERVICE);
      assert.equal(b.json.player_id, null, 'anonymous mode sends no player ID');
      assert.match(b.json.session_id, /^s_[a-z0-9]{16}$/);
    }
    assert.ok(batches.some((b) => b.gzip), 'nothing was gzipped');
  });
  check('one session: started, synthetic, coarse device facts, ended on quit', () => {
    const starts = run.filter((e) => e.type === 'session_start');
    assert.equal(starts.length, 1);
    const s = starts[0];
    assert.equal(s.session_type, 'synthetic');
    assert.equal(s.privacy, 'anonymous');
    assert.equal(s.device.browser, 'Unreal');
    assert.match(s.device.browser_version, /^5\.\d+\.\d+$/);
    for (const k of ['os', 'device_tier', 'gpu_tier', 'renderer', 'driver', 'steam_deck']) assert.ok(k in s.device, `no ${k}`);
    for (const k of ['model', 'gpu', 'os_version', 'cores', 'memory_gb']) assert.ok(!(k in s.device), `anonymous sent ${k}`);
    const end = run.find((e) => e.type === 'session_end');
    assert.equal(end?.reason, 'quit');
  });
  check('maps are levels', () => {
    const levels = run.filter((e) => e.type === 'level_start').map((e) => e.level);
    assert.deepEqual(levels, ['Template_Default', 'TimeOfDay_Default']);
  });
  check('frame windows carry the sketch and the game, render, RHI and GPU times', () => {
    const windows = run.filter((e) => e.type === 'frame_window');
    assert.ok(windows.length >= 3, `${windows.length} windows`);
    for (const w of windows) {
      const s = Sketch.from(w.ft);
      assert.equal(s.n, w.frames);
      assert.equal(Math.round(s.quantile(0.5) * 100) / 100, w.ft_p50);
    }
    const some = (k) => assert.ok(windows.some((w) => typeof w[k] === 'number' && w[k] > 0), `no ${k}`);
    for (const k of ['game_ms', 'process_ms', 'render_ms', 'gpu_ms', 'objects', 'actors', 'heap_mb']) some(k);
    assert.ok(windows.every((w) => w.draw_calls === null || w.draw_calls > 0), 'draw_calls of 0 (not counted) must be null');
    assert.ok(windows.some((w) => w.ctx?.enemies === 12), 'the enemies gauge is missing');
  });
  check('hitches name their causes: game code, garbage collection, the map load', () => {
    const hitches = run.filter((e) => e.type === 'hitch');
    const causes = new Set(hitches.flatMap((h) => h.causes));
    for (const c of ['script', 'gc', 'map_load']) assert.ok(causes.has(c), `no ${c} hitch: ${JSON.stringify(hitches.map((h) => [h.duration_ms, h.causes]))}`);
    const script = hitches.find((h) => h.causes.includes('script') && h.recent?.includes('door_opened'));
    assert.ok(script, 'the 150 ms of game code has no hitch with its breadcrumb');
    assert.ok(script.duration_ms >= 140, `${script.duration_ms} ms`);
    assert.equal(script.bound, 'game');
  });
  check('errors: the log error, the ensure (with its callstack) and the Blueprint error', () => {
    const errors = run.filter((e) => e.type === 'error');
    const log = errors.find((e) => e.kind === 'log_error' && /Planted error/.test(e.message));
    assert.ok(log, JSON.stringify(errors.map((e) => [e.kind, e.message])));
    assert.equal(log.fn, 'LogGlitchlessTest');
    const ens = errors.find((e) => e.kind === 'ensure');
    assert.ok(ens, 'no ensure');
    assert.match(ens.message, /^Ensure condition failed: false: Planted ensure/);
    assert.equal(ens.fn, 'UGlitchlessTestScript::Step'); // the ensure's lambda is folded into its function
    // A packaged Mac or iOS game names its frames by function only (dladdr): no file, and no line.
    assert.ok(ens.source === null || ens.source === 'GlitchlessTestScript.cpp', `source ${ens.source}`);
    const bp = errors.find((e) => e.kind === 'script');
    assert.ok(bp, 'no Blueprint error');
    assert.match(bp.message, /^Accessed None/);
    assert.match(bp.fn, /PlantedScript/);
    for (const e of errors) assert.match(e.fingerprint, /^[0-9a-f]{8}$/);
  });
  check('the death and the events', () => {
    const death = run.find((e) => e.type === 'death');
    assert.equal(death?.cause, 'spikes');
    assert.ok(!('x' in death), 'anonymous mode sent a place');
    const names = run.filter((e) => e.type === 'custom').map((e) => e.name);
    for (const n of ['powerup', 'coins', 'door_opened']) assert.ok(names.includes(n), `no ${n}`);
    assert.equal(run.find((e) => e.name === 'coins').attrs.what, 3);
    assert.equal(run.find((e) => e.type === 'level_complete')?.score, 4200);
  });
  check('the bug report goes on a request of its own, with the note, a screenshot and what just happened', () => {
    const own = batches.find((b) => b.json?.events?.some((e) => e.type === 'bug_report'));
    assert.ok(own, 'no bug_report');
    assert.equal(own.json.events.length, 1, 'the report shared its request');
    const report = own.json.events[0];
    assert.match(report.note, /Planted bug report/);
    assert.match(report.screenshot, /^data:image\/jpeg;base64,\/9j\//);
    assert.ok(report.screenshot.length <= 200_000, `${report.screenshot.length} characters`);
    assert.equal(report.level, 'TimeOfDay_Default');
    assert.ok(report.recent.some((e) => e.type === 'death' && e.cause === 'spikes'), 'the death is not in recent');
    assert.ok(report.recent.some((e) => e.type === 'hitch'), 'no hitch in recent');
    assert.ok(report.frames.length > 0 && report.frames.every((f) => typeof f.fps === 'number'), 'no frames');
    assert.equal(report.device?.browser, 'Unreal');
    assert.ok(!('x' in report), 'anonymous mode sent a place');
  });
}

// Every event reaches the server once: none is sent again with the same session, type and time.
export function checkSentOnce(check, batches) {
  check('each event is sent once, even the batch on its way when the game quits', () => {
    const seen = new Map();
    for (const b of batches) {
      for (const e of b.json?.events || []) {
        const key = `${b.json.session_id} ${e.type} ${e.ts} ${e.name || e.kind || e.level || ''}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    const twice = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    assert.deepEqual(twice, []);
    const quit = events(batches).filter((e) => e.type === 'custom' && e.name === 'quit_requested');
    assert.ok(quit.length > 0, 'the quit_requested event, flushed as the game quits, never arrived');
  });
}

// The bug report box run (-glitchless-test-dialog): a report made while it is open, then one typed into it.
export function checkDialog(check, run) {
  check('the box sends what was typed in it, and a report made while it is open shows it', () => {
    const reports = run.filter((e) => e.type === 'bug_report');
    assert.ok(reports.some((r) => r.note === 'Planted report with the box open' && r.screenshot), JSON.stringify(reports.map((r) => r.note)));
    const typed = reports.find((r) => r.note === 'Door stuck');
    assert.ok(typed, `the box sent no report: ${JSON.stringify(reports.map((r) => r.note))}`);
    assert.match(typed.screenshot || '', /^data:image\/jpeg;base64,/);
  });
}

// -glitchless-measure's one line of JSON, as printed on stdout.
export function checkMeasureLine(check, stdout, level = 'Template_Default') {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{"glitchless_measure"'));
  check('measure: prints one line of JSON, then quits', () => {
    assert.ok(line, 'nothing on stdout');
    const m = JSON.parse(line).glitchless_measure;
    assert.ok(m.frames > 30, `frames ${m.frames}`);
    for (const k of ['p50', 'p95', 'p99', 'worst']) assert.equal(typeof m.frame_ms[k], 'number', `frame_ms.${k}`);
    for (const k of ['fps', 'frame_budget_ms', 'pct_frames_over_budget', 'hitch_count', 'update_cpu_ms', 'render_cpu_ms', 'gpu_ms', 'memory', 'memory_delta', 'new_errors']) assert.ok(k in m, k);
    assert.match(m.session_id, /^s_[a-z0-9]{16}$/);
    assert.equal(m.sdk, SDK);
    assert.equal(m.level_start, level);
  });
  return line ? JSON.parse(line).glitchless_measure : null;
}
