// Renders banner.html to the banner at the top of Glitchless's welcome and product emails: email-hero.png, 1200 x 440
// (600 x 220 in the email, at 2x). The site serves it at www.glitchless.gg/img/email-hero.png, beside the dark
// lockup the plainer emails use (glitchless-lockup-dark.png): copy both to the site's img/ after a change.
//   node assets/brand/glitchless/email/render-banner.mjs     (Playwright from the repo's node_modules, and Chrome)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 220 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(here, 'banner.html')}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(here, 'email-hero.png') });
await browser.close();
console.log('wrote email-hero.png in', path.relative(process.cwd(), here));
