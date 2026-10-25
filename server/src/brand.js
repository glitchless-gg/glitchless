// A game's branding on its boards and share links (SPEC §3b): an accent colour, a logo and a header banner (its key
// art), so a dev log or a Discord share looks like the game's own page. Kept apart from the dashboard spec, so the
// spec stays small: a store keeps what the brand is (the colour, the banner's position, and each image's type, size
// and hash) in one item, and each image's bytes in an item of its own (getBrand, putBrand, getBrandImage,
// putBrandImage: SPEC §7). The dashboard resizes an image before it sends it; this checks what arrives by its content,
// never its name or declared type: PNG, JPEG or WebP only (never SVG or HTML, which could carry script), within each
// kind's bytes and pixels.
import crypto from 'node:crypto';

export const BRAND_IMAGES = {
  logo: { maxBytes: 100 * 1024, maxWidth: 1024, maxHeight: 1024 },
  banner: { maxBytes: 300 * 1024, maxWidth: 4096, maxHeight: 2048 },
};
// Which part of the banner stays in view when it is cropped to a short strip (a phone).
export const BANNER_FOCUS = ['top', 'center', 'bottom'];

export class BrandError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The image's type and size from its first bytes, or null when it isn't a PNG, JPEG or WebP.
export function sniffImage(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webpSize(b);
  return null;
}

// A JPEG's size is in its frame header: walk the markers to the first SOFn (not DHT, JPG or DAC, which share the range).
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(b) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { type: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

// An uploaded image as the brand names it ({ type, width, height, bytes, hash }), or a BrandError saying what to fix.
export function checkImage(kind, bytes) {
  const limit = BRAND_IMAGES[kind];
  if (!limit) throw new BrandError(404, `no such image: ${kind} (logo or banner)`);
  if (!bytes?.length) throw new BrandError(400, `send the ${kind} itself as the body: a PNG, JPEG or WebP image`);
  if (bytes.length > limit.maxBytes) throw new BrandError(413, `a ${kind} is at most ${limit.maxBytes / 1024} KB (the dashboard resizes it before sending)`);
  const img = sniffImage(bytes);
  if (!img) throw new BrandError(415, `a ${kind} is a PNG, JPEG or WebP image, checked by its content (never SVG or HTML)`);
  if (!img.width || !img.height || img.width > limit.maxWidth || img.height > limit.maxHeight) throw new BrandError(400, `a ${kind} is at most ${limit.maxWidth} × ${limit.maxHeight} pixels`);
  return { type: img.type, width: img.width, height: img.height, bytes: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
}

// "#rrggbb" in lower case, or null for none.
export function checkAccent(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) throw new BrandError(400, 'accent is a colour written "#rrggbb", such as "#e4572e" (or null for none)');
  return v.trim().toLowerCase();
}

export function checkFocus(v) {
  if (v == null) return 'center';
  if (!BANNER_FOCUS.includes(v)) throw new BrandError(400, `banner_focus is ${BANNER_FOCUS.join(', ')}`);
  return v;
}

// The brand as the API answers it: the accent, and each image's address with its hash in it (a new image gets a new
// address, so a browser can keep an old one for good). Null when the game has none.
export function brandBody(service, brand) {
  if (!brand) return null;
  const image = (kind) => {
    const m = brand[kind];
    return m ? { url: `/v1/brand/${kind}?service=${encodeURIComponent(service)}&v=${m.hash}`, type: m.type, width: m.width, height: m.height, bytes: m.bytes, hash: m.hash } : null;
  };
  const banner = image('banner');
  return { accent: brand.accent ?? null, logo: image('logo'), banner: banner && { ...banner, focus: brand.banner_focus ?? 'center' }, updated_at: brand.updated_at ?? null, updated_by: brand.updated_by ?? null };
}

export const hasBrand = (b) => !!(b && (b.accent || b.logo || b.banner));
