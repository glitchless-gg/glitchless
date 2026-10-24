# Glitchless for Godot

A Glitchless SDK for Godot 4.5 and later, built for 4.7 and the Mobile renderer. It sends the same events as the browser SDK (`packages/sdk`), so a Godot game shows up in the same Glitchless server, dashboard, findings, Datadog forwarding and MCP tools with no server changes beyond the small ones listed under [Limits](#limits).

It reports:

- **Frame times.** Each 5 s window carries a mergeable 2% sketch, so the server's p95 and p99 cover every player. Slow frames are flagged the way the browser SDK flags them.
- **Hitches with likely causes.** A pipeline (shader) compile, a burst of new nodes, a scene change, slow `_process` code, physics, rendering, or a frozen frame. Each hitch also carries the game's gauges and the events in the 1.5 s before it.
- **Engine counts.** Draw calls, primitives, objects, nodes, orphan nodes, video memory, and static memory (debug builds only). They're the leak watch.
- **Errors** through Godot 4.5's custom loggers, with script backtraces and the last game events as breadcrumbs.
- **Play events:** the level funnel, deaths, game events and gauges.
- **The device:** a coarse tier, renderer, screen size and the refresh rate the OS reports (the rate the game ran at is measured from its frames, in each frame window). The screen size also shows whether an iPhone Duo is open or closed.
- **Bug reports from players**, when the game turns them on: F8 (or the game's own button) opens a short form, and the report carries what the player typed, a screenshot, where they were and what had just happened.

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
	Glitchless.init("starlift", "", "prod", "https://glitchless.example.com")  # "" = the Steam build, else application/config/version

Glitchless.level_start("voyage_3")
Glitchless.level_complete("voyage_3", score)          # duration measured since level_start
Glitchless.level_fail("voyage_3", "lost")              # lost it: died, ran out of time
Glitchless.level_abandon("voyage_3")                  # left it: home, restart, a menu. Never a fail
Glitchless.death(pos.x, pos.y, "meteor")              # the place is sent only when positions are on
Glitchless.track("play", "endless")                   # one word, a number, or a dictionary
Glitchless.set_context({"blocks": blocks.size()})     # at the end of the frame's work
Glitchless.set_position(player.position)              # ignored unless positions are on
Glitchless.error("save slot unreadable", {"slot": 2}) # an error the game caught itself
var stats := await Glitchless.measure(5.0)            # what --glitchless-measure prints
Glitchless.open_bug_report()                          # the bug report form, from a pause menu
await Glitchless.report_bug(note)                     # or a report from the game's own form
```

**Leaving a level is not losing it.** Call `level_abandon()` when the player leaves a level before it ends (goes to the menu, restarts it), not `level_fail()`: the funnel counts abandons apart, they are never rage quits, and walls are judged only on the sessions that played a level to an end. When the game goes to the background or closes with a level started and not yet completed, failed or abandoned, Glitchless sends the abandon itself, before the session's end, and drops a `level_fail` or `level_abandon` the game sends for that level afterwards (from `_exit_tree`, say). Back from the background in the same session, the level carries on and the server takes the abandon back.

`track` is for the game's own metrics, whatever they are: `track("open", "full")`, `track("play", "endless")`,
`track("buy", {"step": "done"})`. One word becomes the attribute `what`. The dashboard's Events page counts each
event over time, breaks it down by attribute and builds funnels between events, and the game's own dashboard (its
pages designed by your coding agent with `glitchless_set_dashboard`) shows the ones that matter. Attributes are strings, numbers or
booleans, at most 12 per event.

Purchases have one convention in every Glitchless SDK:
`Glitchless.track("purchase", {"amount": 4.99, "currency": "USD", "item": "gems_500"})`. Send it when the store confirms the purchase, with `amount` a number in the currency's units (4.99, not 499) and `currency` the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details.

`init(service, version, env, intake, options)` options. Every one is optional.

| option | default | |
| --- | --- | --- |
| `privacy` | `"anonymous"` | `"install"` adds a random player ID kept in `user://`, so retention can be counted; `"full"` that, device detail and positions. See [PRIVACY.md](PRIVACY.md) |
| `positions` | on in full mode only | death places and 4 Hz position samples |
| `client_token` | `"gl_pub_dev"` | the server's `GLITCHLESS_CLIENT_TOKENS` |
| `sample_rate` | `1.0` | the share of sessions that send |
| `flush_interval` | `5.0` | seconds between batches; the first goes 2 s after `init` |
| `session_type` | `"user"` | `"synthetic"` is automatic with `--autoplay`, `--glitchless-synthetic`, `--glitchless-measure` or `--headless`, and on Firebase Test Lab, where Google Play's pre-launch report runs a new build on Google's phones (the Android setting `firebase.test.lab`) |
| `session_timeout` | `300.0` | seconds in the background after which coming back starts a new session |
| `engine_gauges` | `true` | put `nodes`, `orphan_nodes` and `objects` in `ctx` |
| `measure_render_time` | `true` | renderer CPU (and GPU, where the driver reports it) time per frame |
| `capture_warnings` | `false` | also report `push_warning` and engine warnings |
| `rage_input` | off on phones | the same key or tap four times in a second; fast tapping is normal play in a phone game |
| `enabled` | off in debug builds | force sending on or off |
| `debug` | `false` | print each batch |
| `bug_reports` | `false` | `true`, or `{"hotkey": KEY_F8, "pause": true, "screenshot": true}`: F8 opens the [bug report form](#bug-reports) |

Frame times, errors and events are collected from the first frame. They wait in memory until `init()`, so a game can call it after loading its settings.

### Retention needs install mode

In anonymous mode (the default) nothing is kept between launches, so the dashboard can't tell a returning player from a new one. `{"privacy": "install"}` keeps a random `p_…` player ID in `user://glitchless/player_id` (the one full mode uses) and sends it with every batch; nothing else changes. The Players page and `retention` board panels then show D1, D7 and D30. `Glitchless.reset_install_id()` forgets it (for a "reset my ID" setting): this session keeps its ID, the next launch makes a new one. On a Steam Deck, `session_start` carries `steam_deck: true` and, on SteamOS, `os: "SteamOS"` (Linux builds and Windows builds under Proton).

### Steam

If the game already uses [GodotSteam](https://godotsteam.com), every session also says which Steam build and beta branch it ran, whether on a Steam Deck (with GodotSteam 4.21, also a Steam Machine or Steam Frame, and Proton), in Big Picture mode, with which kind of controller, in which Steam language, and whether through Family Sharing or a timed trial. Nothing to set up and no dependency: the addon reads the `Steam` singleton only when the game has one (`Engine.has_singleton("Steam")`), and only once GodotSteam says Steam is initialised (`steamInitEx()`, initialising from the Project Settings, or `steamInit()` with your app ID), since its calls print engine errors before that. The facts are read when the first batch goes, so a game that initialises Steam after Glitchless still sends them. The controller is known once the game has called `inputInit()`. No Steam ID or name is ever read ([PRIVACY.md](PRIVACY.md#steam-facts) has a paragraph for your privacy page).

**Versions are Steam builds.** Pass `""` as the version and a Steam build reports `steam-<build>` (`steam-18231`), so every upload to Steam is a version the Versions page and `glitchless_compare_versions` can compare. Outside Steam it falls back to `application/config/version`. A version you pass always wins.

**Branches.** Filter any dashboard query with `steam_branch=beta`, split a breakdown panel by `$steam_branch`, or compare branches with a versions panel `by: "$steam_branch"` or `glitchless_compare_versions` with `by: "steam_branch"`.

### Off in debug builds

As with the `Metrics` autoload in Linebreakers and Starlift, a debug build (the editor, or an export with debug on) sends nothing unless it is run with `--glitchless`. That keeps a developer's phone and the agents' bot runs out of the players' numbers. Release exports send by default.

### Bug reports

Players and playtesters flag a problem where they see it, and you (or your coding agent, with the `glitchless_bug_reports` MCP tool) see it in Glitchless's Bug Reports view with the screenshot and a link to the session's replay.

```gdscript
Glitchless.init("starlift", "", "prod", intake, {"bug_reports": true})   # F8 opens the form
Glitchless.init("starlift", "", "prod", intake, {"bug_reports": {"hotkey": KEY_F1, "pause": false}})
Glitchless.bug_report_opened.connect(_pause)          # bug_report_closed too; for games that pause themselves
Glitchless.open_bug_report()                          # a pause menu's "Report a bug" (works without bug_reports)
var result := await Glitchless.report_bug(note)       # the game's own form: {"sent": true}, or {"sent": false, "reason": "offline" | "error"}
```

| `bug_reports` key | default | |
| --- | --- | --- |
| `hotkey` | `KEY_F8` | a `Key`, its name (`"F1"`), or `null` for none. It opens and closes the form |
| `pause` | `true` | pause the tree while the form is open, so the game neither runs nor reads what the player types (nodes set to always process still do). The pause state the game had comes back on close. Use `false` and the signals if the game has its own pause |
| `screenshot` | `true` | send a screenshot with each report |

- **The screenshot** is the root viewport's last frame, read before the form shows, so the form is never in it. It is shrunk until it fits the server's 200,000-character limit: the longer side at most 960 px, then 800, 640, 480 and 320, at lower JPEG quality. The frames that read it back and draw the form aren't timed, so they never show as hitches. A headless run draws nothing, so its reports have no screenshot; `report_bug(note, image)` sends an `Image` you pass, and `report_bug(note, false)` none.
- **The form** is a `CanvasLayer` on layer 128 with the note box, Send and Cancel. Esc cancels, Ctrl+Enter (Cmd+Enter) sends, and a captured mouse is set free while it is open.
- **Sending:** a report goes on a request of its own straight away, from every session (`sample_rate` doesn't apply), with the last 20 game events and hitches, the last frame windows and the device. It waits in the outbox meanwhile, so a report made offline goes with a later batch, even on a later launch. A debug build without `--glitchless` sends nothing, and says so.
- **The note is the player's own words.** [PRIVACY.md](PRIVACY.md#bug-reports-the-players-own-words) says what to tell players, and the dashboard can delete a report a player asks about.

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
| `fps`, `frame_budget_ms`, `refresh_hz`, `pct_frames_over_budget` | the budget is the refresh rate the game actually runs at (60/90/120 Hz, or its own cap), read from the fast frames (their 20th percentile); `refresh_hz` is the screen's rate as the OS reports it |
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
| `gpu_or_os` | none of the above, and everything measured in the game (`_process`, physics, the renderer's CPU and GPU time) adds up to less than 40% of the frame: the time went to the GPU (Godot times it only on Vulkan and Direct3D 12, so on iPhones and the Compatibility renderer it lands here), to presenting the frame, or to the OS |
| `frozen` | over 700 ms |

**Engine counts** go in each frame window, and with `engine_gauges` they also go in `ctx`. The two say different things: the window's own `nodes`, `orphan_nodes` and `objects` are the counts when it closed, and `ctx` holds each gauge's highest value in the window. That is where the findings compare a slow level with the smoothest one: *"`orphan_nodes` sits at 2,500 for this whole level vs 0 on level_1, so objects created earlier are never cleaned up"*. Orphan nodes are nodes that were taken out of the tree and never freed, the commonest Godot leak.

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
- **Offline**, batches are saved to `user://glitchless/outbox.json` and sent on a later launch. At most 4,000 events are kept, and anything over six days old is dropped. In anonymous mode the session ID is not saved: each earlier session's batches go out under a new random ID. Each batch keeps its own `batch_id` through every retry and launch, so the server stores it once even when an answer was lost on the way back.

## What goes on the wire

`POST {intake}/v1/intake?token=…` with the browser SDK's envelope and `sdk: "glitchless-godot/0.2.0"`. Event types and core fields are the same; see [docs/SPEC.md](../../../docs/SPEC.md#5-godot-sdk) for what the Godot SDK adds. The browser fields it can't fill (`geometries`, `textures`, `programs`, `page`, `loaf`) are sent as null or empty.

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

- `npm run test:godot` runs the demo game (`godot/demo`) headless against a fresh local server and checks everything above through `/v1/query`. It covers offline saving, anonymous and full mode, errors, background and resume, `--glitchless-measure`, and bug reports: one from code, one typed into the F8 form (key presses pushed into the viewport) and one sent offline. It first runs `test/bug_report_test.gd`, which checks the screenshot shrinking, the slimmed events and the hotkey names.
- `npm test` includes `server/test/godot.test.js`. It checks that the GDScript sketch buckets every frame time like the JavaScript one, and that the server merges the two.
