// Captures the dashboard pages the screenshots frame (captures/findings.png, heatmaps.png, performance.png, errors.png) at
// 1600 x 900, from a local Glitchless server holding the Fetch! sample's bot runs (README.md, "Remaking the images").
// Also writes captures/findings.json, which make-agent-page.mjs quotes.
//   node docs/release/unity-asset-store/media/capture-dashboard.mjs http://127.0.0.1:<port>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base) {
  console.error('usage: node docs/release/unity-asset-store/media/capture-dashboard.mjs http://127.0.0.1:<port>');
  process.exit(2);
}
const SERVICE = 'fetch-unity';
const out = path.join(here, 'captures');
fs.mkdirSync(out, { recursive: true });

// The findings an agent gets, for the agent page: the whole span of the runs.
const now = Date.now();
const res = await fetch(`${base}/v1/query/findings?service=${SERVICE}&from=${now - 7 * 86400_000}&to=${now}`);
const { findings } = await res.json();
fs.writeFileSync(path.join(out, 'findings.json'), `${JSON.stringify(findings, null, 1)}\n`);
console.log(`findings: ${findings.map((f) => f.title).join(' | ')}`);

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

// The overview's findings, with the frisbee exception opened to its advice.
await open('overview');
await page.getByText(/KeyNotFoundException/).first().click().catch(() => {});
await page.waitForTimeout(400);
await shot('findings');

// Heatmaps: where players die on level 2 (the long jump).
await open('heatmaps');
await page.getByText('level-2').first().click().catch(() => {});
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);
await shot('heatmaps');

// Performance: frame time, hitch causes and the hitches with what came before them.
await open('performance');
await page.getByText('By level').first().evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
await page.waitForTimeout(400);
await shot('performance');

// Errors: the frisbee's KeyNotFoundException, opened. The player was built from a checkout, so the stack's file paths
// start with that machine's folder: they're cut to the project's own path (Assets/…), as Unity shows it, and
// nothing else is changed.
await open('errors');
await page.getByText(/KeyNotFoundException/).first().click().catch(() => {});
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/\/(Users|home)\/[^()\n]*?\/unity\/(?=Assets\/)/g, '');
});
await shot('errors');

await browser.close();
