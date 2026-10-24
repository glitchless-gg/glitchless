#!/usr/bin/env node
// The link-preview picture (public/og.png, 1200×630): the game's own title screen on level 5, drawn by the
// game in Chrome. The marks are the dev mock's: it's a poster, and it shows no numbers.
//   npm run dev -w dead-reckoning            (in another terminal)
//   node apps/dead-reckoning/scripts/og-image.mjs [http://localhost:5186/]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const game = process.argv[2] || 'http://localhost:5186/';
const out = fileURLToPath(new URL('../public/og.png', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${game}?level=5&markers=mock&nogd=1&overlay=0&mute=1&poster=1`);
await page.waitForFunction(() => window.deadReckoning?.source.get('5')?.loading === false, null, { timeout: 30_000 });
await page.evaluate(() => window.deadReckoning.run(3)); // let every mark finish popping in
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
