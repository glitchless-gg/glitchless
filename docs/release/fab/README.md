# Fab kit: the Glitchless Unreal plugin

Everything for listing the plugin (`unreal/Plugins/Glitchless`) on [Fab](https://www.fab.com). GitHub stays the main
route for the Nov 12–15 jam; Fab is a second listing, submitted by Nov 3.

| file | what |
| --- | --- |
| [STEPS.md](STEPS.md) | the owner's numbered steps in the Fab portal, from the seller account to "Submit for review" |
| [LISTING.md](LISTING.md) | every field's text: title, descriptions, technical information, tags, project version, declarations, FAQ |
| [REQUIREMENTS.md](REQUIREMENTS.md) | the plugin checked against Fab's Technical Requirements, clause by clause, and who fixes what |
| `media/thumbnail.png` | the listing's thumbnail, 1920 × 1080 |
| `media/gallery-0*.png` | the gallery, six images at 1920 × 1080 |
| `media/publisher-avatar.png` | the publisher profile's picture (the Glitchless icon, 512 × 512) |

The zip comes from the release script, never by hand:

```bash
node unreal/scripts/package-plugin.mjs --fab --engine 5.8 --fab-url <listing id>
```

It writes `dist/unreal/Glitchless_<version>_UE5.8.zip` (0.4.0 now). That zip is the plugin's source as a commit has it, plus the
repo's LICENSE, with `EngineVersion` and `FabURL` stamped into its `.uplugin`. The script fails on anything Fab's
rules reject. Without `--fab` it makes the GitHub release zips (`glitchless-unreal-<version>.zip` and
`glitchless-unreal-toolset-<version>.zip`).

## Remaking the images

The images are HTML pages in `media/src`, rendered with Playwright and Chrome:

```bash
node docs/release/fab/media/render.mjs
```

The gallery pages frame captures in `media/captures/`, all from the demo (`unreal/demo`). The captures are made
again rather than kept in git:

1. `node unreal/demo/run.mjs --shots` plays the demo's three bot runs and a measured run against a local server. It
   writes `dist/unreal-demo/findings.json`, `measure.json` and `shots/` (the game's own 1920 × 1080 HighResShots), and
   prints the data folder it used.
2. Serve that folder (`PORT=<free port> GLITCHLESS_DATA_DIR=<folder> node server/src/local.js`), then run
   `node docs/release/fab/media/capture-dashboard.mjs http://127.0.0.1:<port>`. That captures `findings.png`,
   `performance.png` and `errors.png` at 1600 × 900.
3. Copy `dist/unreal-demo/shots/gallery.png` to `media/captures/demo-gallery.png`.
4. Run `node docs/release/fab/media/make-agent-page.mjs` (the agent page quotes `findings.json` and `measure.json`).
5. Run `node docs/release/fab/media/render.mjs`.

The 2026-10-23 images came from the plugin as it is on main (4d2305a), with one change to the data. The plugin sent
each session's last batch twice when the game quit (U1 has the report), so the served copy had those 12 exact
duplicates removed, and nothing else. Without that, the Performance page lists the last GC hitch of each session
twice. Once the plugin is fixed, the steps above need no edits.

Fab §1.8.6.a: images must show the product as it is. Everything here is a real capture or real output; only the
thumbnail is a drawing.
