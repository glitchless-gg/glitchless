// Config for the server (`npm run server`, or the Docker image): the store, the exporters and the keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from './stores/file.js';
import { envAuth } from './auth.js';
import { createExporters, exporterSettingsFromEnv } from './exporters/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// Events, maps, reports and dashboards live in files under GLITCHLESS_DATA_DIR (./data by default).
export async function createStore() {
  return new FileStore(process.env.GLITCHLESS_DATA_DIR || path.join(ROOT, 'data'));
}

// Datadog and/or OTLP exporters, switched on by env vars (see exporters/index.js). The app only calls
// forward(events) and status() on what this returns; with nothing configured, nothing is sent.
export function createForwarder(env = process.env) {
  return createExporters(exporterSettingsFromEnv(env));
}

// One project, keys from GLITCHLESS_CLIENT_TOKENS / GLITCHLESS_API_KEY (see auth.js for the hooks).
export function appOptions() {
  return { auth: envAuth() };
}
