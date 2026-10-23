#!/usr/bin/env node
// glitchless-sourcemaps: upload a web build's source maps to Glitchless, so errors from the minified game show the
// original function, file and line.
//
//   GLITCHLESS_API_KEY=gl_sk_… npx glitchless-sourcemaps upload dist --version 1.2.0
//   npx glitchless-sourcemaps upload dist --version 1.2.0 --service blastpit --url https://api.glitchless.gg --delete

import { uploadSourcemaps, serviceFromPackage, DEFAULT_URL } from '../src/index.js';

const HELP = `Usage: glitchless-sourcemaps upload <dir> --version VERSION [options]

Uploads every *.js.map under <dir> (your build output, e.g. dist) with the path of the
script it belongs to, for one version of one game.

  --version VERSION   the version your game passes to Glitchless.init (required)
  --service NAME      the game's service name (default $GLITCHLESS_SERVICE, else
                      the "name" in ./package.json)
  --url URL           Glitchless server (default $GLITCHLESS_URL or ${DEFAULT_URL})
  --delete            delete each map after it is uploaded, so maps don't ship
  --dry-run           list the maps and their scripts without uploading

The key comes from $GLITCHLESS_API_KEY: a secret key that can upload source maps.
Exit code: 0 uploaded, 1 an upload failed, 2 usage or setup error.`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const log = (msg) => process.stderr.write(`${msg}\n`);

if (has('help') || has('h') || !argv.length) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 2);
}

const [command, dir] = argv;
try {
  if (command !== 'upload' || !dir || dir.startsWith('--')) throw new Error('usage: glitchless-sourcemaps upload <dir> --version VERSION (see --help)');
  const service = val('service') || process.env.GLITCHLESS_SERVICE || serviceFromPackage();
  const version = val('version') || process.env.GLITCHLESS_VERSION;
  const url = val('url') || process.env.GLITCHLESS_URL || DEFAULT_URL;
  const result = await uploadSourcemaps(dir, { version, service, url, deleteMaps: has('delete'), dryRun: has('dry-run'), log });
  if (!result.uploaded.length && !result.failed.length) log(`No source maps found in ${dir}. Build with source maps on (Vite: build.sourcemap 'hidden').`);
  else if (!has('dry-run')) log(`${result.uploaded.length} of ${result.uploaded.length + result.failed.length} source maps uploaded for ${service} ${version} to ${url}.`);
  process.exit(result.failed.length ? 1 : 0);
} catch (err) {
  log(`glitchless-sourcemaps: ${err.message}`);
  process.exit(2);
}
