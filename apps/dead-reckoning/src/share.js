// The share card: a 1200×630 picture (the right size for a post on X) of the level, everyone's deaths,
// yours, and the run that made it, with the line people post. Plus the ways to send it.
const W = 1200;
const H = 630;
const INK = '#f4f1ea';
const DIM = '#8a93a8';
const EMBER = '#ff7a3d';
const ICE = '#86ecff';
const GOLD = '#ffcf5a';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** The words of the card, also the text of the post. */
export function shareLines({ level, tries, before }) {
  const head = `Level ${level.id}: ${fmt(tries)} ${tries === 1 ? 'try' : 'tries'}.`;
  const sub = before > 0 ? `${fmt(before)} ${before === 1 ? 'death' : 'deaths'} here before me.` : 'Nobody had died here before me.';
  return { head, sub };
}

export function shareText(card, url) {
  const { head, sub } = shareLines(card);
  return `Dead Reckoning. ${head} ${sub}\n${url}`;
}

// A line of the card with its numbers set in the mono face: in this serif a 1 reads as an l once a feed
// shrinks the picture, and the numbers are the point.
function mixed(ctx, text, x0, y, { serif, mono, color, numColor = color }) {
  let x = x0;
  for (const part of text.split(/([\d,]+)/)) {
    if (!part) continue;
    const num = /^[\d,]+$/.test(part);
    ctx.font = num ? mono : serif;
    ctx.fillStyle = num ? numColor : color;
    ctx.fillText(part, x, y);
    x += ctx.measureText(part).width + (num ? 4 : 0);
  }
}

function x(ctx, cx, cy, r, color, alpha, width = 2) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
}

/**
 * Draw the card. `card` = { level, tries, before, attempts, others: { deaths, bin }, fake }.
 * Returns the canvas.
 */
export function renderCard(card, { url } = {}) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const lv = card.level;
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);

  // The level, fitted into the lower part of the card.
  const box = { x: 60, y: 196, w: W - 120, h: H - 196 - 70 };
  const worldW = lv.w;
  const worldH = lv.h + 1.6;
  const ppu = Math.min(box.w / worldW, box.h / worldH);
  const ox = box.x + (box.w - worldW * ppu) / 2;
  const oy = box.y + box.h - (box.h - worldH * ppu) / 2;
  const px = (wx) => ox + wx * ppu;
  const py = (wy) => oy - (wy + 1.6) * ppu;

  ctx.fillStyle = '#1d2433';
  for (let i = 0; i <= lv.w; i++) for (let j = 0; j <= lv.h; j++) ctx.fillRect(px(i) - 1, py(j) - 1, 2, 2);
  // The level, faint: the card is for after you've beaten it.
  for (let r = 0; r < lv.h; r++) {
    for (let k = 0; k < lv.w; k++) {
      const i = r * lv.w + k;
      if (lv.solid[i]) {
        ctx.globalAlpha = lv.visible[i] ? 0.9 : 0.35;
        ctx.fillStyle = lv.visible[i] ? '#e9e4d8' : '#4b5d86';
        ctx.fillRect(px(k) + 1, py(r + 1) + 1, ppu - 2, ppu - 2);
      }
      if (lv.hazard[i]) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ff4d5e';
        ctx.beginPath();
        ctx.arc(px(k + 0.5), py(r + 0.5), ppu * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // A red haze along the bottom.
  const haze = ctx.createLinearGradient(0, py(-1.6), 0, py(-0.2));
  haze.addColorStop(0, 'rgba(179,38,58,0.45)');
  haze.addColorStop(1, 'rgba(179,38,58,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = haze;
  ctx.fillRect(px(0), py(-0.2), lv.w * ppu, 1.4 * ppu);

  // Everyone else.
  ctx.globalCompositeOperation = 'lighter';
  const half = (card.others?.bin || 0.5) * 0.45 * ppu;
  for (const [a, b, n] of card.others?.deaths || []) {
    const show = Math.min(n, 6);
    for (let i = 0; i < show; i++) {
      const jx = (Math.sin(a * 12.9898 + b * 78.233 + i * 3.1) * 43758.5453) % 1;
      const jy = (Math.sin(a * 39.346 + b * 11.135 + i * 7.7) * 24634.6345) % 1;
      x(ctx, px(a) + jx * half, py(b) + jy * half, ppu * 0.16, EMBER, Math.min(0.9, 0.25 + Math.log1p(n) * 0.08), 2);
    }
  }
  // You.
  for (const a of card.attempts) if (a.end === 'death') x(ctx, px(a.death.x), py(a.death.y), ppu * 0.22, ICE, 0.95, 3);
  ctx.globalCompositeOperation = 'source-over';
  // The run that made it.
  const win = card.attempts[card.attempts.length - 1];
  if (win?.n) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < win.n; i += 2) {
      const X = px(win.pts[i * 2]);
      const Y = py(win.pts[i * 2 + 1] + 0.4);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  }
  // Start and goal.
  ctx.fillStyle = ICE;
  ctx.beginPath();
  ctx.arc(px(lv.spawn.x), py(lv.spawn.y + 0.4), ppu * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(px(lv.goal.x), py(lv.goal.y + 0.62), ppu * 0.45, ppu * 0.6, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Words.
  const { head, sub } = shareLines(card);
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = DIM;
  ctx.font = '500 20px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`DEAD RECKONING  ·  LEVEL ${lv.id}  ·  ${lv.name.toUpperCase()}`, 60, 62);
  mixed(ctx, head, 58, 130, { serif: '72px "Instrument Serif", Georgia, serif', mono: '700 60px "JetBrains Mono", ui-monospace, monospace', color: INK });
  mixed(ctx, sub, 60, 178, { serif: 'italic 40px "Instrument Serif", Georgia, serif', mono: '700 32px "JetBrains Mono", ui-monospace, monospace', color: EMBER });
  ctx.fillStyle = DIM;
  ctx.font = '500 18px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText((url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''), 60, H - 28);
  ctx.textAlign = 'right';
  ctx.fillText('every death recorded with Glitchless', W - 60, H - 28);
  if (card.fake) {
    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD;
    ctx.font = '700 22px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText('MOCK DATA', W - 60, 62);
  }
  return c;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Native share with the picture where the browser can (phones), else false. */
export async function shareNative({ blob, text, filename }) {
  if (!navigator.share) return false;
  const file = blob ? new File([blob], filename, { type: 'image/png' }) : null;
  const withFile = file && navigator.canShare?.({ files: [file] });
  try {
    await navigator.share(withFile ? { files: [file], text } : { text });
    return true;
  } catch (err) {
    return err?.name === 'AbortError' ? 'cancelled' : false;
  }
}

export function postOnX(text) {
  const u = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  window.open(u, '_blank', 'noopener');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function saveImage(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
