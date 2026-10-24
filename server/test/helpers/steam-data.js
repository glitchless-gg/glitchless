// A game on Steam, for tests, the cloud's local end-to-end run and screenshots. Four weeks of reviews in Steam's own
// format (the shape of the recorded fixtures in ../fixtures/steam), players online every hour, patch notes and two
// builds: build 15873459 (1.4.2) went live four days ago, and negative reviews about stutter, fps and crashes rose
// after it. Play sessions of 1.4.1 and 1.4.2 to match: 1.4.2 has slower frames, hitches from shader compiles on
// caves-2 and more crashes. steamFetch answers the keyless Steam Web API from it as Steam does (date ranges, cursors,
// 404 for an unknown app); the recorded fixtures are replayed by fixtureFetch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sketch } from '../../../packages/sdk/src/sketch.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/steam');
export const APP_ID = 3141590;

const GPUS = ['NVIDIA GeForce RTX 3060', 'NVIDIA GeForce GTX 1060 6GB', 'AMD Radeon RX 6600', 'Intel(R) UHD Graphics 620', 'NVIDIA GeForce RTX 4070'];
const TEXTS = {
  good: ['Tight controls and a gorgeous cave biome.', 'One more run, every time. Great soundtrack.', 'Plays great, the new levels are fun.', '[b]Recommended.[/b] Short but sweet.', 'Lovely art, fair difficulty.'],
  bad: ['Too short for the price.', 'The new biome is boring.', 'Not my thing, the controls feel floaty.'],
  stutter: ['Since the last update it stutters every time I enter caves-2.', 'Constant stuttering after the patch, fps drops to 20 in the caves.', 'Micro-stutter on every room transition now, unplayable.'],
  crash: ['Crashes to desktop after the update, twice in an hour.', 'The game crashes when loading caves-2.'],
  fps: ['The patch tanked my fps: 60 before, 25 now.'],
};

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// → { appId, builds, reviews (raw, as GetAppReviews returns them), players: [[ts, n]], news (raw), sales, wishlists }
export function steamScenario({ now = Date.now(), seed = 11, days = 28 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const hourly = (ts) => Math.floor(ts / HOUR) * HOUR;
  const builds = [
    { build_id: 15790011, version: '1.4.1', description: 'v1.4.1 hotfix', created: now - 20 * DAY - 2 * HOUR, live_at: now - 20 * DAY, branch: 'public' },
    { build_id: 15873459, version: '1.4.2', description: '1.4.2 caves update', created: now - 4 * DAY - 3 * HOUR, live_at: now - 4 * DAY, branch: 'public' },
    { build_id: 15901120, version: '1.4.3', description: '1.4.3 beta: shader warm-up', created: now - DAY - HOUR, live_at: now - DAY, branch: 'beta' },
  ];
  const release = builds[1].live_at;
  const reviews = [];
  let id = 238_500_000;
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = Math.floor((now - d * DAY) / DAY) * DAY;
    const after = dayStart + DAY > release;
    const n = after ? 9 + Math.floor(rnd() * 5) : 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const ts = Math.min(dayStart + Math.floor(rnd() * DAY), now - 10 * 60_000);
      const late = ts >= release;
      const up = rnd() < (late ? 0.55 : 0.9);
      const perf = !up && rnd() < (late ? 0.8 : 0.25);
      const deck = rnd() < (perf && late ? 0.5 : 0.25);
      const kind = up ? 'good' : perf ? pick(['stutter', 'stutter', 'crash', 'fps']) : 'bad';
      const showHw = deck || rnd() < 0.6;
      const playtime = 30 + Math.floor(rnd() * 900);
      reviews.push({
        recommendationid: String(id++),
        author: { steamid: String(76561190000001000n + BigInt(id)), num_reviews: 1 + Math.floor(rnd() * 20), playtime_forever: playtime + 60, playtime_last_two_weeks: 40, playtime_at_review: playtime, ...(deck ? { deck_playtime_at_review: Math.floor(playtime * 0.8) } : {}), last_played: Math.floor(ts / 1000) },
        language: pick(['english', 'english', 'english', 'german', 'brazilian']),
        review: pick(TEXTS[kind]),
        timestamp_created: Math.floor(ts / 1000),
        timestamp_updated: Math.floor(ts / 1000),
        voted_up: up,
        votes_up: 0,
        votes_funny: 0,
        weighted_vote_score: 0.5,
        comment_count: 0,
        steam_purchase: true,
        received_for_free: false,
        written_during_early_access: false,
        primarily_steam_deck: deck,
        refunded: !up && rnd() < 0.15,
        ...(showHw ? { hardware: deck ? { os: 'SteamOS Holo', cpu_name: 'AMD Custom APU 0405', adapter_description: 'AMD Custom GPU 0405', system_ram: '15400', vram_size: 1024 } : { os: 'Windows 11', cpu_name: 'AMD Ryzen 5 5600X 6-Core Processor', adapter_description: perf && late && rnd() < 0.5 ? 'NVIDIA GeForce GTX 1060 6GB' : pick(GPUS), system_ram: '16310', vram_size: 6144 } } : {}),
      });
    }
  }
  reviews.sort((a, b) => b.timestamp_created - a.timestamp_created);
  const players = [];
  for (let t = hourly(now - days * DAY); t <= now; t += HOUR) {
    const h = new Date(t).getUTCHours();
    players.push([t + 7 * 60_000, Math.max(1, Math.round(6 + 4 * Math.sin((2 * Math.PI * (h - 13)) / 24) + rnd() * 2 - (t > release ? 1 : 0)))]);
  }
  const news = [
    { gid: '6154735015633600003', title: 'Patch 1.4.2: the caves update', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/6154735015633600003', is_external_url: true, author: 'dev', contents: 'T...', feedlabel: 'Community Announcements', date: Math.floor((release + 30 * 60_000) / 1000), feedname: 'steam_community_announcements', feed_type: 1, appid: APP_ID, tags: ['patchnotes'] },
    { gid: '6154735015633600002', title: 'Thank you for 500 reviews!', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/6154735015633600002', is_external_url: true, author: 'dev', contents: 'W...', feedlabel: 'Community Announcements', date: Math.floor((now - 12 * DAY) / 1000), feedname: 'steam_community_announcements', feed_type: 1, appid: APP_ID },
    { gid: '6154735015633600001', title: 'Hotfix 1.4.1', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/6154735015633600001', is_external_url: true, author: 'dev', contents: 'F...', feedlabel: 'Community Announcements', date: Math.floor((builds[0].live_at + HOUR) / 1000), feedname: 'steam_community_announcements', feed_type: 1, appid: APP_ID, tags: ['patchnotes'] },
  ];
  // Units, returns and wishlists by day (Steam's days: Pacific for sales, GMT for wishlists).
  const sales = [];
  const wishlists = [];
  for (let d = days - 1; d >= 1; d--) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    const late = now - d * DAY > release;
    const units = 20 + Math.floor(rnd() * 15);
    sales.push({ day, units, returns: Math.round(units * (late ? 0.16 : 0.05) + rnd()) });
    wishlists.push({ day, adds: 40 + Math.floor(rnd() * 30), deletes: (late ? 14 : 6) + Math.floor(rnd() * 5), purchases: 3 + Math.floor(rnd() * 4), gifts: Math.floor(rnd() * 2) });
  }
  return { appId: APP_ID, now, builds, release, reviews, players, news, sales, wishlists };
}

// A fetch that answers the keyless Steam Web API from a scenario. `calls` lists each request's path.
export function steamFetch(scenario, { calls = [], status = null } = {}) {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (status) return json({}, status);
    const appid = Number(url.searchParams.get('appid') ?? JSON.parse(url.searchParams.get('input_json') || '{}').appid);
    if (url.pathname === '/IUserReviewsService/GetAppReviews/v1/') {
      const input = JSON.parse(url.searchParams.get('input_json'));
      if (input.appid !== scenario.appId) return json({ response: { query_summary: { num_reviews: 0, review_score: 0, review_score_desc: 'No user reviews', total_positive: 0, total_negative: 0, total_reviews: 0 }, cursor: '*', total_matching: 0 } });
      const inRange = scenario.reviews.filter((r) => input.date_range_start == null || (r.timestamp_created >= input.date_range_start && r.timestamp_created <= input.date_range_end));
      const offset = input.cursor && input.cursor !== '*' ? Number(Buffer.from(input.cursor, 'base64').toString()) : 0;
      const page = inRange.slice(offset, offset + (input.num_per_page ?? 20));
      const up = inRange.filter((r) => r.voted_up).length;
      const first = offset === 0 ? { review_score: 8, review_score_desc: 'Mostly Positive', total_positive: up, total_negative: inRange.length - up, total_reviews: inRange.length } : {};
      return json({ response: { query_summary: { num_reviews: page.length, ...first }, ...(page.length ? { reviews: page } : {}), cursor: page.length ? Buffer.from(String(offset + page.length)).toString('base64') : (input.cursor ?? '*'), total_matching: inRange.length } });
    }
    if (url.pathname === '/ISteamUserStats/GetNumberOfCurrentPlayers/v1/') {
      if (appid !== scenario.appId) return json({ response: { result: 42 } }, 404);
      return json({ response: { player_count: scenario.players.at(-1)[1], result: 1 } });
    }
    if (url.pathname === '/ISteamNews/GetNewsForApp/v2/') {
      if (appid !== scenario.appId) return json({ appnews: { appid, newsitems: [], count: 0 } });
      return json({ appnews: { appid, newsitems: scenario.news.slice(0, Number(url.searchParams.get('count') || 20)), count: scenario.news.length } });
    }
    return json({}, 404);
  };
}

// Replays the recorded answers (../fixtures/steam/<name>.json) for the calls a keyless client makes.
export function fixtureFetch(byPath) {
  return async (input) => {
    const url = new URL(String(input));
    const name = typeof byPath === 'function' ? byPath(url) : byPath[url.pathname];
    if (!name) return new Response('not found', { status: 404 });
    const f = readFixture(name);
    return new Response(f.body, { status: f.status, headers: { 'content-type': f.contentType } });
  };
}

export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
}

// Play sessions to go with a scenario, as SDK batches: `perHour` sessions starting each hour over the last `days`,
// each 10–35 minutes in 60-second frame windows. Before the release they run 1.4.1, after it 1.4.2 (slower frames,
// shader-compile hitches on caves-2, a crash in 1 of 12 sessions). One session in four is on a Steam Deck. With
// `steamBuild`, session_start's device names the Steam build, as the SDKs send it from Steamworks (SPEC §4c).
export function scenarioSessions(scenario, { days = 2, perHour = 3, seed = 5, service = 'caverun', steamBuild = false } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  const end = scenario.now - 5 * 60_000;
  let n = 0;
  for (let hour = Math.floor((end - days * DAY) / HOUR) * HOUR; hour < end; hour += HOUR) {
    for (let k = 0; k < perHour; k++) {
      const start = hour + Math.floor(rnd() * HOUR);
      if (start > end - 10 * 60_000) continue;
      const late = start >= scenario.release;
      const deck = rnd() < 0.25;
      const minutes = 10 + Math.floor(rnd() * 25);
      const crashed = rnd() < (late ? 1 / 12 : 1 / 80);
      const events = [];
      let ts = start;
      const build = steamBuild ? { steam_build: scenario.builds.find((b) => b.version === (late ? '1.4.2' : '1.4.1')).build_id, steam_branch: 'public' } : {};
      events.push({ type: 'session_start', ts, session_type: 'user', device: { ...(deck ? { gpu_tier: 'low', gpu: 'AMD Custom GPU 0405', os: 'SteamOS' } : { gpu_tier: rnd() < 0.5 ? 'high' : 'mid', gpu: 'NVIDIA GeForce RTX 3060', os: 'Windows' }), ...build } });
      for (const [i, level] of ['caves-1', 'caves-2'].entries()) {
        events.push({ type: 'level_start', ts: (ts += 1000), level });
        for (let w = 0; w < Math.floor(minutes / 2); w++) {
          const sk = new Sketch();
          let hitches = 0;
          const heavy = late && level === 'caves-2';
          const spike = heavy ? 0.06 : 0.008;
          for (let f = 0; f < 3600; f++) {
            const v = rnd() < spike ? 45 + rnd() * 120 : (deck ? 22 : 15) * (heavy ? 1.3 : 1) * (0.75 + rnd() * 0.4);
            if (v > 50) hitches++;
            sk.add(v);
          }
          events.push({ type: 'frame_window', ts: (ts += 60_000), level, duration_s: 60, frames: 3600, budget_ms: 16.67, ft: sk.toJSON(), hitches, frozen: 0, draw_calls: 300 + Math.floor(rnd() * 200) });
          if (hitches) events.push({ type: 'hitch', ts: ts + 10, level, duration_ms: 80 + Math.floor(rnd() * 120), causes: [late && level === 'caves-2' ? 'shader_compile' : 'gc'] });
        }
        if (i === 0) events.push({ type: 'level_complete', ts: (ts += 500), level });
      }
      if (crashed) events.push({ type: 'error', ts: (ts += 2000), level: 'caves-2', kind: 'crash', message: 'EXCEPTION_ACCESS_VIOLATION in ShaderCache::Compile', fingerprint: 'crash-shader-cache' });
      else events.push({ type: 'session_end', ts: (ts += 2000) });
      out.push({ service, env: 'prod', version: late ? '1.4.2' : '1.4.1', session_id: `st_${n++}`, player_id: `p_${Math.floor(rnd() * 400)}`, sdk: 'glitchless-unity/0.2.0', events });
    }
  }
  return out;
}

// A pk/sk store in memory (get, put, query, remove), as Glitchless Cloud's control table works.
export function memoryKv() {
  const items = new Map();
  const key = (pk, sk) => `${pk}\n${sk}`;
  const clone = (v) => (v == null ? v : structuredClone(v));
  return {
    items,
    get: async (pk, sk) => clone(items.get(key(pk, sk))),
    put: async (item) => void items.set(key(item.pk, item.sk), clone(item)),
    query: async (pk, prefix = '') => [...items.values()].filter((i) => i.pk === pk && i.sk.startsWith(prefix)).sort((a, b) => (a.sk < b.sk ? -1 : 1)).map(clone),
    remove: async (pk, sk) => void items.delete(key(pk, sk)),
  };
}
