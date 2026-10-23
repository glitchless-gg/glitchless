// Uploads a web build's source maps to Glitchless (POST /v1/sourcemaps, SPEC §3d), so errors from the minified game
// show the original function, file and line. Each map goes with the path of the script it belongs to in the build
// (assets/index-3f2a.js): the server matches a stack frame's script URL to the longest uploaded path it ends with,
// so the game can be served from any host or folder.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DEFAULT_URL = 'http://localhost:7777';
const SCRIPT = /\.(m|c)?js$/;
const CONCURRENCY = 4;

// The source maps under `dir`, each with its script: [{ map, file, bytes }] where `map` is the map's path on disk and
// `file` the script's path in the build. A map's script is the one whose sourceMappingURL names it, else its own name
// without ".map", else the one its "file" field names. Maps with no script are returned in `orphans`.
export function findMaps(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${dir} is not a directory`);
  const scripts = [];
  const maps = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules') walk(p);
      } else if (ent.name.endsWith('.map') && !ent.name.endsWith('.css.map')) maps.push(p);
      else if (SCRIPT.test(ent.name)) scripts.push(p);
    }
  };
  walk(root);
  const scriptOf = new Map();
  for (const s of scripts) {
    const url = sourceMappingURL(s);
    if (url && !url.startsWith('data:')) scriptOf.set(path.resolve(path.dirname(s), decodeURI(url.split(/[?#]/)[0])), s);
  }
  const found = [];
  const orphans = [];
  for (const m of maps.sort()) {
    let script = scriptOf.get(m);
    const isScript = (c) => typeof c === 'string' && SCRIPT.test(c) && fs.existsSync(c);
    if (!script && isScript(m.slice(0, -'.map'.length))) script = m.slice(0, -'.map'.length);
    if (!script) {
      const named = readJson(m)?.file;
      if (typeof named === 'string' && isScript(path.resolve(path.dirname(m), named))) script = path.resolve(path.dirname(m), named);
    }
    if (!script) orphans.push(m);
    else found.push({ map: m, file: path.relative(root, script).split(path.sep).join('/'), bytes: fs.statSync(m).size });
  }
  return { maps: found, orphans };
}

// The last sourceMappingURL comment of a script (bundlers write it last), or null.
function sourceMappingURL(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const m = /\/[/*][#@] sourceMappingURL=([^\s*]+)[\s*/]*$/.exec(buf.toString('utf8'));
    return m ? m[1] : null;
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The service a project's package.json names (without an npm scope), or null.
export function serviceFromPackage(dir = process.cwd()) {
  const name = readJson(path.join(dir, 'package.json'))?.name;
  return typeof name === 'string' && name ? name.replace(/^@[^/]+\//, '').toLowerCase() : null;
}

// Uploads every source map under `dir` for one version of one game. Options:
//   version     the version the game passes to Glitchless.init (required)
//   service     the game's service name (required)
//   url         the Glitchless server (default $GLITCHLESS_URL or http://localhost:7777)
//   apiKey      a secret key with the sourcemaps scope (default $GLITCHLESS_API_KEY; a local server without
//               GLITCHLESS_API_KEY of its own needs none)
//   deleteMaps  delete each map once it is uploaded (and the script's comment that points at it)
//   dryRun      only list what would be uploaded
//   log         progress lines (default: none)
// → { uploaded: [{ file, map, bytes, sources, sources_with_content }], failed: [{ file, map, error }], orphans, deleted }
export async function uploadSourcemaps(dir, { version, service, url = process.env.GLITCHLESS_URL || DEFAULT_URL, apiKey = process.env.GLITCHLESS_API_KEY, deleteMaps = false, dryRun = false, log = () => {}, fetch: send = globalThis.fetch } = {}) {
  if (!version) throw new Error('a version is required: the one your game passes to Glitchless.init');
  if (!service) throw new Error('a service is required: the name your game passes to Glitchless.init');
  const { maps, orphans } = findMaps(dir);
  for (const o of orphans) log(`skipped ${path.relative(process.cwd(), o)}: no script in the build points at it`);
  const result = { uploaded: [], failed: [], orphans, deleted: [] };
  if (dryRun) {
    for (const m of maps) log(`would upload ${m.file} (${kb(m.bytes)})`);
    result.uploaded = maps.map(({ map, file, bytes }) => ({ map, file, bytes, dry_run: true }));
    return result;
  }
  const base = url.replace(/\/$/, '');
  const queue = [...maps];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const qs = new URLSearchParams({ service, version, file: m.file });
          const res = await send(`${base}/v1/sourcemaps?${qs}`, {
            method: 'POST',
            headers: { 'content-type': 'application/gzip', 'x-glitchless-client': 'glitchless-sourcemaps', ...(apiKey ? { 'x-glitchless-api-key': apiKey } : {}) },
            // A Blob, not a Buffer: Node's fetch fails outright on a 401 to a request whose body is a Buffer.
            body: new Blob([zlib.gzipSync(fs.readFileSync(m.map))]),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error || res.statusText}${res.status === 401 || res.status === 403 ? '. Set GLITCHLESS_API_KEY to a secret key that can upload source maps.' : ''}`);
          result.uploaded.push({ ...m, sources: body.sources, sources_with_content: body.sources_with_content });
          log(`uploaded ${m.file} (${kb(m.bytes)}, ${body.sources} sources)${body.sources && !body.sources_with_content ? ': no sourcesContent, so no function names or code lines from it' : ''}`);
        } catch (err) {
          result.failed.push({ map: m.map, file: m.file, error: err.message });
          log(`failed ${m.file}: ${err.message}`);
        }
      }
    }),
  );
  if (deleteMaps) {
    for (const m of result.uploaded) {
      fs.rmSync(m.map, { force: true });
      unlink(path.join(path.resolve(dir), m.file), m.map);
      result.deleted.push(m.map);
    }
  }
  return result;
}

// Drops a script's sourceMappingURL comment when it points at `map` (deleted), so browsers don't ask for it.
function unlink(script, map) {
  let text;
  try {
    text = fs.readFileSync(script, 'utf8');
  } catch {
    return;
  }
  const m = /\n?\/[/*][#@] sourceMappingURL=([^\s*]+)[\s*/]*$/.exec(text);
  if (m && path.resolve(path.dirname(script), decodeURI(m[1].split(/[?#]/)[0])) === map) fs.writeFileSync(script, text.slice(0, m.index) + '\n');
}

function kb(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
