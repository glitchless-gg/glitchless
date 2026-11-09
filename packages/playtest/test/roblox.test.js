// Roblox playtests against a stand-in for Roblox Studio's MCP server (fixtures/fake-studio-mcp.mjs), whose play tests
// send real batches to a real Glitchless server in this process: picking the Studio, Workspace attributes set and
// put back, the run read back from the server (the players' sessions and the server's own), and the errors that say
// what to do. roblox/test/playtest.mjs plays the Glitchless test place in real Studio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../server/src/app.js';
import { FileStore } from '../../../server/src/stores/file.js';
import { playtest } from '../src/index.js';
import { unmark, longString } from '../src/roblox.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-studio-mcp.mjs');
const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-roblox-playtest-store-')));
const api = http.createServer(createApp({ store, auth: { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read'] }) }, logger: { warn() {}, error() {} } }));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;
after(() => api.close());

const FAKE_ENV = ['FAKE_STUDIO_LIST', 'FAKE_STUDIO_SERVICE', 'FAKE_STUDIO_HTTP', 'FAKE_STUDIO_SEND', 'FAKE_STUDIO_MODE', 'FAKE_STUDIO_PLAYING', 'FAKE_STUDIO_LOG'];
// A project and a stand-in Studio for one test; `fake` sets its FAKE_STUDIO_* variables.
function project(config = {}, fake = {}) {
  for (const k of FAKE_ENV) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-roblox-playtest-'));
  Object.assign(process.env, { FAKE_STUDIO_INTAKE: base, FAKE_STUDIO_LOG: path.join(dir, 'studio.log'), ...fake });
  fs.writeFileSync(path.join(dir, 'glitchless.playtest.json'), JSON.stringify({ engine: 'roblox', studio: 'FakeRace', studio_mcp: [process.execPath, FAKE], server: base, sessions_wait_s: 3, studio_wait_s: 2, ...config }));
  return dir;
}
const calls = (dir) => fs.readFileSync(path.join(dir, 'studio.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const scenarios = (mode) => [
  { name: 'seed 7', params: { autoplay: true, seed: 7, mode }, max_s: 10 },
  { name: 'seed 21', params: { autoplay: true, seed: 21, mode: 'ok' }, max_s: 10 },
];
const rewrite = (dir, config) => {
  const file = path.join(dir, 'glitchless.playtest.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...config }));
};

test('Luau answers survive however Studio prints them, and long strings hold any text', () => {
  assert.deepEqual(unmark('GLP<{"module":true}>GLP'), { module: true });
  assert.deepEqual(unmark('"GLP<{\\"module\\":true}>GLP"'), { module: true }); // printed inside a quoted string
  assert.equal(unmark('nil'), undefined);
  assert.equal(longString('a ]=] b'), '[==[a ]=] b]==]');
});

test('a Roblox game: play tests in Studio, read back from the server, then a new error fails', async () => {
  const cwd = project({ scenarios: scenarios('ok') });
  const saved = await playtest({ cwd, saveAs: 'baseline' });
  const run = saved.candidate;
  assert.equal(run.kind, 'roblox');
  assert.equal(run.game, 'FakeRace.rbxl');
  assert.equal(run.service, 'fake-race', 'read from the place\'s Glitchless.init');
  assert.deepEqual(run.scenarios.map((s) => [s.session_ids.length, s.server_session_ids.length, s.finished]), [[1, 1, true], [1, 1, true]]);
  assert.equal(run.summary.sessions, 2);
  assert.ok(run.summary.levels.desert_loop, JSON.stringify(run.summary.levels));
  assert.deepEqual(run.summary.errors.map((e) => [e.message, !!e.server]), [["<player>'s trophy is missing", true]], 'the server\'s script error is the game\'s');
  assert.match(saved.report, /2 autoplay runs · fake-race · Roblox Studio/);

  const log = calls(cwd);
  assert.ok(log.filter((c) => c.name).every((c) => c.name === 'list_roblox_studios' || c.studio_id === 's1'), 'never touched another Studio');
  assert.deepEqual(log.filter((c) => c.name === 'start_stop_play').map((c) => c.is_start), [true, false, true, false]);
  const attrs = log.filter((c) => c.attrs).map((c) => c.attrs);
  assert.deepEqual(attrs[0], { Theme: 'desert', autoplay: true, seed: 7, mode: 'ok' }, 'the scenario\'s params, as Workspace attributes');
  assert.deepEqual(attrs.at(-1), { Theme: 'desert' }, 'and the place\'s attributes as they were');

  rewrite(cwd, { scenarios: scenarios('error') });
  const r = await playtest({ cwd });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.comparison.new_errors.map((e) => e.message), ["attempt to index nil with 'Speed'"]);
  assert.ok(!r.comparison.notes.some((n) => /someone else/.test(n)));
});

test('slower frames in a Roblox play test fail, and a quick run compares with the same run only', async () => {
  const same = [
    { name: 'seed 7', params: { autoplay: true, seed: 7 }, max_s: 10 },
    { name: 'seed 21', params: { autoplay: true, seed: 21 }, max_s: 10 },
  ];
  const cwd = project({ scenarios: same });
  await playtest({ cwd, saveAs: 'baseline' });
  process.env.FAKE_STUDIO_MODE = 'slow'; // the same scenarios on a slower build
  const slow = await playtest({ cwd, quick: true });
  assert.equal(slow.verdict, 'fail');
  assert.ok(slow.comparison.regressions.some((c) => c.id === 'pct_frames_over_budget'), JSON.stringify(slow.comparison.regressions));
  assert.match(slow.baseline.name, /matching runs/);
  assert.equal(slow.baseline.summary.sessions, 1, JSON.stringify(slow.baseline.scenarios.map((s) => [s.scenario, s.session_ids, s.server_session_ids])));
  assert.equal(slow.baseline.summary.errors.length, 1, 'the baseline\'s server error is still there, so it isn\'t new');
});

test('Roblox errors say what to do', async () => {
  const fails = (config, fake, pattern, o = {}) => assert.rejects(playtest({ cwd: project(config, fake), ...o }), pattern);
  await fails({ studio: null }, {}, /2 Roblox Studios are open \("FakeRace\.rbxl", "Starlift \(placeId: \d+\)"\): set "studio"/);
  await fails({ studio: 'Obby' }, {}, /No open Roblox Studio is "Obby"/);
  await fails({ studio: null }, { FAKE_STUDIO_LIST: '[]' }, /No Roblox Studio answered[\s\S]*Enable Studio as MCP server/);
  await fails({ studio_mcp: ['/no/such/StudioMCP'] }, {}, /isn't at \/no\/such\/StudioMCP/);
  await fails({}, { FAKE_STUDIO_PLAYING: '1' }, /is in a play test \(Play\): stop it/);
  await fails({}, { FAKE_STUDIO_HTTP: '0' }, /Allow HTTP Requests off[\s\S]*Game Settings → Security/);
  await fails({}, { FAKE_STUDIO_SERVICE: '' }, /set "service" in glitchless\.playtest\.json/);
  await fails({ scenarios: [{ params: { 'level-seconds': 2 } }] }, {}, /"level-seconds" can't be a Roblox attribute name/);
  await fails({ scenarios: [{ params: { autoplay: true }, max_s: 5 }] }, { FAKE_STUDIO_SEND: '0' }, /No session from "fake-race" reached[\s\S]*the intake answered HTTP 401/);
  // With the default scenarios, a game whose bot starts no level has no autoplay mode.
  await fails({}, { FAKE_STUDIO_MODE: 'menu' }, /no player started a level[\s\S]*workspace:GetAttribute\("autoplay"\)/);
  await assert.rejects(playtest({ cwd: project(), baselineUrl: 'http://localhost:5173/' }), /plays in the open Roblox Studio/);
});

test('a play test that never says it is done stops at max_s', async () => {
  const cwd = project({ scenarios: [{ name: 'endless', params: { autoplay: true, mode: 'endless' }, max_s: 2 }] });
  const r = await playtest({ cwd });
  assert.equal(r.candidate.scenarios[0].finished, false);
  assert.match(r.report, /1 autoplay run · fake-race/);
});
