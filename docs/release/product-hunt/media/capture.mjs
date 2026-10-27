// Captures for the Product Hunt gallery, all real: two of Starlift's boards over the last 7 days, opened through share
// links made for this and revoked as soon as the pictures are taken, and glitchless.gg's engines page. Saved at 2x in
// captures/ (not kept in git), for the pages in src/ (render.mjs).
//
//   node docs/release/product-hunt/media/capture.mjs
//
// Uses the saved `glitchless-mcp login` (a workspace key) through the repo's MCP server, Playwright with Chrome, and
// prints no link or token: a share link is shown once, and this one lives only for the capture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const OUT = path.join(here, 'captures');
const GAME = 'Starlift';
const BOARDS = [
  { page: 'overview', file: 'starlift-overview.png' },
  { page: 'progress', file: 'starlift-progress.png' },
];
// The width a board is drawn at: narrow enough that its text stays readable once the picture fills the gallery frame.
const VIEW = { width: 900, height: 470 };
fs.mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GLITCHLESS_(API_KEY|URL|SERVICE)$/.test(k)));
const client = new Client({ name: 'glitchless-product-hunt', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'packages/mcp/src/index.js')], env, stderr: 'ignore' }));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text).join('\n') ?? '';
  if (res.isError) throw new Error(`${name}: ${text.replace(/gl_share_[A-Za-z0-9_-]+/g, 'gl_share_…')}`);
  return text;
};

const browser = await chromium.launch({ channel: 'chrome' });
const made = [];
try {
  for (const b of BOARDS) {
    const text = await call('glitchless_share_board', { game: GAME, page: b.page, name: 'Product Hunt capture (temporary, revoke)', days: 1 });
    const url = text.match(/https:\/\/\S*gl_share_[A-Za-z0-9_-]+\S*/)?.[0]?.replace(/[)".,]+$/, '');
    const id = text.match(/share_[a-z0-9]{8,}/)?.[0];
    if (id) made.push(id);
    if (!url) throw new Error(`no link in the answer for ${b.page}`);
    const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'light' });
    await page.goto(url, { waitUntil: 'networkidle' });
    // The last 7 days, from the range picker.
    const range = page.locator('select:has(option[value="7d"])').first();
    if (await range.count()) {
      await range.selectOption('7d');
      await page.waitForLoadState('networkidle');
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, b.file), fullPage: true });
    await page.close();
    console.log(`› ${b.file}: Starlift's ${b.page} board, 7 days`);
  }
  // The engines, from the site as it is.
  const site = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await site.goto('https://www.glitchless.gg/engines.html', { waitUntil: 'networkidle' });
  await site.waitForTimeout(1000);
  await site.screenshot({ path: path.join(OUT, 'engines.png'), fullPage: true });
  console.log('› engines.png: www.glitchless.gg/engines.html');
} finally {
  for (const id of made) {
    await call('glitchless_revoke_share_link', { game: GAME, id }).catch((err) => console.error(`revoke ${id} by hand: ${err.message}`));
    console.log(`› revoked ${id}`);
  }
  await browser.close();
  await client.close();
}
