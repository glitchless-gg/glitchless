// Renders the Product Hunt images from src/*.html: each page is drawn at its <meta name="size"> (635 x 380 when it has
// none) and saved at 2x: the gallery at 1270 x 760 and the thumbnails at 240 x 240. Then ffmpeg makes them 24-bit
// PNGs, without an alpha channel. The gallery pages frame real captures in captures/ (capture.mjs). Copied from the
// Unity Asset Store kit.
//   node docs/release/product-hunt/media/render.mjs              every page in src/
//   node docs/release/product-hunt/media/render.mjs gallery-01   one page
// Uses Playwright from the repo's node_modules with Chrome, and ffmpeg.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const pages = fs.readdirSync(path.join(here, 'src')).filter((f) => f.endsWith('.html') && !f.startsWith('_')).map((f) => f.replace(/\.html$/, '')).filter((p) => !only.length || only.some((o) => p.startsWith(o)));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 635, height: 380 }, deviceScaleFactor: 2 });
for (const name of pages) {
  const html = fs.readFileSync(path.join(here, 'src', `${name}.html`), 'utf8');
  const [width, height] = (html.match(/<meta name="size" content="(\d+)x(\d+)">/) ?? [null, 635, 380]).slice(1).map(Number);
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
