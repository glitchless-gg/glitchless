import { useEffect, useMemo, useRef, useState } from 'react';
import { causeColor } from './format.js';

// Binned deaths (a positions panel's, with `n` each) are one colour, sized by how many fell there.
const BINNED_DEATH = '#ff6b57';

// World-space heatmap over the level thumbnail the SDK captured (glitchless.captureMap). `maxHeight` keeps a
// tall level to that height (narrower, centred) instead of the width it would need.
export function LevelMap({ map, bounds, axis = 'xy', density, deaths = [], hotspots = [], path, cursor, events = [], zoom = 1, showDensity = true, showDeaths = true, maxHeight = null }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const [img, setImg] = useState(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!map?.image) return setImg(null);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = map.image;
  }, [map?.image]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width || !bounds) return;
    const dpr = window.devicePixelRatio || 1;
    let W = Math.round(width * zoom);
    const aspect = img ? img.width / img.height : (bounds.max[0] - bounds.min[0]) / Math.max(1e-6, bounds.max[1] - bounds.min[1]);
    let H = Math.max(200, Math.round(W / aspect));
    if (maxHeight && H > maxHeight) {
      H = maxHeight;
      W = Math.min(W, Math.max(120, Math.round(H * aspect)));
    }
    c.width = W * dpr;
    c.height = H * dpr;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const span0 = bounds.max[0] - bounds.min[0] || 1;
    const span1 = bounds.max[1] - bounds.min[1] || 1;
    const toPx = (a, b) => [((a - bounds.min[0]) / span0) * W, axis === 'xy' ? ((bounds.max[1] - b) / span1) * H : ((b - bounds.min[1]) / span1) * H];
    const pick = (p) => (axis === 'xy' ? [p.x ?? p[0], p.y ?? p[1]] : [p.x ?? p[0], p.z ?? p[2]]);

    ctx.fillStyle = '#120c20';
    ctx.fillRect(0, 0, W, H);
    if (img) {
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(18, 12, 32, 0.18)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      for (let x = 0; x < W; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }

    if (showDensity && density?.cells?.length) {
      const off = document.createElement('canvas');
      off.width = density.cols;
      off.height = density.rows;
      const octx = off.getContext('2d');
      const im = octx.createImageData(density.cols, density.rows);
      const max = Math.max(...density.cells);
      const lmax = Math.log1p(max);
      density.cells.forEach((v, i) => {
        if (!v) return;
        const t = Math.log1p(v) / lmax;
        const [r, g, b] = ramp(t);
        im.data[i * 4] = r;
        im.data[i * 4 + 1] = g;
        im.data[i * 4 + 2] = b;
        im.data[i * 4 + 3] = Math.round(70 + 150 * t);
      });
      octx.putImageData(im, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.filter = 'blur(2px)';
      ctx.drawImage(off, 0, 0, W, H);
      ctx.filter = 'none';
    }

    if (path?.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      path.forEach((p, i) => {
        const [x, y] = toPx(...pick(p));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }

    if (showDeaths) {
      const most = deaths.reduce((m, d) => Math.max(m, d.n || 0), 0);
      for (const d of deaths) {
        const [x, y] = toPx(...pick(d));
        ctx.beginPath();
        ctx.arc(x, y, d.n ? 2.5 + 7 * Math.sqrt(d.n / most) : d.rage_quit ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = d.n ? BINNED_DEATH : causeColor(d.cause);
        ctx.globalAlpha = d.n ? 0.7 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (d.rage_quit) {
          ctx.strokeStyle = '#ff4fa3';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    for (const e of events) {
      const [x, y] = toPx(...pick(e));
      ctx.fillStyle = e.color || '#fff';
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 6, y + 4);
      ctx.lineTo(x - 6, y + 4);
      ctx.closePath();
      ctx.fill();
    }

    hotspots.filter((h) => h.share >= 0.1).slice(0, 3).forEach((h, i) => {
      const [x, y] = toPx(h.x, axis === 'xy' ? h.y : h.z);
      const [x0] = toPx(h.x_range?.[0] ?? h.x, 0);
      const [x1] = toPx(h.x_range?.[1] ?? h.x, 0);
      const r = Math.max(14, (x1 - x0) / 2 + 10);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `#${i + 1}  ${Math.round(h.share * 100)}% of deaths · ${h.top_cause}`;
      ctx.font = '600 12px Noto Sans, sans-serif';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(W - tw - 12, Math.max(4, x - tw / 2 - 6));
      const ly = y - r - 26 < 4 ? y + r + 6 : y - r - 26;
      ctx.fillStyle = 'rgba(20, 12, 36, 0.92)';
      ctx.fillRect(lx, ly, tw + 12, 20);
      ctx.fillStyle = '#ffd34d';
      ctx.fillText(label, lx + 6, ly + 14);
    });

    if (cursor) {
      const [x, y] = toPx(...pick(cursor));
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#14213d';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }, [img, width, bounds, axis, density, deaths, hotspots, path, cursor, events, zoom, showDensity, showDeaths, maxHeight]);

  if (!bounds) return <div className="empty">No position data for this level yet.</div>;
  return (
    <div ref={wrap} style={{ width: '100%', overflowX: zoom > 1 ? 'auto' : 'hidden' }}>
      <div className="heatwrap" style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%' }}>
        <canvas ref={canvas} style={{ margin: '0 auto' }} />
      </div>
    </div>
  );
}

// A board's positions panel (server/src/board.js): deaths counted per bin, over the coarse grid of where
// players went when the panel shows paths.
export function PositionsMap({ p, maxHeight = 360 }) {
  const deaths = useMemo(() => (p.deaths || []).map(([a, b, n]) => (p.axis === 'xy' ? { x: a, y: b, n } : { x: a, z: b, n })), [p.deaths, p.axis]);
  const density = useMemo(() => (p.path?.cells.length ? pathGrid(p.path, p.bounds, p.axis) : null), [p.path, p.bounds, p.axis]);
  return <LevelMap bounds={p.bounds} axis={p.axis} deaths={deaths} density={density} maxHeight={maxHeight} />;
}

// A path's cells ([a, b, n], bin wide) as the dense grid LevelMap draws: row 0 at the top of the picture
// (the highest y in a side view, the lowest z top-down).
function pathGrid(path, bounds, axis) {
  const size = path.bin;
  const cols = Math.max(1, Math.round((bounds.max[0] - bounds.min[0]) / size));
  const rows = Math.max(1, Math.round((bounds.max[1] - bounds.min[1]) / size));
  const cells = new Array(cols * rows).fill(0);
  for (const [a, b, n] of path.cells) {
    const c = Math.floor((a - bounds.min[0]) / size);
    const r = Math.floor((axis === 'xy' ? bounds.max[1] - b : b - bounds.min[1]) / size);
    if (c >= 0 && c < cols && r >= 0 && r < rows) cells[r * cols + c] += n;
  }
  return { cols, rows, cells, samples: path.samples };
}

function ramp(t) {
  // deep purple → magenta → amber → white-hot
  const stops = [
    [0, [91, 44, 166]],
    [0.45, [224, 67, 122]],
    [0.8, [255, 196, 64]],
    [1, [255, 250, 220]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return stops.at(-1)[1];
}
