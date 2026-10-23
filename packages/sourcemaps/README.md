# glitchless-sourcemaps

Readable errors from your minified web game. A player's error in a production build reads
`e (index-3f2a.js:1:48213)`, which neither you nor your coding agent can act on. Upload the build's
source maps to [Glitchless](https://github.com/glitchless-gg/glitchless) and the same error shows as
`fireShotgun (weapons.js:141)`, with the original stack and the line of code, in the dashboard, in
findings and for agents over MCP (`glitchless_get_error`). An error also keeps one fingerprint across
builds, so 1.2.0 and 1.2.1 don't split one bug into two issues.

Nothing changes in your game or the SDK: the server reads the stack it already gets.

## Vite

```bash
npm install -D glitchless-sourcemaps
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import glitchlessSourcemaps from 'glitchless-sourcemaps/vite';

export default defineConfig({
  plugins: [glitchlessSourcemaps({ deleteMaps: true })],
});
```

The plugin builds with `build.sourcemap: 'hidden'` (maps with no comment pointing at them, so players'
browsers never ask for them) unless you set `build.sourcemap` yourself. After `vite build` it uploads the
maps when `GLITCHLESS_API_KEY` is set, and with `deleteMaps: true` it removes them from `dist`, so they
never ship. Without a key it uploads nothing (and still deletes them with `deleteMaps`).

| option | default | |
| --- | --- | --- |
| `version` | `$GLITCHLESS_VERSION`, else `version` in package.json | must be the version your game passes to `Glitchless.init` |
| `service` | `$GLITCHLESS_SERVICE`, else `name` in package.json | the game's service name |
| `url` | `$GLITCHLESS_URL`, else `http://localhost:7777` | your Glitchless server (hosted: `https://api.glitchless.gg`) |
| `apiKey` | `$GLITCHLESS_API_KEY` | a secret key that can upload source maps |
| `deleteMaps` | `false` | delete the maps from the build after the upload |
| `strict` | `false` | fail the build when an upload fails (otherwise it warns) |

## CLI (any bundler, CI)

```bash
GLITCHLESS_API_KEY=gl_sk_… npx glitchless-sourcemaps upload dist --version 1.2.0
```

It finds every `*.js.map` under `dist` and the script each belongs to (the one whose
`sourceMappingURL` names it, else the map's name without `.map`, else the map's `file`), and uploads
each map with the script's path in the build (`assets/index-3f2a.js`). In CI, upload before you deploy:

```yaml
- run: npm run build
- run: npx glitchless-sourcemaps upload dist --version "$(node -p "require('./package.json').version")" --delete
  env:
    GLITCHLESS_API_KEY: ${{ secrets.GLITCHLESS_API_KEY }}
    GLITCHLESS_URL: https://api.glitchless.gg
```

```
--version VERSION   the version your game passes to Glitchless.init (required)
--service NAME      the game's service name (default $GLITCHLESS_SERVICE, else
                    the "name" in ./package.json)
--url URL           Glitchless server (default $GLITCHLESS_URL or http://localhost:7777)
--delete            delete each map after it is uploaded, so maps don't ship
--dry-run           list the maps and their scripts without uploading
```

Exit code: 0 uploaded, 1 an upload failed, 2 usage or setup error. A local Glitchless server started
without `GLITCHLESS_API_KEY` needs no key.

## Keys

In the hosted dashboard, create a secret key in the game's **Settings** and tick **Can upload source
maps**. Keep it in CI secrets: like every secret key it can also read the game's data.

## How it matches

A stack frame's script URL is matched to the longest uploaded path it ends with, so
`https://cdn.example.com/play/blastpit/assets/index-3f2a.js` finds `assets/index-3f2a.js` wherever the
game is served from. Maps are kept per game and version: upload them for every version you ship, before
players get it. An error that arrives before its version's maps is still shown with original frames once
they are uploaded, but keeps the fingerprint it arrived with.

Maps with `sourcesContent` (the default in Vite, esbuild, Rollup and webpack) give the best results: the
server reads the function's name from the source and shows the failing line.

## Limits

10 MB per request on your own server and 4 MB on the hosted service (gzipped; the CLI gzips, and 4 MB is a
12–20 MB map), 40 MB per map unpacked, 200 maps per version. A game keeps
the 50 versions uploaded most recently; an upload past that deletes the oldest. The hosted service keeps
a map for 400 days after its upload.

`GET /v1/sourcemaps?service=` lists a game's maps; `DELETE /v1/sourcemaps?service=&version=` deletes a
version's (the key needs the sourcemaps scope).
