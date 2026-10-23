// The Vite plugin: builds with hidden source maps (no sourceMappingURL comment, so players' browsers never ask for
// them), uploads them after the build when a key is set, and can delete them from the output.
//
//   import glitchlessSourcemaps from 'glitchless-sourcemaps/vite';
//   export default defineConfig({ plugins: [glitchlessSourcemaps({ deleteMaps: true })] });

import fs from 'node:fs';
import path from 'node:path';
import { uploadSourcemaps, serviceFromPackage, DEFAULT_URL } from './index.js';

// Options (each also read from the environment):
//   version     the version the game passes to Glitchless.init ($GLITCHLESS_VERSION, else package.json "version")
//   service     the game's service name ($GLITCHLESS_SERVICE, else package.json "name")
//   url         the Glitchless server ($GLITCHLESS_URL, else http://localhost:7777)
//   apiKey      a secret key with the sourcemaps scope ($GLITCHLESS_API_KEY); without one nothing is uploaded
//   deleteMaps  delete the maps from the output after the upload (or right away when there is no key), so they
//               never ship to players
//   strict      fail the build when an upload fails (default: warn and carry on)
export default function glitchlessSourcemaps(options = {}) {
  let outDir = null;
  let root = process.cwd();
  let ssr = false;
  return {
    name: 'glitchless-sourcemaps',
    apply: 'build',
    config(user) {
      // Maps for every build, but no comment pointing at them, unless the project asked for something else.
      if (!user.build?.sourcemap) return { build: { sourcemap: 'hidden' } };
    },
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
      ssr = !!config.build.ssr;
      if (config.build.sourcemap === true && !options.deleteMaps) config.logger.warn('[glitchless-sourcemaps] build.sourcemap is true: players can read your source. Use "hidden" or deleteMaps: true.');
    },
    async closeBundle() {
      if (ssr || !outDir || !fs.existsSync(outDir)) return;
      const pkg = readPackage(root);
      const version = options.version || process.env.GLITCHLESS_VERSION || pkg?.version;
      const service = options.service || process.env.GLITCHLESS_SERVICE || serviceFromPackage(root);
      const apiKey = options.apiKey || process.env.GLITCHLESS_API_KEY;
      const url = options.url || process.env.GLITCHLESS_URL || DEFAULT_URL;
      const log = (msg) => console.log(`[glitchless-sourcemaps] ${msg}`);
      if (!apiKey) {
        log('GLITCHLESS_API_KEY is not set: source maps not uploaded.');
        if (options.deleteMaps) deleteAll(outDir, log);
        return;
      }
      try {
        const res = await uploadSourcemaps(outDir, { version, service, url, apiKey, deleteMaps: !!options.deleteMaps });
        log(`uploaded ${res.uploaded.length} source maps for ${service} ${version} to ${url}${res.deleted.length ? ', and deleted them from the build' : ''}.`);
        if (res.failed.length) throw new Error(res.failed.map((f) => `${f.file}: ${f.error}`).join('; '));
      } catch (err) {
        if (options.strict) throw new Error(`[glitchless-sourcemaps] ${err.message}`);
        log(`upload failed: ${err.message}`);
      }
    },
  };
}

function readPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function deleteAll(dir, log) {
  let n = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.map')) {
        fs.rmSync(p);
        n++;
      }
    }
  };
  walk(dir);
  if (n) log(`deleted ${n} source maps from the build without uploading them.`);
}
