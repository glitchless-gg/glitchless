// Renders banner.html to banner.png (1950 x 1300: the 975 x 650 card at 2x) for the Asset Store promo banner.
//   node assets/brand/glitchless/asset-store/render-banner.mjs     (Playwright from the repo's node_modules, and Chrome)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 975, height: 650 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(here, 'banner.html')}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
await page.screenshot({ path: path.join(here, 'banner.png') });
await browser.close();
console.log('wrote', path.relative(process.cwd(), path.join(here, 'banner.png')));
