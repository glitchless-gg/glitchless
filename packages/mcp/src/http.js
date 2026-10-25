// Glitchless's MCP server over Streamable HTTP, for clients that connect to a URL instead of starting a process
// (claude.ai and ChatGPT connectors, agents on another machine). Every request gets a server of its own
// (createServer), so nothing lives between requests: it runs behind a load balancer or in a serverless function, and
// answers clients of the 2026-07-28 protocol and older ones that open with initialize alike. The tools that act on
// the computer the server runs on (playtests, the Steam Deck, the device sign-in) are left out.
//
// The host checks each request's credentials, then hands over the connection it runs with and its scopes:
//
//   const mcp = createHttpHandler();
//   http.createServer((req, res) => mcp.handle(req, res, { connection, scopes }));
//
// Glitchless Cloud signs people in with OAuth and runs each request with their workspace key; `glitchless-mcp serve`
// (serve() below) serves this machine's own key or self-hosted server.
import crypto from 'node:crypto';
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer, base } from './context.js';
import './hosted-tools.js';

export const MAX_BODY = 4 * 1024 * 1024;

// → { fetch(Request, { authInfo }) → Response, handle(req, res, opts), close() }. opts: { connection (default: this
// process's own), scopes (default: every tool), token, clientId }.
export function createHttpHandler({ responseMode = 'auto', onerror } = {}) {
  const mcp = createMcpHandler(({ authInfo }) => createServer({ remote: true, connection: authInfo?.extra?.connection ?? null, scopes: authInfo?.extra?.scopes ?? null }), { responseMode, onerror, maxRequestBodySize: MAX_BODY });
  return {
    fetch: mcp.fetch,
    async handle(req, res, { connection = null, scopes = null, token = '', clientId = '' } = {}) {
      const request = await toRequest(req, res);
      if (!request) return;
      await send(res, await mcp.fetch(request, { authInfo: { token, clientId, scopes: scopes ?? [], extra: { connection, scopes } } }));
    },
    close: mcp.close,
  };
}

// A Node request as a web Request (null once it has answered 413 itself), aborted if the client goes away.
async function toRequest(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request body too large.' }));
      return null;
    }
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const abort = new AbortController();
  res.on('close', () => res.writableFinished || abort.abort());
  const body = req.method === 'GET' || req.method === 'HEAD' || !size ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url, `http://${req.headers.host || 'localhost'}`), { method: req.method, headers, body, signal: abort.signal });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}

// ── glitchless-mcp serve ─────────────────────────────────────────
// The hosted tools at http://<host>:<port>/mcp, reading with this machine's key or self-hosted server (as the stdio
// server does: GLITCHLESS_URL, GLITCHLESS_API_KEY or a saved sign-in). On this computer only by default, where it
// checks Host and Origin against DNS rebinding; to listen beyond it, set GLITCHLESS_MCP_TOKEN and clients send it as
// Authorization: Bearer.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostname = (value) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
};

// → the listening http.Server; throws when told to listen beyond this computer without a token.
export async function serve(argv = []) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const port = Number(flag('port') || process.env.PORT || 3001);
  const host = flag('host') || '127.0.0.1';
  const token = process.env.GLITCHLESS_MCP_TOKEN || '';
  const local = LOOPBACK.has(host);
  if (!local && !token) throw new Error(`Listening on ${host} lets other computers in: set GLITCHLESS_MCP_TOKEN, and clients send it as Authorization: Bearer.`);
  const mcp = createHttpHandler();
  const server = http.createServer(async (req, res) => {
    const deny = (status, error, extra = {}) => res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify({ error }));
    if (new URL(req.url, 'http://local').pathname !== '/mcp') return deny(404, 'Not found: the MCP endpoint is /mcp.');
    if (local && (!LOOPBACK.has(hostname(req.headers.host || '')) || (req.headers.origin && !LOOPBACK.has(hostname(req.headers.origin))))) return deny(403, 'Only this computer may call this server.');
    if (token) {
      const given = crypto.createHash('sha256').update(String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')).digest();
      if (!crypto.timingSafeEqual(given, crypto.createHash('sha256').update(token).digest())) return deny(401, 'Send GLITCHLESS_MCP_TOKEN as Authorization: Bearer.', { 'www-authenticate': 'Bearer' });
    }
    try {
      await mcp.handle(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) deny(500, 'Something went wrong.');
      else res.end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  console.error(`Glitchless MCP on http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}/mcp, reading ${base()}`);
  return server;
}
