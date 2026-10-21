// AWS Lambda Web Functions entry: a plain Node HTTP server listening where Lambda tells it to.
// Same app as `npm run server`, with DynamoDB instead of the local file store.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { DynamoStore } from '../src/stores/dynamo.js';
import { createForwarder, appOptions } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = (p) => path.join(here, 'public', p);

const store = new DynamoStore({ table: process.env.GLITCHLESS_EVENTS_TABLE || 'glitchless-selfhost-events', region: process.env.GLITCHLESS_REGION || process.env.AWS_REGION || 'us-east-1' });
const handler = createApp({
  store,
  forwarder: createForwarder(),
  ...appOptions(),
  staticRoutes: [
    { prefix: '/sdk/', dir: pub('sdk') },
    { prefix: '/play/', dir: pub('play') },
    { prefix: '/brand/', dir: pub('brand') },
    { prefix: '/', dir: pub('dashboard'), spa: true },
  ],
});

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:8080').split(':');
http.createServer(handler).listen(Number(port), host, () => console.log(`Glitchless web function listening on ${host}:${port} (table ${store.table})`));
