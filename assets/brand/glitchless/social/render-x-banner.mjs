// Renders x-banner.html to the X profile banner (x-banner.png at 1500 x 500, x-banner@2x.png at 3000 x 1000), and a
// preview of how a phone shows it (x-banner-phone-preview.png): the middle 1250 px, with the back and search
// buttons, the status bar, the Dynamic Island and the profile picture drawn where an iPhone puts them (measured from
// a screenshot of the live profile).
//   node assets/brand/glitchless/social/render-x-banner.mjs     (Playwright from the repo's node_modules, and Chrome)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
for (const [scale, name] of [[1, 'x-banner.png'], [2, 'x-banner@2x.png']]) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: scale });
  await page.goto(`file://${path.join(here, 'x-banner.html')}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(here, name) });
}
// The phone: 390 pt wide, the banner 2.5:1 behind the status bar, the profile picture over its bottom left.
const phone = await browser.newPage({ viewport: { width: 390, height: 230 }, deviceScaleFactor: 3 });
await phone.setContent(`<body style="margin:0;background:#000">
  <div style="position:relative;width:390px;height:156px;overflow:hidden">
    <img src="data:image/png;base64,${fs.readFileSync(path.join(here, 'x-banner.png')).toString('base64')}" style="position:absolute;left:${-125 * (390 / 1250)}px;top:0;width:${1500 * (390 / 1250)}px;height:156px">
    <div style="position:absolute;left:15px;top:64px;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.55)"></div>
    <div style="position:absolute;left:298px;top:64px;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.55)"></div>
    <div style="position:absolute;left:341px;top:64px;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.55)"></div>
    <div style="position:absolute;left:133px;top:11px;width:125px;height:37px;border-radius:19px;background:#000"></div>
    <div style="position:absolute;left:0;right:0;top:0;height:40px;font:600 15px -apple-system;color:#fff;display:flex;justify-content:space-between;padding:20px 40px 0">9:54<span>●●● ▮</span></div>
  </div>
  <div style="position:absolute;left:8px;top:142px;width:72px;height:72px;border-radius:50%;background:#14213D;border:4px solid #000"></div>
</body>`, { waitUntil: 'load' });
await phone.screenshot({ path: path.join(here, 'x-banner-phone-preview.png') });
await browser.close();
console.log('wrote x-banner.png, x-banner@2x.png and x-banner-phone-preview.png in', path.relative(process.cwd(), here));
