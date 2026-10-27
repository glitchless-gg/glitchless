# Fab listing: Glitchless for Unreal

Every field of the Fab listing, in the order [STEPS.md](STEPS.md) fills them in. Paste the text inside each box as it
is. Fab's own rules for these fields are in its [Technical Requirements](https://www.fab.com/technical-requirements)
(§1.8 for the product page, §4 for Unreal Engine; read 2026-10-23, "Last Updated: September 21, 2026").

## Title

```text
Glitchless Game Observability
```

That's 29 characters; Fab suggests 30 or fewer. If it's taken: `Glitchless: Stutter & Crash Finder` (34).

## Short description

For any field that asks for a one-line summary, and for the forum post if one is made.

```text
See how your Unreal game runs for real players: every stutter with its cause, crashes and ensures, where players quit, and bug reports with screenshots. Your coding agent reads it all over MCP. Free and open source.
```

## Description

```text
Glitchless shows you how your game runs for the people playing it, and gives your coding agent the same data, so it can fix what they hit.

Add the plugin, fill in three settings, and every play session reports:

• Stutter, with its cause. Every frame is timed on the game, render and RHI threads and the GPU. Each hitch says what held it up: a pipeline state created on the spot (a PSO), garbage collection, a map load, a streamed level, an asset load, or a long game or render frame.
• Errors and crashes. UE_LOG errors, ensures with their callstacks, Blueprint runtime errors (Accessed None and the rest) and crashes, which are written down as the game dies and sent the next time it starts. They're grouped into issues, each with what the player did just before.
• Where players give up. Maps are levels on their own; deaths, fails, levels left halfway and quits feed level funnels, death heatmaps and rage-quit detection.
• Bug reports. Players press F8 (or a button in your menu) to send a note and a screenshot from where they are.
• Leaks. UObject and actor counts and memory, level by level.
• Multiplayer. On a client, ping, packet loss and disconnects come from Unreal's own replication; on a dedicated or listen server, tick rate, players and server crashes, filed apart from the players. Matches, parties and runs tie sessions together, so you can tell a lagging lobby (the server) from one lagging player (their connection).
• Your game's own terms. Counters for things that happen hundreds of times a second (shots, gold), player properties such as class or rank to split any chart by, level attributes such as difficulty, and zones in an open world.
• Steam and TestFlight. On Steam, each session says its build, branch and hardware (Steam Deck included), so you can compare a beta branch or a Deck against everyone else. On iOS, TestFlight and development installs count as testers, not players, and their purchases stay out of revenue.

Glitchless then ranks what it found. Each finding says what's wrong, how many players it hits and what usually fixes it, in Unreal's terms: turn PSO precaching on and ship a bundled PSO cache; pool actors instead of making a UObject per shot; test a pointer with IsValid(). Your coding agent (Claude Code, Codex, Cursor and others) reads the same findings over MCP, changes the game, and measures the new build with -glitchless-measure.

Setup needs no code: Project Settings → Plugins → Glitchless → Service, Intake and Client Token. Blueprint nodes and a C++ API (FGlitchless) let you name levels, deaths, pickups and anything else you want counted.

You need a Glitchless server to send to: the open-source one runs on your own machine with one command (Node.js), or use the hosted service at glitchless.gg.

Private by default: no player ID, no device identifier, only coarse device facts. Players can turn it off at any time: wire a "Share performance data" setting to the Set Enabled node, which stops it at once, deletes what was waiting to be sent, and holds on every later launch; Opt In starts it off until the player says yes. PRIVACY.md lists every field that each of the three modes (anonymous, install, full) sends, with wording for your privacy policy and store forms.

Made for Unreal Engine 5.8. The source is MIT-licensed on GitHub, with a small demo game that has three planted problems for Glitchless to find.

Optional, separate and Experimental: the Glitchless Toolset plugin on GitHub adds Status and Measure tools to Epic's Unreal MCP (Experimental in UE 5.8), so an agent can measure the game in Play In Editor. This product doesn't include it or need it.
```

## Technical information

Fab §1.8.4: every relevant field filled in, and every dependency or prerequisite named.

```text
Features:
- Frame times in 5-second windows (p50, p95, p99 and a mergeable sketch) on the game, render and RHI threads and the GPU
- Hitches with their likely causes: pso_compile, shader_compile (editor), gc, map_load, level_stream, asset_load, script, render, gpu_or_os, frozen
- UE_LOG errors, ensures, Blueprint runtime errors and crashes (written to disk as the game dies, sent on the next launch)
- Maps as levels, deaths, level complete, fail and abandon, custom events (Track), gauges (Set Context), positions for heatmaps
- In-game bug reports: a key (F8) or a Blueprint node opens a Slate box with a screenshot and a note
- An offline outbox, gzip and retries, with an ID on every batch so a retried send is stored once; -glitchless-measure prints frame stats as JSON for agents and CI
- Steam facts per session when the game already uses Steamworks (build, branch, Steam Deck and other hardware, Proton, Big Picture); never a Steam ID
- iOS: App Store, TestFlight and development installs told apart; testers' sessions and sandbox purchases kept out of players and revenue
- Multiplayer: net driver ping, packet loss and jitter, disconnects with their reason, match/party/run groups (IDs hashed by default); a server role for dedicated and listen servers (tick rate, players, server crashes)
- Counters, player properties, level attributes, zones, and list and boolean attributes (FGlitchlessAttributes)
- The player's off switch: Set Enabled (FGlitchless::SetEnabled) for a "Share performance data" toggle, saved on the device and read before the first frame; Opt In for a game that asks first
- A Project Settings page, a Blueprint function library, a C++ API and a game instance subsystem

Code Modules:
- Glitchless (Runtime)

Number of Blueprints: 0
Number of C++ Classes: 17
Network Replicated: No
Supported Development Platforms: Windows, Mac
Supported Target Build Platforms: Windows, Mac
Documentation: https://github.com/glitchless-gg/glitchless/blob/main/unreal/Plugins/Glitchless/README.md
Example Project: https://github.com/glitchless-gg/glitchless/tree/main/unreal/demo

Important/Additional Notes:
- Needs a Glitchless server to send to: the open-source server (Node.js 20 or later, MIT, https://github.com/glitchless-gg/glitchless) or the hosted service at https://glitchless.gg.
- Network use: HTTPS POST requests (or HTTP to a server on your own machine) of gzipped JSON to the Intake URL you set, every 15 seconds and when the game quits. Nothing is sent until Service and Intake are set. Enabled off, or -glitchless-off on the command line, sends nothing.
- Privacy: anonymous by default, with no player ID and no device identifier. A player who turns it off (Set Enabled, from the game's settings) sends nothing more, in that launch or any later one. PRIVACY.md in the plugin lists every field each mode sends.
- Dependencies: engine modules only (HTTP, ImageWrapper, Slate, RHI and others). No other plugins; Steam facts are read only through the Steamworks the game already set up.
- Third-party code: the natural logarithm from fdlibm 5.3 (Sun Microsystems, freely redistributable, as in V8), so frame-time buckets match the JavaScript SDK exactly.
```

Before submitting, make **Supported Target Build Platforms** match what was actually built and run (Fab §4.2.3.a):
Win64 only once the Windows build has passed. iOS, Android and Linux compile in the plugin's code, but nobody has
run them yet, so leave them out.

## Tags

Fab §1.8.5: accurate and relevant. Add these, or the closest ones the tag picker offers:

```text
analytics, telemetry, performance, profiling, optimization, debugging, crash reporting, bug report, stutter, hitch, PSO, garbage collection, metrics, dashboard, MCP, AI, C++, Blueprint, tools, code plugin
```

## Category

**Tools & Plugins.** For the subcategory, pick the one the portal lists that's closest to engine or debugging tools
(for example "Engine Tools" or "Utility").

## Price and license

**Free** ($0.00) under Fab's Standard license. The same source stays MIT on GitHub; publishing it on Fab under Fab's
license is the copyright holder's own choice. If you'd rather charge, the lowest paid price is $0.99 (Fab's Licenses
and Pricing page).

## Project version (one per engine version, Fab §4.2.2.d)

| field | value |
| --- | --- |
| Engine version | **5.8** |
| Target platforms | **Windows** and **Mac** (see the note under Technical information) |
| Distribution method | **Engine Plugin** (Fab installs code plugins into `Engine/Plugins/Fab`, §4.3.6.3.a) |
| Project file link | a direct download of `Glitchless_0.4.0_UE5.8.zip` that needs no sign-in (§4.2.1, and the asset file format page) |
| Version notes | `0.4.0: first Fab release, for Unreal Engine 5.8.` |

## Third-party software declaration (Fab §4.2.5)

Answer **"This product uses third-party software"**, then fill in Fab's form with:

| | |
| --- | --- |
| Name | fdlibm (Freely Distributable LIBM) 5.3: `__ieee754_log`, as V8 carries it |
| Where | `Source/ThirdParty/fdlibm/fdlibm_log.h`, with its own README |
| Licence | Sun Microsystems notice: "Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved." The notice is kept in the file |
| Why | the frame-time sketch has to bucket values exactly as JavaScript's `Math.log` does, on every platform |
| Distributed | as source, compiled into the plugin |

The rest is engine code (HTTP, ImageWrapper, Slate, FCompression for gzip). There are no fonts, images or sounds.

## Declarations

| Fab question | answer | why |
| --- | --- | --- |
| Created with AI (§1.8.8) | **Yes** | the plugin's code and docs were written with coding agents (Claude Code), and the mascot in the thumbnail is a generated image |
| Mature content (§1.8.9) | **No** | |
| Promotional content (§1.8.10) | **No paid promotion.** The listing points to the hosted glitchless.gg service, which is the publisher's own | |
| Experimental features (§4.3.1.d) | none in this product; the description says the optional Toolset (GitHub only) uses Experimental Unreal MCP | |

## Publisher profile and support (Fab §1.1, §1.3)

| field | value |
| --- | --- |
| Publisher name | `Glitchless` (§1.3.a bars Epic or Unreal words; this has none) |
| Creator code | `glitchless` (or the closest one free) |
| Website | `https://glitchless.gg` |
| Support email | `support@glitchless.gg` |
| Support URL | `https://github.com/glitchless-gg/glitchless/issues` |
| Documentation URL | `https://github.com/glitchless-gg/glitchless/blob/main/unreal/Plugins/Glitchless/README.md` |
| Profile photo | `media/profile-photo-500.png` (500 × 500, the logo on full navy) |
| Cover photo | `media/cover.png` (1920 × 540) |

Bio:

```text
Glitchless makes observability tools for game developers and their coding agents.

Our plugins time every frame on real players' machines, catch crashes and errors, and show where players quit. Your coding agent (Claude Code, Codex, Cursor and others) reads the same data over MCP, so you can ask it why a level stutters and let it fix the cause.

The Unreal plugin is free C++ source with Blueprint nodes. It works with the hosted service at glitchless.gg or with a server you run yourself from our open-source repo. We also make SDKs for Unity, Godot, Three.js and GameMaker.

Support: support@glitchless.gg · github.com/glitchless-gg/glitchless/issues
```

## FabURL (Fab §4.3.6.c)

Fab wants the `.uplugin` to carry `FabURL`: `com.epicgames.launcher://ue/Fab/product/<id>`, where `<id>` is the ID at the
end of the listing's URL in the publisher portal. That ID exists only once the draft listing is made, so STEPS.md
makes the draft first and then builds the zip with `--fab-url`, which stamps it in.

## FAQ (optional, "+ Add FAQ")

```text
Q: Do I need a server?
A: Yes, somewhere to send the data. Run the open-source Glitchless server on your own machine (npm run server, from the GitHub repo) or use the hosted service at glitchless.gg. Set its address as the Intake in Project Settings → Plugins → Glitchless.

Q: Does it slow my game down?
A: It times each frame and does its work in small batches every 15 seconds; there is nothing per object or per draw call. The heaviest moment is a bug report, which reads the screen once.

Q: Does it work with Blueprint-only projects?
A: Yes, installed from Fab: Fab builds the binaries. From GitHub, a Blueprint-only project needs one C++ class first, because the plugin is source.

Q: What does it send about my players?
A: In the default anonymous mode, no player ID, no device identifier and only coarse device facts. PRIVACY.md in the plugin lists every field per mode, with wording for your privacy policy.

Q: Can my coding agent use it?
A: Yes. The glitchless-mcp server (npm) gives Claude Code, Codex, Cursor and other MCP clients the findings, errors, sessions and bug reports; packaged builds measure themselves with -glitchless-measure.
```

## Media

The images are in [`media/`](media), each 1920 × 1080 PNG. [README.md](README.md) says how they were made.

| slot | file | shows |
| --- | --- | --- |
| Thumbnail | `media/thumbnail.png` | the Glitchless mark and "Stutter, crashes and bug reports from real players, for Unreal" |
| Gallery 1 | `media/gallery-01-findings.png` | the dashboard's findings for the demo: the PSO hitch, the GC spikes and the ensure, each with Unreal advice |
| Gallery 2 | `media/gallery-02-performance.png` | the Performance page: frame time and hitch causes by level |
| Gallery 3 | `media/gallery-03-errors.png` | the Errors page: the ensure with its stack and the events before it |
| Gallery 4 | `media/gallery-04-demo.png` | the demo's gallery level as the fireworks go off |
| Gallery 5 | `media/gallery-05-setup.png` | the no-code setup in Project Settings, and the Blueprint nodes |
| Gallery 6 | `media/gallery-06-agent.png` | an agent's view: the finding over MCP and `-glitchless-measure` JSON |
