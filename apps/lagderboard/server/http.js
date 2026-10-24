// The leaderboard's HTTP API as one function from a web Request to a Response, so it runs under Node's http
// server (serve.js) or any host that speaks fetch-style handlers.
//
//   POST {prefix}/runs                  a run (JSON) → { id, rank, total, approximate, deviceBest, deviceRuns }
//   GET  {prefix}/devices?class=phone   best run per device, highest first (limit= up to 100)
//   GET  {prefix}/runs?class=phone      single runs, highest first
//   GET  {prefix}/health
//
// The game posts with Content-Type text/plain, a CORS-safelisted type, so a cross-origin board needs no preflight.
const MAX_BODY = 4096;

export function createHandler(service, { origins = ['*'], prefix = '' } = {}) {
  const allow = (origin) => (origins.includes('*') ? '*' : origin && origins.includes(origin) ? origin : null);

  return async function handle(request, { ip } = {}) {
    const url = new URL(request.url);
    const origin = allow(request.headers.get('origin'));
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors, ...headers } });

    if (!url.pathname.startsWith(prefix)) return json(404, { error: 'not found' });
    const route = url.pathname.slice(prefix.length) || '/';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
    }
    try {
      if (route === '/health' && request.method === 'GET') return json(200, { ok: true });
      if (route === '/runs' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > MAX_BODY) return json(413, { error: 'run too large' });
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: 'expected a JSON run' });
        }
        return json(200, await service.submit(body, { ip }), { 'cache-control': 'no-store' });
      }
      if ((route === '/devices' || route === '/runs') && request.method === 'GET') {
        const cls = url.searchParams.get('class');
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 25));
        const rows = route === '/devices' ? await service.devices(cls, { limit }) : await service.runs(cls, { limit });
        // Short-lived and shared: a CDN in front answers most reads, and a new best shows within half a minute.
        return json(200, { class: cls, rows }, { 'cache-control': 'public, max-age=30, s-maxage=30' });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      if (err.status) return json(err.status, { error: err.message });
      console.error('[lagderboard] request failed', err);
      return json(500, { error: 'something went wrong' });
    }
  };
}
