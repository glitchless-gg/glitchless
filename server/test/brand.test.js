// A game's branding (brand.js): images are checked by their content and size, only the dashboard scope changes it,
// a share link reads its own game's, and every store keeps it apart from the dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { sniffImage, checkImage, checkAccent, BrandError, brandBody } from '../src/brand.js';
import { STORES } from './helpers/stores.js';
import { png, jpeg, webp, svg, html, gif } from './helpers/images.js';

test('images are recognised by their bytes: PNG, JPEG and WebP with their size; SVG, HTML and GIF never, whatever they are called', () => {
  assert.deepStrictEqual(sniffImage(png(256, 128)), { type: 'image/png', width: 256, height: 128 });
  assert.deepStrictEqual(sniffImage(jpeg(1600, 400)), { type: 'image/jpeg', width: 1600, height: 400 });
  assert.deepStrictEqual(sniffImage(webp(300, 200)), { type: 'image/webp', width: 300, height: 200 });
  for (const bad of [svg, html, gif, Buffer.from('not an image'), Buffer.alloc(0)]) assert.equal(sniffImage(bad), null);
  const refused = (kind, bytes) => assert.throws(() => checkImage(kind, bytes), BrandError);
  refused('logo', svg);
  refused('logo', html);
  assert.equal(catchStatus(() => checkImage('logo', svg)), 415);
  // Sizes: a logo up to 100 KB, a banner up to 300 KB, and pixels within reason.
  assert.equal(checkImage('logo', png(256, 256, { pad: 100 * 1024 })).bytes, 100 * 1024);
  assert.equal(catchStatus(() => checkImage('logo', png(256, 256, { pad: 100 * 1024 + 1 }))), 413);
  assert.equal(checkImage('banner', jpeg(1600, 400, { pad: 300 * 1024 })).type, 'image/jpeg');
  assert.equal(catchStatus(() => checkImage('banner', jpeg(1600, 400, { pad: 300 * 1024 + 1 }))), 413);
  assert.equal(catchStatus(() => checkImage('logo', png(2000, 2000))), 400);
  assert.equal(catchStatus(() => checkImage('poster', png())), 404);
  const a = checkImage('logo', png(4, 4));
  assert.match(a.hash, /^[0-9a-f]{16}$/);
  assert.notEqual(a.hash, checkImage('logo', png(4, 4, { rgb: [1, 2, 3] })).hash, 'another image, another hash (and address)');
  // Accents.
  assert.equal(checkAccent('#E4572E'), '#e4572e');
  assert.equal(checkAccent(null), null);
  for (const bad of ['red', '#fff', 'url(x)', '#e4572e; color: red', 12]) assert.throws(() => checkAccent(bad), BrandError);
  assert.equal(brandBody('starlift', null), null);
});

function catchStatus(fn) {
  try {
    fn();
  } catch (err) {
    return err.status;
  }
  return 200;
}

const SHARE = { id: 'share-1', service: 'starlift', page: 'overview' };
const readers = {
  writer: { projectId: 'p1', scopes: ['read', 'dashboard'] },
  reader: { projectId: 'p1', scopes: ['read'] },
  other: { projectId: 'p2', scopes: ['read', 'dashboard'] },
  share: { projectId: 'p1', scopes: ['read'], share: SHARE, keyId: 'share', rps: 1000 },
};
const auth = {
  resolveIngest() {
    return { projectId: 'p1' };
  },
  resolveReader(req) {
    const r = readers[req.headers['x-test-reader']];
    if (!r) throw new AuthError(401, 'no key');
    return r;
  },
};

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a game's accent, logo and banner are saved with the dashboard scope, served as images with their own type, read by its share link, and removed`, async () => {
    const { store, close: closeStore } = await make({ legacyProject: null });
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, who, body, type = 'application/json') => {
      const res = await fetch(base + p, { method, headers: { 'x-test-reader': who, 'x-glitchless-client': 'test', 'content-type': type }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(buf.toString());
      } catch {}
      return { status: res.status, headers: res.headers, json, buf };
    };
    try {
      assert.equal((await call('GET', '/v1/brand?service=starlift', 'reader')).json.brand, null, 'no branding until someone sets it');
      // Only the dashboard scope changes it.
      assert.equal((await call('PUT', '/v1/brand?service=starlift', 'reader', { accent: '#e4572e' })).status, 403);
      assert.equal((await call('PUT', '/v1/brand/logo?service=starlift', 'reader', png(), 'image/png')).status, 403);
      assert.equal((await call('PUT', '/v1/brand?service=starlift', 'writer', { accent: 'orange' })).status, 400);
      const accent = await call('PUT', '/v1/brand?service=starlift', 'writer', { accent: '#E4572E' });
      assert.equal(accent.status, 200);
      assert.equal(accent.json.brand.accent, '#e4572e');
      assert.equal(accent.json.brand.updated_by, 'test');

      // Images by their content: a renamed SVG or HTML page is refused and nothing is kept.
      for (const [bytes, type] of [[svg, 'image/png'], [html, 'image/jpeg'], [gif, 'image/webp']]) assert.equal((await call('PUT', '/v1/brand/logo?service=starlift', 'writer', bytes, type)).status, 415);
      assert.equal((await call('PUT', '/v1/brand/logo?service=starlift', 'writer', png(256, 256, { pad: 100 * 1024 + 1 }), 'image/png')).status, 413);
      assert.equal((await call('PUT', '/v1/brand/banner?service=starlift', 'writer', jpeg(1600, 400, { pad: 300 * 1024 + 1 }), 'image/jpeg')).status, 413);
      assert.equal((await call('GET', '/v1/brand?service=starlift', 'reader')).json.brand.logo, null);

      const logo = png(256, 256);
      const withLogo = await call('PUT', '/v1/brand/logo?service=starlift', 'writer', logo, 'application/octet-stream');
      assert.equal(withLogo.status, 200);
      assert.equal(withLogo.json.brand.logo.type, 'image/png');
      assert.equal(withLogo.json.brand.accent, '#e4572e', 'an image leaves the accent as it was');
      const banner = jpeg(1600, 400, { pad: 250 * 1024 });
      const withBanner = await call('PUT', '/v1/brand/banner?service=starlift', 'writer', banner, 'image/jpeg');
      assert.equal(withBanner.json.brand.banner.focus, 'center');
      assert.equal((await call('PUT', '/v1/brand?service=starlift', 'writer', { banner_focus: 'top' })).json.brand.banner.focus, 'top');
      assert.equal((await call('PUT', '/v1/brand?service=starlift', 'writer', { banner_focus: 'left' })).status, 400);

      // Served with its own type, never sniffed, cached for good at its hashed address.
      const { brand } = (await call('GET', '/v1/brand?service=starlift', 'reader')).json;
      assert.match(brand.logo.url, /^\/v1\/brand\/logo\?service=starlift&v=[0-9a-f]{16}$/);
      const got = await call('GET', brand.logo.url, 'reader');
      assert.equal(got.status, 200);
      assert.equal(got.headers.get('content-type'), 'image/png');
      assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
      assert.match(got.headers.get('content-security-policy'), /sandbox/);
      assert.match(got.headers.get('cache-control'), /immutable/);
      assert.deepStrictEqual(got.buf, logo);
      assert.equal((await call('GET', '/v1/brand/logo?service=starlift&v=old', 'reader')).headers.get('cache-control'), 'no-cache', 'an old address is not kept');
      assert.deepStrictEqual((await call('GET', brand.banner.url, 'reader')).buf, banner);

      // Per game and per project.
      assert.equal((await call('GET', '/v1/brand?service=zoomies', 'reader')).json.brand, null);
      assert.equal((await call('GET', '/v1/brand?service=starlift', 'other')).json.brand, null, "another project never sees this game's brand");
      assert.equal((await call('GET', brand.logo.url, 'other')).status, 404);

      // A share link reads its own game's brand and images, nothing else, and changes nothing.
      const shared = await call('GET', '/v1/brand?service=starlift', 'share');
      assert.equal(shared.json.brand.accent, '#e4572e');
      assert.deepStrictEqual((await call('GET', shared.json.brand.logo.url, 'share')).buf, logo);
      assert.equal((await call('GET', '/v1/brand?service=zoomies', 'share')).status, 403);
      assert.equal((await call('PUT', '/v1/brand?service=starlift', 'share', { accent: '#000000' })).status, 403);
      assert.equal((await call('DELETE', '/v1/brand/logo?service=starlift', 'share')).status, 403);

      // A new logo gets a new address; removing one leaves the rest; a reset removes everything.
      const next = await call('PUT', '/v1/brand/logo?service=starlift', 'writer', webp(200, 200), 'image/webp');
      assert.notEqual(next.json.brand.logo.url, brand.logo.url);
      assert.equal(next.json.brand.logo.type, 'image/webp');
      const noBanner = await call('DELETE', '/v1/brand/banner?service=starlift', 'writer');
      assert.equal(noBanner.json.brand.banner, null);
      assert.equal(noBanner.json.brand.logo.type, 'image/webp');
      assert.equal(await store.getBrandImage('p1', 'starlift', 'banner'), null, "the banner's bytes go with it");
      assert.equal((await call('DELETE', '/v1/brand?service=starlift', 'writer')).json.brand, null);
      assert.equal(await store.getBrandImage('p1', 'starlift', 'logo'), null);
      assert.equal((await call('GET', '/v1/brand?service=starlift', 'reader')).json.brand, null);
      assert.equal((await call('GET', '/v1/dashboard?service=starlift', 'reader')).json.dashboard, null, 'branding is no part of the dashboard spec');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
