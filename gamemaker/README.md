# Glitchless for GameMaker

A Glitchless SDK for GameMaker 2024.2 and later, written in GML and built for LTS 2026 (runtime 2026.0.0.23). It sends the same events as the browser SDK (`packages/sdk`), so a GameMaker game shows up in the same Glitchless server, dashboard, findings and MCP tools as the browser, Godot, Unity and Unreal games.

It reports:

- **Frame times.** Each 5 s window carries a mergeable 2% sketch, so the server's p95 and p99 cover every player.
- **Hitches with likely causes:** a texture page loaded on first draw, a room change, a garbage collection, a burst of new instances, slow Step code, slow drawing, or a frozen frame. Each hitch also carries the game's gauges and the events in the 1.5 s before it.
- **Engine counts:** instances, the runner's memory, and the surfaces, DS lists and maps and buffers in memory. GameMaker frees none of the last four by itself, so a count that only climbs is a leak.
- **Rooms as levels.** A room that reads as a level (`rm_cave_2`, not `rm_main_menu`) starts that level by itself.
- **Errors and crashes.** An unhandled exception stops a GameMaker game: Glitchless writes it down as the game dies and sends it on the next launch. Errors the game catches go through `glitchless_error`.
- **Play events:** the level funnel, deaths, the game's own events and gauges.
- **Bug reports from players**, when the game turns them on: F8 (or the game's own button) opens a short form, and the report carries what the player typed, a screenshot, where they were and what had just happened.

It also has an agent flag, `-glitchless-measure=SECONDS`, which prints frame stats as JSON and quits, like the Godot, Unity and Unreal SDKs.

Anonymous mode, the default, sends nothing that can be tied to a person. [PRIVACY.md](PRIVACY.md) lists every field each mode sends.

## Install

1. Get the local package, `Glitchless-0.2.0.yymps`: from the [0.2.0 release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-gamemaker/v0.2.0), or make it with `node gamemaker/tools/project.mjs package` (it lands in `gamemaker/dist/`).
2. In GameMaker: **Tools → Import Local Package**, pick the file, **Add All**, **Import**. It adds a *Glitchless* folder with eight scripts and two objects, `obj_glitchless` and `obj_glitchless_tail`. Don't place the objects in a room: `glitchless_init` makes them.
3. Call `glitchless_init` once, as early as you can: the first room's creation code, or the Create event of your first object.
4. For a sandboxed macOS build (the Mac App Store): **Game Options → macOS → Allow outgoing network connections**.

The SDK's own names all start with `glitchless_`, `__glitchless_` or `GLITCHLESS_`, so they won't clash with a game's.

## Use

```gml
glitchless_init("caverun", "", "prod", "https://glitchless.example.com"); // "" = GM_version, from Game Options

glitchless_level_start("cave_3");               // only if rooms aren't your levels (see below)
glitchless_level_complete(undefined, score);    // undefined: the current level; duration measured since it started
glitchless_level_fail(undefined, "lost");          // lost it: died, ran out of time
glitchless_level_abandon();                     // left it: the menu, a restart. Never a fail
glitchless_death(x, y, "spikes");               // the place is sent only when positions are on
glitchless_track("play", "endless");            // one word, a number, or a struct
glitchless_set_context({ enemies: instance_number(obj_enemy) }); // in an End Step event
glitchless_set_position(obj_player.x, obj_player.y); // ignored unless positions are on
try { load_save(); } catch (_e) { glitchless_error(_e, { slot: 2 }); } // an error the game caught
glitchless_measure(5, function(_stats) { show_debug_message(json_stringify(_stats)); });
glitchless_open_bug_report();                   // the bug report form, from a pause menu
glitchless_report_bug(note);                    // or a report from the game's own form
glitchless_quit();                              // the Quit button: sends the last batch, then game_end()
```

`glitchless_track` is for the game's own metrics, whatever they are: `glitchless_track("open", "full")`, `glitchless_track("buy", { step: "done" })`. One word becomes the attribute `what`. The dashboard's Events page counts each event over time, breaks it down by attribute and builds funnels between events. Attributes are strings, numbers or booleans, at most 12 per event.

| function | |
| --- | --- |
| `glitchless_init(service, version, env, intake, options)` | who the game is and where to send. Nothing is measured or sent before it |
| `glitchless_level_start(level)` | closes the current frame window, so a window never spans two levels. The first call turns rooms as levels off |
| `glitchless_level_complete([level], [score], [duration_s])`, `glitchless_level_fail([level], [cause])` | |
| `glitchless_level_abandon([level])` | the player left the level before it ended (the menu, a restart): never counted as a fail or a rage quit. Quitting mid-level sends one by itself, before the session's end, and a `glitchless_level_fail` or `glitchless_level_abandon` for that level after that (from a Clean Up event, say) is dropped. A room level that ends with its room (back in a menu) closes without one |
| `glitchless_death(x, y, [cause], [z])` | |
| `glitchless_track(name, [what])` | |
| `glitchless_set_context(struct)` | numbers that describe what is going on: the largest value in each window is sent, and the current ones go with each hitch |
| `glitchless_set_position(x, y, [z])` | sampled 4 times a second for heatmaps, when positions are on |
| `glitchless_error(message_or_exception, [attrs])` | |
| `glitchless_crash(exception)` | for a game with its own `exception_unhandled_handler` (see [Errors](#errors)) |
| `glitchless_report_bug([note], [screenshot], [callback])` | `callback({sent})`, or `{sent: false, reason: "offline" or "error"}` |
| `glitchless_open_bug_report()`, `glitchless_bug_report_is_open()` | |
| `glitchless_measure(seconds, callback)` | what `-glitchless-measure` prints |
| `glitchless_flush()` | closes the window and sends what is waiting; runs by itself every few seconds |
| `glitchless_quit()` | see [Quitting](#quitting-offline-and-crashes) |
| `glitchless_has_flag(name)`, `glitchless_flag_value(name, [fallback])` | read the game's own flags (`-autoplay`, `-seed=7`) where Glitchless reads its own |
| `glitchless_stats()`, `glitchless_session_id()` | for a debug overlay or a support screen |

`glitchless_init` options. Every one is optional.

| option | default | |
| --- | --- | --- |
| `privacy` | `"anonymous"` | `"install"` keeps a random player ID on the device, so returning players can be counted; `"full"` adds device detail and positions. See [PRIVACY.md](PRIVACY.md) |
| `positions` | on in full mode only | death places and 4 Hz position samples |
| `client_token` | `"gl_pub_dev"` | the server's `GLITCHLESS_CLIENT_TOKENS` |
| `sample_rate` | `1` | the share of sessions that send |
| `flush_interval` | `5` | seconds between batches; the first goes 2 s after `glitchless_init` |
| `session_type` | `"user"` | `"synthetic"` is automatic with `-autoplay`, `-glitchless-synthetic` or `-glitchless-measure` |
| `session_timeout` | `300` | seconds in the background (a phone) after which coming back is a new session |
| `rooms_as_levels` | `true` | a room that reads as a level starts that level |
| `engine_gauges` | `true` | put `instances`, `surfaces`, `ds_lists`, `ds_maps`, `ds_grids`, `buffers`, `particle_systems` and `vertex_buffers` in `ctx` |
| `rage_input` | off on phones | the same key or click four times in a second |
| `enabled` | off when run from the IDE | force sending on or off |
| `gzip` | `true` | gzip each batch (plain JSON in a web build, or where the runner's zlib can't make gzip) |
| `debug` | `false` | log what is sent with `show_debug_message` |
| `bug_reports` | `false` | `true`, or `{ hotkey: vk_f8, pause: true, screenshot: true, on_open, on_close }`: F8 opens the [bug report form](#bug-reports) |
| `exception_handler` | none | the game's own unhandled-exception function, called after Glitchless writes the crash down |

### Rooms as levels

When a room starts, Glitchless asks whether its name reads as a level. Names with a word like `menu`, `title`, `boot`, `init`, `loading`, `splash`, `options`, `credits`, `lobby` or `game over` in them don't (`rm_main_menu`, `rmTitle`, `room_game_over`); others do, and the room's name is the level. A menu room leaves the level: its frames have none. The same words decide Unity scenes and Unreal maps.

A game whose levels aren't rooms (an endless runner, waves in one room) calls `glitchless_level_start` itself. The first call turns rooms as levels off for the session.

### Off when run from the IDE

A build run from the IDE (or Igor's `Run`, where `GM_build_type` is `"run"`) sends nothing unless it is run with `-glitchless`, so a developer's test runs and the agents' bot runs stay out of the players' numbers. Executables (`GM_build_type` `"exe"`) send by default.

### Bug reports

Players and playtesters flag a problem where they see it, and you (or your coding agent, with the `glitchless_bug_reports` MCP tool) see it in Glitchless's Bug Reports view with the screenshot and a link to the session.

```gml
glitchless_init("caverun", "", "prod", intake, { bug_reports: true });   // F8 opens the form
glitchless_init("caverun", "", "prod", intake, { bug_reports: { hotkey: vk_f1, pause: false, on_open: my_pause, on_close: my_resume } });
glitchless_open_bug_report();                    // a pause menu's "Report a bug" (works without bug_reports)
glitchless_report_bug(note, true, function(_r) { if (_r.sent) show_message("Thanks!"); });
```

| `bug_reports` key | default | |
| --- | --- | --- |
| `hotkey` | `vk_f8` | a key code, or `undefined` for none. It opens and closes the form |
| `pause` | `true` | deactivate every instance but Glitchless's own while the form is open, and wake exactly those afterwards (not ones the game had deactivated itself). Use `false` with `on_open` and `on_close` if the game has its own pause |
| `screenshot` | `true` | send a screenshot with each report |
| `on_open`, `on_close` | none | functions called as the form opens and closes |

- **The screenshot** is the application surface at the end of the frame, taken before the form shows, so the form is never in it. The GUI layer (whatever Draw GUI events draw: a HUD, menus) is drawn after the application surface, so it isn't in it either. GameMaker can only save PNG, so it is a PNG, shrunk until it fits the server's 200,000-character limit: the longer side at most 960 px, then 800, 640, 480 and 320. With the application surface turned off, it is `screen_save`'s. The frame that saves it and the form's first frame aren't timed, so they never show as hitches.
- **The form** draws over everything in Draw GUI End with GameMaker's built-in font: the screenshot, the note, Send and Cancel. The note is what the player types (`keyboard_string`, which keeps up to 1,024 characters). Enter sends, Esc cancels. The game's `keyboard_string` comes back on close.
- **Sending:** a report goes on a request of its own straight away, from every session (`sample_rate` doesn't apply), with the last 20 game events and hitches, the last frame windows and the device. It waits in the outbox meanwhile, so a report made offline goes with a later batch, even on a later launch.
- **The note is the player's own words.** [PRIVACY.md](PRIVACY.md#bug-reports-the-players-own-words) says what to tell players, and the dashboard can delete a report a player asks about.

### Flags

| flag | |
| --- | --- |
| `-glitchless` | send from a build run from the IDE too |
| `-glitchless-intake=URL` | send to this server instead of the one in `glitchless_init`, and turn sending on |
| `-glitchless-privacy=MODE` | `anonymous`, `install` or `full`, for a test run |
| `-glitchless-measure=SECONDS` | print frame stats as one line of JSON, `{"glitchless_measure": {...}}`, write it to `glitchless/measure.json` in the save area, then quit |
| `-glitchless-warmup=SECONDS` | with `-glitchless-measure`: wait this long before measuring |
| `-glitchless-out=PATH` | with `-glitchless-measure`: write the line to this file too (a path the game's file sandbox allows) |
| `-glitchless-synthetic` | mark the session as a bot's (`-autoplay` does too) |
| `-glitchless-debug` | log what is sent |

One or two dashes both work. They are read from the command line (`parameter_string`) and from the `GLITCHLESS_ARGS` environment variable. Igor's `Run`, which the IDE and `gm-cli run` use, starts the game with macOS's `open`, which passes on neither, so a build run from the IDE or Igor also reads `glitchless/args.txt` in its save area (`~/Library/Application Support/com.yoyogames.macyoyorunner/` on a Mac): one flag per line or space. An executable ignores that file.

## For agents: `-glitchless-measure`

```bash
# after a VM build (Igor's Mac Compile, as gamemaker/test/e2e.mjs does it), with the game's files beside game.ios:
open -n -W -a "$RUNTIME/mac/YoYo Runner.app" --args -game "$PWD/build/game.ios" -autoplay -seed=7 -glitchless-measure=10
cat ~/Library/Application\ Support/com.yoyogames.macyoyorunner/glitchless/measure.json
```

The runner's save area is `com.yoyogames.macyoyorunner` for a build run that way, and the game's own (`game_save_id`) for an executable.

It works in any build, sends nothing unless sending is on, and quits when done. The fields match the other SDKs':

| field | |
| --- | --- |
| `frame_ms` | `p50`, `p95`, `p99`, `worst` |
| `fps`, `frame_budget_ms`, `refresh_hz`, `pct_frames_over_budget` | the budget is the game's speed (`game_set_speed`), which GameMaker holds the frame rate to |
| `hitches`, `hitch_count` | up to 10 hitches: `ms`, `causes`, `ctx`, `recent` events |
| `process_ms` | every instance's Begin Step, Step and End Step in a frame, and what runs between them (collisions, alarms) |
| `render_cpu_ms` | the draw events' CPU time per frame. `gpu_ms`, `draw_calls` and `triangles_avg` are null: GameMaker doesn't report them |
| `gc_ms` | time in garbage collections over the run |
| `peak_context` | the highest value of each gauge |
| `memory`, `memory_delta` | instances, the runner's MB, surfaces, DS lists and maps and buffers, now and change over the run |
| `new_errors`, `errors` | errors during the run, grouped, with locations |
| `renderer` | `vm` or `yyc` |
| `level_start`, `level_end`, `session_id` | |

Run the same seed before and after a change to compare.

## What it measures

**Frame times** come from `delta_time`, the wall-clock time between frames. A global time source reads it at the start of every frame, and keeps running when the game deactivates instances for its own pause menu; it also brings Glitchless's two objects back if the game deactivated or destroyed them. These rules follow `packages/sdk/src/core.js`:

- A **hitch** is a frame over 50 ms *and* over twice the median of the last 60.
- **Jank** is a frame over 33.4 ms.
- A **frozen** frame is over 700 ms.
- A run of long frames is the OS throttling a hidden window, so it is dropped.
- Time out of focus, and in the background on a phone, is never counted as a frame.

**Hitch causes** come from what the slow frame measured:

| cause | when |
| --- | --- |
| `texture_upload` | a texture group's status turned loaded or fetched (`texturegroup_get_status`): a page was loaded the first time something on it was drawn |
| `scene_change` | the room changed. This is the room's load: the findings count it apart from stalls during play |
| `gc` | a garbage collection (`gc_get_stats`) took a quarter of the frame, and at least 4 ms |
| `object_spawn` | 50 or more instances were added |
| `script` | Step events took 40% of the frame. `obj_glitchless` is drawn first and `obj_glitchless_tail` last, so the time from the frame's start to the first Pre-Draw is every Step event, and from there to the last Draw GUI End is every draw event |
| `render` | draw events took 40% of the frame |
| `gpu_or_os` | none of the above, and Step and draw time (with any collection) add up to under 40% of the frame: the time went to the GPU, to presenting the frame or to the OS, none of which GameMaker times |
| `frozen` | over 700 ms |

Each hitch also has `process_ms`, `render_ms`, `gc_ms`, `instances_added` and `texture_loads`. Each frame window adds `process_ms`, `render_ms`, `gc_collections`, `gc_ms`, `texture_loads`, `heap_mb` (`debug_event("DumpMemory")`), `instances`, `surfaces`, `ds_lists`, `ds_maps` and `buffers` (`debug_event("ResourceCounts")`). With `engine_gauges` the counts also go in `ctx`, where the findings compare a slow level with the smoothest one: *"`instances` sits at 2,540 for this whole level vs 33 on rm_level_1, so objects created earlier are never cleaned up"*.

## Errors

| kind | what |
| --- | --- |
| `crash` | an unhandled exception. GameMaker stops the game, so it counts as a crash: the session ends with `session_end` reason `crash`, written to the outbox in the exception handler and sent on the next launch |
| `manual` | `glitchless_error`: a message, or the exception a `catch` got, with its callstack |

Glitchless groups errors with the browser SDK's fingerprint: the kind, the message with long numbers and hex blanked, and the function. Callstack lines become functions: `gml_Object_obj_player_Step_0 (line 12)` is `obj_player.Step_0` at line 12, `gml_Script_spawn_wave` is `spawn_wave`. The `stack` keeps GameMaker's own names. Each error carries the last six game events (`recent`), and paths on the computer are cut down before sending: the save folder becomes `save:/`, and the user-name part of `/Users/…`, `/home/…` or `C:\Users\…` becomes `~`. Each kind of error is sent at most 25 times per session.

`glitchless_init` sets `exception_unhandled_handler`. A game that sets its own after that replaces Glitchless's: pass yours as the `exception_handler` option instead, and Glitchless calls it after writing the crash down (its return value is the game's exit code), or call `glitchless_crash(ex)` first thing in yours.

## Quitting, offline and crashes

- **`glitchless_quit()`** ends the session, gives the network up to 1.5 s to take the last batch, then calls `game_end()`. GameMaker can't wait on a request while the game closes, so a game that quits with `game_end()` or the window's close button saves its last batch, and the next launch sends it.
- **Offline**, batches are saved to `glitchless/outbox.json` in the save area and sent on a later launch, as is a crash. At most 4,000 events are kept, and anything over six days old is dropped. In anonymous mode the session ID is not saved: each earlier session's batches go out under a new random ID. Each batch keeps its own `batch_id` through every try and launch, so the server stores it once even when a reply was lost: one the game closed on, or one that never came within 20 s.
- **On a phone**, coming back from the background within `session_timeout` carries on the session with an `app_resume` event; later than that starts a new session.

## What goes on the wire

`POST {intake}/v1/intake?token=…` with the browser SDK's envelope and `sdk: "glitchless-gamemaker/0.2.0"`, as gzip with `Content-Type: text/plain` (the server knows gzip by its first bytes). GameMaker has no gzip, so the SDK wraps `buffer_compress`'s zlib stream in a gzip header and trailer. It checks once what `buffer_crc32` gives for a known input and corrects for it: runtime 2026.0.0.23 returns the inverted CRC-32. A runner where neither fits sends plain JSON. See [docs/SPEC.md](../docs/SPEC.md#5d-gamemaker-sdk) for what the GameMaker SDK adds; the browser fields it can't fill are sent as null or empty.

## Limits

- **GameMaker 2024.2 or later**: the project format, `texturegroup_get_status`, time sources and `debug_event`'s structs.
- **No draw calls, triangles or GPU time.** GameMaker doesn't report them to the game. The debug overlay (`show_debug_overlay(true)`) shows texture swaps and vertex batches.
- **Web and GX.games builds** are untested. They send plain JSON.
- **Phones** are untested beyond the background rule above.

## Tests

From the repo root:

- `npm run test:gamemaker:core` runs the SDK's GML in Node, with no GameMaker needed. `test/gml.mjs` turns the GML into JavaScript (it refuses JavaScript-only syntax, and reading a missing struct field throws, as in GameMaker). `test/core.test.mjs` checks that every GameMaker name the GML uses is a real one (`test/gml-builtins.txt`) and that the sketch, fingerprints, path scrubbing and gzip match the JavaScript SDK. It also plays whole sessions against a local server: offline and the outbox, install and full mode, hitches and their causes, rooms as levels, errors, a crash sent on the next launch, bug reports and measure, a batch whose reply never came (or that the game closed on) stored once, quitting mid-level, and the load event's time and `first_launch`.
- `npm run test:gamemaker` builds the demo with GameMaker's Igor (a VM build for the mac target, in `gamemaker/.build`) and plays it against a local server: see [the demo](#the-demo). First the runner computes the sketch, fingerprints, gzip and JSON numbers of the JavaScript fixture (`-glitchless-selftest`), then come offline and the outbox, full and install mode, measure, the planted crash sent on the next launch, and bug reports from code and the F8 form, 32 checks in all (with batch IDs in the outbox, nothing stored twice, and the load event at the first frame). The bug report's screenshot is saved as `gamemaker/.build/bug-report.png`. Each run starts the runtime's YoYo Runner with its flags on the command line and its output in a `-debugoutput` file, so it opens a game window for a few seconds and needs a logged-in macOS desktop.
- `npm test` includes `server/test/gamemaker-findings.test.js`: GameMaker sessions get GameMaker's fixes.

### Setting up GameMaker for the end-to-end test

A person does this once, because it accepts GameMaker's terms. The e2e never signs in or fetches a licence: it uses the runtime and `licence.plist` it finds, or `GM_RUNTIME` (a runtime folder) and `GM_LICENCE` (a `licence.plist`). Either of these is enough:

- **The IDE.** Install GameMaker LTS 2026 from [gamemaker.io/download](https://gamemaker.io/en/download), open it, sign in (a free account) and let it install runtime 2026.0.0.23 with the macOS module. The e2e uses `/Users/Shared/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-*` and the signed-in user folder in `~/Library/Application Support/GameMakerStudio2-LTS2026/`.
- **YoYo Games' [`gm-cli`](https://github.com/YoYoGames/gm-cli)**, with no IDE and no account (a free guest licence). It needs Node 24 or later and about 1 GB:

  ```bash
  export GAMEMAKER_CLI_CACHE_DIR="$HOME/Library/Caches/GameMakerCLI-glitchless"
  mkdir -p ~/gm-setup && cd ~/gm-setup
  npx @gamemaker/gm-cli@2.4.1 init --template "Blank Game" --no-interactive
  npx @gamemaker/gm-cli@2.4.1 run --target=mac --runtime=vm
  ```

  A blank game window opens; close it. The e2e reads the runtime and licence from the same `GAMEMAKER_CLI_CACHE_DIR`.

Builds are VM builds (YYC needs Xcode). The free tier is non-commercial: shipping a commercial game needs GameMaker Professional, whatever Glitchless does. Two things found on runtime 2026.0.0.23: the runner can't load a game from a temporary folder (`/tmp`, `/var/folders`), hence `gamemaker/.build`; and builds run from the IDE or Igor save to the runner's own folder, `~/Library/Application Support/com.yoyogames.macyoyorunner/`, where the e2e removes only Glitchless's files.

## The demo

`Glitchless.yyp` in this folder is the SDK and a demo game in one project: the *Glitchless* folder is the SDK (what the local package holds), the *Demo* folder the game. It has a boot room and three levels, each a room, with planted problems for the findings to find:

- **rm_level_2:** a power-up makes 2,500 spark instances in one step and sorts them with a bubble sort (a stutter, `object_spawn` and `script`). The sparks are persistent and never destroyed, so rm_level_3 carries every one, and each power-up makes a glow surface it never frees: two leaks.
- **rm_level_3:** a bonus reads a variable from an object with no instances, which stops the game. Glitchless sends the crash on the next launch.
- **rm_level_1** also has an error the game catches and reports, with the save folder in its message.

`-autoplay` plays it by itself and quits after the last level; `-seed=N`, `-level-seconds=S`, `-no-crash`, `-bug-report-at=S` and `-bug-form-at=S` are its test flags, and `-glitchless-selftest` makes the runner compute the sketch and fingerprints of `datafiles/glitchless_fixture.json` and write them to its save area, so the e2e can check this runner against JavaScript. `node gamemaker/tools/project.mjs` rewrites the project's `.yyp` and `.yy` files after a script, object or event is added.
