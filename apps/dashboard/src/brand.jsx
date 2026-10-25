// A game's branding in the dashboard (server/src/brand.js): its accent colour, logo and banner, read once per game
// for the dashboard and its share links (useBrand), applied as a few CSS variables on the page (brandStyle) and as a
// header with the banner (BoardHero), and changed in Edit pages → Look (BrandSettings), where an image is checked by
// its content and resized in this browser before it is sent.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from './api.js';
import { Widget } from './components.jsx';
import { PALETTE } from './format.js';

// ───────────────────────────── reading it ─────────────────────────────

const brands = new Map(); // service → { brand, loaded }
const listeners = new Set();
const changed = () => listeners.forEach((f) => f());
const loading = new Set();

async function load(service) {
  if (loading.has(service)) return;
  loading.add(service);
  try {
    const res = await apiFetch(`/v1/brand?service=${encodeURIComponent(service)}`);
    // A server without branding (501), or a reader that can't see it: no brand.
    brands.set(service, { brand: res.ok ? (await res.json()).brand : null, loaded: true });
  } catch {
    brands.set(service, { brand: null, loaded: true });
  }
  loading.delete(service);
  changed();
}

function setBrand(service, brand) {
  brands.set(service, { brand, loaded: true });
  changed();
}

// The game's brand (null without one), loaded once and shared by everything on the page.
export function useBrand(service) {
  const entry = useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => (service ? brands.get(service) : undefined),
  );
  useEffect(() => {
    if (service && !brands.has(service)) load(service);
  }, [service]);
  return entry?.brand ?? null;
}

// An image of the brand as an address the page can show: fetched with the dashboard's headers (a share link's too),
// so it works wherever the dashboard does. Its address names its hash, so the browser keeps it.
const images = new Map(); // url → object URL
export function useBrandImage(image) {
  const url = image?.url ?? null;
  const [src, setSrc] = useState(() => (url ? images.get(url) ?? null : null));
  useEffect(() => {
    if (!url) return setSrc(null);
    if (images.has(url)) return setSrc(images.get(url));
    let live = true;
    apiFetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || !live) return;
        if (!images.has(url)) images.set(url, URL.createObjectURL(blob));
        setSrc(images.get(url));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  return src;
}

// ───────────────────────────── colours ─────────────────────────────

const PANELS = { light: '#ffffff', dark: '#131b2c' };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// The accent darkened on light or lightened on dark until it reads against a panel.
function readable(accent, theme, min) {
  const bg = PANELS[theme];
  const toward = theme === 'dark' ? '#ffffff' : '#000000';
  let c = accent;
  for (let t = 0.05; contrast(c, bg) < min && t <= 1; t += 0.05) c = mix(accent, toward, t);
  return c;
}

// What an accent does to a page in a theme: its marks (3:1 on a panel), its links (4.5:1), and whether the main
// chart series takes it (not when it is close to one of the other series' colours, so a chart's colours stay apart).
export function brandStyle(brand, theme) {
  const accent = brand?.accent;
  if (!accent) return { className: '', style: undefined };
  const mark = readable(accent, theme, 3);
  const others = PALETTE.slice(1).filter((c) => c.startsWith('#'));
  const apart = others.every((c) => Math.hypot(...rgb(c).map((v, i) => v - rgb(mark)[i])) > 70);
  return { className: `branded${apart ? ' branded-series' : ''}`, style: { '--accent': mark, '--accent-ink': readable(accent, theme, 4.5) } };
}

// How an accent reads on each theme's panels, for the warning next to the picker.
export function accentWarnings(accent) {
  if (!accent) return [];
  return Object.entries(PANELS)
    .filter(([, bg]) => contrast(accent, bg) < 3)
    .map(([theme, bg]) => `${contrast(accent, bg).toFixed(1)}:1 on ${theme} panels: it is ${theme === 'dark' ? 'lightened' : 'darkened'} there so it still reads.`);
}

// ───────────────────────────── the header ─────────────────────────────

// A board's header when the game has a banner: its key art across the top, with a scrim under the title so the
// title reads on any picture, light or dark; the logo and the game's name beside it. A short strip on a phone.
export function BoardHero({ brand, game, title }) {
  const banner = useBrandImage(brand?.banner);
  const logo = useBrandImage(brand?.logo);
  if (!brand?.banner) return null;
  return (
    <div className="board-hero">
      {banner && <img className="hero-art" src={banner} alt="" style={{ objectPosition: `center ${brand.banner.focus === 'center' ? '50%' : brand.banner.focus}` }} />}
      <div className="hero-scrim" />
      <div className="hero-title">
        {logo && <img className="hero-logo" src={logo} alt="" />}
        <div>
          {game && <div className="hero-game">{game}</div>}
          <h2>{title}</h2>
        </div>
      </div>
    </div>
  );
}

// The logo, small, where the game's name is written (the top bar, a share link's header).
export function BrandLogo({ brand, className = 'brand-logo' }) {
  const src = useBrandImage(brand?.logo);
  return src ? <img className={className} src={src} alt="" /> : null;
}

// ───────────────────────────── changing it ─────────────────────────────

export const SWATCHES = [
  ['#e4572e', 'Vermilion'],
  ['#d6336c', 'Pink'],
  ['#7c4dff', 'Violet'],
  ['#2f80ed', 'Blue'],
  ['#0f9d76', 'Green'],
  ['#d9480f', 'Orange'],
];
const KINDS = {
  logo: { maxBytes: 100 * 1024, width: 256, height: 256, fit: 'contain', hint: 'Square works best. Resized here to 256 px, up to 100 KB.' },
  banner: { maxBytes: 300 * 1024, width: 1600, height: 400, fit: 'cover', hint: 'Key art, wide. Cropped here to 1600 × 400, up to 300 KB.' },
};

// PNG, JPEG or WebP by the file's first bytes, whatever it is called (the server checks again).
async function imageType(file) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// The image drawn at the kind's size (a logo fitted inside 256 px, never enlarged; a banner cropped to 4:1 around the
// part to keep in view) and encoded as WebP (PNG where the browser can't), smaller until it fits the kind's limit.
export async function prepareImage(file, kind, focus = 'center') {
  const k = KINDS[kind];
  if (!(await imageType(file))) throw new Error('Only PNG, JPEG or WebP images: this file is not one, whatever its name says.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image can't be read. Try saving it again as PNG, JPEG or WebP.");
  }
  for (let scale = 1; scale > 0.2; scale *= 0.8) {
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    let w;
    let h;
    if (k.fit === 'cover') {
      const ratio = k.width / k.height;
      if (sw / sh > ratio) {
        sw = sh * ratio;
        sx = (bitmap.width - sw) / 2;
      } else {
        sh = sw / ratio;
        sy = focus === 'top' ? 0 : focus === 'bottom' ? bitmap.height - sh : (bitmap.height - sh) / 2;
      }
      w = Math.min(k.width, Math.round(sw)) * scale;
      h = w / ratio;
    } else {
      const fit = Math.min(1, k.width / sw, k.height / sh) * scale;
      w = sw * fit;
      h = sh * fit;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await toBlob(canvas, 'image/webp', quality);
      if (blob && blob.size <= k.maxBytes) return blob;
      if (blob?.type !== 'image/webp') break; // a browser that can't encode WebP gave PNG: only a smaller size helps
    }
  }
  throw new Error(`This image doesn't fit in ${k.maxBytes / 1024} KB even at a smaller size.`);
}

async function send(method, path, body, type) {
  const res = await apiFetch(path, { method, ...(body ? { body, headers: { 'content-type': type } } : {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('Only members who manage games (Owner, Admin or Developer) can change the look.');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.brand;
}

// Edit pages → Look: the accent, the logo and the banner of this game's boards and share links.
export function BrandSettings({ service }) {
  const brand = useBrand(service);
  const [accent, setAccent] = useState(null); // a colour being picked, before it is saved
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const logoInput = useRef(null);
  const bannerInput = useRef(null);
  const logo = useBrandImage(brand?.logo);
  const banner = useBrandImage(brand?.banner);
  const shown = accent ?? brand?.accent ?? '';
  const run = async (what, fn) => {
    setBusy(what);
    setNote(null);
    try {
      setBrand(service, await fn());
      setNote({ ok: true, text: 'Saved.' });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
    setBusy(null);
  };
  const saveAccent = (value) =>
    run('accent', async () => {
      const next = await send('PUT', `/v1/brand?service=${encodeURIComponent(service)}`, JSON.stringify({ accent: value || null }), 'application/json');
      setAccent(null);
      return next;
    });
  const upload = (kind) => async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await run(kind, async () => send('PUT', `/v1/brand/${kind}?service=${encodeURIComponent(service)}`, await prepareImage(file, kind, brand?.banner?.focus ?? 'center'), 'image/webp'));
  };
  const remove = (kind) => run(kind, () => send('DELETE', `/v1/brand/${kind}?service=${encodeURIComponent(service)}`));
  const warnings = accentWarnings(/^#[0-9a-f]{6}$/i.test(shown) ? shown : null);
  return (
    <Widget span={12} title="Look" sub={`The logo, banner and accent colour of ${service}'s boards and their share links`} actions={brand && <button className="btn" disabled={!!busy} onClick={() => run('reset', () => send('DELETE', `/v1/brand?service=${encodeURIComponent(service)}`))}>Reset</button>}>
      <div className="look" id="look">
        <div className="look-row">
          <div className="look-label">Accent</div>
          <div className="look-body">
            <div className="swatches" role="group" aria-label="Accent colours">
              {SWATCHES.map(([c, name]) => (
                <button key={c} type="button" className={`swatch-btn${shown === c ? ' on' : ''}`} style={{ background: c }} aria-label={name} aria-pressed={shown === c} title={name} disabled={!!busy} onClick={() => saveAccent(c)} />
              ))}
              <label className="swatch-pick" title="Any colour">
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : '#e4572e'} onChange={(e) => setAccent(e.target.value)} aria-label="Pick any colour" />
              </label>
              <input className="input mono look-hex" value={shown} placeholder="#e4572e" maxLength={7} onChange={(e) => setAccent(e.target.value.trim())} aria-label="Accent colour as #rrggbb" />
              {accent != null && accent !== (brand?.accent ?? '') && (
                <button className="btn primary" disabled={!!busy || (accent && !/^#[0-9a-f]{6}$/i.test(accent))} onClick={() => saveAccent(accent)}>
                  Save colour
                </button>
              )}
              {brand?.accent && (
                <button className="btn" disabled={!!busy} onClick={() => saveAccent(null)}>
                  No accent
                </button>
              )}
            </div>
            {warnings.map((w) => (
              <div key={w} className="warn-t look-hint">
                Low contrast, {w}
              </div>
            ))}
            <div className="muted look-hint">Links, the selected page, stats and the main line of charts take it; charts keep their other colours.</div>
          </div>
        </div>
        {['logo', 'banner'].map((kind) => (
          <div className="look-row" key={kind}>
            <div className="look-label">{kind === 'logo' ? 'Logo' : 'Banner'}</div>
            <div className="look-body">
              <div className="row">
                {kind === 'logo' ? logo && <img className="look-logo" src={logo} alt="The logo" /> : banner && <img className="look-banner" src={banner} alt="The banner" style={{ objectPosition: `center ${brand.banner.focus === 'center' ? '50%' : brand.banner.focus}` }} />}
                <input ref={kind === 'logo' ? logoInput : bannerInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload(kind)} />
                <button className="btn" disabled={!!busy} onClick={() => (kind === 'logo' ? logoInput : bannerInput).current.click()}>
                  {busy === kind ? 'Sending…' : brand?.[kind] ? `Replace ${kind}` : `Upload a ${kind}`}
                </button>
                {brand?.[kind] && (
                  <button className="btn" disabled={!!busy} onClick={() => remove(kind)}>
                    Remove
                  </button>
                )}
                {kind === 'banner' && (
                  <div className="segmented" role="group" aria-label="Part of the banner kept in view">
                    {['top', 'center', 'bottom'].map((v) => (
                      <button key={v} type="button" className={(brand?.banner?.focus ?? 'center') === v ? 'on' : undefined} aria-pressed={(brand?.banner?.focus ?? 'center') === v} disabled={!!busy || !brand?.banner} onClick={() => run('focus', () => send('PUT', `/v1/brand?service=${encodeURIComponent(service)}`, JSON.stringify({ banner_focus: v }), 'application/json'))}>
                        {v === 'center' ? 'Centre' : v[0].toUpperCase() + v.slice(1)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="muted look-hint">PNG, JPEG or WebP. {KINDS[kind].hint}</div>
            </div>
          </div>
        ))}
        {note && <div className={note.ok ? 'ok-t' : 'err'}>{note.text}</div>}
      </div>
    </Widget>
  );
}
