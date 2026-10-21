# Glitchless for Godot

A Glitchless SDK for Godot 4.5 and later, built for 4.7 and the Mobile renderer. It sends the same events as the browser SDK (`packages/sdk`), so a Godot game shows up in the same Glitchless server, dashboard, findings, Datadog forwarding and MCP tools with no server changes beyond the small ones listed under [Limits](#limits).

It reports:

- **Frame times.** Each 5 s window carries a mergeable 2% sketch, so the server's p95 and p99 cover every player. Slow frames are flagged the way the browser SDK flags them.
- **Hitches with likely causes.** A pipeline (shader) compile, a burst of new nodes, a scene change, slow `_process` code, physics, rendering, or a frozen frame. Each hitch also carries the game's gauges and the events in the 1.5 s before it.
- **Engine counts.** Draw calls, primitives, objects, nodes, orphan nodes, video memory, and static memory (debug builds only). They're the leak watch.
- **Errors** through Godot 4.5's custom loggers, with script backtraces and the last game events as breadcrumbs.
- **Play events:** the level funnel, deaths, game events and gauges.
- **The device:** a coarse tier, renderer, screen size and refresh rate. The screen size also shows whether an iPhone Duo is open or closed.

It also has an agent flag, `--glitchless-measure=SECONDS`, which prints frame stats as JSON and quits. It's the native version of the browser SDK's `glitchless_measure` tool.

Anonymous mode, the default, sends nothing that can be tied to a person. [PRIVACY.md](PRIVACY.md) lists every field each mode sends. [PORTING.md](PORTING.md) shows how a game that counts events with its own `Metrics.count(event, word)` moves over.

## Install

1. Copy `addons/glitchless/` into the game's `addons/`.
2. Add the autoload. Either turn on the plugin under *Project Settings → Plugins*, or add this line under `[autoload]` in `project.godot`:

   ```ini
   Glitchless="*res://addons/glitchless/glitchless.gd"
   ```

3. Optional, for script lines on errors in release builds: *Project Settings → Debug → GDScript → Always Track Call Stacks* (`debug/settings/gdscript/always_track_call_stacks=true`). It makes every GDScript call do a little more work. Without it, a release build reports the engine's own file and function instead.

The addon uses no `class_name`, so it adds no global names and works in a project that has never been opened in the editor.

## Use

```gdscript
func _ready() -> void:
	Glitchless.init("starlift", "", "prod", "https://glitchless.example.com")  # "" = application/config/version

Glitchless.level_start("voyage_3")
Glitchless.level_complete("voyage_3", score)          # duration measured since level_start
Glitchless.level_fail("voyage_3", "lost")
Glitchless.death(pos.x, pos.y, "meteor")              # the place is sent only when positions are on
Glitchless.track("play", "endless")                   # one word, a number, or a dictionary
Glitchless.set_context({"blocks": blocks.size()})     # at the end of the frame's work
Glitchless.set_position(player.position)              # ignored unless positions are on
Glitchless.error("save slot unreadable", {"slot": 2}) # an error the game caught itself
var stats := await Glitchless.measure(5.0)            # what --glitchless-measure prints
```

`init(service, version, env, intake, options)` options. Every one is optional.

| option | default | |
| --- | --- | --- |
| `privacy` | `"anonymous"` | or `"full"`; see [PRIVACY.md](PRIVACY.md) |
| `positions` | on in full mode only | death places and 4 Hz position samples |
| `client_token` | `"gl_pub_dev"` | the server's `GLITCHLESS_CLIENT_TOKENS` |
| `sample_rate` | `1.0` | the share of sessions that send |
| `flush_interval` | `5.0` | seconds between batches; the first goes 2 s after `init` |
| `session_type` | `"user"` | `"synthetic"` is automatic with `--autoplay`, `--glitchless-synthetic`, `--glitchless-measure` or `--headless` |
| `session_timeout` | `300.0` | seconds in the background after which coming back starts a new session |
| `engine_gauges` | `true` | put `nodes`, `orphan_nodes` and `objects` in `ctx` |
| `measure_render_time` | `true` | renderer CPU (and GPU, where the driver reports it) time per frame |
| `capture_warnings` | `false` | also report `push_warning` and engine warnings |
| `rage_input` | off on phones | the same key or tap four times in a second; fast tapping is normal play in a phone game |
| `enabled` | off in debug builds | force sending on or off |
| `debug` | `false` | print each batch |

Frame times, errors and events are collected from the first frame. They wait in memory until `init()`, so a game can call it after loading its settings.

### Off in debug builds

As with the `Metrics` autoload in Linebreakers and Starlift, a debug build (the editor, or an export with debug on) sends nothing unless it is run with `--glitchless`. That keeps a developer's phone and the agents' bot runs out of the players' numbers. Release exports send by default.

### Flags

These go after `--` on the command line, like the games' own debug flags.

| flag | |
| --- | --- |
| `--glitchless` | send from a debug build too |
| `--glitchless-intake=URL` | send to this server instead of the one in `init()`, and turn sending on |
| `--glitchless-measure=SECONDS` | print frame stats as one line of JSON, `{"glitchless_measure": {...}}`, then quit |
| `--glitchless-warmup=SECONDS` | with `--glitchless-measure`: wait this long before measuring |
| `--glitchless-out=PATH` | with `--glitchless-measure`: write the line to this file too |
| `--glitchless-synthetic` | mark the session as a bot's (`--autoplay` does too) |
| `--glitchless-debug` | print what is sent |

## For agents: `--glitchless-measure`

```bash
godot --path . -- --autoplay --seed=7 --glitchless-measure=10 | grep '^{"glitchless_measure"'
```

It works in any build, sends nothing unless sending is on, and quits when done. The fields match the browser SDK's `glitchless_measure`:

| field | |
| --- | --- |
| `frame_ms` | `p50`, `p95`, `p99`, `worst` |
| `fps`, `frame_budget_ms`, `refresh_hz`, `pct_frames_over_budget` | the budget is the refresh rate the game actually runs at (60/90/120 Hz, or its own cap), read from the median early frame |
| `hitches`, `hitch_count` | up to 10 hitches: `ms`, `causes`, `ctx`, `recent` events |
| `render_cpu_ms`, `gpu_ms` | the renderer's time per frame; `gpu_ms` is null where the driver doesn't report it (Metal) |
| `process_ms` | all the game's `_process` code per frame |
| `draw_calls`, `triangles_avg` | |
| `peak_context` | the highest value of each gauge |
| `memory`, `memory_delta` | objects, nodes, orphan nodes, resources, video MB and static MB, now and change over the run |
| `new_errors`, `errors` | errors during the run, grouped, with locations |
| `level_start`, `level_end`, `headless` | under `--headless` nothing is drawn and frames run uncapped, so frame times mean little there |

Run the same seed before and after a change to compare.

## What it measures

**Frame times** are the wall-clock time between frames, read in `_process`. The `delta` Godot passes in is smoothed (`application/run/delta_smoothing` is on by default) and scaled by `Engine.time_scale`, either of which would hide a stutter. These rules follow `packages/sdk/src/core.js`:

- A **hitch** is a frame over 50 ms *and* over twice the median of the last 60.
- **Jank** is a frame over 33.4 ms.
- A **frozen** frame is over 700 ms.
- A run of long frames is the OS throttling a hidden window, so it is dropped.
- Time spent in the background is never counted as a frame.

**Hitch causes** come from what the slow frame measured:

| cause | when |
| --- | --- |
| `shader_compile` | the engine's pipeline-compile counters went up |
| `scene_change` | `current_scene` changed |
| `node_spawn` | 50 or more nodes were added |
| `script` | `_process` code took 40% of the frame. Glitchless runs first in each frame and has a child node that runs last, so the gap between them is every other node's `_process` |
| `physics` | physics steps took 40% of the frame |
| `render` | the renderer's CPU and GPU time took 40% of the frame |
| `frozen` | over 700 ms |

**Engine counts** go in each frame window, and with `engine_gauges` they also go in `ctx`. That is where the findings compare a slow level with the smoothest one: *"`orphan_nodes` sits at 2,500 for this whole level vs 0 on level_1, so objects created earlier are never cleaned up"*. Orphan nodes are nodes that were taken out of the tree and never freed, the commonest Godot leak.

A frame window never spans two levels: `level_start` closes the current one.

## Errors

A custom `Logger` (Godot 4.5+) hears every engine and script error, on any thread. Glitchless groups them with the browser SDK's fingerprint, made from the kind, the message with long numbers blanked, and the function. Each error event also carries the last six game events (`recent`). The server adds breadcrumbs from the session's stored events.

| kind | what |
| --- | --- |
| `script` | a GDScript runtime error, which stops the function part way. Counted as unhandled, like an uncaught JS exception |
| `engine` | an error from the engine's own code, usually a bad call from a script (a missing node, a failed load). The engine's C++ location is the first stack line, the script lines follow |
| `push_error` | the game's own `push_error()` |
| `shader` | a shader compile error |
| `manual` | `Glitchless.error()` |
| `warning` | only with `capture_warnings` |

Paths on the device are cut out of messages before they're sent: the user-data folder becomes `user://`, the user-name part of `/Users/…` or `C:\Users\…` becomes `~`, and iOS container IDs become `<id>`. Errors raised inside the addon are never reported, so a failing send can't feed itself. Each kind of error is sent at most 25 times per session.

**Release builds catch fewer errors than debug builds.** Godot leaves most GDScript runtime checks out of release exports. This was measured with a macOS release export of Godot 4.7.2, with *Always Track Call Stacks* on:

| in the game's code | debug build | release export |
| --- | --- | --- |
| `get_node()` on a missing path, `load()` of a missing file, a null argument to an engine call | `engine`, with script line | `engine`, with script line |
| `push_error()` | `push_error` | `push_error` |
| index out of range, missing dictionary key, missing method, call on an untyped null, divide by zero | `script` | **nothing**: the code carries on |
| call on a *typed* null (`var n: Node = null; n.free()`) | `script` | **the game crashes** (SIGSEGV) |

So run the bots (`--autoplay --seed`) in debug builds with `--glitchless` to catch script mistakes, and let release builds report engine errors, `push_error` and performance. Native crashes are left to the platform: Xcode Organizer and App Store Connect on iOS, Android vitals in the Play Console. Glitchless sees a crash only as a session that stops without a `session_end`.

## Phones: background, close, offline

- **Going to the background ends the session.** iOS and Android usually stop a backgrounded app without warning, so on `NOTIFICATION_APPLICATION_PAUSED` Glitchless sends `session_end` (`reason: "background"`) at once. It waits up to 1.5 s on the network, then saves whatever didn't go.
- **Coming back** within `session_timeout` carries on the same session with an `app_resume` event. A later `session_end` then replaces the first. Coming back later than that starts a new session with a new random ID.
- **Closing** (the window's close button, Android's back button, or `get_tree().quit()`) sends `session_end` the same way.
- **Offline**, batches are saved to `user://glitchless/outbox.json` and sent on a later launch. At most 4,000 events are kept, and anything over six days old is dropped. In anonymous mode the session ID is not saved: each earlier session's batches go out under a new random ID.

## What goes on the wire

`POST {intake}/v1/intake?token=…` with the browser SDK's envelope and `sdk: "glitchless-godot/0.1.0"`. Event types and core fields are the same; see [docs/SPEC.md](../../../docs/SPEC.md#5-godot-sdk) for what the Godot SDK adds. The browser fields it can't fill (`geometries`, `textures`, `programs`, `page`, `loaf`) are sent as null or empty.

## Limits

- **Godot 4.5 or later.** The `Logger` class came in 4.5.
- **The server:**
  - GDScript runtime errors count as unhandled because `server/src/analytics.js` treats kind `script` like `js`.
  - Deaths sent without a place, as anonymous mode sends them, are left off heatmaps and hotspot findings.
  - The memory-leak finding still reads three.js geometry counts. Godot leaks show through the `orphan_nodes` and `nodes` gauges instead.
  - Fix suggestions in findings are written for three.js.
- **Web exports** are untested. A web game is better served by the browser SDK.
- Sending uses `HTTPRequest` while the game runs and a blocking `HTTPClient` for the last batch, which has no frames left to finish an `HTTPRequest`. A batch the server received just before a close can arrive twice.

## Tests

From the repo root:

- `npm run test:godot` runs the demo game (`godot/demo`) headless against a fresh local server and checks everything above through `/v1/query`. It covers offline saving, anonymous and full mode, errors, background and resume, and `--glitchless-measure`.
- `npm test` includes `server/test/godot.test.js`. It checks that the GDScript sketch buckets every frame time like the JavaScript one, and that the server merges the two.
