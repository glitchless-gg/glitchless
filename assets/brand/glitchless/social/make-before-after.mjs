// A 10-second before/after clip for social posts: Zoomies (the site's hero recordings, Chrome's CPU slowed 4x)
// before and after the agent's fix, the same 5 seconds of play each, with every frame's real duration drawn
// underneath as it plays. 1920x1080, 30 fps, H.264 (fits X and LinkedIn).
//
//   node assets/brand/glitchless/social/make-before-after.mjs [--site ../glitchless-site] [--from 20.5] [--out x.mp4]
//
// The band (label, fps, frame-time strip, mark) is drawn per frame in a page by Playwright (transparent PNGs),
// then laid over the footage by ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const site = path.resolve(flag('site', path.join(here, '../../../../../glitchless-site')));
const from = Number(flag('from', 20.5));
const out = path.resolve(flag('out', path.join(here, 'zoomies-before-after.mp4')));
const SEG = 5;
const FPS = 30;
const W = 1920;
const H = 1080;

const runs = ['before', 'after'].map((name) => {
  const { frames } = JSON.parse(fs.readFileSync(path.join(site, `media/hero-${name}-t4.frames.json`), 'utf8'));
  const inWindow = frames.filter(([t]) => t >= from && t < from + SEG).map(([t, ms]) => [t - from, ms]);
  const fps = inWindow.length / SEG;
  const sorted = inWindow.map(([, ms]) => ms).sort((a, b) => a - b);
  return { name, video: path.join(site, `media/hero-${name}-t4.mp4`), frames: inWindow, fps, p95: sorted[Math.floor(sorted.length * 0.95)] };
});

const mark = fs.readFileSync(path.join(here, '../logo/glitchless-mark-dark.svg'), 'utf8');
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@800&family=Inter:wght@500;600&display=swap">
<style>html,body{margin:0;background:transparent}canvas{display:block}</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas>
<img id="mark" src="data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}" style="display:none">
<script>
const runs = ${JSON.stringify(runs.map(({ video, ...r }) => r))};
const SEG = ${SEG}, W = ${W}, H = ${H};
const c = document.getElementById('c').getContext('2d');
const C = { navy: '#14213d', mint: '#2ee6a6', coral: '#ff6b57', soft: '#c5d0e4', muted: '#9fb0cf' };
window.draw = (run, t) => {
  const r = runs[run];
  c.clearRect(0, 0, W, H);
  // The band: a dark gradient over the bottom of the footage.
  const g = c.createLinearGradient(0, 700, 0, H);
  g.addColorStop(0, 'rgba(11,20,38,0)');
  g.addColorStop(0.35, 'rgba(11,20,38,0.82)');
  g.addColorStop(1, 'rgba(11,20,38,0.96)');
  c.fillStyle = g;
  c.fillRect(0, 700, W, H - 700);
  const color = run === 0 ? C.coral : C.mint;
  // The label and the fps.
  const label = run === 0 ? 'BEFORE THE FIX' : 'AFTER THE FIX';
  c.font = '600 26px Inter';
  const lw = c.measureText(label).width + 44;
  c.fillStyle = color;
  c.beginPath(); c.roundRect(64, 820, lw, 48, 24); c.fill();
  c.fillStyle = C.navy;
  c.fillText(label, 86, 853);
  c.font = '800 64px Outfit';
  c.fillStyle = '#fff';
  const fpsText = Math.round(r.fps) + ' fps';
  c.fillText(fpsText, 64 + lw + 28, 866);
  c.font = '500 26px Inter';
  c.fillStyle = C.soft;
  c.fillText('p95 frame ' + Math.round(r.p95) + ' ms', 64 + lw + 28 + c.measureText(fpsText).width * 2.2 + 24, 862);
  // The mark, top right of the band.
  const m = document.getElementById('mark');
  c.drawImage(m, W - 64 - 300, 822, 62, 44);
  c.font = '800 38px Outfit';
  c.fillStyle = '#fff';
  c.fillText('glitchless.gg', W - 64 - 226, 858);
  // The frame strip: each frame a bar as wide as it lasted and as tall as its time, the 60 fps budget dashed.
  const x0 = 64, x1 = W - 64, top = 900, bottom = 1030, maxMs = 120;
  const y = (ms) => bottom - Math.min(ms, maxMs) / maxMs * (bottom - top);
  const xs = (s) => x0 + (s / SEG) * (x1 - x0);
  for (const [s, ms] of r.frames) {
    if (s > t) break;
    const start = Math.max(0, s - ms / 1000);
    const over = ms > 25;
    c.fillStyle = over ? C.coral : C.mint;
    c.fillRect(xs(start), y(ms), Math.max(2, xs(s) - xs(start) - 1), bottom - y(ms));
  }
  // The budget over the bars, so it shows through a stutter too.
  c.strokeStyle = 'rgba(255,255,255,0.85)'; c.setLineDash([10, 8]); c.lineWidth = 2;
  c.beginPath(); c.moveTo(x0, y(16.7)); c.lineTo(x1, y(16.7)); c.stroke(); c.setLineDash([]);
  c.font = '600 18px Inter';
  const bw = c.measureText('60 fps budget').width + 20;
  c.fillStyle = 'rgba(11,20,38,0.9)';
  c.beginPath(); c.roundRect(x1 - bw, y(16.7) - 34, bw, 28, 14); c.fill();
  c.fillStyle = '#fff';
  c.fillText('60 fps budget', x1 - bw + 10, y(16.7) - 14);
  c.font = '500 20px Inter'; c.fillStyle = C.muted;
  c.fillText('Every frame, timed · Zoomies demo, Chrome CPU slowed 4x', x0, 1062);
};
</script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'before-after-'));
const browser = await chromium.launch({ channel: 'chrome' });
const tab = await browser.newPage({ viewport: { width: W, height: H } });
await tab.setContent(page, { waitUntil: 'networkidle' });
await tab.evaluate(() => document.fonts.ready);
let n = 0;
for (let run = 0; run < 2; run++) {
  for (let f = 0; f < SEG * FPS; f++) {
    await tab.evaluate(([r, t]) => window.draw(r, t), [run, (f + 1) / FPS]);
    await tab.screenshot({ path: path.join(tmp, `o${String(n++).padStart(4, '0')}.png`), omitBackground: true });
  }
}
await browser.close();

const args = ['-loglevel', 'error', '-y'];
for (const r of runs) args.push('-ss', String(from), '-t', String(SEG), '-i', r.video);
args.push('-framerate', String(FPS), '-i', path.join(tmp, 'o%04d.png'));
args.push(
  '-filter_complex',
  `[0:v]fps=${FPS},scale=${W}:${H},setsar=1[a];[1:v]fps=${FPS},scale=${W}:${H},setsar=1[b];[a][b]concat=n=2:v=1:a=0[v];[v][2:v]overlay=0:0:format=auto,scale=out_range=tv,format=yuv420p[o]`,
  '-map', '[o]', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-movflags', '+faststart', '-r', String(FPS), out,
);
execFileSync('ffmpeg', args, { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', path.relative(process.cwd(), out), runs.map((r) => `${r.name}: ${r.fps.toFixed(1)} fps, p95 ${r.p95} ms`).join(' · '));
