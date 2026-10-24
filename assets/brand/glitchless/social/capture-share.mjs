// Captures a Glitchless share link as an image for social posts: signed out, as anyone with the link sees it, at 2x.
//
//   node assets/brand/glitchless/social/capture-share.mjs <share url> <out.png> [--range 30d] [--width 1440]
import path from 'node:path';
import { chromium } from 'playwright';

const [url, out] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
if (!url || !out) throw new Error('usage: capture-share.mjs <share url> <out.png> [--range 30d] [--width 1440]');
const width = Number(flag('width', 1440));

const browser = await chromium.launch({ channel: 'chrome' });
// A short viewport: the page is as tall as the board, so the Made with Glitchless footer sits right under it.
const page = await browser.newPage({ viewport: { width, height: 480 }, deviceScaleFactor: 2, colorScheme: 'light' });
await page.goto(url, { waitUntil: 'networkidle' });
const range = page.getByLabel('Time range');
await range.selectOption(flag('range', '30d'));
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500); // charts draw after their data arrives
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('wrote', path.relative(process.cwd(), out));
