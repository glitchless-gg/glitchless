# Glitchless brand

**Glitchless** is one word with a capital G. It's speedrunner slang for a run with no glitches, which is what the product helps a game ship with. In one line: Glitchless shows you how your game plays for real players, and gives your coding agent the same data so it can fix what they hit.

## Logo

The mark is a game controller with a screen in its body. The screen shows a frame-time line that starts with a coral spike (a stutter) and settles into a smooth line. It's drawn by hand in SVG, in `logo/`.

| File | Use it for |
| --- | --- |
| `logo/glitchless-icon.svg` | App icon, avatars, social images: anything 64 px and up |
| `logo/glitchless-icon-small.svg`, `favicon.svg`, `favicon.ico` | 48 px and below: favicons, tabs, tiny UI. One spike and thicker lines, because the full graph turns to mush at that size |
| `logo/glitchless-mark-light.svg` | The controller alone on white or light backgrounds (navy body, coral spike, navy line) |
| `logo/glitchless-mark-dark.svg` | The controller alone on navy or dark backgrounds (mint body, coral spike, mint line) |
| `logo/png/glitchless-lockup-light.png`, `-dark.png`, `-icon.png` | Mark plus wordmark, for site headers, README and slides |
| `logo/png/glitchless-icon-*.png` | Rendered sizes from 16 to 1024 px; 180 is the Apple touch icon, 192 and 512 are for web manifests |

- Leave clear space around the mark at least as tall as its screen.
- Don't use the mark below 24 px tall; switch to the small icon instead.
- The spike is always coral. Don't recolour the mark, stretch it, outline it or add shadows or gradients.
- Mint on white is too faint (1.6:1). On light backgrounds use the light mark, which is navy.
- The screen in the light and dark marks is a real cut-out, so it takes on whatever background it sits on.

The earlier "line into a G" version is kept in `logo/_archive/`. People read it as "MG", so don't use it.

## Colour

| Name | Hex | Role |
| --- | --- | --- |
| Mint | `#2EE6A6` | The brand colour: the controller, smooth lines, things that are healthy or fixed |
| Navy | `#14213D` | Text, dark backgrounds, the app icon |
| Coral | `#FF6B57` | Accent only: the spike, regressions and errors, Glitchy's antenna |
| White | `#FFFFFF` | Light backgrounds, Glitchy's face plate |
| Mist | `#F4F6FA` | Soft light background for pages and panels |

Contrast, measured:

| Text on background | Ratio | Verdict |
| --- | --- | --- |
| Navy on white or mist | 16.0:1 / 14.8:1 | Use for all body text |
| White on navy | 16.0:1 | Body text on dark backgrounds |
| Mint on navy | 9.9:1 | Fine for text and lines on dark backgrounds |
| Coral on navy | 5.7:1 | Fine for short labels on dark backgrounds |
| Coral on white | 2.8:1 | Shapes and icons only, never text |
| Mint on white | 1.6:1 | Never for text or thin lines |

## Type

- **Wordmark and headlines:** [Outfit](https://fonts.google.com/specimen/Outfit), ExtraBold (800), letter spacing about −2%.
- **Interface and body text:** Inter, or the system UI font.
- **Code:** JetBrains Mono.

## Glitchy, the mascot

Glitchy is a small playtest robot shaped like a handheld console. It plays your game so players don't run into glitches; the autoplay bots in the product are its job. It's upbeat, curious and good at its job. It has a white face plate, a navy screen with mint arc eyes, a d-pad, a mint button and a coral antenna light.

| File | Pose | Good for |
| --- | --- | --- |
| `mascot/glitchy.png` | Running with a stopwatch | Marketing, speed and performance |
| `mascot/glitchy-wave.png` | Waving hello | Onboarding welcome, sign-in |
| `mascot/glitchy-search.png` | Peering through a magnifying glass | Empty states while data arrives, "finding the problem" |
| `mascot/glitchy-win.png` | Jumping with a trophy | A fix that passed its playtest, success screens |
| `mascot/glitchy-play.png` | Playing with the Glitchless controller | Playtest and bot features, docs, stickers |

- **On navy or other dark backgrounds, use `mascot/on-dark/`.** Glitchy's outline, arms and legs are the brand navy, so on a navy background they disappear. The `on-dark` versions add a white sticker outline. On white, mist and other light backgrounds, use the plain files.
- Glitchy is the mascot, not the logo. Keep it out of the logo lockup and out of the dashboard's navigation; use it in onboarding, empty states, docs, the site and swag.
- The poses are generated images, made with the `claude-image-gen` skill using the first accepted concept (`_staging/concept-a-bot.png`) as the reference so the character stays on model. The unprocessed generations in `_staging/` stay in the private repo; the public one has only the finished art.
- Props stay in the palette. The trophy's gold is the one exception, because a trophy reads as a win in gold.
- Generate new poses on a flat magenta background, not white. Glitchy's face plate is white, so a background remover deletes it on a white background. After cutting out a new pose, make its `on-dark` version: run `python assets/brand/glitchless/outline-mascots.py`, which needs Pillow.

## Voice

- Write for developers who don't make games for a living. Say what players feel ("it lags on my laptop") before the metric.
- Define a game or performance term the first time it matters. For example, p95 frame time is the time taken by the slowest 5% of frames.
- Show the real product: screenshots, real numbers and the actual commands.

## Rebuilding the assets

```bash
node assets/brand/glitchless/build.mjs           # every PNG size and the lockups, from the SVGs
node assets/brand/glitchless/build.mjs compare   # logo/variants/*.svg side by side at 256–16 px
```

The build also packs `favicon.ico` from the 16, 32 and 48 px PNGs and copies the small icon to `favicon.svg`.
