// Steam as a review store (reviews.js): the keyless Steam Web API calls and their parsers, and one sync step for them.
// Reviews come out in the store-neutral shape, with what only Steam has (playtime, Steam Deck, refunds, Early Access)
// in `steam`; builds and patch notes come out as release marks. Glitchless Cloud adds the publisher's keys, the
// partner calls (builds and branches, wishlists, units and returns) and the hourly sync.
// SPEC §3f.
//
// The review's author (their Steam ID, other reviews, last played) is never read or kept.
import { reviewText, plain } from './reviews.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const STEAM_API = 'https://api.steampowered.com';
const PER_PAGE = 100;
// Reviews are asked for by date: windows of a week, each starting an hour before the last one ended (Steam caches
// anonymous answers for up to 10 minutes, so a review written just before a run may only show in the next one).
const WINDOW = 7 * DAY;
const OVERLAP = HOUR;
// Patch notes and the review score change rarely: asked for every 6 hours.
const SLOW_EVERY = 6 * HOUR;

export class SteamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───────────────────────────── parsers ─────────────────────────────

// One review from IUserReviewsService/GetAppReviews, as a store review. `author` is read for playtime only.
export function parseReview(r) {
  const a = r?.author || {};
  const hw = r?.hardware;
  const { text, topics } = reviewText(r?.review);
  return {
    store: 'steam',
    id: String(r?.recommendationid ?? ''),
    ts: Number(r?.timestamp_created) * 1000,
    up: r?.voted_up === true,
    rating: null,
    lang: line(r?.language, 24),
    text,
    topics,
    version: null,
    device: hw && typeof hw === 'object' ? { os: line(hw.os, 60), cpu: line(hw.cpu_name, 80), gpu: line(hw.adapter_description, 80), ram_mb: count(hw.system_ram) } : null,
    steam: { playtime_min: count(a.playtime_at_review), deck_min: count(a.deck_playtime_at_review), deck: r?.primarily_steam_deck === true, refunded: r?.refunded === true, early_access: r?.written_during_early_access === true },
  };
}

// A page of reviews → { reviews, count, cursor, summary }: `count` is how many Steam sent (a page short of the asked
// number is the last). The first page of a query has its totals (summary).
export function parseReviewsPage(json) {
  const res = json?.response;
  if (!res || typeof res !== 'object') throw new SteamError(502, 'Steam sent reviews Glitchless could not read.');
  const reviews = (Array.isArray(res.reviews) ? res.reviews : []).map(parseReview).filter((r) => r.id && Number.isFinite(r.ts) && r.ts > 0);
  const q = res.query_summary;
  const summary = q && q.total_reviews != null ? { desc: line(q.review_score_desc, 40), positive: count(q.total_positive), negative: count(q.total_negative), total: count(q.total_reviews) } : null;
  return { reviews, count: Array.isArray(res.reviews) ? res.reviews.length : 0, cursor: typeof res.cursor === 'string' ? res.cursor : null, summary };
}

// ISteamUserStats/GetNumberOfCurrentPlayers → the count, or null when Steam has none for the app (result 42).
export function parsePlayers(json) {
  const res = json?.response;
  return res?.result === 1 && Number.isFinite(Number(res.player_count)) ? Number(res.player_count) : null;
}

// ISteamNews/GetNewsForApp, the developer's own announcements → [{ id, ts, title, url, patch }], newest first.
// `patch`: tagged as patch notes, or titled like a release.
export function parseNews(json) {
  const items = json?.appnews?.newsitems;
  if (!Array.isArray(items)) throw new SteamError(502, 'Steam sent news Glitchless could not read.');
  return items
    .filter((n) => n && n.gid && Number.isFinite(Number(n.date)))
    .map((n) => {
      const title = line(n.title, 140);
      const url = typeof n.url === 'string' && /^https:\/\//.test(n.url) ? n.url.slice(0, 300) : null;
      return { id: String(n.gid), ts: Number(n.date) * 1000, title, url, patch: (Array.isArray(n.tags) && n.tags.includes('patchnotes')) || PATCH_TITLE.test(title) };
    })
    .sort((a, b) => b.ts - a.ts);
}
const PATCH_TITLE = /\b(?:patch|hotfix|update|changelog|release notes|v?\d+\.\d+(?:\.\d+)*)\b/i;

// Steam's release marks for the join (reviews.js storeReleases): the builds set live on the default branch (public),
// from the branches' history (`builds`: { list, history }, from the host's partner calls), and the patch notes, which the join
// uses when there is no build history. → { releases, notes } (`notes` null without news)
export function steamMarks({ builds = null, news = null } = {}) {
  const list = new Map((builds?.list ?? []).map((b) => [String(b.build_id), b]));
  const releases = (builds?.history ?? []).filter((h) => h.branch === 'public').map((h) => ({ source: 'build', build_id: String(h.build_id), from: h.from, title: list.get(String(h.build_id))?.description || '', ...(h.approx ? { approx: true } : {}) }));
  const notes = news ? news.filter((n) => n.patch).map((n) => ({ source: 'patch_notes', from: n.ts, title: n.title, ...(n.url ? { url: n.url } : {}) })) : null;
  return { releases, notes };
}

// ───────────────────────────── the keyless client ─────────────────────────────

// fetch: the host's (tests replay recorded answers). key: the publisher's Web API key for the app, which Steam
// gives a higher rate limit on reviews; never sent anywhere but Steam, and never in an error or a log.
// onCall(kind) counts each call ('keyless', or 'publisher' when it carries the key), for the daily budget.
export function steamClient({ fetch = globalThis.fetch, key = null, base = STEAM_API, timeoutMs = 15_000, onCall = () => {} } = {}) {
  async function get(path, params, { keyed = false, missing = null } = {}) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries({ ...params, ...(keyed && key ? { key } : {}) })) if (v != null) url.searchParams.set(k, String(v));
    onCall(keyed && key ? 'publisher' : 'keyless');
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new SteamError(0, err.name === 'TimeoutError' ? `Steam did not answer within ${timeoutMs / 1000} seconds.` : `Could not reach Steam (${err.cause?.code || err.name}).`);
    }
    if (missing && res.status === missing) return res.json().catch(() => null);
    if (!res.ok) {
      await res.arrayBuffer().catch(() => null);
      throw new SteamError(res.status, httpWords(res.status));
    }
    try {
      return await res.json();
    } catch {
      throw new SteamError(502, 'Steam sent an answer Glitchless could not read.');
    }
  }
  const reviewQuery = (appId, extra) => ({ input_json: JSON.stringify({ appid: Number(appId), filter: 1, languages: ['all'], purchase_type: 1, ...extra }) });
  return {
    // Reviews created in [start, end], newest first, a page at a time (cursor '*' for the first).
    reviews: async ({ appId, start, end, cursor = '*', perPage = PER_PAGE }) => parseReviewsPage(await get('/IUserReviewsService/GetAppReviews/v1/', reviewQuery(appId, { num_per_page: perPage, cursor, date_range_start: Math.floor(start / 1000), date_range_end: Math.floor(end / 1000) }), { keyed: true })),
    // The app's review score over all time (one review's page; its totals are what's wanted).
    summary: async (appId) => parseReviewsPage(await get('/IUserReviewsService/GetAppReviews/v1/', reviewQuery(appId, { num_per_page: 1 }), { keyed: true })).summary,
    players: async (appId) => parsePlayers(await get('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { appid: Number(appId) }, { missing: 404 })),
    // The developer's announcements without their text (maxlength 1): titles, dates and tags are what's used.
    news: async (appId, n = 20) => parseNews(await get('/ISteamNews/GetNewsForApp/v2/', { appid: Number(appId), count: n, maxlength: 1, feeds: 'steam_community_announcements', format: 'json' })),
  };
}

export function httpWords(status) {
  if (status === 429) return 'Steam is limiting how often Glitchless may ask (HTTP 429); the next sync tries again.';
  if (status === 401 || status === 403) return `Steam refused the key (HTTP ${status}).`;
  if (status === 404) return 'Steam has nothing at that address for this app (HTTP 404).';
  if (status >= 500) return `Steam answered HTTP ${status}; the next sync tries again.`;
  return `Steam refused the request (HTTP ${status}).`;
}

// One run's keyless part for one game. Reviews by date from where the last run stopped (on the first run,
// `backfillDays` back), at most `maxPages` pages; players online now; patch notes and the review score every 6
// hours. `state` is what the last run returned. → { reviews, players: [ts, n] | null, news, summary, state, errors }
// Each part fails on its own: its error is in `errors` ({ part, status, error }) and its state stays for next time.
export async function syncKeyless({ client, appId, state = {}, now = Date.now(), backfillDays = 30, maxPages = 20, deadline = Infinity, clock = Date.now }) {
  const out = { reviews: [], players: null, news: null, summary: null, state: { ...state }, errors: [] };
  const fail = (part, err) => {
    if (!(err instanceof SteamError)) throw err;
    out.errors.push({ part, status: err.status, error: err.message });
  };
  try {
    const n = await client.players(appId);
    if (n != null) out.players = [now, n];
  } catch (err) {
    fail('players', err);
  }
  const r = { until: now - backfillDays * DAY, window: null, ...state.reviews };
  try {
    for (let pages = 0; pages < maxPages && clock() < deadline; pages++) {
      if (!r.window) {
        const start = Math.max(0, r.until - OVERLAP);
        if (start >= now - 5 * 60_000) break;
        r.window = { start, end: Math.min(start + WINDOW, now), cursor: '*' };
      }
      const page = await client.reviews({ appId, start: r.window.start, end: r.window.end, cursor: r.window.cursor });
      out.reviews.push(...page.reviews);
      const done = page.count < PER_PAGE || !page.cursor || page.cursor === r.window.cursor;
      if (!done) r.window.cursor = page.cursor;
      else {
        r.until = r.window.end;
        r.window = null;
        if (r.until >= now) break;
      }
    }
  } catch (err) {
    fail('reviews', err);
  }
  out.state.reviews = r;
  if (!state.slowAt || now - state.slowAt >= SLOW_EVERY) {
    const before = out.errors.length;
    try {
      out.news = await client.news(appId);
    } catch (err) {
      fail('news', err);
    }
    try {
      out.summary = await client.summary(appId);
    } catch (err) {
      fail('summary', err);
    }
    if (out.errors.length === before) out.state.slowAt = now;
  }
  return out;
}

function line(v, max) {
  const s = plain(v);
  return s ? s.slice(0, max) : null;
}

function count(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
