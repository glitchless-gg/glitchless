// Makes the dashboard captures the Godot Asset Store screenshots frame (captures/findings.png, performance.png,
// errors.png) at 1600 x 900: starts an empty local Glitchless server, plays the Godot demo (godot/demo, with its
// planted stutter, leak and errors) a few times in a window so frames are drawn, then opens the dashboard on it.
// Then render.mjs frames them. Needs Godot 4.5+ (as the Godot tests find it) and Chrome.
//   node docs/release/godot-asset-store/media/make-captures.mjs [port]   (default 7863)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findGodot } from '../../../../godot/test/godot-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../..');
const port = Number(process.argv[2] || 7863);
const base = `http://127.0.0.1:${port}`;
const godot = findGodot();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-godot-captures-'));
const out = path.join(here, 'captures');
fs.mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server/src/local.js')], {
  env: { ...process.env, PORT: String(port), GLITCHLESS_DATA_DIR: dataDir, GLITCHLESS_DATADOG: 'off', GLITCHLESS_API_KEY: '' },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/v1/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Six players: each run plays the three levels at random from its seed, and quits after the last.
  for (const seed of [3, 7, 11, 21, 29, 42]) {
    const r = spawnSync(godot, ['--path', path.join(ROOT, 'godot'), '--', '--autoplay', `--seed=${seed}`, '--glitchless', `--intake=${base}`], { encoding: 'utf8', timeout: 120_000 });
    console.log(`played seed ${seed}: exit ${r.status}`);
  }
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const open = async (hash) => {
    await page.goto(`${base}/#/${hash}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
  };
  const shot = async (name) => {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log('wrote', path.relative(process.cwd(), path.join(out, `${name}.png`)));
  };

  // The overview's findings, with the level 2 stutter opened to its advice.
  await open('overview');
  await page.getByText(/level_2/).first().click();
  await page.waitForTimeout(400);
  await shot('findings');

  // Performance: frame time, hitch causes and the per-level table.
  await open('performance');
  await page.getByText('By level').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await shot('performance');

  // Errors: level 3's call on a missing node, opened.
  await open('errors');
  await page.getByText(/nonexistent|null instance|missing/i).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await shot('errors');
  await browser.close();
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
