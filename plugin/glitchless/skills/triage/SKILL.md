---
name: triage
description: Find and fix the most important problem in a web game using Glitchless player telemetry — frame-time hitches, GPU/geometry leaks, errors, difficulty spikes and rage quits — then verify the fix with live measurements. Use when the user asks what's wrong with their game, why it stutters or lags, why players quit, or to "fix the Glitchless findings".
---

# Triage a game with Glitchless

You have two sources of truth:
- **Glitchless MCP** (`glitchless_*` tools without "live") — production telemetry from every player, aggregated.
- **WebMCP** (`glitchless_live_performance`, `glitchless_measure`, `glitchless_inspect_scene`, `glitchless_errors`, plus the game's own tools like `<game>_load_level`) — the game running in the user's browser right now. Tool names may carry a channel prefix (e.g. `localhost_5173-glitchless_measure`).
  If WebMCP tools are missing, ask the user to open the game, call the `_webmcp_get-token` tool and have them paste the token into the WebMCP widget. Work without it if they decline.

## Loop

1. **Rank.** Call `glitchless_triage` (24h by default). Pick the top finding, or the one the user named. Say in one line which one and why (severity × share of players affected).
2. **Get the evidence.** Drill in by category:
   - performance → `glitchless_performance` with `level`: look at `hitch_context` (which gauges spike during hitches, which events precede them) and `slowest_recent_hitches[].loaf` (script attribution).
   - memory → `glitchless_performance` `memory` + `by_level.geometries_max`.
   - stability → `glitchless_get_error` with the fingerprint: stack, `location`, breadcrumbs.
   - design → `glitchless_death_hotspots` for the level, then `glitchless_player_funnel`.
3. **Find the code.** Use the evidence as search keys: event names from `preceding_events` (e.g. the `glitchless.track('powerup')` call site), gauge names passed to `glitchless.setContext`, the error's function/file, level data near the hotspot's x range.
4. **Reproduce and baseline (if WebMCP is connected).** Load the level / trigger the effect with the game's tools, then run `glitchless_measure` for 5–10s. Record p95, worst frame, draw calls, peak gauges, geometry delta. For errors, reproduce and confirm with `glitchless_errors`.
5. **Save a playtest baseline before touching code.** Call `glitchless_playtest` with `save_as: "baseline"`. The game's autoplay bots play fixed-seed runs on the current code so you can prove later that your change made nothing else worse. It needs the game and Glitchless server running and Playwright in the project; if it can't run, say so and continue.
6. **Fix the root cause**, minimally and idiomatically:
   - many short-lived meshes → one `InstancedMesh`/`THREE.Points` or a pool; shared geometry/material; remove **and** `dispose()` when done
   - geometry growth per level load → dispose geometries/materials/textures on unload; share per-tile geometry
   - shader-compile hitches → `renderer.compileAsync(scene, camera)` during loading
   - unchecked lookups (`pool.find()` → undefined) → handle exhaustion gracefully, and apply game state (score) before anything that can throw
   - **design findings** (a jump nobody makes): propose 1–2 concrete level-data changes with the numbers, and ask the user before changing game design.
7. **Verify.** Reload, repeat the exact reproduction, `glitchless_measure` again. Show a before/after table. Drop a breadcrumb with `glitchless_annotate` (e.g. "agent: confetti → InstancedMesh, p95 48→15ms").
8. **Playtest the change.** Call `glitchless_playtest` with no arguments to compare every scenario against the baseline. A FAIL means the work isn't done: read the regressions and new errors, fix them, and run it again. Report the verdict and the improvements table to the user.
9. **Version it.** Bump the patch version passed to `Glitchless.init` so production data from the fix is separable, and tell the user to run `glitchless_compare_versions` (or open Versions in the dashboard) once players have played the new build.

Never claim a fix worked without a measurement and a passing playtest; if you couldn't run either, say so and say what to watch in production.
