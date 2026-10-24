// The App Store without a key (app-store.js, SPEC §3f): Apple's public review feed parsed from pages recorded on
// 2026-10-24 (reviewers' names and texts replaced), and a sync over countries that stops where it has been before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRss, appStoreRss, syncRss, AppStoreError } from '../src/app-store.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/app-store');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const replay = (pick) => async (input) => {
  const f = fixture(pick(new URL(String(input))));
  return new Response(f.body, { status: f.status, headers: { 'content-type': f.contentType } });
};

test('recorded feed pages parse to store reviews with their version and stars, and no reviewer', () => {
  const page = parseRss(JSON.parse(fixture('rss-page1').body), 'us');
  assert.equal(page.length, 50);
  for (const r of page) {
    assert.deepEqual(Object.keys(r), ['store', 'id', 'ts', 'up', 'rating', 'lang', 'text', 'topics', 'version', 'device', 'app_store']);
    assert.ok(r.store === 'app_store' && /^\d+$/.test(r.id) && r.ts > Date.parse('2026-01-01') && r.version && r.rating >= 1 && r.rating <= 5);
    assert.equal(r.up, r.rating >= 4);
    assert.deepEqual(r.app_store, { territory: 'US' });
  }
  assert.equal(JSON.stringify(page).includes('Reviewer'), false, "no reviewer's name");
  assert.ok(page.some((r) => r.topics.includes('crash')), 'topics found in the title and text');
  const single = parseRss(JSON.parse(fixture('rss-single').body), 'us');
  assert.equal(single.length, 1, 'one review comes as an object, not a list');
  assert.deepEqual(parseRss(JSON.parse(fixture('rss-empty').body), 'us'), [], 'no entry at all');
  assert.throws(() => parseRss({}, 'us'), AppStoreError);
});

test('a sync reads each country newest first and stops at a page it has seen; page 11 is refused as Apple refuses it', async () => {
  const urls = [];
  const fetch = replay((url) => {
    urls.push(url.pathname);
    const n = Number(/page=(\d+)/.exec(url.pathname)[1]);
    return url.pathname.startsWith('/gb/') ? 'rss-empty' : n === 1 ? 'rss-page1' : n === 2 ? 'rss-page2' : n > 10 ? 'rss-page11' : 'rss-empty';
  });
  const client = appStoreRss({ fetch });
  const first = await syncRss({ client, appId: '1519367184', countries: ['us', 'gb'], now: Date.parse('2026-10-24T12:00:00Z') });
  assert.equal(first.reviews.length, 100);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(urls, ['/us/rss/customerreviews/page=1/id=1519367184/sortby=mostrecent/json', '/us/rss/customerreviews/page=2/id=1519367184/sortby=mostrecent/json', '/us/rss/customerreviews/page=3/id=1519367184/sortby=mostrecent/json', '/gb/rss/customerreviews/page=1/id=1519367184/sortby=mostrecent/json']);
  urls.length = 0;
  const again = await syncRss({ client, appId: '1519367184', countries: ['us'], state: first.state, now: Date.parse('2026-10-24T18:00:00Z') });
  assert.deepEqual([again.reviews.length, urls.length], [0, 1], 'nothing new on page 1: it stops there');
  await assert.rejects(client.page('1519367184', 'us', 11), (err) => err.status === 400 && /10 pages deep/.test(err.message));
});
