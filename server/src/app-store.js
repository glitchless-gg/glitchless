// The App Store as a review store (reviews.js), without a key: Apple's public RSS feed of a country's latest reviews,
// 50 a page and 10 pages deep (about 500 a country), each with the version it was written on (`im:version`) and its
// stars. Enough for a game with no setup at all; Glitchless Cloud adds the App Store Connect API (every review, joined
// to its version, and Apple's own hang, launch and animation metrics). And Apple's overall rating in each country, from
// its public lookup (lookupRating). SPEC §3f.
//
// The reviewer (their name and profile link) is never read or kept.
import { reviewText, plain } from './reviews.js';

export const ITUNES = 'https://itunes.apple.com';
// The feed's depth: Apple refuses page 11 ("CustomerReviews RSS page depth is limited to 10").
const MAX_PAGES = 10;
// The newest review ids remembered, so the next sync stops at the first page it has already seen (by count, not age:
// a quiet game's feed can reach back years).
const SEEN = 1500;

export class AppStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// One entry of the feed, as a store review.
export function parseRssReview(e, country) {
  const label = (v) => (v && typeof v === 'object' ? v.label : v);
  const rating = Number(label(e?.['im:rating']));
  const title = plain(label(e?.title));
  const body = plain(label(e?.content));
  const { text, topics } = reviewText(title && body ? `${title}. ${body}` : title || body);
  return {
    store: 'app_store',
    id: String(label(e?.id) ?? ''),
    ts: Date.parse(label(e?.updated) ?? ''),
    up: rating >= 4,
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    lang: null,
    text,
    topics,
    version: plain(label(e?.['im:version'])) || null,
    device: null,
    app_store: { territory: String(country).toUpperCase() },
  };
}

// A page of the feed → reviews. `entry` is a list, one object when there is a single review, or missing when there are
// none; an entry without stars (the app itself, in older feeds) is not a review.
export function parseRss(json, country) {
  const feed = json?.feed;
  if (!feed || typeof feed !== 'object') throw new AppStoreError(502, 'Apple sent a reviews feed Glitchless could not read.');
  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  return entries.filter((e) => e?.['im:rating']).map((e) => parseRssReview(e, country)).filter((r) => r.id && Number.isFinite(r.ts) && r.rating != null);
}

// fetch: the host's (tests replay recorded pages). onCall counts each call for the daily budget.
export function appStoreRss({ fetch = globalThis.fetch, base = ITUNES, timeoutMs = 15_000, onCall = () => {} } = {}) {
  return {
    async page(appId, country, page) {
      const url = new URL(`/${encodeURIComponent(country)}/rss/customerreviews/page=${page}/id=${encodeURIComponent(appId)}/sortby=mostrecent/json`, base);
      onCall('keyless');
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new AppStoreError(0, err.name === 'TimeoutError' ? `Apple did not answer within ${timeoutMs / 1000} seconds.` : `Could not reach Apple (${err.cause?.code || err.name}).`);
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => null);
        throw new AppStoreError(res.status, res.status === 400 ? 'Apple refused the page (HTTP 400): the feed is 10 pages deep.' : `Apple answered HTTP ${res.status}.`);
      }
      try {
        return parseRss(await res.json(), country);
      } catch (err) {
        if (err instanceof AppStoreError) throw err;
        throw new AppStoreError(502, 'Apple sent a reviews feed Glitchless could not read.');
      }
    },
  };
}

// Apple's own rating of an app in one country's store, from the public lookup (GET /lookup?id=&country=): the average
// stars and how many ratings, of every version and of the current one (ratings with or without a review). → { country,
// average, count, version, current_average, current_count } or null when the app isn't sold there.
export function parseLookup(json, country) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) throw new AppStoreError(502, 'Apple sent a lookup Glitchless could not read.');
  const app = json.results.find((r) => r?.wrapperType === 'software' || r?.kind === 'software') ?? json.results[0];
  if (!app) return null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const average = num(app.averageUserRating);
  const count = num(app.userRatingCount);
  return { country: String(country).toLowerCase(), average: average != null ? Math.round(average * 100) / 100 : null, count: count ?? 0, version: plain(app.version) || null, current_average: num(app.averageUserRatingForCurrentVersion), current_count: num(app.userRatingCountForCurrentVersion) };
}

// The lookup for each of `countries` → { rating: { countries: [...], average, count } | null, errors }: `average` is
// weighted by each country's ratings. A country where the app isn't sold is left out.
export async function lookupRating({ fetch = globalThis.fetch, base = ITUNES, appId, countries = ['us'], timeoutMs = 15_000, onCall = () => {} }) {
  const out = [];
  const errors = [];
  for (const country of countries) {
    const url = new URL('/lookup', base);
    url.searchParams.set('id', appId);
    url.searchParams.set('country', country);
    onCall('keyless');
    try {
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new AppStoreError(0, err.name === 'TimeoutError' ? `Apple did not answer within ${timeoutMs / 1000} seconds.` : `Could not reach Apple (${err.cause?.code || err.name}).`);
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => null);
        throw new AppStoreError(res.status, `Apple answered HTTP ${res.status}.`);
      }
      const r = parseLookup(await res.json().catch(() => null), country);
      if (r) out.push(r);
    } catch (err) {
      if (!(err instanceof AppStoreError)) throw err;
      errors.push({ part: `rating (${country})`, status: err.status, error: err.message });
    }
  }
  const rated = out.filter((r) => r.average != null && r.count > 0);
  const count = rated.reduce((a, r) => a + r.count, 0);
  return { rating: out.length ? { countries: out, average: count ? Math.round((rated.reduce((a, r) => a + r.average * r.count, 0) / count) * 100) / 100 : null, count } : null, errors };
}

// One run over the feeds of `countries` (ISO codes, e.g. ['us', 'gb']): newest first, page by page, each country until
// a page brings nothing new. `state.seen` remembers the newest 1,500 ids. → { reviews, state, errors }
export async function syncRss({ client, appId, countries = ['us'], state = {}, maxPages = MAX_PAGES }) {
  const seen = { ...state.seen };
  const reviews = [];
  const errors = [];
  for (const country of countries) {
    try {
      for (let page = 1; page <= Math.min(maxPages, MAX_PAGES); page++) {
        const list = await client.page(appId, country, page);
        const fresh = list.filter((r) => !seen[r.id]);
        for (const r of fresh) seen[r.id] = r.ts;
        reviews.push(...fresh);
        if (list.length < 50 || !fresh.length) break;
      }
    } catch (err) {
      if (!(err instanceof AppStoreError)) throw err;
      errors.push({ part: `reviews (${country})`, status: err.status, error: err.message });
    }
  }
  const kept = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, SEEN);
  return { reviews, state: { ...state, seen: Object.fromEntries(kept) }, errors };
}
