// Runs the fetch-style handler from http.js under Node's (req, res), for serve.js or any Node server that wants to
// mount the leaderboard under a path of its own.
//
// ip(req): the client's address for rate limits. The default is the socket's; behind a proxy or CDN pass a function
// that reads the header that proxy sets and the client can't forge.
export function nodeHandler(handle, { ip = (req) => req.socket.remoteAddress || 'unknown' } = {}) {
  return async function (req, res) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 8192) break; // the handler answers 413 for anything over its own limit
      chunks.push(c);
    }
    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]])),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await handle(request, { ip: ip(req) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
