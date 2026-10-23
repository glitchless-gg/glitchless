#!/usr/bin/env node
// Autoplay bots: real Chromium instances playing the real game with ?autoplay=1, so the telemetry
// is genuine (tagged session_type "synthetic"). Use it to put fresh numbers on a new build — e.g.
// after an agent's fix — before real players arrive. The game equivalent of Datadog Synthetics.
//
//   node scripts/bots.js                      # 6 bots, mixed skill, against http://localhost:5173
//   node scripts/bots.js --bots 12 --level 2  # start everyone on level 2
//   node scripts/bots.js --headed             # watch them play
//   node scripts/bots.js --game http://localhost:5176/ --seed 2000   # any game whose bot sets
//                                             # window.__GLITCHLESS_PLAYTEST_DONE__ when its run is over

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const GAME = flag('game', 'http://localhost:5173/');
const N = Number(flag('bots', 6));
const LEVEL = flag('level', null);
const MAX_S = Number(flag('max', 240));
const headed = !!flag('headed', false);
const intake = flag('intake', null);
const SEED = Number(flag('seed', 1000));

const browser = await chromium.launch({
  headless: !headed,
  channel: flag('channel', 'chrome'), // your installed Chrome = your real GPU; pass --channel chromium for Playwright's build
  // Use the real GPU (Metal via ANGLE on macOS) — SwiftShader would make every bot look like a potato.
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

async function bot(i) {
  const skill = (0.3 + ((i * 0.37) % 0.65)).toFixed(2);
  const qs = new URLSearchParams({ autoplay: '1', skill, seed: String(SEED + i), env: 'prod' });
  if (LEVEL) qs.set('level', LEVEL);
  if (intake) qs.set('intake', intake);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const started = Date.now();
  await page.goto(`${GAME}?${qs}`);
  // Autoplay ends by winning, giving up (rage quit) or the time cap.
  while (Date.now() - started < MAX_S * 1000) {
    await page.waitForTimeout(2000);
    const done = await page.evaluate(() => window.__GLITCHLESS_PLAYTEST_DONE__ || window.zoomies?.halted || window.zoomies?.won || window.zoomies?.quit).catch(() => true);
    if (done) break;
  }
  const stats = await page.evaluate(() => ({ session: window.__GLITCHLESS__?.sessionId, level: window.__GLITCHLESS__?.level, deaths: window.__GLITCHLESS__?.stats.deaths, errors: window.__GLITCHLESS__?.stats.errors })).catch(() => ({}));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
  await page.waitForTimeout(500);
  await ctx.close();
  console.log(`bot ${i} skill=${skill} → ${JSON.stringify(stats)} in ${Math.round((Date.now() - started) / 1000)}s`);
}

const pool = Math.min(N, Number(flag('parallel', 3)));
let next = 0;
await Promise.all(
  Array.from({ length: pool }, async () => {
    while (next < N) await bot(next++);
  }),
);
await browser.close();
