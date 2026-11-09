// Renders the Godot Asset Store listing's images from src/*.html: each page is drawn at 960 x 540 and saved at 2x,
// 1920 x 1080 (16:9, which the store asks of the thumbnail). The screenshots frame captures in captures/, made from
// the Godot demo's bot runs (capture-dashboard.mjs), and Starlift's shared board.
//   node docs/release/godot-asset-store/media/render.mjs            every page in src/
//   node docs/release/godot-asset-store/media/render.mjs thumbnail  one page
// Uses Playwright from the repo's node_modules with Chrome.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const pages = fs.readdirSync(path.join(here, 'src')).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => f.replace(/\.html$/, '')).filter((p) => !only.length || only.includes(p));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
for (const name of pages) {
  const html = fs.readFileSync(path.join(here, 'src', `${name}.html`), 'utf8');
  const [width, height] = (html.match(/<meta name="size" content="(\d+)x(\d+)">/) ?? [null, 960, 540]).slice(1).map(Number);
  await page.setViewportSize({ width, height });
  await page.goto(`file://${path.join(here, 'src', `${name}.html`)}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: path.join(here, `${name}.png`) });
  console.log('wrote', path.relative(process.cwd(), path.join(here, `${name}.png`)));
}
await browser.close();
