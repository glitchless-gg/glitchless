// A Devvit Web app without Reddit, for the tests of a game in a Reddit post (SPEC §5g): devvit-webview.mjs (the
// browser SDK) and godot/test/web.mjs (Godot's web export). A real `devvit playtest` needs a Reddit login; this has
// the parts of Reddit's webview that decide whether Glitchless gets through:
//   - every response carries a Content-Security-Policy whose connect-src is 'self': the page reaches its own origin
//     only, as Devvit's webview does ("All backend responses are locked down to the webview domain via CSP");
//   - every HTML page gets Reddit's script first in its <head>, as Devvit adds it at upload: here a stand-in for
//     webview.devvit.net/scripts/devvit.v1.min.js that does what that one does to requests (sets globalThis.devvit and
//     adds `Authorization: Bearer <token>` to the page's same-origin fetches, @devvit/web-view-scripts src/fetch.ts);
//   - /api/ answers only a request with that token, the strictest reading of Devvit's gateway: a beacon, which carries
//     no header, is turned away (401). The token stands for a redditor in a subreddit's post: `context` reads it, as
//     @devvit/web/server's context does, for the request being answered.
// The app's own routes (`api`, a Fetch API handler) are given the request with the token taken off, as Devvit's server
// gets its context from metadata headers instead.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const REDDITOR = { subredditName: 'DailyDots', postId: 't3_1q2w3e4', userId: 't2_q7w9e2rt', username: 'bright_otter_42', loid: undefined, appName: 'daily-dots', appVersion: '0.0.1.7' };
const TOKEN = 'devvit-harness-token';

// Devvit's webview script, as far as requests go.
const DEVVIT_SCRIPT = `(function () {
  var token = ${JSON.stringify(TOKEN)};
  globalThis.devvit = { token: token, context: ${JSON.stringify({ subredditName: REDDITOR.subredditName, postId: REDDITOR.postId, appName: REDDITOR.appName })} };
  var globalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    var req = new Request(input, init);
    if (new URL(req.url).origin === location.origin) req.headers.set('Authorization', 'Bearer ' + globalThis.devvit.token);
    return await globalFetch(req);
  };
})();`;

export const STRICT_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors *";

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };

/**
 * @param {object} o
 * @param {Record<string, string>} o.dirs  URL prefix → folder served there ('/' the client, '/sdk/' the SDK's sources…)
 * @param {(request: Request) => Promise<Response|null>} o.api  the app's /api/ routes; null is a 404
 * @param {string} [o.csp]
 * @param {Record<string, string>} [o.headers]  more headers on every page (COOP and COEP for a threaded build)
 * @param {(html: string, url: URL) => string} [o.rewrite]  changes an HTML page before it is served (a Godot export's args)
 */
export async function devvitApp({ dirs, api, csp = STRICT_CSP, headers = {}, rewrite = (html) => html }) {
  const store = new AsyncLocalStorage();
  // @devvit/web/server's `context`: the redditor of the request being answered.
  const context = new Proxy({}, { get: (_t, k) => store.getStore()?.[k] });
  const requests = []; // every /api/ request: { method, path, authorized, mode, at, status }
  const violations = []; // CSP reports the page posted (report-uri)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = { 'Content-Security-Policy': `${csp}; report-uri /__csp`, 'Cache-Control': 'no-store', ...headers };
    if (url.pathname === '/__devvit/devvit.v1.min.js') return res.writeHead(200, { ...base, 'Content-Type': 'text/javascript' }).end(DEVVIT_SCRIPT);
    if (url.pathname === '/__csp') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        violations.push(JSON.parse(Buffer.concat(chunks).toString())['csp-report']);
      } catch {}
      return res.writeHead(204).end();
    }
    if (url.pathname.startsWith('/api/')) {
      const r = { method: req.method, path: url.pathname, authorized: req.headers.authorization === `Bearer ${TOKEN}`, mode: req.headers['sec-fetch-mode'] || '', at: Date.now(), status: 0 };
      requests.push(r);
      if (!r.authorized) {
        r.status = 401;
        return res.writeHead(401, { ...base, 'Content-Type': 'application/json' }).end('{"error":"no devvit token"}');
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const fwd = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'authorization' && k !== 'host'));
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: fwd, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const answer = await store.run({ ...REDDITOR }, () => api(request));
      r.status = answer?.status ?? 404;
      if (!answer) return res.writeHead(404, base).end();
      res.writeHead(answer.status, { ...base, ...Object.fromEntries(answer.headers) });
      return res.end(Buffer.from(await answer.arrayBuffer()));
    }
    const prefix = Object.keys(dirs).filter((p) => url.pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (!prefix) return res.writeHead(404, base).end();
    const root = dirs[prefix];
    const file = path.join(root, path.normalize(url.pathname.slice(prefix.length) || 'index.html'));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404, base).end();
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) body = Buffer.from(rewrite(body.toString(), url).replace(/<head([^>]*)>/i, '<head$1><script src="/__devvit/devvit.v1.min.js"></script>'));
    res.writeHead(200, { ...base, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    context,
    requests,
    violations,
    close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))),
  };
}
