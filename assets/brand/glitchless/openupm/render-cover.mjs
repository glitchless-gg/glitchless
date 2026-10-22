// Renders cover.html to cover.png (1200 x 600, the 600 x 300 card at 2x) for the OpenUPM listing.
//   node assets/brand/glitchless/openupm/render-cover.mjs     (Playwright from the repo's node_modules, and Chrome)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 300 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(here, 'cover.html')}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
await page.screenshot({ path: path.join(here, 'cover.png') });
await browser.close();
console.log('wrote', path.relative(process.cwd(), path.join(here, 'cover.png')));
