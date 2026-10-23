// Source maps (SPEC §3d): the reader decodes v3 maps exactly, every store keeps a game's maps per version, and with
// them a minified build's errors show the original function, file and line, group the same in every build, and
// stay out of share links. The end-to-end tests minify a small game with esbuild, run it, and send its real stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { FileStore } from '../src/stores/file.js';
import { DynamoStore } from '../src/stores/dynamo.js';
import { buildContext } from '../src/analytics.js';
import { evaluateBoard } from '../src/board.js';
import { lifecycleRules } from '../src/lake/layout.js';
import { decodeMappings, parseMap, originalPosition, parseFrame, matchFile, cleanSource, cleanFile, functionsOf, stableMessage, createSourcemaps, MAX_UPLOAD_BYTES } from '../src/sourcemaps.js';
import { fingerprint as sdkFingerprint } from '../../packages/sdk/src/fingerprint.js';
import { FakeDynamo } from './helpers/fake-dynamo.js';
import { liveLake, hasDuckDB } from './helpers/lake-sim.js';

// The real path: bundlers write sources relative to it, and macOS's /var is a link.
const tmpdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-sourcemaps-')));
const quiet = { warn() {}, error() {} };

// ───────────────────────────── the reader ─────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    out += B64[d];
  } while (v);
  return out;
}

// Segments (absolute, per generated line) → a mappings string, as a bundler writes it.
function encode(lines) {
  const prev = [0, 0, 0, 0];
  return lines
    .map((segs) => {
      let col = 0;
      return segs
        .map((s) => {
          let out = vlq(s[0] - col);
          col = s[0];
          if (s.length >= 4) {
            out += vlq(s[1] - prev[0]) + vlq(s[2] - prev[1]) + vlq(s[3] - prev[2]);
            [prev[0], prev[1], prev[2]] = [s[1], s[2], s[3]];
          }
          if (s.length === 5) {
            out += vlq(s[4] - prev[3]);
            prev[3] = s[4];
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

test('VLQ: known mappings decode to their segments', () => {
  // 'gB' is 16; original line, column, source and name carry over from line to line, the generated column doesn't.
  const { segs, lines } = decodeMappings('AAAA,EAAE;AACA,gBAAgBC;;K');
  assert.deepEqual([...segs], [0, 0, 0, 0, -1, 2, 0, 0, 2, -1, 0, 0, 1, 2, -1, 16, 0, 1, 18, 1, 5, -1, -1, -1, -1]);
  assert.deepEqual([...lines], [0, 2, 4, 4, 5]);
  assert.deepEqual([...decodeMappings('').lines], [0, 0]);
});

test('VLQ: random segments survive encode → decode, big and negative deltas included', () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const lines = [];
  for (let l = 0; l < 40; l++) {
    const segs = [];
    let col = 0;
    for (let s = rand(30); s > 0; s--) {
      col += rand(5000);
      const kind = rand(3);
      segs.push(kind === 0 ? [col] : kind === 1 ? [col, rand(4), rand(100000), rand(300)] : [col, rand(4), rand(100000), rand(300), rand(5000)]);
    }
    lines.push(segs);
  }
  const { segs, lines: starts } = decodeMappings(encode(lines));
  const back = lines.map((_, l) => {
    const out = [];
    for (let s = starts[l]; s < starts[l + 1]; s++) out.push([...segs.slice(s * 5, s * 5 + 5)]);
    return out;
  });
  assert.deepEqual(
    back,
    lines.map((segs) => segs.map((s) => [s[0], s[1] ?? -1, s[2] ?? -1, s[3] ?? -1, s[4] ?? -1])),
  );
});

test('VLQ: broken mappings are refused with a 400', () => {
  for (const bad of ['AA', 'AAAAAA', 'A!AA', 'AAAg', 'D']) assert.throws(() => decodeMappings(bad), (err) => err.status === 400, bad);
});

test('a map answers original positions; out-of-order segments, sections and sourceRoot work', () => {
  const map = parseMap({ version: 3, sources: ['a.js', 'b.js'], names: ['hp'], sourceRoot: 'src/', sourcesContent: ['x\ny', null], mappings: encode([[[10, 1, 4, 2], [0, 0, 0, 0, 0], [20]]]) });
  assert.deepEqual(map.sources, ['src/a.js', 'src/b.js']);
  const at = (l, c) => {
    const p = originalPosition(map, l, c);
    return p && [p.source, p.line, p.column, p.name];
  };
  assert.deepEqual(at(1, 1), ['src/a.js', 1, 1, 'hp']);
  assert.deepEqual(at(1, 15), ['src/b.js', 5, 3, null]);
  assert.equal(at(1, 21), null); // a segment without a source
  assert.equal(at(2, 1), null);
  const indexed = parseMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['one.js'], mappings: 'AAAA' } }, { offset: { line: 0, column: 100 }, map: { version: 3, sources: ['two.js'], mappings: 'AACA' } }] });
  assert.equal(originalPosition(indexed, 1, 50).source, 'one.js');
  assert.deepEqual([originalPosition(indexed, 1, 101).source, originalPosition(indexed, 1, 101).line], ['two.js', 2]);
  for (const bad of ['{', '[]', '{"version":2,"sources":[],"mappings":""}', '{"version":3,"sources":"a.js","mappings":""}', '{"version":3,"sources":[],"mappings":5}']) assert.throws(() => parseMap(bad), (err) => err.status === 400, bad);
});

test('stack frames: Chrome, Firefox and Safari lines, and matching a script to an uploaded file', () => {
  assert.deepEqual(parseFrame('    at Xe.fireShotgun (https://cdn.example.com/game/assets/index-3f2a.js:1:48213)'), { fn: 'Xe.fireShotgun', url: 'https://cdn.example.com/game/assets/index-3f2a.js', line: 1, col: 48213 });
  assert.deepEqual(parseFrame('    at async e (http://localhost:4176/assets/a.js:3:9)'), { fn: 'e', url: 'http://localhost:4176/assets/a.js', line: 3, col: 9 });
  assert.deepEqual(parseFrame('    at http://localhost:4176/assets/a.js:3:9'), { fn: '<anonymous>', url: 'http://localhost:4176/assets/a.js', line: 3, col: 9 });
  assert.deepEqual(parseFrame('fireShotgun@https://x.io/assets/a.js:1:2'), { fn: 'fireShotgun', url: 'https://x.io/assets/a.js', line: 1, col: 2 });
  assert.deepEqual(parseFrame('@https://x.io/assets/a.js:1:2'), { fn: '<anonymous>', url: 'https://x.io/assets/a.js', line: 1, col: 2 });
  assert.deepEqual(parseFrame('https://x.io/assets/a.js:1:2'), { fn: '<anonymous>', url: 'https://x.io/assets/a.js', line: 1, col: 2 });
  assert.equal(parseFrame("TypeError: Cannot read properties of undefined (reading 'hp')"), null);
  assert.equal(parseFrame('    at Array.forEach (<anonymous>)'), null);
  const files = ['assets/index-3f2a.js', 'index-3f2a.js', 'assets/vendor-9.js'];
  assert.equal(matchFile('https://cdn.example.com/game/assets/index-3f2a.js?v=2', files), 'assets/index-3f2a.js');
  assert.equal(matchFile('file:///C:/game/resources/app/dist/assets/vendor-9.js', files), 'assets/vendor-9.js');
  assert.equal(matchFile('https://cdn.example.com/other-3f2a.js', files), null);
  assert.equal(cleanSource('../../src/weapons.js'), 'src/weapons.js');
  assert.equal(cleanSource('webpack://game/./src/weapons.js'), 'src/weapons.js');
  assert.equal(cleanSource('../../../../node_modules/three/build/three.core.js'), 'node_modules/three/build/three.core.js');
  assert.equal(cleanFile('./assets\\index.js'), 'assets/index.js');
  for (const bad of ['', '../secret.js', 'a/../../b.js', 'x'.repeat(201), '.'.repeat(70)]) assert.equal(cleanFile(bad), null);
  assert.equal(cleanFile('x'.repeat(200)), 'x'.repeat(200));
});

test('function names come from the source, the way V8 names them', () => {
  const src = [
    'export function createWeapons(game) {', // 1
    '  function fireShotgun() {', // 2
    "    const re = /[{'\"]/g; const s = `a ${game.x + '}'} {`;", // 3
    '    game.enemies.forEach((e) => { e.hp -= 1; });', // 4
    '    return game.enemies[9].hp;', // 5
    '  }', // 6
    '  const fireLauncher = async (n) => {', // 7
    '    return n.x;', // 8
    '  };', // 9
    '  return { fire: function (name) { return fireShotgun(name); }, aim() { return 1; } };', // 10
    '}', // 11
    'class Player extends Entity {', // 12
    '  constructor() { super(); this.hp = 3; }', // 13
    '  update(dt) { if (dt) { this.hp -= dt; } }', // 14
    '  onHit = (e) => { this.hp -= e.dmg; };', // 15
    '}', // 16
    'function typed<T>(xs: T[], n: number): Promise<T | null> {', // 17
    '  return xs[n];', // 18
    '}', // 19
  ].join('\n');
  const fns = functionsOf(src);
  const at = (line, col) => {
    const offset = src.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0) + col - 1;
    return fns.filter((f) => f.start <= offset && offset <= f.end).sort((a, b) => b.start - a.start)[0]?.name;
  };
  assert.equal(at(5, 5), 'fireShotgun');
  assert.equal(at(3, 30), 'fireShotgun'); // past a regex and a template with braces in them
  assert.equal(at(4, 35), '<anonymous>');
  assert.equal(at(8, 5), 'fireLauncher');
  assert.equal(at(10, 37), 'fire');
  assert.equal(at(10, 75), 'aim');
  assert.equal(at(11, 1), 'createWeapons');
  assert.equal(at(13, 25), 'new Player');
  assert.equal(at(14, 30), 'Player.update');
  assert.equal(at(15, 22), 'Player.onHit');
  assert.equal(at(18, 3), 'typed');
});

test('minified variables are masked out of the message a mapped error groups on', () => {
  assert.equal(stableMessage('TypeError: t.getPos is not a function'), 'TypeError: ?.getPos is not a function');
  assert.equal(stableMessage('TypeError: this.target.getPos is not a function'), 'TypeError: this.target.getPos is not a function');
  assert.equal(stableMessage("TypeError: Cannot read properties of undefined (reading 'hp')"), "TypeError: Cannot read properties of undefined (reading 'hp')");
  assert.equal(stableMessage("ReferenceError: Cannot access 'Qe' before initialization"), "ReferenceError: Cannot access '?' before initialization");
  assert.equal(stableMessage('TypeError: can\'t access property "hp", e is undefined'), 'TypeError: can\'t access property "hp", ? is undefined');
  assert.equal(stableMessage("TypeError: undefined is not an object (evaluating 'e.target.hp')"), "TypeError: undefined is not an object (evaluating '?.target.hp')");
  assert.equal(stableMessage('TypeError: (intermediate value).foo is not a function'), 'TypeError: (intermediate value).foo is not a function');
});

// ───────────────────────────── a minified game, end to end ─────────────────────────────

const WEAPONS = `export function createWeapons(game) {
  const w = { dmg: 3 };
  function onHit(e) {
    game.hits.push(e.type);
  }
  function fireShotgun() {
    const targets = [0, 1, 2];
    for (let i = 0; i < targets.length; i++) {
      const e = game.enemies[targets[i]];
      e.hp -= w.dmg;
      onHit(e);
      if (e.hp <= 0) game.enemies.splice(targets[i], 1);
    }
  }
  return { fire(name) { if (name === 'shotgun') fireShotgun(); } };
}
`;
const THROW_LINE = WEAPONS.split('\n').findIndex((l) => l.includes('e.hp -= w.dmg')) + 1;
const MAIN = `import { createWeapons } from './weapons.js';
export function play() {
  const game = { enemies: [{ hp: 1, type: 'imp' }, { hp: 9, type: 'ogre' }], hits: [] };
  createWeapons(game).fire('shotgun');
}
`;
// The next build: more code above the bug and elsewhere, so lines, columns and minified names all move.
const WEAPONS_2 = WEAPONS.replace(
  '  function fireShotgun() {',
  `  function recoil(n) {
    let a = 0, b = 1, c = 2, d = 3;
    for (let i = 0; i < n; i++) { a += b; b += c; c += d; d += a; }
    return a + b + c + d;
  }
  function fireShotgun() {
    recoil(2);`,
);
const MAIN_2 = `import { createWeapons } from './weapons.js';
const banner = ['blast', 'pit'].map((s, i) => s + i).join('-');
export function play() {
  const game = { enemies: [{ hp: 1, type: 'imp' }, { hp: 9, type: 'ogre' }], hits: [], banner };
  createWeapons(game).fire('shotgun');
}
`;

// Bundles and minifies the game into dist/assets/<name>.js with a hidden source map, runs it, and returns the error it
// threw as the browser SDK would send it.
async function minifiedBuild(dir, name, files) {
  const src = path.join(dir, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(src, f), text);
  const out = path.join(dir, 'dist', 'assets', `${name}.js`);
  await build({ entryPoints: [path.join(src, 'main.js')], bundle: true, minify: true, format: 'esm', sourcemap: 'external', outfile: out, logLevel: 'silent' });
  const game = await import(pathToFileURL(out).href);
  let err;
  try {
    game.play();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'the planted error should throw');
  const message = `${err.name}: ${err.message}`;
  const top = err.stack.split('\n').map(parseFrame).find(Boolean);
  const event = { type: 'error', kind: 'js', message, stack: err.stack, source: path.basename(top.url), line: top.line, col: top.col, fn: top.fn, fingerprint: sdkFingerprint('js', message, top.fn) };
  return { event, map: fs.readFileSync(`${out}.map`), file: `assets/${name}.js` };
}

async function serve(store, auth) {
  const server = http.createServer(createApp({ store, logger: quiet, ...(auth ? { auth } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async upload(q, body, key = null, headers = {}) {
      const res = await fetch(`${base}/v1/sourcemaps?${new URLSearchParams(q)}`, { method: 'POST', body, headers: { ...(key ? { 'x-glitchless-api-key': key } : {}), ...headers } });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async send(version, sessionId, events, token = 'gl_pub_dev') {
      const res = await fetch(`${base}/v1/intake?token=${token}`, { method: 'POST', body: JSON.stringify({ service: 'blastpit', env: 'prod', version, session_id: sessionId, player_id: `p_${sessionId}`, sdk: 'glitchless-browser/0.2.2', events }) });
      assert.equal(res.status, 202);
    },
    async get(p, key = null) {
      const res = await fetch(base + p, { headers: key ? { 'x-glitchless-api-key': key } : {} });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))),
  };
}

const sessionEvents = (ts, error) => [{ type: 'session_start', ts: ts - 5000, device: { browser: 'Chrome' } }, { type: 'level_start', ts: ts - 4000, level: 'arena-1' }, { ...error, ts, level: 'arena-1' }];

test('a minified build: errors, findings, boards and timelines show the original frames, and two builds group as one issue', async () => {
  const dir = tmpdir();
  const one = await minifiedBuild(dir, 'index-AAAA1111', { 'weapons.js': WEAPONS, 'main.js': MAIN });
  const two = await minifiedBuild(dir, 'index-BBBB2222', { 'weapons.js': WEAPONS_2, 'main.js': MAIN_2 });
  // What makes this test mean something: minified, the two builds' errors look like two different bugs.
  assert.equal(one.event.line, 1);
  assert.notEqual(one.event.fingerprint, two.event.fingerprint, `minified names: ${one.event.fn} and ${two.event.fn}`);

  const store = new FileStore(path.join(dir, 'data'));
  const app = await serve(store);
  try {
    const now = Date.now();
    // Before any map is uploaded an error keeps what the SDK sent.
    await app.send('1.0.0', 's_before', sessionEvents(now - 60_000, one.event));
    let issues = (await app.get('/v1/query/errors?service=blastpit&from=0')).body.issues;
    assert.equal(issues[0].fingerprint, one.event.fingerprint);

    const gz = zlib.gzipSync(one.map);
    const up = await app.upload({ service: 'Blastpit', version: '1.0.0', file: one.file }, gz);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.deepEqual([up.body.service, up.body.version, up.body.file, up.body.sources_with_content], ['blastpit', '1.0.0', 'assets/index-AAAA1111.js', 2]);
    assert.equal((await app.upload({ service: 'blastpit', version: '1.0.1' }, two.map)).status, 400); // no file, and esbuild's map names none
    assert.equal((await app.upload({ service: 'blastpit', version: '1.0.1', file: two.file }, two.map)).status, 201);
    const listed = (await app.get('/v1/sourcemaps?service=blastpit')).body.sourcemaps;
    assert.deepEqual(listed.map((m) => [m.version, m.file]).sort(), [['1.0.0', 'assets/index-AAAA1111.js'], ['1.0.1', 'assets/index-BBBB2222.js']]);

    // The older error is mapped when it is shown, the new ones as they arrive: all three are one issue.
    await app.send('1.0.0', 's_one', sessionEvents(now - 30_000, one.event));
    await app.send('1.0.1', 's_two', sessionEvents(now - 10_000, two.event));
    issues = (await app.get('/v1/query/errors?service=blastpit&from=0')).body.issues;
    const mapped = issues.filter((i) => i.fingerprint !== one.event.fingerprint);
    assert.equal(mapped.length, 1, JSON.stringify(issues.map((i) => [i.fingerprint, i.location])));
    const [issue] = mapped;
    assert.equal(issue.count, 2);
    assert.deepEqual(issue.versions, ['1.0.0', '1.0.1']);
    assert.equal(issue.location, `fireShotgun (weapons.js:${THROW_LINE})`);
    assert.match(issue.stack, new RegExp(`at fireShotgun \\(src-index-AAAA1111/weapons\\.js:${THROW_LINE}:\\d+\\)`));
    assert.match(issue.stack, /at (Object\.)?fire \(src-index-AAAA1111\/weapons\.js:\d+:\d+\)/);
    assert.match(issue.stack, /at play \(src-index-AAAA1111\/main\.js:4:\d+\)/);
    const { minified, ...frame } = issue.frames[0];
    assert.deepEqual(frame, { fn: 'fireShotgun', file: 'src-index-AAAA1111/weapons.js', line: THROW_LINE, col: frame.col, mapped: true, code: 'e.hp -= w.dmg;' });
    assert.ok(minified.startsWith(`${one.event.fn} (`) && minified.endsWith(`/dist/assets/index-AAAA1111.js:1:${one.event.col})`), minified);
    assert.equal(issue.minified.location, issue.frames[0].minified);
    assert.match(issue.minified.stack, /index-AAAA1111\.js:1:\d+/);
    // The error sent before the upload is mapped for display too, under its old fingerprint.
    assert.equal(issues.find((i) => i.fingerprint === one.event.fingerprint).location, `fireShotgun (weapons.js:${THROW_LINE})`);

    // Findings and the overview's top errors read the same issue; the advice starts at the original place.
    const found = (await app.get('/v1/query/findings?service=blastpit&from=0')).body.findings.find((f) => f.id === `error-${issue.fingerprint}`);
    assert.equal(found.evidence.location, issue.location);
    assert.match(found.suggestion, new RegExp(`Start at fireShotgun \\(weapons\\.js:${THROW_LINE}\\)`));
    assert.match(found.evidence.stack, /at fireShotgun \(/);
    assert.equal((await app.get('/v1/query/overview?service=blastpit&from=0')).body.top_errors[0].location, issue.location);

    // A session's timeline maps its errors; the minified stack stays beside it.
    const detail = (await app.get('/v1/query/session?service=blastpit&id=s_two&from=0')).body;
    const err = detail.timeline.find((e) => e.type === 'error');
    assert.deepEqual([err.fn, err.source, err.line], ['fireShotgun', 'weapons.js', THROW_LINE + 6]);
    assert.equal(err.minified.fn, two.event.fn);
    assert.match(err.minified.stack, /index-BBBB2222\.js:1:/);

    // A board's error panel shows where; a share link of that board doesn't, nor any line of source.
    const panel = { id: 'errs', type: 'errors' };
    const ctx = buildContext(await store.query('default', { service: 'blastpit', from: 0, to: Date.now() }), { service: 'blastpit', from: 0, to: Date.now(), type: 'all' });
    await createSourcemaps(store, { logger: quiet }).prepare(ctx, 'default', 'blastpit');
    const [own] = evaluateBoard(ctx, { panels: [panel, { id: 'f', type: 'findings' }] });
    assert.equal(own.issues.find((i) => i.fingerprint === issue.fingerprint).location, issue.location);
    const shared = JSON.stringify(evaluateBoard(ctx, { panels: [panel, { id: 'f', type: 'findings' }] }, { shared: true }));
    for (const leak of ['weapons.js', 'e.hp -= w.dmg', 'fireShotgun', 'index-AAAA1111']) assert.equal(shared.includes(leak), false, `a shared board shows ${leak}`);

    // Deleting a version's maps (and only that version's).
    assert.equal((await fetch(`${app.base}/v1/sourcemaps?service=blastpit&version=1.0.0`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await app.get('/v1/sourcemaps?service=blastpit')).body.sourcemaps.map((m) => m.version), ['1.0.1']);
    assert.equal((await fetch(`${app.base}/v1/sourcemaps?service=blastpit&version=1.0.0`, { method: 'DELETE' })).status, 404);
  } finally {
    await app.close();
  }
});

test('upload checks: the sourcemaps scope, the size, and the shape of the map', async () => {
  const dir = tmpdir();
  const scopes = { gl_sk_up: ['read', 'sourcemaps'], gl_sk_read: ['read'] };
  const auth = {
    resolveIngest: () => ({ projectId: 'P' }),
    resolveReader(req) {
      const s = scopes[req.headers['x-glitchless-api-key']];
      if (!s) throw new AuthError(401, 'no key');
      return { projectId: 'P', scopes: s };
    },
  };
  const app = await serve(new FileStore(dir, { legacyProject: null }), auth);
  try {
    const map = JSON.stringify({ version: 3, file: 'index-1.js', sources: ['src/a.js'], sourcesContent: ['let a = 1;'], names: [], mappings: 'AAAA' });
    const q = { service: 'blastpit', version: '1.0.0' };
    assert.equal((await app.upload(q, map, 'gl_sk_read')).status, 403);
    assert.match((await app.upload(q, map, 'gl_sk_read')).body.error, /sourcemaps scope/);
    assert.equal((await app.upload({ service: 'blastpit' }, map, 'gl_sk_up')).status, 400);
    const ok = await app.upload(q, map, 'gl_sk_up');
    assert.equal(ok.status, 201);
    assert.equal(ok.body.file, 'index-1.js'); // the map's own "file" when none is given
    assert.equal((await app.get('/v1/sourcemaps?service=blastpit', 'gl_sk_read')).body.sourcemaps.length, 1);
    assert.equal((await fetch(`${app.base}/v1/sourcemaps?service=blastpit&version=1.0.0`, { method: 'DELETE', headers: { 'x-glitchless-api-key': 'gl_sk_read' } })).status, 403);
    for (const bad of ['not json', '{"version":3}', '{"version":3,"sources":[],"mappings":"!!"}', JSON.stringify({ version: 3, sources: [], mappings: '' })]) {
      const res = await app.upload({ ...q, file: 'assets/x.js' }, bad, 'gl_sk_up');
      assert.equal(res.status, bad.includes('"mappings":""') ? 201 : 400, bad);
    }
    assert.equal((await app.upload({ ...q, file: '../../etc/passwd' }, map, 'gl_sk_up')).status, 400);
    // Too big on the wire, and too big unpacked (a gzip bomb).
    assert.equal((await app.upload({ ...q, file: 'big.js' }, Buffer.alloc(MAX_UPLOAD_BYTES + 1, 32), 'gl_sk_up').catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await app.upload({ ...q, file: 'bomb.js' }, zlib.gzipSync(Buffer.alloc(50_000_000, 32)), 'gl_sk_up')).status, 413);
  } finally {
    await app.close();
  }
});

test('ingest leaves errors alone when the game has no maps, and engine SDKs\' stacks always', async () => {
  const store = new FileStore(tmpdir(), { legacyProject: null });
  const sm = createSourcemaps(store, { logger: quiet });
  const error = { type: 'error', service: 'g', version: '1', sdk: 'glitchless-browser/0.2.2', kind: 'js', message: 'TypeError: x', stack: 'TypeError: x\n    at e (https://g.io/assets/index-1.js:1:5)', fn: 'e', fingerprint: 'abc' };
  await sm.refingerprint('P', [error]);
  assert.equal(error.fingerprint, 'abc');
  await store.putSourcemap('P', 'g', '1', 'assets/index-1.js', JSON.stringify({ version: 3, sources: ['src/a.js'], sourcesContent: ['function boom() {\n  x.y();\n}'], names: [], mappings: 'AAAA,IACE' }));
  // A process trusts its list of a game's maps for a minute; a new one sees the upload.
  const fresh = createSourcemaps(store, { logger: quiet });
  const godot = { ...error, sdk: 'glitchless-godot/0.1.0' };
  await fresh.refingerprint('P', [error, godot]);
  assert.equal(godot.fingerprint, 'abc');
  assert.deepEqual([error.fn, error.source, error.line, error.minified.fingerprint], ['boom', 'a.js', 2, 'abc']);
  assert.notEqual(error.fingerprint, 'abc');
  // Another project's identical error is not mapped by this project's maps.
  const other = { ...error, fn: 'e', fingerprint: 'abc', minified: undefined };
  await fresh.refingerprint('Q', [other]);
  assert.equal(other.fingerprint, 'abc');
});

test('ingest reads only the maps its top frames need, once per process', async () => {
  const store = new FileStore(tmpdir(), { legacyProject: null });
  const map = JSON.stringify({ version: 3, sources: ['src/a.js'], sourcesContent: ['function boom() {\n  x.y();\n}'], names: [], mappings: 'AAAA,IACE' });
  await store.putSourcemap('P', 'g', '1', 'assets/index-1.js', map);
  await store.putSourcemap('P', 'g', '1', 'assets/vendor-1.js', map);
  const reads = [];
  const get = store.getSourcemap.bind(store);
  store.getSourcemap = (...args) => (reads.push(args[3]), get(...args));
  const sm = createSourcemaps(store, { logger: quiet });
  const frames = ['e (https://g.io/assets/index-1.js:1:5)', 'f (https://g.io/assets/index-1.js:1:1)', 'g (https://g.io/assets/index-1.js:1:1)', 'h (https://g.io/assets/index-1.js:1:1)', 'render (https://g.io/assets/vendor-1.js:1:5)'];
  const error = () => ({ type: 'error', service: 'g', version: '1', sdk: 'glitchless-browser/0.2.2', kind: 'js', message: 'TypeError: x', stack: ['TypeError: x', ...frames.map((f) => `    at ${f}`)].join('\n'), fn: 'e', fingerprint: 'abc' });
  const [one, two] = [error(), error()];
  await sm.refingerprint('P', [one]);
  await sm.refingerprint('P', [two]);
  assert.equal(one.fn, 'boom');
  assert.equal(two.fingerprint, one.fingerprint);
  assert.deepEqual(reads, ['assets/index-1.js']);
});

// ───────────────────────────── every store ─────────────────────────────

const stores = {
  file: () => new FileStore(tmpdir(), { legacyProject: null }),
  dynamodb: () => new DynamoStore({ table: 't', doc: new FakeDynamo(), legacyProject: null, rollupsSince: 0 }),
  ...(hasDuckDB ? { lake: () => liveLake().store } : {}),
};

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: keeps source maps per project, game and version, replaces, deletes and clears them`, async () => {
    const store = make();
    // Big enough to need several DynamoDB items: source text that doesn't compress.
    let seed = 1;
    const noise = Array.from({ length: 700_000 }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join('');
    const big = JSON.stringify({ version: 3, sources: ['a.js'], sourcesContent: [noise], names: [], mappings: 'AAAA' });
    await store.putSourcemap('A', 'g', '1.0.0', 'assets/index-1.js', big);
    await store.putSourcemap('A', 'g', '1.0.0', 'assets/vendor~1.js', '{"v":1}');
    await store.putSourcemap('A', 'g', '1.0.1', 'assets/index-2.js', '{"v":2}');
    await store.putSourcemap('B', 'g', '1.0.0', 'assets/index-1.js', '{"b":1}');
    assert.equal(await store.getSourcemap('A', 'g', '1.0.0', 'assets/index-1.js'), big);
    assert.equal(await store.getSourcemap('B', 'g', '1.0.0', 'assets/index-1.js'), '{"b":1}');
    assert.equal(await store.getSourcemap('C', 'g', '1.0.0', 'assets/index-1.js'), null);
    const list = async (p) => (await store.sourcemaps(p, 'g')).map((m) => `${m.version} ${m.file} ${m.size}`).sort();
    assert.deepEqual(await list('A'), ['1.0.0 assets/index-1.js ' + big.length, '1.0.0 assets/vendor~1.js 7', '1.0.1 assets/index-2.js 7']);
    assert.ok((await store.sourcemaps('A', 'g')).every((m) => m.uploaded_at > 0));
    assert.deepEqual(await list('B'), ['1.0.0 assets/index-1.js 7']);
    // An upload of the same file replaces it (and, in DynamoDB, its old chunks).
    await store.putSourcemap('A', 'g', '1.0.0', 'assets/index-1.js', '{"small":true}');
    assert.equal(await store.getSourcemap('A', 'g', '1.0.0', 'assets/index-1.js'), '{"small":true}');
    if (kind === 'dynamodb') assert.equal([...(store.doc.tables.get('P#A#SMAP#g')?.keys() || [])].filter((sk) => sk.startsWith('C#')).length, 3);
    await store.deleteSourcemaps('A', 'g', '1.0.0');
    assert.deepEqual(await list('A'), ['1.0.1 assets/index-2.js 7']);
    assert.equal(await store.getSourcemap('A', 'g', '1.0.0', 'assets/vendor~1.js'), null);
    if (kind !== 'dynamodb') {
      await store.clear('A', 'g');
      assert.deepEqual(await list('A'), []);
      assert.deepEqual(await list('B'), ['1.0.0 assets/index-1.js 7']);
    }
  });
}

test('the lake keeps source maps under sourcemaps/ and expires them a while after their upload', () => {
  const rule = lifecycleRules().find((r) => r.Prefix === 'sourcemaps/');
  assert.equal(rule.ExpirationInDays, 400);
});

test('an upload past MAX_VERSIONS deletes the versions uploaded longest ago', async () => {
  const store = new FileStore(tmpdir(), { legacyProject: null });
  const clock = Date.now() - 3_600_000;
  const sm = createSourcemaps(store, { logger: quiet });
  const map = JSON.stringify({ version: 3, sources: ['a.js'], names: [], mappings: 'AAAA' });
  for (let v = 0; v < 52; v++) {
    const res = await sm.upload('P', { service: 'g', version: `1.0.${v}`, file: 'a.js' }, Buffer.from(map));
    if (v < 50) assert.equal(res.pruned, undefined);
    // Files written in the same millisecond tie: give each version its own upload time.
    const f = path.join(store.sourcemapDir('P', 'g', `1.0.${v}`), 'a%2Ejs.map');
    fs.utimesSync(f, new Date(clock + v * 1000), new Date(clock + v * 1000));
  }
  const versions = new Set((await store.sourcemaps('P', 'g')).map((m) => m.version));
  assert.equal(versions.size, 50);
  assert.equal(versions.has('1.0.0'), false);
  assert.equal(versions.has('1.0.1'), false);
  assert.equal(versions.has('1.0.51'), true);
});
