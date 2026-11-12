# Godot Asset Store listing: Glitchless for Godot

Every field the [Godot Asset Store](https://store.godotengine.org) asks for, filled in for the addon at 0.6.8. Rules
quoted are the store's [guidelines](https://store.godotengine.org/guidelines/) and
[submission docs](https://docs.godotengine.org/en/stable/community/asset_store/submitting_to_asset_store.html), read
9 November 2026. The old Asset Library's entry ([5587](https://godotengine.org/asset-library/asset/5587)) has the same
text; the store doesn't copy it over.

## Publisher

| field | value |
| --- | --- |
| Publisher Name | **Glitchless** |
| Publisher URL Slug | **glitchless** (the store's link becomes `store.godotengine.org/asset/glitchless/<asset>/`) |

## Overview and Settings

| field | value |
| --- | --- |
| Asset Name | **Glitchless: Game Observability for Coding Agents** (title case, which the store's reviewers ask for) |
| Asset URL Slug | **glitchless**, the addon's folder name: the page is `store.godotengine.org/asset/glitchless/glitchless/` |
| Asset type | **Addon** |
| License | **MIT**. The zip carries `addons/glitchless/LICENSE` ("Copyright (c) 2026 The Glitchless authors"), and the source repo's root `LICENSE` is the same file, as the guidelines ask |
| Link to source code | https://github.com/glitchless-gg/glitchless-godot (the addon alone, copied from the main repo at each release) |
| Tags | In this order, since browsing shows only the first 5 (up to 10 allowed): `analytics`, `performance`, `debugging`, `crash-reporting`, `ai`, then `profiling`, `telemetry`, `multiplayer`, `bug-reports`, `mcp`. Tags can't be the asset's name, and where the store suggests an existing spelling or its singular or plural, use that one |
| AI usage disclosure | Mandatory when AI was used, which it was. See below |

### Asset Summary

```text
See how your Godot game runs for the people playing it: every frame timed with each stutter's likely cause, errors with what the player did just before, and where players quit. Your coding agent reads it over MCP and fixes the next build.
```

### Detailed description

The store shows Markdown: bold lead-ins and lists work, and the guidelines want full sentences in proper English.

```markdown
Glitchless times every frame on every player's device and names each hitch's likely cause, groups errors and crashes with what the player did just before, and shows where players quit. Your coding agent (Claude Code, Codex, Cursor and others) reads it all over MCP and fixes the next build.

**What it reports**

- **Frame times and stutter.** Every frame is timed. Each hitch comes with its likely cause: a shader compile, a burst of new nodes, a scene change, slow `_process` code, physics, rendering, or a frozen frame, with the events from the 1.5 seconds before it.
- **Errors**, through Godot 4.5's custom loggers, with script backtraces and the player's last events.
- **Levels and players:** the level funnel, deaths, where players quit, and your game's own events, counters and session properties.
- **Leaks:** nodes, orphan nodes and video memory over a session.
- **Multiplayer:** ping, packet loss and disconnects from Godot's MultiplayerAPI (ENet, and WebSocket in web exports), and a dedicated server's tick time and players.
- **Bug reports from players**, when you turn them on: F8 (or your own button) opens a short form, and the report carries the note, a screenshot and what had just happened.
- **Web exports** name the player's browser and send their last batch as the page closes.

**Setup.** Turn on the plugin under Project Settings → Plugins, which adds the `Glitchless` autoload, then call `Glitchless.init(...)` when the game starts. Or paste the setup prompt from glitchless.gg/godot.html into your coding agent and let it do the rest.

**For agents.** A build measures itself with `--glitchless-measure=SECONDS` and writes the numbers as JSON, so an agent can compare a change before and after.

**Cost to the game.** It isn't a profiler and hooks nothing: about 6 µs of GDScript a frame on a fast laptop, and the offline outbox is written on a worker thread.

**Privacy.** Anonymous by default: no player ID and only coarse device facts. Debug builds send nothing unless run with `--glitchless`, so your own test runs don't count as players. Players can turn it off from your settings menu with `Glitchless.set_enabled(false)`, which holds on every later launch. PRIVACY.md, inside the addon, lists every field each mode sends.

**It needs a Glitchless server.** Glitchless Cloud is free for 5,000 play sessions a month (glitchless.gg/pricing.html), or run the open-source MIT server yourself (github.com/glitchless-gg/glitchless).
```

### AI usage disclosure

```text
Code written with AI coding agents (Claude Code), directed, reviewed and tested by the developer: end-to-end tests run in Godot on desktop and web for every release. The mascot art is AI-generated; the screenshots are real captures.
```

232 characters: the field keeps about 255 and cuts the rest without saying so. The owner checks this before sending: it has
to be true of what's submitted.

## Media

The images are rendered from `media/src` (README.md, "Media"). Once the public repo is pushed, each has a direct link
on `raw.githubusercontent.com`, which the store asks for when an image is given by link:

| image | file | link |
| --- | --- | --- |
| Thumbnail (16:9, required) | `media/thumbnail.png`, 1920 × 1080 | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/thumbnail.png |
| Screenshot 1 | `media/screenshot-01-findings.png` | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/screenshot-01-findings.png |
| Screenshot 2 | `media/screenshot-02-performance.png` | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/screenshot-02-performance.png |
| Screenshot 3 | `media/screenshot-03-errors.png` | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/screenshot-03-errors.png |
| Screenshot 4 | `media/screenshot-04-starlift.png` | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/screenshot-04-starlift.png |
| Featured image (optional) | `media/featured.jpg`, 1920 × 1080, 211 KB (a JPEG: the store caps it at 600 KB): the home page carousel shows it at 16:9 beside a panel with the name and description, so it has no headline | https://raw.githubusercontent.com/glitchless-gg/glitchless/main/docs/release/godot-asset-store/media/featured.jpg |
| YouTube video | Leave empty | |

The guidelines reject thumbnails dominated by text or showing what the asset can't produce. This one has the name, "for
Godot", Glitchy and a frame-time trace. Screenshots 1 to 3 are the dashboard on the Godot demo's own bot runs, and 4 is
Starlift's shared board (a shipped Godot game).

## Versions

| field | value |
| --- | --- |
| Version name | **0.6.8** (the addon's `plugin.cfg` version) |
| Changelog | See below |
| Minimum Godot version | **4.5** (the addon needs 4.5's custom loggers) |
| Maximum Godot version | Leave empty |
| Additional information | `Turn on the plugin under Project Settings → Plugins, then call Glitchless.init(...). Setup for coding agents: glitchless.gg/godot.html` |
| File | `dist/godot-asset-store/glitchless-0.6.8.zip` from `node scripts/export-godot-addon.mjs`: `addons/glitchless/` alone, with its LICENSE, README and PRIVACY.md |

### Changelog for 0.6.8

For the first version on the store (nothing uploaded yet):

```text
First version on the Godot Asset Store.
- Web exports name the player's browser (Chrome, Safari, Firefox, Edge) and its OS, and send their last batch by beacon as the page closes (0.6.5).
- No script warnings, even with addons included in the warning settings (0.6.6).
- Web exports run in a Reddit post (Devvit Web): set the intake to /api/glitchless and the game's Reddit app relays to Glitchless. The page is read without eval, which a strict content policy blocks. (0.6.7)
- Web exports say where they were played: the page's origin and path and the referrer's origin, so plays on itch.io count as itch.io.
```

When an earlier version is already on the store:

```text
- Web exports run in a Reddit post (Devvit Web): set the intake to /api/glitchless and the game's Reddit app relays to Glitchless. The page is read without eval, which a strict content policy blocks. (0.6.7)
- Web exports say where they were played: the page's origin and path and the referrer's origin, so plays on itch.io count as itch.io.
```

## Pricing

| field | value |
| --- | --- |
| Price | Free (the store can't sell assets yet) |
| Donation link | Leave empty |
| Reviews | Leave on |
