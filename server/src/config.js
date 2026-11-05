// Config for the server (`npm run server`, or the Docker image): the store, the exporters and the keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from './stores/file.js';
import { FileRoomStore, DirFiles } from './stores/rooms-file.js';
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

// Jam rooms (rooms.js, SPEC §3j): their records and games' files under the data folder, served on a port of their own
// (play.js; GLITCHLESS_PLAY_PORT, default PORT + 1000, so 8777). The jam's own pages are at /jam/ (the organiser's) and
// /jam/<CODE> (a room's). GLITCHLESS_PUBLIC_URL is where phones reach this server
// (http://192.168.1.5:7777 on a meetup's Wi-Fi): the arcade's links and QR codes use it. Games may send telemetry to it.
export function roomsOptions(env = process.env) {
  const port = Number(env.PORT || 7777);
  const playPort = Number(env.GLITCHLESS_PLAY_PORT || port + 1000);
  const app = new URL(env.GLITCHLESS_PUBLIC_URL || `http://localhost:${port}`);
  const play = env.GLITCHLESS_PLAY_URL || `${app.protocol}//${app.hostname}:${playPort}/r/`;
  const dir = path.join(env.GLITCHLESS_DATA_DIR || path.join(ROOT, 'data'), 'rooms');
  return {
    rooms: { store: new FileRoomStore(dir), files: new DirFiles(path.join(dir, 'files')), urls: { app: app.origin, play, jam: `${app.origin}/jam/` }, abuse: env.GLITCHLESS_ABUSE_EMAIL || null, requireService: true },
    playPort,
    intake: [...new Set([app.origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`])],
  };
}
