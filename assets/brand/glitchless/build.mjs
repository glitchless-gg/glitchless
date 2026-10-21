// Renders the Glitchless brand assets from their SVG/HTML sources with headless Chrome.
//   node assets/brand/glitchless/build.mjs            # everything
//   node assets/brand/glitchless/build.mjs preview    # logo/preview.png only, for iterating on the mark
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const logo = (f) => path.join(here, 'logo', f);
const svg = (f) => fs.readFileSync(logo(f), 'utf8');

const FONT = 'https://fonts.googleapis.com/css2?family=Outfit:wght@700;800&display=block';
const C = { mint: '#2EE6A6', navy: '#14213D', coral: '#FF6B57', white: '#FFFFFF' };

const browser = await chromium.launch({ channel: 'chrome' }); // installed Chrome, like scripts/bots.js
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(html, out, w, h, { transparent = true, crop = false } = {}) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${FONT}"><style>html,body{margin:0;background:${transparent ? 'transparent' : C.white}}</style></head><body><div id="c" style="display:inline-block">${html}</div></body></html>`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  // crop: trim the image to the content box (lockups), otherwise capture exactly w×h
  if (crop) await page.locator('#c').screenshot({ path: out, omitBackground: transparent });
  else await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}

const img = (markup, size) => markup.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);

if (process.argv[2] === 'compare') {
  // every SVG in logo/variants, one row each, at app-icon, toolbar and favicon sizes
  const files = fs.readdirSync(logo('variants')).filter((f) => f.endsWith('.svg')).sort();
  const rows = files
    .map((f) => {
      const mark = fs.readFileSync(logo(`variants/${f}`), 'utf8');
      const cells = [256, 96, 48, 32, 16].map((s) => `<div style="display:flex;align-items:flex-end;padding:10px 14px">${img(mark, s)}</div>`).join('');
      return `<div style="display:flex;align-items:flex-end;border-bottom:1px solid #d5dbe5"><div style="width:190px;padding:14px;font:600 18px Outfit,sans-serif;color:${C.navy}">${f.replace('.svg', '')}</div>${cells}</div>`;
    })
    .join('');
  await render(`<div style="background:#eef1f6">${rows}</div>`, logo('variants/compare.png'), 760, files.length * 286);
} else if (process.argv[2] === 'preview') {
  const icon = svg('glitchless-icon.svg');
  const small = svg('glitchless-icon-small.svg');
  const sizes = [512, 128, 64, 32, 16];
  const row = sizes.map((s) => `<div style="display:flex;align-items:flex-end;padding:12px">${img(s <= 48 ? small : icon, s)}</div>`).join('');
  const marks = ['glitchless-mark-light.svg', 'glitchless-mark-dark.svg'].filter((f) => fs.existsSync(logo(f)));
  const markRow = marks
    .map((f) => `<div style="padding:24px;background:${f.includes('dark') ? C.navy : C.white}">${img(svg(f), 220)}</div>`)
    .join('');
  await render(`<div style="display:flex;align-items:flex-end;background:#e9edf3">${row}</div><div style="display:flex">${markRow}</div>`, logo('preview.png'), 1100, 820);
} else {
  // icon PNGs + favicon sizes
  const icon = svg('glitchless-icon.svg');
  const small = svg('glitchless-icon-small.svg'); // spike + G only: the zigzag turns to mush below ~48 px
  fs.mkdirSync(logo('png'), { recursive: true });
  for (const s of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) await render(img(s <= 48 ? small : icon, s), logo(`png/glitchless-icon-${s}.png`), s, s);
  for (const [name, color] of [['light', C.navy], ['dark', C.white]]) {
    const mark = svg(`glitchless-mark-${name}.svg`);
    await render(mark.replace('<svg ', '<svg width="1024" height="726" style="display:block" '), logo(`png/glitchless-mark-${name}-1024.png`), 1024, 726);
    // horizontal lockup: mark + wordmark
    const lockup = `<div style="display:flex;align-items:center;gap:32px;padding:32px 40px">${mark.replace('<svg ', '<svg width="254" height="180" style="display:block" ')}<span style="font-family:Outfit,sans-serif;font-weight:800;font-size:150px;letter-spacing:-3px;color:${color};line-height:1">Glitchless</span></div>`;
    await render(lockup, logo(`png/glitchless-lockup-${name}.png`), 1400, 400, { crop: true });
  }
  // favicon.ico: PNG-compressed entries (16, 32, 48), which every current browser reads
  const sizes = [16, 32, 48].map((s) => [s, fs.readFileSync(logo(`png/glitchless-icon-${s}.png`))]);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach(([s, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s, e);
    head.writeUInt8(s, e + 1);
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  fs.writeFileSync(logo('favicon.ico'), Buffer.concat([head, ...sizes.map(([, png]) => png)]));
  fs.copyFileSync(logo('glitchless-icon-small.svg'), logo('favicon.svg'));
  // app-icon lockup (icon + wordmark) for light backgrounds
  const iconLockup = `<div style="display:flex;align-items:center;gap:36px;padding:32px 40px">${img(icon, 200)}<span style="font-family:Outfit,sans-serif;font-weight:800;font-size:150px;letter-spacing:-3px;color:${C.navy};line-height:1">Glitchless</span></div>`;
  await render(iconLockup, logo('png/glitchless-lockup-icon.png'), 1400, 400, { crop: true });
}
await browser.close();
console.log('done');
