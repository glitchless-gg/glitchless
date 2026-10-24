// Everyone's deaths, read from a Glitchless share link to a board with one `positions` panel per level.
//
// A share link (https://app.glitchless.gg/#/share/gl_share_…) lets anyone read one board page, nothing else
// (docs/SPEC.md §3c). The board query takes the token as ?share= and replaces every other parameter with the
// link's own service and page, so only the window matters here: `days=30`, the last 30 days up to the last
// whole minute. Every player polls that one URL, and the answer is cacheable for a minute (at CloudFront on
// Glitchless Cloud), so a crowd costs the server one board a minute. The token goes in the query string, not
// the x-glitchless-share header: no CORS preflight, the URL is the cache key, and the token ships in this
// game's bundle anyway (the board is public by design).
//
// Each positions panel evaluates to
//   { level, axis: 'xy', bounds: { min: [a, b], max: [a, b] }, bin, deaths: [[a, b, n], …], total, truncated }
// with a and b world x and y, and n the deaths in that bin. A panel with no data is { empty: true, why }.
//
// The source polls about once a minute (jittered, paused while the tab is hidden) and keeps the last good
// answer when a fetch fails, so markers go stale rather than vanish. A 429 waits for its Retry-After.


/** The token in a share link, a bare token, or null. */
export function shareTokenOf(link) {
  if (!link) return null;
  const m = String(link).match(/gl_share_[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/**
 * Where to fetch the board. `source` is a share link or token (read through the API), or the URL of a JSON
 * copy of the board's answer (a snapshot the owner serves from a CDN, so players don't each hit the API).
 */
export function boardUrl(source, { api = 'https://api.glitchless.gg', days = 30 } = {}) {
  if (/^https?:\/\/.+\.json(\?|$)/.test(source)) return source;
  const token = shareTokenOf(source);
  if (!token) return null;
  return `${api.replace(/\/$/, '')}/v1/query/board?share=${encodeURIComponent(token)}&days=${days}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The board's answer → Map(level → { level, deaths, total, bin, bounds, truncated }). Throws on an error
 * answer or a board without positions panels. Malformed bins are dropped, not trusted.
 */
export function parseBoard(body) {
  if (!body || typeof body !== 'object') throw new Error('empty answer');
  if (body.error) throw new Error(String(body.error));
  const panels = body.board?.panels;
  if (!Array.isArray(panels)) throw new Error('no board in the answer');
  const out = new Map();
  for (const p of panels) {
    if (p?.type !== 'positions') continue;
    const level = p.level ?? p.spec?.level;
    if (level == null) continue;
    const key = String(level);
    if (p.empty) {
      out.set(key, { level: key, deaths: [], total: 0, bin: null, bounds: null, truncated: false, empty: p.why || true });
      continue;
    }
    const deaths = Array.isArray(p.deaths) ? p.deaths.filter((d) => Array.isArray(d) && isNum(d[0]) && isNum(d[1]) && isNum(d[2]) && d[2] > 0) : [];
    const sum = deaths.reduce((s, d) => s + d[2], 0);
    out.set(key, {
      level: key,
      deaths,
      total: isNum(p.total) ? p.total : sum,
      bin: isNum(p.bin) ? p.bin : null,
      bounds: p.bounds && Array.isArray(p.bounds.min) && Array.isArray(p.bounds.max) ? p.bounds : null,
      truncated: !!p.truncated,
    });
  }
  if (!out.size) throw new Error('the shared board has no positions panels');
  return out;
}

/**
 * createShareMarkers({ link }) → a marker source (see ./index.js). `fetchImpl`, `now`, `setTimer` and
 * `random` are there for tests.
 */
export function createShareMarkers({
  link,
  api,
  intervalMs = 60_000,
  days = 30,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  random = Math.random,
  hidden = () => typeof document !== 'undefined' && document.hidden,
} = {}) {
  let levels = new Map();
  let fetchedAt = 0;
  let error = null;
  let timer = null;
  let stopped = true;
  let inFlight = null;
  const listeners = new Set();

  const notify = () => listeners.forEach((fn) => fn());

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const url = boardUrl(link, { api, days });
      if (!url) {
        error = 'no share link';
        notify();
        return { wait: null };
      }
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
        if (res.status === 429) {
          const retry = Number(res.headers?.get?.('retry-after'));
          error = 'rate limited';
          notify();
          return { wait: Number.isFinite(retry) && retry > 0 ? retry * 1000 : null };
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        levels = parseBoard(body);
        fetchedAt = now();
        error = null;
      } catch (err) {
        error = err?.message || String(err);
      }
      notify();
      return { wait: null };
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function schedule(waitMs) {
    if (stopped) return;
    const jittered = intervalMs * (0.85 + 0.3 * random());
    timer = setTimer(tick, Math.max(waitMs ?? 0, jittered));
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (hidden()) return schedule(null); // no point polling a background tab
    const { wait } = await refresh();
    schedule(wait);
  }

  return {
    kind: 'share',
    fake: false,
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    refresh,
    /** This level's markers, or null before the first answer. `stale` once a later fetch has failed. */
    get(level) {
      const e = levels.get(String(level));
      if (!e) return fetchedAt ? { level: String(level), deaths: [], total: 0, bin: null, bounds: null, truncated: false, missing: true, fetchedAt, stale: !!error, error } : null;
      return { ...e, fetchedAt, stale: !!error, error };
    },
    status() {
      return { kind: 'share', fake: false, fetchedAt, error, levels: [...levels.keys()] };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
