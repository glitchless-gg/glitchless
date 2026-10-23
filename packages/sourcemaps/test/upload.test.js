// The uploader finds each map's script however the bundler linked them, sends one gzip request per map with the
// script's path in the build, deletes what it uploaded when asked, and the Vite plugin turns hidden maps on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMaps, uploadSourcemaps, serviceFromPackage } from '../src/index.js';
import glitchlessSourcemaps from '../src/vite.js';

const BIN = fileURLToPath(new URL('../bin/glitchless-sourcemaps.js', import.meta.url));
const MAP = (file) => JSON.stringify({ version: 3, file, sources: ['../../src/main.js'], sourcesContent: ['play();'], names: [], mappings: 'AAAA' });

// A build: a hidden map (no comment), a linked map with another name, a map named by its "file", a CSS map, a stray map.
function dist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-sm-'));
  const w = (p, text) => (fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }), fs.writeFileSync(path.join(dir, p), text));
  w('index.html', '<script src="assets/index-3f2a.js"></script>');
  w('assets/index-3f2a.js', 'play();');
  w('assets/index-3f2a.js.map', MAP('index-3f2a.js'));
  w('assets/vendor-9c1d.js', 'three();\n//# sourceMappingURL=maps/vendor.map\n');
  w('assets/maps/vendor.map', MAP('vendor.js'));
  w('assets/worker.mjs', 'work();');
  w('assets/w.map', MAP('worker.mjs'));
  w('assets/index-77aa.css', 'body{}');
  w('assets/index-77aa.css.map', MAP('index-77aa.css'));
  w('assets/old-1234.js.map', MAP('old-1234.js'));
  return dir;
}

// A stand-in Glitchless server that records each upload.
async function fakeServer(status = () => 201) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = zlib.gunzipSync(Buffer.concat(chunks)).toString('utf8');
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-glitchless-api-key'], type: req.headers['content-type'], body });
      const code = status(url.searchParams.get('file'));
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(code < 300 ? { sources: 1, sources_with_content: 1 } : { error: 'nope' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

test('finds each map and the script it belongs to', () => {
  const dir = dist();
  const { maps, orphans } = findMaps(dir);
  assert.deepEqual(
    maps.map((m) => [path.relative(dir, m.map), m.file]),
    [
      ['assets/index-3f2a.js.map', 'assets/index-3f2a.js'],
      ['assets/maps/vendor.map', 'assets/vendor-9c1d.js'],
      ['assets/w.map', 'assets/worker.mjs'],
    ],
  );
  assert.deepEqual(orphans.map((o) => path.relative(dir, o)), ['assets/old-1234.js.map']);
  assert.throws(() => findMaps(path.join(dir, 'nope')), /not a directory/);
});

test('uploads one gzip request per map, and deletes what it uploaded when asked', async () => {
  const dir = dist();
  const server = await fakeServer((file) => (file === 'assets/worker.mjs' ? 500 : 201));
  try {
    const lines = [];
    const res = await uploadSourcemaps(dir, { version: '1.2.0', service: 'blastpit', url: server.url + '/', apiKey: 'gl_sk_test', deleteMaps: true, log: (l) => lines.push(l) });
    assert.deepEqual(server.seen.map((s) => [s.method, s.path, s.query.service, s.query.version, s.query.file, s.key, s.type]).sort(), [
      ['POST', '/v1/sourcemaps', 'blastpit', '1.2.0', 'assets/index-3f2a.js', 'gl_sk_test', 'application/gzip'],
      ['POST', '/v1/sourcemaps', 'blastpit', '1.2.0', 'assets/vendor-9c1d.js', 'gl_sk_test', 'application/gzip'],
      ['POST', '/v1/sourcemaps', 'blastpit', '1.2.0', 'assets/worker.mjs', 'gl_sk_test', 'application/gzip'],
    ]);
    assert.equal(JSON.parse(server.seen.find((s) => s.query.file === 'assets/index-3f2a.js').body).file, 'index-3f2a.js');
    assert.deepEqual(res.failed.map((f) => [f.file, f.error]), [['assets/worker.mjs', 'HTTP 500: nope']]);
    // Uploaded maps are gone, and so is the comment that pointed at one; the failed one stays for a retry.
    assert.equal(fs.existsSync(path.join(dir, 'assets/index-3f2a.js.map')), false);
    assert.equal(fs.existsSync(path.join(dir, 'assets/maps/vendor.map')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'assets/vendor-9c1d.js'), 'utf8'), 'three();\n');
    assert.equal(fs.existsSync(path.join(dir, 'assets/w.map')), true);
    assert.ok(lines.some((l) => l.startsWith('skipped assets/old-1234.js.map') || l.includes('old-1234.js.map')));
  } finally {
    await server.close();
  }
});

test('needs a version and a service; a refused key says which key it needs', async () => {
  const dir = dist();
  await assert.rejects(uploadSourcemaps(dir, { service: 'g', apiKey: 'k' }), /version is required/);
  await assert.rejects(uploadSourcemaps(dir, { version: '1', apiKey: 'k' }), /service is required/);
  const server = await fakeServer(() => 401);
  try {
    const res = await uploadSourcemaps(dir, { version: '1', service: 'g', apiKey: '', url: server.url });
    assert.equal(server.seen[0].key, undefined);
    assert.match(res.failed[0].error, /HTTP 401: nope\. Set GLITCHLESS_API_KEY/);
  } finally {
    await server.close();
  }
  const dry = await uploadSourcemaps(dir, { version: '1', service: 'g', apiKey: '', dryRun: true });
  assert.equal(dry.uploaded.length, 3);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-sm-pkg-'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@studio/BlastPit","version":"1.0.0"}');
  assert.equal(serviceFromPackage(pkg), 'blastpit');
});

test('the CLI uploads a build and says how it went', async () => {
  const dir = dist();
  const server = await fakeServer();
  try {
    const run = (args, env = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, GLITCHLESS_URL: '', GLITCHLESS_SERVICE: '', ...env } });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => resolve({ code, err }));
      });
    const ok = await run(['upload', dir, '--version', '2.0.0', '--service', 'blastpit', '--url', server.url], { GLITCHLESS_API_KEY: 'gl_sk_cli' });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.err, /3 of 3 source maps uploaded for blastpit 2\.0\.0/);
    assert.equal(server.seen.length, 3);
    assert.ok(server.seen.every((s) => s.key === 'gl_sk_cli' && s.query.version === '2.0.0'));
    const usage = await run(['upload', dir, '--service', 'blastpit'], { GLITCHLESS_API_KEY: 'k' });
    assert.equal(usage.code, 2);
    assert.match(usage.err, /version is required/);
  } finally {
    await server.close();
  }
});

test('the Vite plugin turns hidden maps on, uploads after the build and can delete the maps', async () => {
  const server = await fakeServer();
  const plugin = glitchlessSourcemaps({ version: '3.0.0', service: 'blastpit', apiKey: 'gl_sk_vite', deleteMaps: true, url: server.url });
  assert.equal(plugin.apply, 'build');
  assert.deepEqual(plugin.config({}), { build: { sourcemap: 'hidden' } });
  assert.equal(plugin.config({ build: { sourcemap: true } }), undefined); // the project's own choice stands
  const built = (p, dir) => p.configResolved({ root: path.dirname(dir), build: { outDir: path.basename(dir), sourcemap: 'hidden' }, logger: { warn() {} } });
  const dir = dist();
  const logs = [];
  const log = console.log;
  console.log = (l) => logs.push(l);
  try {
    built(plugin, dir);
    await plugin.closeBundle();
    assert.equal(server.seen.length, 3);
    assert.equal(fs.existsSync(path.join(dir, 'assets/index-3f2a.js.map')), false);
    assert.ok(logs.some((l) => /uploaded 3 source maps for blastpit 3\.0\.0/.test(l)), logs.join('\n'));
    // No key: nothing is uploaded, and deleteMaps still keeps maps out of the build.
    const bare = dist();
    const offline = glitchlessSourcemaps({ version: '3.0.0', service: 'blastpit', deleteMaps: true, url: server.url });
    const key = process.env.GLITCHLESS_API_KEY;
    delete process.env.GLITCHLESS_API_KEY;
    built(offline, bare);
    await offline.closeBundle();
    if (key != null) process.env.GLITCHLESS_API_KEY = key;
    assert.equal(server.seen.length, 3);
    assert.equal(findMaps(bare).maps.length, 0);
    // strict: a failed upload fails the build.
    const strict = glitchlessSourcemaps({ version: '3.0.0', service: 'blastpit', apiKey: 'k', url: 'http://127.0.0.1:9', strict: true });
    built(strict, dist());
    await assert.rejects(strict.closeBundle(), /glitchless-sourcemaps/);
  } finally {
    console.log = log;
    await server.close();
  }
});
