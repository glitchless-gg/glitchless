// Local dev server: `npm run server` from the repo root → http://localhost:7777
import http from 'node:http';
import path from 'node:path';
import { createApp } from './app.js';
import { ROOT, loadEnv, createStore, createForwarder, appOptions } from './config.js';

loadEnv();
const port = Number(process.env.PORT || 7777);
const store = await createStore();
const forwarder = createForwarder();

const handler = createApp({
  store,
  forwarder,
  ...appOptions(),
  staticRoutes: [
    { prefix: '/sdk/', dir: path.join(ROOT, 'packages/sdk/dist') },
    { prefix: '/play/', dir: path.join(ROOT, 'apps/zoomies/dist') },
    { prefix: '/brand/', dir: path.join(ROOT, 'assets/brand/glitchless/logo') },
    { prefix: '/', dir: path.join(ROOT, 'apps/dashboard/dist'), spa: true },
  ],
});

http.createServer(handler).listen(port, () => {
  console.log(`🐶 Glitchless listening on http://localhost:${port}`);
  console.log(`   store: ${store.kind}${store.events ? ` (${store.events.length} events loaded)` : ''}`);
  console.log(`   exporters: ${forwarder.status().map((x) => `${x.kind} → ${x.target}`).join(', ') || 'none'}`);
});
