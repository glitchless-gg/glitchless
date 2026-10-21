// Shared config for the local server and the Lambda Web Function.
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

export async function createStore() {
  if (process.env.GLITCHLESS_EVENTS_TABLE) {
    const { DynamoStore } = await import('./stores/dynamo.js');
    return new DynamoStore({ table: process.env.GLITCHLESS_EVENTS_TABLE, region: process.env.AWS_REGION || 'us-east-1' });
  }
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
