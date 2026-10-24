#!/usr/bin/env node
// A self-hosted Lagderboard leaderboard: Node's http server, the board kept in a JSON file. No dependencies.
//
//   PORT=7798 LAGDERBOARD_DATA=data/lagderboard-board.json node apps/lagderboard/server/serve.js
//
// LAGDERBOARD_ORIGINS   comma-separated origins allowed to call it (default *)
// LAGDERBOARD_HIDE      comma-separated device names to leave off the lists (moderation)
// TRUST_PROXY=1         take the client address from X-Forwarded-For's first entry (only behind a proxy you run,
//                       which sets that header itself)
import http from 'node:http';
import { createLeaderboardService } from './leaderboard.js';
import { createHandler } from './http.js';
import { MemoryStore } from './memory-store.js';
import { nodeHandler } from './node.js';

const port = Number(process.env.PORT) || 7798;
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const store = new MemoryStore({ file: process.env.LAGDERBOARD_DATA || 'data/lagderboard-board.json' });
const service = createLeaderboardService({ store, hidden: list(process.env.LAGDERBOARD_HIDE) });
const origins = list(process.env.LAGDERBOARD_ORIGINS);
const handle = createHandler(service, { origins: origins.length ? origins : ['*'] });
const forwarded = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
const ip = process.env.TRUST_PROXY === '1' ? (req) => forwarded(req) || req.socket.remoteAddress || 'unknown' : undefined;

http.createServer(nodeHandler(handle, ip ? { ip } : {})).listen(port, () => console.log(`[lagderboard] leaderboard on http://localhost:${port} (${store.kind}: ${store.file ?? 'memory'})`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
