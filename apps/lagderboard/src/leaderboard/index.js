// The leaderboard, behind one small interface so the store can change without touching the game.
//
// A run:   { id, score, deviceClass: 'phone' | 'tablet' | 'desktop', deviceName, gpu, browser, os, hz, seconds,
//            version, sessionId, at }   (score: cubes on screen when Glitchless last measured 30 fps or better)
//
// A board:
//   kind                          'local' (this browser only) or 'hosted'
//   degraded                      hosted, but the last call couldn't reach it and used the local board
//   submit(run)                   → { rank, total, approximate?, deviceBest, deviceRuns, offline? }  rank within the class
//   devices(deviceClass, {limit}) → [{ deviceName, best, runs }]               best run per device, highest first
//   runs(deviceClass, {limit})    → [run]                                      single runs, highest first
//
// With VITE_LAGDERBOARD_API set (the base URL of server/http.js's API) the board is shared; without it, local.
import { LocalLeaderboard } from './local.js';
import { HttpLeaderboard } from './http.js';

export function createLeaderboard(api = import.meta.env.VITE_LAGDERBOARD_API) {
  return api ? new HttpLeaderboard(api) : new LocalLeaderboard();
}
