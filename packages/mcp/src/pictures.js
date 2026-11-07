// The pictures an agent gives a game's boards through glitchless_set_dashboard: heatmap backgrounds (`background`, a
// picture of a level, a zone or the whole game with the world bounds its edges stand for, so the paths and deaths on
// a positions panel and the Heatmaps view read as the place they happened in: the server's PUT /v1/maps, SPEC §3b
// Backgrounds) and the brand's logo and banner (`logo`, `banner`: PUT /v1/brand/logo and /v1/brand/banner, §3b
// Branding). The local server reads a picture from a file on this computer; any server takes it as base64.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { write, upload, base, isRemote } from './context.js';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// A picture's bytes and type from { file } (only a local server reads files: the hosted one is told the curl to run
// instead, `url` being where it goes) or { image } (base64 or a data: URL).
async function readPicture({ file, image }, url) {
  if (file) {
    if (isRemote()) throw new Error(`this server can't read files on your computer: pass the picture as image (base64), or upload it yourself with a secret key that has the dashboard scope: curl -X PUT '${url}' -H 'x-glitchless-api-key: <key>' --data-binary @${file}`);
    return { bytes: await fs.readFile(path.resolve(file)), type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  }
  return { bytes: Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64'), type: 'application/octet-stream' };
}

// One place's background for set_dashboard's `background`: save a picture (a file here, or base64) with its world
// bounds, or remove: true to remove the upload. Returns { text, map? }.
export async function saveBackground(svc, { level, zone, file, image, axis, bounds, remove }) {
  if (level && zone) throw new Error('give level or zone, not both (neither: the whole game)');
  const place = level ? { level } : zone ? { zone } : {};
  const name = level ? `level ${level}` : zone ? `zone ${zone}` : 'the whole game';
  const where = new URLSearchParams({ service: svc, ...place });
  if (remove) {
    await write('DELETE', `/v1/maps?${where}`);
    return { text: `Removed the uploaded background of ${name}.` };
  }
  if (!file && !image) throw new Error('give background.file or background.image (the picture), or background.remove: true');
  if (!bounds) throw new Error('give bounds: the world coordinates the picture covers, { "min": [a, b], "max": [a, b] }');
  where.set('axis', axis || 'xz');
  where.set('min', bounds.min.join(','));
  where.set('max', bounds.max.join(','));
  const { bytes, type } = await readPicture({ file, image }, `${base()}/v1/maps?${where}`);
  const { map } = await upload('PUT', `/v1/maps?${where}`, bytes, type);
  // A picture shaped unlike its bounds is stretched to fit them: often bounds that don't match its edges.
  const [w, h] = map.size;
  const shape = w / h / ((bounds.max[0] - bounds.min[0]) / (bounds.max[1] - bounds.min[1]));
  const note = shape > 1.15 || shape < 0.87 ? `The picture is ${w} × ${h} pixels but the bounds are ${round(bounds.max[0] - bounds.min[0])} × ${round(bounds.max[1] - bounds.min[1])} world units: it is stretched to fit them. Check that its edges are the bounds.` : null;
  return { text: `Saved the background of ${name}: ${w} × ${h} pixels, ${map.axis === 'xy' ? 'a side view' : 'seen from above'}. The Heatmaps view and positions panels of ${name} draw on it now.${note ? ` ${note}` : ''}`, map };
}

// The game's backgrounds, captured and uploaded, for glitchless_dashboard; null from a server without them.
export async function listBackgrounds(svc) {
  return (await write('GET', `/v1/maps?service=${encodeURIComponent(svc)}`).catch(() => null))?.maps ?? null;
}

// The schema of set_dashboard's `background`.
export const backgroundSchema = z
  .object({
    level: z.string().optional().describe('The level, as the game passes it to levelStart'),
    zone: z.string().optional().describe('Or the zone, as the game passes it to setZone (leave out level and zone for the whole game)'),
    file: z.string().optional().describe('The picture: a PNG, JPEG or WebP file on this computer. Only the local server (npx glitchless-mcp) reads files; the hosted one takes image'),
    image: z.string().optional().describe("The picture as base64 (or a data: URL), where the server can't read your files"),
    axis: z.enum(['xz', 'xy']).optional().describe('xz: seen from above, x across and z down the picture (default); xy: a side view, x across and y up'),
    bounds: z
      .object({ min: z.tuple([z.number(), z.number()]), max: z.tuple([z.number(), z.number()]) })
      .optional()
      .describe('The world coordinates the picture covers on the axis\'s two coordinates: { "min": [x, z], "max": [x, z] } for xz, e.g. { "min": [-120, -80], "max": [120, 80] }'),
    remove: z.boolean().optional().describe("Remove this place's uploaded background (an SDK's capture, if any, shows again)"),
  })
  .describe("A place's heatmap background, so the Heatmaps view and positions panels (where players went and died) read as the room they happened in: a top-down picture of a hub, a lobby or a level and the world bounds its edges stand for, with no SDK code. The place is a level, a zone the game sets with setZone, or neither: the whole game, for a game whose players move about with no level set (a hub); a zone with no picture of its own uses the whole game's. With axis xz (seen from above, the default) the picture's left edge is bounds.min[0] (x) and its right edge bounds.max[0], its top edge bounds.min[1] (z) and its bottom edge bounds.max[1]; with xy (a side view) its top is bounds.max[1] (y). Get the bounds from the game's own level data (the floor's corners), not by guessing. An upload is drawn over whatever an SDK captured for that place; remove: true goes back to the capture. PNG, JPEG or WebP, at most 256 KB and 4096 pixels a side: a JPEG about 1024 pixels across fits. Send it alone to change only the background, one place a call; glitchless_dashboard lists the game's backgrounds");

function round(v) {
  return Math.round(v * 100) / 100;
}

// The brand's logo or banner (kind) for set_dashboard: an image ({ file } or { image }), remove: true, and for the
// banner a focus (top, center or bottom: what stays in view when it is cropped to a strip). Returns a line to show.
export async function saveBrandImage(svc, kind, { file, image, remove, focus }) {
  const q = `service=${encodeURIComponent(svc)}`;
  const said = [];
  if (remove) {
    await write('DELETE', `/v1/brand/${kind}?${q}`);
    said.push(`Removed the ${kind}.`);
  } else if (file || image) {
    const { bytes, type } = await readPicture({ file, image }, `${base()}/v1/brand/${kind}?${q}`);
    const { brand } = await upload('PUT', `/v1/brand/${kind}?${q}`, bytes, type);
    const b = brand?.[kind];
    said.push(`Saved the ${kind}${b ? `: ${b.width} × ${b.height} pixels` : ''}.`);
  }
  if (focus) {
    await write('PUT', `/v1/brand?${q}`, { banner_focus: focus });
    said.push(`The banner keeps its ${focus} in view.`);
  }
  if (!said.length) throw new Error(`give ${kind}.file or ${kind}.image (the picture), ${kind}.remove: true${kind === 'banner' ? ', or banner.focus' : ''}`);
  return said.join(' ');
}

// The schema of set_dashboard's `logo` and `banner`.
const picture = {
  file: z.string().optional().describe('A PNG, JPEG or WebP file on this computer. Only the local server (npx glitchless-mcp) reads files; the hosted one takes image'),
  image: z.string().optional().describe("The picture as base64 (or a data: URL), where the server can't read your files"),
  remove: z.boolean().optional().describe('Remove it'),
};
export const logoSchema = z
  .object(picture)
  .describe("The game's logo, shown by its name on its boards and share links: PNG, JPEG or WebP (never SVG), at most 100 KB and 1024 × 1024 pixels; the dashboard fits it inside 256 px. Use the game's own logo or icon from its files; ask before making one up");
export const bannerSchema = z
  .object({ ...picture, focus: z.enum(['top', 'center', 'bottom']).optional().describe('What stays in view when the banner is cropped to a strip (default center); can be sent alone') })
  .describe("The game's banner (its key art), the header behind each board's title, with a dark scrim so the title reads on any picture: PNG, JPEG or WebP, at most 300 KB and 4096 × 2048 pixels; the dashboard crops it to 1600 × 400 around its focus (a short strip on a phone), so a wide picture works best. Use the game's own key art or a capture of it from its files; ask before making one up");
