// Publishing a game's build to a jam room, for the tool (tool.js) and the CLI (cli.js) alike. Nothing is built here:
// the maker's agent builds the game as it always does (npm run build → dist/) and this sends that folder of static
// files.
//
// readBuild() checks the folder on this computer before anything is sent, so the agent gets a fix it can act on:
// index.html at its root, relative paths, file types the room serves, the size limits, no password fields; and it
// reads the service and version the build passes to Glitchless.init. publishBuild() then joins the room (joining again
// answers the same game), starts an upload with the list of files, sends each file, sends source maps to
// /v1/sourcemaps instead of the room, and publishes. The server checks every limit again on its own.
//
// linkGame() is for a game played on its itch.io page (an online jam): nothing is uploaded. It joins the room and
// registers the version, read from the web export's folder when there is one, so the room counts that version's plays
// and its arcade sends players to the page.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { JamError, request, gameFor, gameIn, remember } from './context.js';

// The room's limits and the types it serves, as server/src/rooms.js has them (LIMITS, FILE_TYPES). The server checks
// them again; these are here so nothing is refused half way through an upload.
export const LIMITS = { files: 400, fileBytes: 4_000_000, uploadBytes: 25_000_000, pathLength: 200 };
export const FILE_TYPES = ['html', 'htm', 'js', 'mjs', 'css', 'json', 'txt', 'csv', 'xml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'glb', 'gltf', 'bin', 'ktx2', 'hdr', 'wasm', 'pck', 'data', 'mp3', 'ogg', 'wav', 'm4a', 'opus', 'webm', 'mp4', 'woff', 'woff2', 'ttf', 'otf', 'tmj', 'tsj', 'tmx', 'tsx', 'atlas', 'fnt'];
const TYPES = new Set(FILE_TYPES);
const CONCURRENCY = 4;

const mb = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} kB` : `${Math.round((n / 1e6) * 10) / 10} MB`);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

// Every file under `root`, without dotfiles and node_modules: [{ path, abs, bytes }], `path` relative with /.
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      const stat = fs.statSync(abs, { throwIfNoEntry: false });
      if (stat?.isDirectory()) visit(abs);
      else if (stat?.isFile()) out.push({ path: posix(path.relative(root, abs)), abs, bytes: stat.size });
    }
  };
  visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// A path the room takes: segments of letters, digits, . _ and -, up to 200 characters, a type it serves.
function pathProblem(p) {
  if (p.length > LIMITS.pathLength) return `"${p}": paths are at most ${LIMITS.pathLength} characters`;
  if (p.split('/').some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) return `"${p}": rename it with letters, digits, . _ and - only (no spaces)`;
  const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : '';
  if (!TYPES.has(ext)) return `"${p}": ${ext ? `.${ext} files aren't` : "files without an extension aren't"} served in a jam room: leave it out of the build (allowed: ${FILE_TYPES.join(', ')})`;
  return null;
}

// What an HTML file must not have: a password field (games never need one; phishing pages always do), a <base> of
// its own (the room sets where the game's files are), and files loaded from the root of the host ("/assets/…"),
// which break once the game is served from its room's folder.
function htmlProblems(p, text) {
  const out = [];
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(text)) out.push(`${p} has a password field: a game never needs one, and the room refuses pages with one`);
  if (/<base\b/i.test(text)) out.push(`${p} has a <base> tag: remove it, the room sets where the game's files are`);
  const absolute = [...text.matchAll(/\b(?:src|href)\s*=\s*["']?(\/(?!\/)[^"'\s>]*)/gi)].map((m) => m[1]);
  if (absolute.length) {
    const source = absolute.some((a) => a.startsWith('/src/'));
    out.push(
      source
        ? `${p} loads ${absolute[0]}: this is the game's source folder, not its build. Build it (npm run build) and publish the folder the build makes (often dist)`
        : `${p} loads files from the root of the host (${absolute.slice(0, 3).join(', ')}): rebuild with relative paths, \`vite build --base ./\` (or base: './' in vite.config), then publish again`,
    );
  }
  return out;
}

function cssProblems(p, text) {
  const absolute = [...text.matchAll(/url\(\s*["']?(\/(?!\/)[^"')\s]*)/gi)].map((m) => m[1]);
  return absolute.length ? [`${p} loads ${absolute[0]} from the root of the host: rebuild with relative paths, \`vite build --base ./\`, then publish again`] : [];
}

// The object literal a call opens at text[start] ("{"), up to its closing brace: strings, template literals and
// comments are skipped, so a brace or quote in them doesn't end it early. → its text, or null.
function objectAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length && i < start + 20_000; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    else if (ch === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 1;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// A key's value in an object literal's text: a string, or a constant the same file sets to one string
// (version: GAME_VERSION, or a minified Ke where Ke="1.2.0"). → the string, or null.
function valueOf(object, key, file) {
  const lit = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\\\n]){1,128})\\1`).exec(object);
  if (lit && !(lit[1] === '`' && lit[2].includes('${'))) return lit[2];
  const ref = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}]`).exec(object);
  if (!ref) return null;
  const id = ref[1].replace(/\$/g, '\\$');
  const values = new Set([...file.matchAll(new RegExp(`(?:^|[^\\w$.])${id}\\s*=\\s*(["'])([^"'\\\\\\n]{1,128})\\1`, 'g'))].map((m) => m[2]));
  return values.size === 1 ? [...values][0] : null;
}

// The service and version a build's JS passes to Glitchless.init (minified bundles keep them as strings, in either
// order and either quote): the first init({ … }) with a service. → { service, version } (either may be null).
export function findInit(text) {
  for (const m of text.matchAll(/\.init\(\s*\{/g)) {
    const object = objectAt(text, m.index + m[0].length - 1);
    if (!object) continue;
    const service = valueOf(object, 'service', text);
    if (service) return { service, version: valueOf(object, 'version', text) };
  }
  return { service: null, version: null };
}

// The build in `dir`, checked: { root, files, maps, service, version, title } where files are what the room gets and
// maps the source maps (each with the script it belongs to). Throws every problem at once, each with its fix.
export function readBuild(dir) {
  const root = path.resolve(dir);
  const stat = fs.statSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new JamError(`There's no folder at ${root}: build the game first (npm run build) and give the folder the build makes (often dist).`);
  const all = walk(root);
  const maps = all.filter((f) => f.path.endsWith('.map'));
  const files = all.filter((f) => !f.path.endsWith('.map'));
  const problems = [];
  if (!files.some((f) => f.path === 'index.html')) {
    const inner = ['dist', 'build', 'out', 'public'].find((d) => fs.existsSync(path.join(root, d, 'index.html')));
    problems.push(inner ? `index.html isn't at the root of ${root}, but ${inner}/index.html is: publish ${path.join(root, inner)} instead` : `index.html isn't at the root of ${root}: publish the folder the build makes, with the game's index.html at its root`);
  }
  let total = 0;
  let found = { service: null, version: null };
  let title = null;
  for (const f of files) {
    total += f.bytes;
    const bad = pathProblem(f.path);
    if (bad) problems.push(bad);
    if (f.bytes > LIMITS.fileBytes) problems.push(`"${f.path}" is ${mb(f.bytes)}: a file is at most ${mb(LIMITS.fileBytes)} (compress it, or split it)`);
    const ext = f.path.split('.').pop().toLowerCase();
    if (!['html', 'htm', 'css', 'js', 'mjs'].includes(ext) || f.bytes > LIMITS.uploadBytes) continue;
    const text = fs.readFileSync(f.abs, 'utf8');
    if (ext === 'html' || ext === 'htm') {
      problems.push(...htmlProblems(f.path, text));
      if (f.path === 'index.html') title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1].trim().slice(0, 60) || null;
    } else if (ext === 'css') problems.push(...cssProblems(f.path, text));
    else if (!found.service) found = findInit(text);
  }
  if (files.length > LIMITS.files) problems.push(`the build has ${files.length} files: a jam room takes at most ${LIMITS.files} (source maps aside)`);
  if (total > LIMITS.uploadBytes) problems.push(`the build is ${mb(total)}: a jam room takes at most ${mb(LIMITS.uploadBytes)}`);
  if (problems.length) throw new JamError(`This build can't be published yet:\n- ${problems.join('\n- ')}`);
  return { root, files, maps: mapsWithScripts(root, maps, files), total, title, ...found };
}

// Each source map with the path of the script it belongs to: the map's name without .map, else the script its "file"
// names. CSS maps and maps with no script are left out.
function mapsWithScripts(root, maps, files) {
  const have = new Set(files.map((f) => f.path));
  const out = [];
  for (const m of maps) {
    if (m.path.endsWith('.css.map')) continue;
    let script = m.path.slice(0, -'.map'.length);
    if (!have.has(script)) {
      let named = null;
      try {
        named = JSON.parse(fs.readFileSync(m.abs, 'utf8')).file;
      } catch {}
      script = typeof named === 'string' ? posix(path.relative(root, path.resolve(path.dirname(m.abs), named))) : null;
    }
    if (script && have.has(script) && /\.(m|c)?js$/.test(script)) out.push({ ...m, file: script });
  }
  return out;
}

// Runs fn over items, `n` at a time.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
  }));
}

// The game's page on itch.io, as the room takes it (checkLink in server/src/rooms.js, which checks it again): https,
// <name>.itch.io/<game>, nothing after it. → the page in that form, or throws what to give instead, before anything
// is sent.
export function itchPage(url) {
  const want = "give the game's page on itch.io, https://<name>.itch.io/<game>";
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new JamError(`"${url}" isn't an address: ${want}.`);
  }
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.itch.zone')) throw new JamError(`${url} is the address of the frame itch.io plays the game in, which changes with every upload: ${want}.`);
  if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.itch\.io$/.test(host)) throw new JamError(`A room links games on itch.io only: ${want}.`);
  const page = u.pathname.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(page)) throw new JamError(`${url} isn't a game's page: ${want}.`);
  if (u.search) throw new JamError(`Give the page's address with nothing after it: a draft's secret link stops working once the page is public. Make the page public on itch.io, then link https://${host}${page}.`);
  return `https://${host}${page}`;
}

// What a web export says about itself without the room's limits (itch.io takes bigger builds): the service and version
// its JS passes to Glitchless.init, and its page's title. Godot's and Unity's exports keep theirs inside the build, so
// those come back null. → { service, version, title }
export function readInit(dir) {
  const root = path.resolve(dir);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new JamError(`There's no folder at ${root}: give the folder the web export made (the one you zipped for itch.io).`);
  let found = { service: null, version: null };
  let title = null;
  for (const f of walk(root)) {
    const ext = f.path.split('.').pop().toLowerCase();
    if (f.bytes > LIMITS.uploadBytes || !['html', 'js', 'mjs'].includes(ext)) continue;
    if (f.path === 'index.html') title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(fs.readFileSync(f.abs, 'utf8'))?.[1].trim().slice(0, 60) || null;
    else if (ext !== 'html' && !found.service) found = findInit(fs.readFileSync(f.abs, 'utf8'));
  }
  return { ...found, title };
}

const roomPath = (room, slug = null) => `/v1/rooms/${room}/games${slug ? `/${encodeURIComponent(slug)}` : ''}`;

// Joins `room` with the game (joining again answers the same game). opts: { game, title, by, service }. → the entry
// ({ slug, title, url, uploads, links, … }), with `project` (the workspace game's id, or null).
export async function joinRoom(c, room, { game = null, title = null, by, service = null } = {}) {
  const ws = await gameFor(c, game || gameIn(c, room)?.project);
  const body = { service: service || ws?.service || undefined, ...(title ? { title } : !service && !ws?.service && ws ? { title: ws.name } : {}), ...(by !== undefined ? { by } : {}) };
  const entry = await request(c, 'POST', roomPath(room), { body, project: ws?.id });
  const svc = body.service ?? entry.service ?? null;
  remember(c, { room, slug: entry.slug, project: ws?.id ?? null, service: svc });
  return { ...entry, project: ws?.id ?? null, service: svc };
}

// Links a version of the game played on its itch.io page to `room`, joining it first if need be. opts: { url (the page;
// default: the one linked before), version, dir (the web export's folder, to read the version and service from),
// service, game, title, by }. → { url, site, version, n, qr_text, qr_svg, arcade, room, slug, title, service, warnings }.
export async function linkGame(c, room, { url = null, version = null, dir = null, service = null, game = null, title = null, by } = {}) {
  const page = url ? itchPage(url) : null;
  const build = dir ? readInit(dir) : { service: null, version: null, title: null };
  const warnings = [];
  version ||= build.version;
  if (!version) throw new JamError(`Give version: the one the game passes to Glitchless.init${dir ? ` (it isn't in ${dir}'s scripts, as in a Godot or Unity export)` : ', or dir, the web export\'s folder, to read it from'}. Each link needs a new one, so the room tells the versions' players apart.`);
  const mine = gameIn(c, room);
  game ||= mine?.project;
  const ws = await gameFor(c, game);
  const svc = service || build.service || ws?.service || mine?.service || null;
  const entry = await joinRoom(c, room, { game, title, by, service: svc });
  if (!page && entry.site == null) throw new JamError(`Give url: the game's page on itch.io (https://<name>.itch.io/<game>), where its build is uploaded as HTML5.`);
  if (entry.uploads?.length && entry.site == null) throw new JamError(`"${entry.title}" publishes its builds to room ${room}, so it plays from there: publish each new version instead.`, 409);
  if (entry.uploads?.some((u) => u.version === version)) throw new JamError(`${version} is already linked in room ${room}: bump the version passed to Glitchless.init, upload that build to itch.io, then link it. Otherwise both builds' players count as one version.`, 409);
  if (!svc && !entry.service) warnings.push(`No service is known for this game, so its plays won't count in the room: link again with service, the name the game passes to Glitchless.init.`);
  // A first join without a title takes the service as its title; the export's page title or the game's name reads better.
  const nicer = build.title || ws?.name;
  if (!title && !entry.uploads?.length && nicer && entry.title === svc && nicer !== svc) {
    Object.assign(entry, await request(c, 'PATCH', roomPath(room, entry.slug), { body: { title: nicer }, project: entry.project }));
  }
  const done = await request(c, 'POST', `${roomPath(room, entry.slug)}/links`, { body: { version, ...(page ? { url: page } : {}), ...(svc ? { service: svc } : {}) }, project: entry.project });
  remember(c, { room, slug: entry.slug, project: entry.project, service: svc ?? entry.service ?? null });
  return { ...done, room, slug: entry.slug, title: entry.title, service: svc ?? entry.service ?? null, warnings };
}

// Publishes the build in `dir` to `room`. opts: { version, service, game, title, by, log }. → { url, version, n,
// qr_text, qr_svg, arcade, room, slug, title, files, bytes, sourcemaps: { sent, failed }, warnings }.
export async function publishBuild(c, room, dir, { version = null, service = null, game = null, title = null, by, log = () => {} } = {}) {
  const build = readBuild(dir);
  const warnings = [];
  version ||= build.version;
  if (!version) throw new JamError(`No version found in the build: pass version (the one the game passes to Glitchless.init${build.service ? `, next to service: "${build.service}"` : ''}). Each publish needs a new one, so the room tells the versions' players apart.`);
  game ||= gameIn(c, room)?.project;
  const ws = await gameFor(c, game);
  let svc = service || build.service || ws?.service || null;
  if (!svc) {
    // A build that never names a service still publishes; the room knows it by a name made from its title.
    svc = String(title || build.title || ws?.name || path.basename(build.root)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'game';
    warnings.push(`The build never names a service in Glitchless.init, so its plays won't count in the room. Add Glitchless with service: "${svc}" (and the version) and publish again.`);
  }

  const entry = await joinRoom(c, room, { game, title, by, service: svc });
  // A first join without a title takes the service as its title; the page's own <title> reads better.
  const nicer = build.title || ws?.name;
  if (!title && !entry.uploads?.length && nicer && entry.title === svc && nicer !== svc) {
    Object.assign(entry, await request(c, 'PATCH', roomPath(room, entry.slug), { body: { title: nicer }, project: entry.project }));
  }
  if (entry.uploads?.some((u) => u.version === version)) throw new JamError(`${version} is already published in room ${room}: bump the version passed to Glitchless.init, or both uploads' players count as one version. Then build and publish again.`, 409);

  const list = await Promise.all(build.files.map(async (f) => ({ ...f, sha256: sha256(await fs.promises.readFile(f.abs)) })));
  const started = await request(c, 'POST', `${roomPath(room, entry.slug)}/uploads`, { body: { version, service: svc, files: list.map(({ path: p, bytes, sha256: h }) => ({ path: p, bytes, sha256: h })) }, project: entry.project });
  log(`Sending ${started.send.length} files (${mb(build.total)}) to room ${room}…`);

  // Source maps go to Glitchless, never into the room, so errors show original lines and the source stays private.
  const sourcemaps = { sent: [], failed: [] };
  await pool(build.maps, CONCURRENCY, async (m) => {
    try {
      const qs = new URLSearchParams({ service: svc, version, file: m.file });
      await request(c, 'POST', `/v1/sourcemaps?${qs}`, { raw: zlib.gzipSync(await fs.promises.readFile(m.abs)), type: 'application/gzip', project: entry.project });
      sourcemaps.sent.push(m.file);
    } catch (err) {
      sourcemaps.failed.push({ file: m.file, error: err.message });
    }
  });
  if (sourcemaps.failed.length) warnings.push(`${sourcemaps.failed.length} source map${sourcemaps.failed.length === 1 ? '' : 's'} not sent (${sourcemaps.failed[0].error}), so errors in ${sourcemaps.failed.map((f) => f.file).join(', ')} show minified lines.`);

  const byPath = new Map(list.map((f) => [f.path, f]));
  await pool(started.send, CONCURRENCY, async (p) => {
    const f = byPath.get(p);
    if (!f) throw new JamError(`the server asked for "${p}", which isn't in the build`);
    const at = `${roomPath(room, entry.slug)}/uploads/${started.n}/files/${p.split('/').map(encodeURIComponent).join('/')}`;
    await request(c, 'PUT', at, { raw: await fs.promises.readFile(f.abs), project: entry.project });
  });
  const done = await request(c, 'POST', `${roomPath(room, entry.slug)}/uploads/${started.n}/publish`, { project: entry.project });
  remember(c, { room, slug: entry.slug, project: entry.project, service: svc });
  return { ...done, room, slug: entry.slug, title: entry.title, service: svc, files: list.length, bytes: build.total, sourcemaps, warnings };
}
