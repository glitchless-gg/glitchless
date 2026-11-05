// Local dev server: `npm run server` from the repo root → http://localhost:7777
import http from 'node:http';
import path from 'node:path';
import { createApp } from './app.js';
import { ROOT, loadEnv, createStore, createForwarder, appOptions, roomsOptions } from './config.js';
import { watchAlerts } from './alerts.js';
import { createPlay } from './play.js';

loadEnv();
const port = Number(process.env.PORT || 7777);
const store = await createStore();
const forwarder = createForwarder();

const jam = roomsOptions();
const handler = createApp({
  store,
  forwarder,
  ...appOptions(),
  rooms: jam.rooms,
  staticRoutes: [
    { prefix: '/sdk/', dir: path.join(ROOT, 'packages/sdk/dist') },
    { prefix: '/play/', dir: path.join(ROOT, 'apps/zoomies/dist') },
    { prefix: '/brand/', dir: path.join(ROOT, 'assets/brand/glitchless/logo') },
    // The jam's own pages (jam rooms: the organiser's, and each room's arcade, big screen, survey and join page).
    { prefix: '/jam/', dir: path.join(ROOT, 'apps/dashboard/dist'), spa: 'jam.html' },
    { prefix: '/', dir: path.join(ROOT, 'apps/dashboard/dist'), spa: true },
  ],
});

// Alerts (alerts.js) to one Discord or Slack webhook, checked every 15 minutes while this server runs.
const alertWebhook = process.env.GLITCHLESS_ALERT_WEBHOOK;
if (alertWebhook) watchAlerts({ store, url: alertWebhook, format: process.env.GLITCHLESS_ALERT_FORMAT || null, appUrl: `http://localhost:${port}` });

// Jam rooms' games on a port of their own (play.js), so a game never shares an origin with the dashboard. A port in use
// leaves rooms without games, not the server down. The sweep ends rooms past their time and deletes them a day after.
http
  .createServer(createPlay({ files: jam.rooms.files, intake: jam.intake, https: jam.rooms.urls.play.startsWith('https:') }))
  .on('error', (err) => console.warn(`   jam rooms: games can't be served on port ${jam.playPort} (${err.code}); set GLITCHLESS_PLAY_PORT`))
  .listen(jam.playPort);
const sweep = () => handler.rooms.sweep().catch((err) => console.warn('[rooms] sweep', err.message));
sweep();
setInterval(sweep, 60 * 60_000).unref();

http.createServer(handler).listen(port, () => {
  console.log(`🐶 Glitchless listening on http://localhost:${port}`);
  console.log(`   store: ${store.kind}${store.events ? ` (${store.events.length} events loaded)` : ''}`);
  console.log(`   exporters: ${forwarder.status().map((x) => `${x.kind} → ${x.target}`).join(', ') || 'none'}`);
  console.log(`   alerts: ${alertWebhook ? `to ${new URL(alertWebhook).host}, every 15 minutes` : 'off (GLITCHLESS_ALERT_WEBHOOK)'}`);
  console.log(`   jam rooms: ${jam.rooms.urls.jam} (rooms at ${jam.rooms.urls.jam}<code>), games at ${jam.rooms.urls.play}${process.env.GLITCHLESS_PUBLIC_URL ? '' : ' (for phones, set GLITCHLESS_PUBLIC_URL to this machine\'s address on the network)'}`);
});
