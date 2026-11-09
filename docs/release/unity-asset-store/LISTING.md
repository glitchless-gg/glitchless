# Unity Asset Store listing: Glitchless for Unity

Every field the Publisher Portal asks for, filled in for `gg.glitchless.sdk` 0.7.1. Rule numbers are the
[Asset Store Submission Guidelines](https://assetstore.unity.com/publishing/submission-guidelines), read 26 October
2026. The description's first paragraph is required there (1.4.a, 1.4.c, 1.5.c): it must come first.

## Publisher profile

| field | value |
| --- | --- |
| Publisher name | **Glitchless** (a UPM product's `author.name` must match it; `asset-store.mjs --publisher` sets it) |
| Website | https://www.glitchless.gg |
| Support email | support@glitchless.gg |
| Support page | https://www.glitchless.gg/support.html |
| UPM namespace | Only for a UPM product: `gg.glitchless`, verified through glitchless.gg's DNS (STEPS.md, "Later") |

## Product

| field | value |
| --- | --- |
| Product name | **Glitchless Game Observability** |
| Package | A classic package, uploaded from `Assets/Glitchless` (`asset-store.mjs --classic`). As a UPM product: single package, technical name `gg.glitchless.sdk` |
| Category | **Tools → Integration** (an SDK for a service). If the picker has no Integration, **Tools → Utilities** |
| Price | **Free** |
| Unity versions | 0.7.1 (in review since 9 November 2026): **6000.3** (Unity 6.3 LTS) and later, uploaded from and tested on 6000.3.27f1. **From the next update (0.7.2): 6000.0** (Unity 6.0 LTS) and later, uploaded from 6000.0.85f2, which the store then lists as the oldest (STEPS.md, step 3). Tested on 6000.0.85f2, 6000.3.27f1 and 6000.5.9f1 |
| Render pipelines | **Built-in, URP and HDRP**: the SDK draws nothing but its optional IMGUI bug-report form |
| Platforms | All: pure C# on Unity's own modules, with no native plugins |
| Release notes | `0.7.1: first Asset Store release.` The next update: `0.7.2: runs on Unity 6.0 LTS and later (it needed 6.3).` |
| Documentation | https://github.com/glitchless-gg/glitchless/blob/main/unity/Packages/gg.glitchless.sdk/README.md (the same README is in the package) |

## Summary

```text
See how your Unity game runs for real players: frame times and stutter with their causes, errors, levels and where players quit, and an MCP server so your coding agent can read it all.
```

## Description

```text
Needs a Glitchless server. Send to your own: the open-source Glitchless server, MIT and free (github.com/glitchless-gg/glitchless). Or to Glitchless Cloud (glitchless.gg), which needs an account: Free is $0 for 5,000 play sessions a month (1 game, 14 days of data), Indie is $19 a month for 25,000, Studio is $99 a month for 250,000. Plans and terms: glitchless.gg/pricing.html and glitchless.gg/terms.html.

Glitchless records how your game runs for real players and gives your coding agent the same data, so it can fix what they hit.

- Stutter. Every frame is timed. Each hitch comes with its likely cause: a garbage collection, a shader compile, a scene load, a burst of new objects, or long script, physics or render work.
- Errors. Uncaught exceptions, Debug.LogError, assertions and engine errors, grouped into issues, with what the player did just before each one.
- Levels and players. Scenes are levels on their own. Deaths, fails, levels left part-way and quits feed the level funnel, death heatmaps and rage-quit detection. Glitchless.CaptureMap takes a picture of each level, so heatmaps show where players died on the level itself.
- Multiplayer. Ping, jitter and disconnects from Netcode for GameObjects or Mirror, with nothing to set up, and a server mode for dedicated servers.
- Bug reports from players, when you turn them on: F8 (or your own button) opens a short form, and the report carries the note, a screenshot and what had just happened.
- WebGL builds name the player's browser and OS, and send their last batch as the page closes.
- Your game's own numbers: track events, count streams, set session properties, and design a dashboard for your game from your coding agent.

Setup without code: add the Glitchless Bootstrap component to your first scene and fill in the server, the game's name and its client token. Or call Glitchless.Init() from a script.

Privacy. Anonymous by default: no player ID, no device identifier, coarse device facts only. Nothing is sent until you call Glitchless.Init() (or add the Bootstrap). Players can turn it off at any time: wire a "Share performance data" setting to Glitchless.SetEnabled(), which stops it at once, deletes what was waiting to be sent, and holds on every later launch. OptIn starts it off until the player says yes. PRIVACY.md, in the package, lists every field and has wording for your privacy policy and store forms.

The client token. A game sends with a public client token (gl_pub_...), which can only send data, so it ships inside your game like an analytics key. Secret keys (gl_sk_..., gl_ws_...) are for servers and agents and never go in a build.

For coding agents. The Glitchless MCP server (the separate npm package glitchless-mcp, or the hosted https://api.glitchless.gg/mcp) lets Claude, Codex, Cursor and others rank what's wrong, read errors and design dashboards. Builds measure themselves with --glitchless-measure=SECONDS, for an agent to compare before and after a change. Nothing in this package runs in the Editor or talks to an AI.

Includes the Fetch! sample: a small runner with an autoplay bot and four planted bugs for Glitchless to find.

This package uses no third-party components.
```

## Technical details

The first line said Unity 6000.3 (6.3 LTS) for 0.7.1; from 0.7.2:

```text
- Unity 6000.0 (6.0 LTS) or later. Built-in, URP and HDRP; CaptureMap (the level picture under heatmaps) renders in Built-in and URP.
- Imports into Assets/Glitchless, with the Fetch! sample game in Assets/Glitchless/Samples/Fetch.
- Dependencies: Unity's own modules only (UnityWebRequest, IMGUI, ImageConversion, ScreenCapture, UI, and Physics for the sample), which every new project has.
- Optional, found at runtime by reflection so the package depends on none of them: Netcode for GameObjects, Mirror, Steamworks.NET or Facepunch.Steamworks. With the Input System, the bug-report key uses it.
- Sends JSON (gzipped, except in WebGL) to the server you choose, every 15 seconds; batches wait on the device while offline and go on a later launch.
- Anonymous, install-ID and full privacy modes; PRIVACY.md lists every field each one sends.
- Starts itself before the first scene so the first frames are kept, but sends nothing until Glitchless.Init(). Define GLITCHLESS_DISABLE to turn the automatic start off.
- A player's off switch: Glitchless.SetEnabled(on) for a settings toggle, saved on the device and read before anything else; OptIn for a game that asks first.
- Code in the GlitchlessSdk namespace, in one assembly (GlitchlessSdk.asmdef). No Editor code, no native plugins, no executables; WebGL builds use one small .jslib that reads the browser and sends the last batch.
- Documentation: README.md, PRIVACY.md and CHANGELOG.md in Assets/Glitchless.
```

## Keywords

```text
analytics, telemetry, performance, profiler, frame time, stutter, crash reporting, error tracking, observability, multiplayer, netcode, bug report, MCP, AI agent, debugging
```

## AI description (1.6.a)

```text
The SDK's code, tests and documentation were written with AI coding agents (Claude Code) under the developer's direction, and checked by the package's automated tests in Unity 6.3. The mascot on the key images was generated with AI; the screenshots are captures of the product.
```

## Third-party software (1.2.a)

None: the package uses only Unity's built-in modules. (If that changes, the package needs a `Third-Party Notices.md`
and this field lists each component; `asset-store.mjs` refuses a `ThirdParty` folder without one.)

## Licence (1.2.c)

The Asset Store copy is sold under the **Asset Store EULA**: `asset-store.mjs` leaves out `LICENSE.md` (and for a UPM
product points `licensesUrl` at https://unity.com/legal/as-terms). The same code stays MIT on GitHub; the copyright holder can offer
both. Publishing it under MIT on the store instead would need Unity's written agreement first.

## Media

See [README.md](README.md#media). Key images: icon, card, cover and social. Screenshots: at least 1,200 px wide.
