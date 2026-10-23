// Captures the dashboard pages the Fab gallery frames (captures/findings.png, performance.png, errors.png) at
// 1600 x 900, from a local Glitchless server holding the Unreal demo's bot runs (node unreal/demo/run.mjs --serve,
// or local.js on the data folder a run left). Then render.mjs frames them.
//   node docs/release/fab/media/capture-dashboard.mjs http://127.0.0.1:<port>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) {
  console.error('usage: node docs/release/fab/media/capture-dashboard.mjs http://127.0.0.1:<port>');
  process.exit(2);
}
const out = path.join(here, 'captures');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

async function open(hash) {
  await page.goto(`${base}/#/${hash}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

async function shot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('wrote', path.relative(process.cwd(), path.join(out, `${name}.png`)));
}

// The overview's findings, with the gallery's PSO hitch opened to its advice.
await open('overview');
await page.getByText(/Hitches on gallery/).first().click();
await page.waitForTimeout(400);
await shot('findings');

// Performance: frame time, hitch causes and the hitches with what came before them.
await open('performance');
// The dashboard scrolls its own panel, not the window: bring the per-level table to the top.
await page.getByText('By level').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
await page.waitForTimeout(400);
await shot('performance');

// Errors: the ensure, opened.
await open('errors');
await page.getByText(/Ensure condition failed/).first().click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);
await shot('errors');

await browser.close();
