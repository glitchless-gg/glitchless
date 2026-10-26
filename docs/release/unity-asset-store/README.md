# Asset Store kit: the Glitchless Unity SDK

Everything for listing the Unity SDK (`unity/Packages/gg.glitchless.sdk`) on the
[Unity Asset Store](https://assetstore.unity.com) as a classic package: it imports into `Assets/Glitchless`, with the
Fetch! sample beside it, and needs no UPM enrollment. A UPM product, installed through the Package Manager as the
GitHub git URL does, can come later (STEPS.md, "Later"). GitHub stays the install route until the listing is live.

| file | what |
| --- | --- |
| [STEPS.md](STEPS.md) | the owner's numbered steps, from the draft to "Submit", and the UPM route for later |
| [LISTING.md](LISTING.md) | every field's text: summary, description (its required first paragraph), technical details, keywords, AI description |
| [REQUIREMENTS.md](REQUIREMENTS.md) | the package checked against the Submission Guidelines, rule by rule, and what's left |
| `media/icon.png`, `card.png`, `cover.png`, `social.png` | the four key images, at 160 × 160, 420 × 280, 1950 × 1300 and 1200 × 630 |
| `media/screenshot-0*.png` | six screenshots at 1920 × 1080: findings, where players die, hitches, errors, setup, and what an agent reads |

The package comes from the script, never by hand:

```bash
node unity/scripts/asset-store.mjs --classic
```

It writes `dist/unity-asset-store/GlitchlessClassic`, a Unity project whose `Assets/Glitchless` is the store's copy of
the commit: under the Asset Store EULA (no `LICENSE.md`; GitHub's copy stays MIT), without the tests, with the sample
moved out of `Samples~` so it imports, and with the README's install, sample and tests text for the store. The files
keep the package's GUIDs, and the few that had none get GUIDs made from their paths, so updates replace files. Its
`Packages/manifest.json` lists the built-in modules the SDK and the sample use. The script checks the store's
packaging rules and fails on any it breaks. Open the project in Unity 6000.3.27f1, then use Unity's Asset Store
Publishing Tools to validate and upload it (STEPS.md 3 to 6). On 26 October 2026 it imported with no errors or
warnings, and the sample scene's scripts were all found.

Without `--classic` the script writes the UPM product's project instead, `dist/unity-asset-store/GlitchlessAssetStore`,
with `unityRelease`, the publisher as author and the EULA as `licensesUrl` in its manifest. It too imported cleanly.

## Media

The key images are drawn in `media/src` (the cover may carry the title, the publisher and a tagline; the card the
title and publisher; the icon and the social image no text). The screenshots frame real captures of the Fetch!
sample's bot runs, so they show the product as it is. All are 24-bit PNGs without alpha.

```bash
node docs/release/unity-asset-store/media/render.mjs
```

### Remaking the screenshots

The captures in `media/captures/` are made again rather than kept in git:

1. Build the Fetch! player: `npm run test:unity` leaves it at `unity/Builds/e2e/Fetch.app`.
2. Start an empty server: `PORT=7846 GLITCHLESS_DATA_DIR=data/unity-demo node server/src/local.js`.
3. Play it a few times, in a window so frames are drawn, for example
   `Fetch.app/Contents/MacOS/Fetch -screen-fullscreen 0 -screen-width 1280 -screen-height 720 --autoplay --level=2 --skill=0.7 --seed=12 --quit-after=60 --glitchless-intake=http://127.0.0.1:7846`,
   across the three levels and a few seeds and skills, then once with
   `--glitchless-off --glitchless-warmup=2 --glitchless-measure=12 --glitchless-out=docs/release/unity-asset-store/media/captures/measure.json`.
4. `node docs/release/unity-asset-store/media/capture-dashboard.mjs http://127.0.0.1:7846`
5. `node docs/release/unity-asset-store/media/make-agent-page.mjs`, then `render.mjs`.
