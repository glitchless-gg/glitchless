// The share card: a 1200x675 picture (16:9, which X shows uncropped) of the meltdown frame with what was measured
// and on what device, and the ways to send it.
import markUrl from './assets/glitchless-mark-dark.svg?url';

const MARK_ASPECT = 440 / 312; // the mark's viewBox; an SVG with only a viewBox has no dependable natural size

const W = 1200;
const H = 675;
const DISPLAY = '"Unbounded Variable", "Arial Black", system-ui, sans-serif';
const MONO = '"JetBrains Mono Variable", ui-monospace, Menlo, monospace';

let logo = null;
function loadLogo() {
  if (!logo) {
    logo = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = markUrl;
    });
  }
  return logo;
}

export async function drawCard({ snapshot, score, device, measured, stats, url }) {
  await Promise.all([document.fonts.load(`800 100px ${DISPLAY}`), document.fonts.load(`500 24px ${MONO}`), document.fonts.load(`700 24px ${MONO}`)]).catch(() => {});
  const mark = await loadLogo();
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  g.fillStyle = '#070b18';
  g.fillRect(0, 0, W, H);
  if (snapshot) {
    // cover-fit the meltdown frame, a little to the right so the text has the left side
    const s = Math.max(W / snapshot.width, H / snapshot.height);
    const w = snapshot.width * s;
    const h = snapshot.height * s;
    g.drawImage(snapshot, (W - w) / 2 + W * 0.12, (H - h) / 2, w, h);
  }
  const shade = g.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, 'rgba(7,11,24,0.96)');
  shade.addColorStop(0.5, 'rgba(7,11,24,0.78)');
  shade.addColorStop(1, 'rgba(7,11,24,0.1)');
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ff6b57';
  g.fillRect(0, 0, W, 8);

  const x = 64;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#2ee6a6';
  g.font = `800 30px ${DISPLAY}`;
  g.fillText('LAGDERBOARD', x, 82);
  g.fillStyle = 'rgba(233,238,255,0.72)';
  g.font = `500 26px ${MONO}`;
  g.fillText(`My ${device.short} survived`, x, 170);

  g.fillStyle = '#ffffff';
  const num = score.toLocaleString('en-US');
  let size = 150;
  g.font = `800 ${size}px ${DISPLAY}`;
  while (g.measureText(num).width > 640 && size > 80) {
    size -= 6;
    g.font = `800 ${size}px ${DISPLAY}`;
  }
  g.fillText(num, x - 4, 170 + size * 0.98);
  const numBottom = 170 + size * 0.98;
  g.font = `800 46px ${DISPLAY}`;
  g.fillStyle = '#2ee6a6';
  g.fillText('cubes', x, numBottom + 62);

  g.fillStyle = 'rgba(233,238,255,0.92)';
  g.font = `700 24px ${MONO}`;
  g.fillText(fit(g, device.label, 660), x, numBottom + 124);
  g.fillStyle = 'rgba(233,238,255,0.66)';
  g.font = `500 21px ${MONO}`;
  const [l1, l2] =
    measured.reason === 'unbreakable'
      ? ['and p95 frame time never stayed over', `${measured.limitMs.toFixed(1)} ms (30 fps). Unbreakable.`]
      : measured.reason === 'context_lost'
        ? ['before the browser dropped the GPU', '(WebGL context lost)']
        : [`until p95 frame time stayed over ${measured.limitMs.toFixed(1)} ms`, `(under ${Math.round(1000 / measured.limitMs)} fps) for ${Math.round(measured.heldS)} s`];
  g.fillText(l1, x, numBottom + 162);
  g.fillText(l2, x, numBottom + 192);

  let cx = x;
  const cy = numBottom + 222;
  g.font = `700 20px ${MONO}`;
  for (const chip of [`${stats.lights} lights`, `${stats.explosions} explosions`, clock(stats.seconds), `${measured.hz} Hz screen`]) {
    const w = g.measureText(chip).width + 28;
    if (cx + w > W - 40) break;
    roundRect(g, cx, cy, w, 38, 19);
    g.fillStyle = 'rgba(46,230,166,0.14)';
    g.fill();
    g.fillStyle = '#c9fbe9';
    g.fillText(chip, cx + 14, cy + 26);
    cx += w + 10;
  }

  g.fillStyle = 'rgba(233,238,255,0.8)';
  g.font = `500 20px ${MONO}`;
  const by = H - 40;
  if (mark) {
    const mh = 30;
    g.drawImage(mark, x, by - mh + 6, mh * MARK_ASPECT, mh);
    g.fillText('Measured by Glitchless', x + 54, by);
  } else g.fillText('Measured by Glitchless', x, by);
  g.textAlign = 'right';
  g.fillStyle = '#2ee6a6';
  g.font = `700 22px ${MONO}`;
  g.fillText(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), W - 40, by);
  g.textAlign = 'left';
  return c;
}

export function shareText({ score, device, reason }) {
  const n = score.toLocaleString('en-US');
  if (reason === 'unbreakable') return `My ${device.short} took ${n} cubes and never dropped under 30 fps. Unbreakable. How much can yours take?`;
  return `My ${device.short} survived ${n} cubes before it dropped under 30 fps. How much can yours take?`;
}

// The phone share sheet, with the picture where the browser can share files. `file` is made ahead of the tap:
// Safari only opens the sheet from a tap that hasn't waited on anything. False when there's no share sheet.
export async function nativeShare(file, text, url) {
  if (!navigator.share) return false;
  try {
    const data = file && navigator.canShare?.({ files: [file] }) ? { files: [file], text: `${text} ${url}` } : { text, url };
    await navigator.share(data);
    return true;
  } catch (err) {
    return err?.name === 'AbortError'; // the player closed the sheet: that's an answer, not a failure
  }
}

export function xIntentUrl(text, url) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

export function download(canvas, name = 'lagderboard.png') {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = name;
  a.click();
}

export function clock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 4 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
