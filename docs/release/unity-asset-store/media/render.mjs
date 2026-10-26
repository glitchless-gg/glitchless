// Renders the Asset Store images from src/*.html: each page is drawn at its <meta name="size"> (960 x 540 when it has
// none) and saved at 2x: the key images at the store's sizes (icon 160 x 160, card 420 x 280, cover 1950 x 1300,
// social 1200 x 630) and the screenshots at 1920 x 1080. Then ffmpeg makes them 24-bit PNGs, without an alpha
// channel. The screenshot pages frame captures in captures/ (capture-dashboard.mjs, make-agent-page.mjs).
//   node docs/release/unity-asset-store/media/render.mjs            every page in src/
//   node docs/release/unity-asset-store/media/render.mjs cover      one page
// Uses Playwright from the repo's node_modules with Chrome, and ffmpeg.
import { execFileSync } from 'node:child_process';
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
  const raw = path.join(here, `${name}.raw.png`);
  const out = path.join(here, `${name}.png`);
  await page.screenshot({ path: raw });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-pix_fmt', 'rgb24', out]);
  fs.rmSync(raw);
  console.log('wrote', path.relative(process.cwd(), out), `${width * 2} x ${height * 2}`);
}
await browser.close();
