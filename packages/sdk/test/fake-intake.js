// A stand-in Glitchless server for the multiplayer and server tests: it answers GET /v1/health with the features it is
// given and keeps every batch POSTed to /v1/intake, gunzipped, in `batches`. With `forward` (a Glitchless server's URL)
// it also sends each batch on to that server, as the SDK sent it, so a test's match lands on a real server too.
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

export async function fakeIntake({ features = ['counts', 'server_mode'], health = true, forward = null } = {}) {
  const batches = [];
  const healthAsks = [];
  const forwarded = []; // the forward's answers, as promises of their status
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/v1/health') {
        healthAsks.push(Date.now());
        if (!intake.health) return res.writeHead(503).end();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, store: 'fake', ...(intake.features ? { features: intake.features } : {}) }));
      }
      if (url.pathname === '/v1/intake' && req.method === 'POST') {
        let buf = Buffer.concat(chunks);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
        batches.push({ token: url.searchParams.get('token'), contentType: req.headers['content-type'], body: JSON.parse(buf.toString('utf8')) });
        const answer = () => {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end('{"accepted":1}');
        };
        if (!forward) return answer();
        forwarded.push(
          fetch(`${forward}/v1/intake?token=${encodeURIComponent(url.searchParams.get('token') || 'gl_pub_dev')}`, { method: 'POST', body: buf }).then(
            (r) => r.status,
            () => 0,
          ),
        );
        return void forwarded.at(-1).then(answer);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const intake = {
    url: `http://127.0.0.1:${server.address().port}`,
    features,
    health,
    batches,
    healthAsks,
    forwarded,
    // Every event sent, each with its batch's envelope as `_batch`.
    events: () => batches.flatMap((b) => b.body.events.map((e) => ({ ...e, _batch: b.body }))),
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections(); // fetch keeps connections alive
    }),
  };
  return intake;
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
