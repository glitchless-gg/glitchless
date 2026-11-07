// The pictures an agent gives a game's boards through glitchless_set_dashboard: heatmap backgrounds (`background`, a
// picture of a level, a zone or the whole game with the world bounds its edges stand for, so the paths and deaths on
// a positions panel and the Heatmaps view read as the place they happened in: the server's PUT /v1/maps, SPEC §3b
// Backgrounds) and the brand's logo and banner (`logo`, `banner`: PUT /v1/brand/logo and /v1/brand/banner, §3b
// Branding). The local server reads a picture from a file on this computer; the hosted one, which can't, answers a
// file with an upload link (POST /v1/uploads, §3b Upload links) the agent sends it to with one curl, as either does
// with upload: true; any server takes a picture as base64.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { write, upload, base, isRemote } from './context.js';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// A picture for one slot (logo, banner, or a background with its place, axis and bounds as `params`): its bytes and
// type from { file } (only a local server reads files) or { image } (base64 or a data: URL), or { link }, the line
// to show, when it goes by an upload link: asked for (upload: true), or a file the hosted server can't read. `what`
// names it in that line; `route` is the slot's own address, for a server too old to make links.
async function readPicture(svc, slot, params, { file, image, upload: asked }, what, route) {
  if (asked && image) throw new Error('give image (the picture as base64) or upload: true (a link to send it to), not both');
  if (asked || (file && isRemote())) {
    const link = await uploadLink(svc, slot, params, file, what);
    if (link) return { link };
    if (isRemote() || !file) throw new Error(`this server makes no upload links${isRemote() ? " and can't read files on your computer" : ''}: pass the picture as image (base64), or upload it yourself with a secret key that has the dashboard scope: curl -X PUT '${route}' -H 'x-glitchless-api-key: <key>' --data-binary @${file ? shellArg(file) : '<file>'}`);
  }
  if (file) return { bytes: await fs.readFile(path.resolve(file)), type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  return { bytes: Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64'), type: 'application/octet-stream' };
}

// A short-lived, single-use link for one picture (POST /v1/uploads), as the line that tells the agent to run its curl;
// null from a server without upload links. The link is shown here once: the server keeps only its hash.
async function uploadLink(svc, slot, params, file, what) {
  let made;
  try {
    made = (await write('POST', `/v1/uploads?${new URLSearchParams({ service: svc, slot, ...params })}`)).upload;
  } catch (err) {
    if (/→ HTTP (404|405|501)\b/.test(err.message)) return null;
    throw err;
  }
  const url = `${base()}${made.path}`;
  const minutes = Math.max(1, Math.round(made.expires_in_s / 60));
  const command = `curl -X PUT --data-binary @${file ? shellArg(file) : '<file>'} '${url}'`;
  return `To send ${what}, run this within ${minutes} minutes: \`${command}\`. The link takes one picture (PNG, JPEG or WebP, at most ${Math.round(made.max_bytes / 1024)} KB and ${made.max_width} × ${made.max_height} pixels) and then stops working; it needs no key. curl's answer says what was saved, or what to fix: a picture refused for its size or type can be fixed and sent to the same link until it expires.`;
}

// A path as one shell word.
function shellArg(f) {
  return /^[\w@%+=:,./-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`;
}

// One place's background for set_dashboard's `background`: save a picture (a file here, or base64) with its world
// bounds, or make a link to send it to (upload: true, or a file over HTTP), or remove: true to remove the upload.
// Returns { text, map? }, and link: true when the picture is still to be sent.
export async function saveBackground(svc, { level, zone, file, image, upload: asked, axis, bounds, remove }) {
  if (level && zone) throw new Error('give level or zone, not both (neither: the whole game)');
  const place = level ? { level } : zone ? { zone } : {};
  const name = level ? `level ${level}` : zone ? `zone ${zone}` : 'the whole game';
  const where = new URLSearchParams({ service: svc, ...place });
  if (remove) {
    await write('DELETE', `/v1/maps?${where}`);
    return { text: `Removed the uploaded background of ${name}.` };
  }
  if (!file && !image && !asked) throw new Error('give background.file or background.image (the picture), background.upload: true (a link to send it to), or background.remove: true');
  if (!bounds) throw new Error('give bounds: the world coordinates the picture covers, { "min": [a, b], "max": [a, b] }');
  where.set('axis', axis || 'xz');
  where.set('min', bounds.min.join(','));
  where.set('max', bounds.max.join(','));
  const { bytes, type, link } = await readPicture(svc, 'background', Object.fromEntries([...where].filter(([k]) => k !== 'service')), { file, image, upload: asked }, `the background of ${name}`, `${base()}/v1/maps?${where}`);
  if (link) return { text: link, link: true };
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
    file: z.string().optional().describe('The picture: a PNG, JPEG or WebP file on this computer. The local server (npx glitchless-mcp) reads it; the hosted one answers with an upload link to send it to with one curl'),
    image: z.string().optional().describe('Or the picture as base64 (or a data: URL); a big one is long in a call, so prefer file'),
    upload: z.boolean().optional().describe('Answer with an upload link instead of saving now: send the picture to it with one curl (curl -X PUT --data-binary @file \'<link>\') within 10 minutes; it takes one picture and needs no key. The hosted server does this for file by itself'),
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

// The brand's logo or banner (kind) for set_dashboard: an image ({ file } or { image }, or upload: true for a link to
// send it to), remove: true, and for the banner a focus (top, center or bottom: what stays in view when it is cropped
// to a strip). Returns { text, saved }: the line to show, and whether anything changed now (a link changes nothing
// until the picture comes).
export async function saveBrandImage(svc, kind, { file, image, upload: asked, remove, focus }) {
  const q = `service=${encodeURIComponent(svc)}`;
  const said = [];
  let saved = false;
  if (remove) {
    await write('DELETE', `/v1/brand/${kind}?${q}`);
    said.push(`Removed the ${kind}.`);
    saved = true;
  } else if (file || image || asked) {
    const { bytes, type, link } = await readPicture(svc, kind, {}, { file, image, upload: asked }, `the ${kind}`, `${base()}/v1/brand/${kind}?${q}`);
    if (link) said.push(link);
    else {
      const { brand } = await upload('PUT', `/v1/brand/${kind}?${q}`, bytes, type);
      const b = brand?.[kind];
      said.push(`Saved the ${kind}${b ? `: ${b.width} × ${b.height} pixels` : ''}.`);
      saved = true;
    }
  }
  if (focus) {
    await write('PUT', `/v1/brand?${q}`, { banner_focus: focus });
    said.push(`The banner keeps its ${focus} in view.`);
    saved = true;
  }
  if (!said.length) throw new Error(`give ${kind}.file or ${kind}.image (the picture), ${kind}.upload: true (a link to send it to), ${kind}.remove: true${kind === 'banner' ? ', or banner.focus' : ''}`);
  return { text: said.join(' '), saved };
}

// The schema of set_dashboard's `logo` and `banner`.
const picture = {
  file: z.string().optional().describe('A PNG, JPEG or WebP file on this computer. The local server (npx glitchless-mcp) reads it; the hosted one answers with an upload link to send it to with one curl'),
  image: z.string().optional().describe('Or the picture as base64 (or a data: URL); a banner is long in a call, so prefer file'),
  upload: z.boolean().optional().describe("Answer with an upload link instead of saving now: send the picture to it with one curl (curl -X PUT --data-binary @file '<link>') within 10 minutes; it takes one picture and needs no key. The hosted server does this for file by itself"),
  remove: z.boolean().optional().describe('Remove it'),
};
export const logoSchema = z
  .object(picture)
  .describe("The game's logo, shown by its name on its boards and share links: PNG, JPEG or WebP (never SVG), at most 100 KB and 1024 × 1024 pixels; the dashboard fits it inside 256 px. Use the game's own logo or icon from its files; ask before making one up");
export const bannerSchema = z
  .object({ ...picture, focus: z.enum(['top', 'center', 'bottom']).optional().describe('What stays in view when the banner is cropped to a strip (default center); can be sent alone') })
  .describe("The game's banner (its key art), the header behind each board's title, with a dark scrim so the title reads on any picture: PNG, JPEG or WebP, at most 300 KB and 4096 × 2048 pixels; the dashboard crops it to 1600 × 400 around its focus (a short strip on a phone), so a wide picture works best. Use the game's own key art or a capture of it from its files; ask before making one up");
