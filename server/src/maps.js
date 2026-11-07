// Heatmap backgrounds uploaded without SDK code (SPEC §3b Backgrounds): a top-down (or side) picture of a level, a
// zone or the whole game, and the world bounds its edges stand for, so the paths and deaths on a positions panel or
// the Heatmaps view read as the room they happened in. `PUT /v1/maps` takes the picture as the body (app.js) and
// keeps it as a `map` event marked `uploaded`, next to the maps the SDKs capture (store.putMap; places.js says which
// place a map belongs to and which one a place draws). The picture is checked by its content (brand.js sniffImage),
// never its name or declared type: PNG, JPEG or WebP only, never SVG or HTML, within MAP_UPLOAD's bytes and pixels.

import { sniffImage } from './brand.js';
import { placeOf, placeFields, mapId } from './places.js';

// 256 KB of picture is about 342 KB as the data URL a map keeps, inside a 400 KB DynamoDB item.
export const MAP_UPLOAD = { maxBytes: 256 * 1024, maxWidth: 4096, maxHeight: 4096 };
export const AXES = ['xz', 'xy'];

export class MapError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The place a request names (level= or zone=, neither for the whole game); both is a mistake worth saying.
export function placeParam(params) {
  const level = params.get('level');
  const zone = params.get('zone');
  if (level && zone) throw new MapError(400, 'give level or zone, not both (neither: the whole game)');
  if ((level && level.length > 128) || (zone && zone.length > 64)) throw new MapError(400, 'a level is at most 128 characters and a zone 64');
  return placeOf({ level, zone });
}

// "a,b" → [a, b], two finite numbers.
function pair(v, name) {
  const parts = String(v ?? '').split(',').map((s) => s.trim());
  const nums = parts.map(Number);
  if (parts.length !== 2 || parts.some((s) => s === '') || !nums.every(Number.isFinite)) throw new MapError(400, `${name} is the ${name === 'min' ? 'smallest' : 'largest'} world coordinates the picture covers on the axis's two coordinates, "a,b" (x and z for xz, such as ${name === 'min' ? '-120,-80' : '120,80'})`);
  return nums;
}

// A map event from an upload: the place, its axis and bounds from the query, the picture as a data URL.
export function mapUpload(service, params, bytes, now = Date.now()) {
  const place = placeParam(params);
  const axis = params.get('axis') || 'xz';
  if (!AXES.includes(axis)) throw new MapError(400, 'axis is xz (seen from above: x across, z down the picture) or xy (a side view: x across, y up)');
  const bounds = { min: pair(params.get('min'), 'min'), max: pair(params.get('max'), 'max') };
  if (!(bounds.max[0] > bounds.min[0] && bounds.max[1] > bounds.min[1])) throw new MapError(400, 'max must be above min on both coordinates: min is the smallest a and b the picture covers, max the largest');
  if (!bytes?.length) throw new MapError(400, 'send the picture itself as the body: a PNG, JPEG or WebP image');
  if (bytes.length > MAP_UPLOAD.maxBytes) throw new MapError(413, `a background is at most ${MAP_UPLOAD.maxBytes / 1024} KB: save it as a JPEG about 1024 pixels across`);
  const img = sniffImage(bytes);
  if (!img) throw new MapError(415, 'a background is a PNG, JPEG or WebP image, checked by its content (never SVG or HTML)');
  if (!img.width || !img.height || img.width > MAP_UPLOAD.maxWidth || img.height > MAP_UPLOAD.maxHeight) throw new MapError(400, `a background is at most ${MAP_UPLOAD.maxWidth} × ${MAP_UPLOAD.maxHeight} pixels`);
  return {
    type: 'map',
    service,
    ...placeFields(place),
    axis,
    bounds,
    size: [img.width, img.height],
    image: `data:${img.type};base64,${bytes.toString('base64')}`,
    uploaded: true,
    version: null,
    env: null,
    ts: now,
  };
}

// A map as GET /v1/maps lists it: its place, plane, bounds and size, never the picture (the url fetches it).
export function mapBody(service, m) {
  const id = mapId(m);
  return { ...placeFields(placeOf(m)), axis: m.axis ?? null, bounds: m.bounds ?? null, size: m.size ?? null, uploaded: !!m.uploaded, version: m.version ?? null, ts: m.ts ?? null, id, url: `/v1/maps/image?service=${encodeURIComponent(service)}&id=${id}` };
}

// A map's picture as bytes and their type, from its data URL; null for one that isn't a picture the browser can show.
export function mapImage(m) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(m?.image || ''));
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  // A captured map's picture came from the game: serve only what it says it is.
  return sniffImage(bytes)?.type === match[1] ? { type: match[1], bytes } : null;
}
