# Product Hunt kit: Glitchless

Everything for launching Glitchless on [Product Hunt](https://www.producthunt.com): the text for every field, a thumbnail
and a gallery made from real captures. The owner submits; nothing here posts anything.

| file | what |
| --- | --- |
| [LISTING.md](LISTING.md) | every field's text: name, tagline options, description, links, topics, pricing, the maker's first comment, timing |
| `media/thumbnail.png` | the thumbnail, 240 × 240: the Glitchless app icon |
| `media/thumbnail-glitchy.png` | the other choice, 240 × 240: Glitchy on navy |
| `media/gallery-01-cover.png` | the tagline, the eight engines and Glitchy |
| `media/gallery-02-players.png` | Starlift's "Where players stop" board over 7 days (tutorial finished, skipped, what comes after a skip) |
| `media/gallery-03-agent.png` | Starlift's build 17 commit, written with Claude Code from what Glitchless showed (real text, trimmed) |
| `media/gallery-04-before-after.png` | Starlift 1.1.1 against 1.1.2 on players' phones, from `glitchless_compare_versions` |
| `media/gallery-05-every-frame.png` | two frames of the Zoomies demo's before-and-after clip: 11 fps, then 60 fps |
| `media/gallery-06-engines.png` | the eight engines and each one's install line |
| `media/before-after.gif` | the Zoomies before and after as a GIF: 640 × 360, 6 seconds, 2.8 MB |

The gallery is 1270 × 760, the size Product Hunt's guides give, and every file is under 3 MB.

## Remaking it

The pages are HTML in `media/src`, drawn at half size and saved at 2x, like the Unity and Fab kits:

```bash
node docs/release/product-hunt/media/capture.mjs   # the real captures, into media/captures/ (not kept in git)
node docs/release/product-hunt/media/render.mjs    # every page in media/src, or name one: render.mjs gallery-04
```

- `capture.mjs` opens two of Starlift's boards through share links it makes and revokes straight after, with the saved
  `glitchless-mcp login` (a workspace key), and prints no link or token. Share links leave money out, so the Overview
  board's revenue panels come out empty: the gallery uses "Where players stop" instead. Don't show revenue publicly
  without the owner's word.
- The Zoomies frames come from `assets/brand/glitchless/social/zoomies-before-after.mp4` (at 1 s and 5 s, with ffmpeg),
  and so does the GIF: the two halves (1.2 to 4.3 s and 5.1 to 8.2 s) at 640 wide, 8 fps and 64 colours.
- The numbers on `gallery-04` were read on 27 October 2026, when 1.1.2 had 34 sessions; read them again with
  `glitchless_compare_versions` (Starlift, 1.1.1 against 1.1.2, 7 days, players only) before a later launch.
