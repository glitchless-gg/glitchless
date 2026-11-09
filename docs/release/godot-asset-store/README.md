# Godot kit: the Asset Store and the Asset Library

Everything for listing the Godot addon (`godot/addons/glitchless`) in Godot's two catalogues:

- **The Godot Asset Store** (store.godotengine.org), the new one, built into the editor from Godot 4.7. It takes an
  uploaded zip for each version.
- **The Asset Library** (godotengine.org/asset-library), the old one, where Glitchless is
  [asset 5587](https://godotengine.org/asset-library/asset/5587). It installs a commit of the addon's own repo,
  [glitchless-gg/glitchless-godot](https://github.com/glitchless-gg/glitchless-godot).

| file | what |
| --- | --- |
| [STEPS.md](STEPS.md) | the owner's steps: the Asset Store the first time, and both catalogues at each release |
| [LISTING.md](LISTING.md) | every field's text: summary, description, tags, AI disclosure, version and changelog, and the images' links |
| `media/thumbnail.png` | the 16:9 thumbnail the store requires, 1920 × 1080 |
| `media/featured.jpg` | the optional featured image for the home page's carousel, 1920 × 1080, a JPEG under the store's 600 KB limit |
| `media/screenshot-0*.png` | four screenshots at 1920 × 1080: findings, performance, errors from the Godot demo's bot runs, and Starlift's board |

## The zip and the library's fields

Both come from the script, never by hand:

```bash
node scripts/export-godot-addon.mjs
```

It copies the addon into the mirror (`../glitchless-godot`) and writes `dist/godot-asset-store/glitchless-<version>.zip`,
holding `addons/glitchless/` alone, as the store's guidelines ask: the addon's folder with its LICENSE, README and
PRIVACY.md, and no `.gitignore`, `.gitattributes` or `.DS_Store`. Once the mirror's commit is tagged `v<version>` and
pushed, the same script with `--fields` prints the Asset Library edit's Version, Download Commit and Download URL, and
refuses a commit GitHub doesn't have yet.

The store rejects an addon with script warnings ("Fix or suppress all script warnings"), though Godot hides warnings
in `addons/` from the game's developer by default. `npm run test:godot` starts with `godot/test/warnings.mjs`, which
installs the addon in a fresh project with every warning Godot shows by default turned into an error.

## Media

The thumbnail and the screenshots' frames are drawn in `media/src` and rendered at 2x:

```bash
node docs/release/godot-asset-store/media/render.mjs
```

The screenshots frame real captures, never mock-ups (the guidelines reject "fabricated screenshots"). To make the
captures again:

```bash
node docs/release/godot-asset-store/media/make-captures.mjs
```

It starts an empty local server on port 7863, plays the Godot demo six times in a window with its planted stutter,
leak and errors, and saves the dashboard's findings, performance and errors pages to `media/captures/` (not kept in
git). The fourth screenshot frames Starlift's shared board from `assets/brand/glitchless/social/starlift-dashboard.png`.
