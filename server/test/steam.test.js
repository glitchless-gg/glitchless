// Steam as a review store (steam.js, SPEC §3f): the keyless calls' parsers on answers recorded from the real Steam
// Web API, the client, the incremental sync by date, and Steam's release marks. The join by build is store-neutral
// (store-reviews.test.js). Nothing here calls Steam: recorded fixtures and a scenario stand in for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewsPage, parsePlayers, parseNews, steamClient, syncKeyless, steamMarks, SteamError } from '../src/steam.js';
import { reviewTopics } from '../src/reviews.js';
import { readFixture, fixtureFetch, steamScenario, steamFetch, APP_ID } from './helpers/steam-data.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const body = (name) => JSON.parse(readFixture(name).body);

test('recorded reviews parse to the store-neutral review, with what only Steam has under steam, and no author', () => {
  const page = parseReviewsPage(body('reviews-page1'));
  assert.equal(page.reviews.length, 8);
  assert.equal(page.count, 8);
  assert.match(page.cursor, /=$/);
  assert.deepEqual(page.summary, { desc: 'Very Positive', positive: 55, negative: 5, total: 60 });
  for (const r of page.reviews) {
    assert.deepEqual(Object.keys(r), ['store', 'id', 'ts', 'up', 'rating', 'lang', 'text', 'topics', 'version', 'device', 'steam']);
    assert.deepEqual(Object.keys(r.steam), ['playtime_min', 'deck_min', 'deck', 'refunded', 'early_access']);
    assert.equal(r.store, 'steam');
    assert.equal(r.rating, null);
    assert.equal(r.version, null, 'Steam never says which version was reviewed: the join finds it');
    assert.ok(r.ts > Date.parse('2026-01-01') && Number.isInteger(r.steam.playtime_min));
  }
  assert.equal(JSON.stringify(page).includes('7656119'), false, 'no Steam ID of an author');
  const deck = page.reviews.find((r) => r.steam.deck);
  assert.equal(deck.steam.deck_min, 733);
  const hw = page.reviews.find((r) => r.device);
  assert.deepEqual(hw.device, { os: 'Windows 11', cpu: 'AMD Ryzen 5 4600G with Radeon Graphics', gpu: 'NVIDIA GeForce RTX 3060', ram_mb: 16178 });
  assert.ok(page.reviews.filter((r) => r.device).every((r) => r.device.cpu === r.device.cpu.trim()), 'trailing spaces of a CPU name are gone');
  // The fixture's texts were replaced when it was recorded; BBCode is taken out and topics found.
  const stutters = page.reviews.find((r) => /stutters/.test(r.text));
  assert.deepEqual(stutters.topics, ['stutter', 'fps']);
  assert.ok(page.reviews.some((r) => r.text === 'Masterpiece. The music alone is worth it.'), 'BBCode out');
  assert.ok(page.reviews.some((r) => r.text.startsWith('Verified for a reason Plays')));
  assert.equal(parseReviewsPage(body('reviews-page2')).summary, null, 'only the first page has totals');
  const empty = parseReviewsPage(body('reviews-empty'));
  assert.deepEqual([empty.reviews, empty.count, empty.summary.total], [[], 0, 0]);
  assert.equal(parseReviewsPage(body('reviews-summary')).summary.desc, 'Overwhelmingly Positive');
  assert.throws(() => parseReviewsPage({}), SteamError);
});

test('recorded players online and patch notes parse', () => {
  assert.equal(parsePlayers(body('players')), 3278);
  assert.equal(parsePlayers(body('players-unknown-app')), null);
  const news = parseNews(body('news'));
  assert.equal(news.length, 6);
  assert.ok(news.every((n, i) => !i || news[i - 1].ts >= n.ts));
  assert.deepEqual(news.find((n) => /Orchestral/.test(n.title)).patch, false);
  assert.equal(news.find((n) => /v1\.0 Is Now Available/.test(n.title)).patch, true);
  assert.ok(parseNews(body('news-patchnotes')).every((n) => n.patch));
});

test('topics are found in the languages reviews are written in, and not inside other words', () => {
  const cases = {
    'Constant stuttering after the patch': ['stutter'],
    'Micro-stutter and frame drops': ['stutter'],
    'laggy online, input delay': ['lag'],
    'the fps tanked, framerate is 20': ['fps'],
    'froze twice, then not responding': ['freeze'],
    'crashes to desktop, CTD every hour': ['crash'],
    'Das Spiel ruckelt und stürzt ständig ab': ['stutter', 'crash'],
    'лаги и вылеты': ['lag', 'crash'],
    'благодарю, отличная игра': [],
    '游戏卡顿，经常闪退': ['stutter', 'crash'],
    '컬렉션이 좋아요': [],
    'A flag and a plan': [],
  };
  for (const [text, topics] of Object.entries(cases)) assert.deepEqual(reviewTopics(text), topics, text);
});

test('the keyless client asks Steam as documented, with the key only where it helps and never in an error', async () => {
  const urls = [];
  const kinds = [];
  const fetch = async (u) => {
    urls.push(new URL(String(u)));
    return fixtureFetch({ '/IUserReviewsService/GetAppReviews/v1/': 'reviews-page1', '/ISteamUserStats/GetNumberOfCurrentPlayers/v1/': 'players-unknown-app', '/ISteamNews/GetNewsForApp/v2/': 'news' })(u);
  };
  const client = steamClient({ fetch, key: 'ABCDEF0123456789ABCDEF0123456789', onCall: (k) => kinds.push(k) });
  await client.reviews({ appId: 1145360, start: Date.parse('2026-10-20T00:00:00Z'), end: Date.parse('2026-10-21T00:00:00Z'), cursor: 'AoJ4+x/y=' });
  assert.equal(await client.players(1), null, '404 with result 42: no count');
  await client.news(1145360);
  const input = JSON.parse(urls[0].searchParams.get('input_json'));
  assert.deepEqual(input, { appid: 1145360, filter: 1, languages: ['all'], purchase_type: 1, num_per_page: 100, cursor: 'AoJ4+x/y=', date_range_start: Date.parse('2026-10-20T00:00:00Z') / 1000, date_range_end: Date.parse('2026-10-21T00:00:00Z') / 1000 });
  assert.equal(urls[0].searchParams.get('key'), 'ABCDEF0123456789ABCDEF0123456789');
  assert.equal(urls[1].searchParams.get('key'), null);
  assert.deepEqual([urls[2].searchParams.get('feeds'), urls[2].searchParams.get('maxlength')], ['steam_community_announcements', '1']);
  assert.deepEqual(kinds, ['publisher', 'keyless', 'keyless']);
  const bad = steamClient({ fetch: fixtureFetch(() => 'reviews-bad-input'), key: 'ABCDEF0123456789ABCDEF0123456789' });
  await assert.rejects(bad.reviews({ appId: 1, start: 0, end: 1 }), (err) => err instanceof SteamError && err.status === 400 && !err.message.includes('ABCDEF'));
  const limited = steamClient({ fetch: async () => new Response('', { status: 429 }) });
  await assert.rejects(limited.players(1), /HTTP 429/);
});

test('reviews sync by date: a backfill in weekly windows, then only what is new, resuming from a cursor', async () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const sc = steamScenario({ now });
  const calls = [];
  const client = steamClient({ fetch: steamFetch(sc, { calls }) });
  const first = await syncKeyless({ client, appId: APP_ID, now });
  const reviewCalls = calls.filter((c) => c.includes('GetAppReviews'));
  // 30 days back in windows of a week (5 windows, one page each) and the review score; players and news once.
  assert.equal(reviewCalls.length, 6);
  assert.equal(first.errors.length, 0);
  assert.equal(new Set(first.reviews.map((r) => r.id)).size, sc.reviews.length, 'every review in the scenario');
  assert.deepEqual(first.players, [now, sc.players.at(-1)[1]]);
  assert.equal(first.news.length, 3);
  assert.equal(first.summary.total, sc.reviews.length);
  assert.deepEqual(first.state.reviews, { until: now, window: null });

  // An hour later: one window from an hour before the last one ended; news and the score wait 6 hours.
  const later = now + HOUR;
  sc.reviews.unshift({ ...sc.reviews[0], recommendationid: '999', timestamp_created: Math.floor((later - 60_000) / 1000) });
  calls.length = 0;
  const second = await syncKeyless({ client, appId: APP_ID, state: first.state, now: later });
  assert.deepEqual(calls.filter((c) => !c.includes('Players')), ['/IUserReviewsService/GetAppReviews/v1/']);
  assert.ok(second.reviews.some((r) => r.id === '999'));
  assert.ok(second.reviews.every((r) => r.ts >= now - HOUR));
  assert.equal(second.news, null);

  // One page a run: the first run stops inside a window and the next goes on from its cursor.
  const many = Array.from({ length: 250 }, (_, i) => ({ ...sc.reviews[i % sc.reviews.length], recommendationid: String(5000 + i), timestamp_created: Math.floor((now - 2 * HOUR) / 1000) }));
  const small = steamClient({ fetch: steamFetch({ ...sc, reviews: many }) });
  const a = await syncKeyless({ client: small, appId: APP_ID, now, backfillDays: 1, maxPages: 1 });
  assert.equal(a.reviews.length, 100);
  assert.ok(a.state.reviews.window.cursor !== '*');
  const b = await syncKeyless({ client: small, appId: APP_ID, now, state: a.state, maxPages: 5 });
  assert.equal(new Set([...a.reviews, ...b.reviews].map((r) => r.id)).size, 250);
  assert.equal(b.state.reviews.window, null);

  // Rate-limited: the error is said, and the state stays where it was for the next run.
  const limited = await syncKeyless({ client: steamClient({ fetch: steamFetch(sc, { status: 429 }) }), appId: APP_ID, state: first.state, now: later });
  assert.deepEqual(limited.errors.map((e) => [e.part, e.status]), [['players', 429], ['reviews', 429]]);
  assert.equal(limited.state.reviews.until, first.state.reviews.until);
  assert.equal(limited.state.reviews.window.cursor, '*', 'the same window, from its start');
});

test("Steam's release marks: builds set live on the default branch, and patch notes for when there are none", () => {
  const builds = { list: [{ build_id: '15873459', description: '1.4.2 caves update' }], history: [{ branch: 'public', build_id: '15873459', from: 1, approx: true }, { branch: 'beta', build_id: '15901120', from: 2 }] };
  const news = parseNews(body('news'));
  const marks = steamMarks({ builds, news });
  assert.deepEqual(marks.releases, [{ source: 'build', build_id: '15873459', from: 1, title: '1.4.2 caves update', approx: true }]);
  assert.ok(marks.notes.length && marks.notes.every((n) => n.source === 'patch_notes' && n.title));
  assert.deepEqual(steamMarks({ news: null }), { releases: [], notes: null });
});
