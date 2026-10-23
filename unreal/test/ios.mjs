// Plays the test game on an iPhone against a fresh Glitchless server on this Mac, over the network, and
// checks what arrives, as e2e.mjs does for the game packaged for this computer.
//
//   node unreal/test/ios.mjs              build, cook, package and sign, install, then play
//   node unreal/test/ios.mjs --no-build   install and play the last package again
//   IOS_DEVICE=<udid or name>             the phone (default: the first paired iPhone)
//   GLITCHLESS_HOST=<address>             this Mac's address on the phone's network (default: en0's)
//
// Signing is automatic, with the team and bundle ID in GlitchlessTest/Config/DefaultEngine.ini (Xcode signed
// in to that team's account). The phone must be unlocked, in Developer Mode and on the same network. The
// first launch asks to find devices on the local network: allow it on the phone, and the run goes on.
//
//   0. reach      short runs, until the phone's batches arrive
//   1. autoplay   the scripted run, as in e2e.mjs, and the phone's device facts
//   2. crash      the run ending in a crash, sent on the next launch
//   3. dialog     the bug report box
//   4. measure    -glitchless-measure prints its line of JSON on the console
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, checkAutoplay, checkDialog, checkMeasureLine, checkSentOnce, checker, events, freePort, packageGame, query, requireEngine, startRecorder, startServer } from './harness.mjs';

const GAME = path.join(ROOT, 'unreal/test/GlitchlessTest');
const build = !process.argv.includes('--no-build');
const { check, finish, results } = checker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-unreal-ios-'));

requireEngine();

function devicectl(args, opts = {}) {
  const json = path.join(tmp, 'devicectl.json');
  const r = spawnSync('xcrun', ['devicectl', ...args, '--json-output', json], { encoding: 'utf8', timeout: 300_000, ...opts });
  const out = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null;
  fs.rmSync(json, { force: true });
  if (r.status !== 0) throw new Error(`devicectl ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return out;
}

function phone() {
  const wanted = process.env.IOS_DEVICE;
  const devices = devicectl(['list', 'devices']).result.devices.filter((d) => d.hardwareProperties?.platform === 'iOS' && d.hardwareProperties?.reality === 'physical');
  const found = wanted
    ? devices.find((d) => [d.hardwareProperties.udid, d.identifier, d.deviceProperties?.name].includes(wanted))
    : devices.find((d) => d.connectionProperties?.pairingState === 'paired' && d.hardwareProperties?.deviceType === 'iPhone');
  if (!found) throw new Error(wanted ? `no iPhone ${wanted}` : 'no paired iPhone (xcrun devicectl list devices)');
  return { udid: found.hardwareProperties.udid, name: found.deviceProperties?.name };
}

// The signed app UAT packaged (modern Xcode builds it into Binaries/IOS).
function app() {
  const candidates = [path.join(GAME, 'Binaries/IOS/GlitchlessTest.app'), path.join(GAME, 'Saved/StagedBuilds/IOS/GlitchlessTest.app')];
  const found = candidates.find((p) => fs.existsSync(path.join(p, 'Info.plist')));
  if (!found) throw new Error(`no packaged iOS app in ${candidates.join(' or ')}`);
  return found;
}

function bundleId(appPath) {
  const r = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(appPath, 'Info.plist')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no bundle ID in ${appPath}`);
  return r.stdout.trim();
}

function macAddress() {
  if (process.env.GLITCHLESS_HOST) return process.env.GLITCHLESS_HOST;
  for (const iface of ['en0', 'en1']) {
    const r = spawnSync('ipconfig', ['getifaddr', iface], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('no network address for this Mac; set GLITCHLESS_HOST');
}

// Launches the game on the phone and waits for it to quit, with its stdout (the console) kept.
function play(device, id, args, label, { timeout = 180_000 } = {}) {
  const log = path.join(tmp, `${label}.log`);
  return new Promise((resolve) => {
    const child = spawn('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.udid, '--console', '--terminate-existing', id, '--', '-stdout', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGINT'), timeout);
    child.on('exit', (status) => {
      clearTimeout(timer);
      fs.writeFileSync(log, out);
      resolve({ stdout: out, status, log });
    });
  });
}

const until = async (fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
};

// Batches of the one session in which the scripted run tracked its powerup.
function sessionOf(slice, name) {
  const sid = events(slice).find((e) => e.type === 'custom' && e.name === name)?._sid;
  return slice.filter((b) => b.json?.session_id === sid);
}

const port = await freePort();
const recorderPort = await freePort();
const batches = [];
let server;
let recorder;
try {
  const device = phone();
  if (build) packageGame('IOS', path.join(tmp, 'package.log'), ['-package']);
  const appPath = app();
  const id = bundleId(appPath);
  console.log(`installing ${id} on ${device.name}…`);
  devicectl(['device', 'install', 'app', '--device', device.udid, appPath]);
  server = await startServer(port, path.join(tmp, 'data'));
  recorder = await startRecorder(recorderPort, port, batches, '0.0.0.0');
  const intake = `-glitchless-intake=http://${macAddress()}:${recorderPort}`;

  // 0. reach: iOS asks once whether the game may use the local network, and nothing gets through until then.
  console.log(`0. reaching this Mac from the phone (${intake})…`);
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    if (i === 1) console.log('   nothing yet: on the phone, allow GlitchlessTest to find devices on your local network');
    const r = await play(device, id, ['-glitchless-measure=3', intake], `reach-${i}`);
    if (/locked/i.test(r.stdout) && !/glitchless_measure/.test(r.stdout)) console.log('   the phone is locked: unlock it');
    reached = await until(() => batches.length > 0, 5000);
  }
  check('the phone reaches the server on this Mac', () => assert.ok(reached, 'no batch arrived; is the phone on this network, with Local Network allowed?'));
  if (!reached) throw new Error('the phone never reached the recorder');
  await new Promise((r) => setTimeout(r, 2000)); // what the first runs left in the outbox comes in too

  // 1. autoplay
  console.log('1. autoplay…');
  const before = batches.length;
  await play(device, id, ['-autoplay', intake], 'autoplay');
  await until(() => events(batches.slice(before)).some((e) => e.type === 'session_end'), 10_000);
  const mine = sessionOf(batches.slice(before), 'powerup');
  const run1 = events(mine);
  checkAutoplay(check, mine, run1);
  checkSentOnce(check, mine);
  check('the phone\'s device: iOS, mobile, Metal, its refresh rate', () => {
    const d = run1.find((e) => e.type === 'session_start')?.device;
    assert.equal(d?.os, 'iOS');
    assert.equal(d.mobile, true);
    assert.equal(d.renderer, 'mobile');
    assert.equal(d.driver, 'Metal');
    assert.ok(d.refresh_hz >= 60, `refresh_hz ${d.refresh_hz}`);
    assert.equal(d.screen?.length, 2);
    assert.equal(d.steam_deck, false);
  });

  // 2. crash
  console.log('2. crash, then a launch that sends it…');
  const beforeCrash = batches.length;
  await play(device, id, ['-autoplay', '-glitchless-test-crash', intake], 'crash');
  await play(device, id, ['-glitchless-measure=2', intake], 'after-crash');
  await until(() => events(batches.slice(beforeCrash)).some((e) => e.kind === 'crash'), 5000);
  check('the next launch sends the crash, with its callstack', () => {
    const crash = events(batches.slice(beforeCrash)).find((e) => e.type === 'error' && e.kind === 'crash');
    assert.ok(crash, 'no crash arrived');
    assert.match(crash.message, /^SIG(SEGV|BUS)/);
    assert.match(crash.fn || '', /UGlitchlessTestScript::Step/);
    assert.match(crash.stack, /^crash: /);
  });

  // 3. dialog
  console.log('3. the bug report box…');
  const beforeBox = batches.length;
  await play(device, id, ['-autoplay', '-glitchless-test-dialog', intake], 'dialog');
  await until(() => events(batches.slice(beforeBox)).some((e) => e.note === 'Door stuck'), 5000);
  checkDialog(check, events(batches.slice(beforeBox)));

  // 4. measure
  console.log('4. measure…');
  const m4 = await play(device, id, ['-glitchless-off', '-glitchless-warmup=1', '-glitchless-measure=5'], 'measure');
  checkMeasureLine(check, m4.stdout);

  await new Promise((r) => setTimeout(r, 300));
  const { sessions } = await query(port, 'sessions');
  check('the server has the phone\'s sessions', () => {
    const started = sessions.filter((s) => s.browser);
    assert.ok(started.length >= 3, `${started.length} sessions with a start`);
    for (const s of started) assert.match(s.browser, /^Unreal 5\./);
  });
  const { issues } = await query(port, 'errors');
  check('the server groups the phone\'s errors', () => {
    for (const kind of ['log_error', 'ensure', 'script', 'crash']) assert.ok(issues.some((i) => i.kind === kind), `no ${kind} issue: ${JSON.stringify(issues.map((i) => i.kind))}`);
  });
} catch (err) {
  results.push(['FAIL', 'run', err.message]);
} finally {
  server?.kill();
  recorder?.close();
  fs.writeFileSync(path.join(tmp, 'batches.json'), JSON.stringify(batches));
}

finish('iOS', tmp);
