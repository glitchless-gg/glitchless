# Glitchless for GameMaker

A Glitchless SDK for GameMaker 2024.2 and later, written in GML and built for LTS 2026 (runtime 2026.0.0.23). It sends the same events as the browser SDK (`packages/sdk`), so a GameMaker game shows up in the same Glitchless server, dashboard, findings and MCP tools as the browser, Godot, Unity and Unreal games.

It reports:

- **Frame times.** Each 5 s window carries a mergeable 2% sketch, so the server's p95 and p99 cover every player.
- **Hitches with likely causes:** a texture page loaded on first draw, a room change, a garbage collection, a burst of new instances, slow Step code, slow drawing, or a frozen frame. Each hitch also carries the game's gauges and the events in the 1.5 s before it.
- **Engine counts:** instances, the runner's memory, and the surfaces, DS lists and maps and buffers in memory. GameMaker frees none of the last four by itself, so a count that only climbs is a leak.
- **Rooms as levels.** A room that reads as a level (`rm_cave_2`, not `rm_main_menu`) starts that level by itself.
- **Errors and crashes.** An unhandled exception stops a GameMaker game: Glitchless writes it down as the game dies and sends it on the next launch. Errors the game catches go through `glitchless_error`.
- **Play events:** the level funnel, deaths, the game's own events and gauges.
- **Streams, sessions and matches:** counters for events that come by the hundred (kills, gold, taps), properties that describe the session (rank tier, class, region), the match, party or run every event belongs to, and zones in an open world.
- **Ping and disconnects** in a multiplayer game, from the game's own ping around GameMaker's `network_*` functions.
- **Bug reports from players**, when the game turns them on: F8 (or the game's own button) opens a short form, and the report carries what the player typed, a screenshot, where they were and what had just happened.

It also has an agent flag, `-glitchless-measure=SECONDS`, which prints frame stats as JSON and quits, like the Godot, Unity and Unreal SDKs.

Anonymous mode, the default, sends nothing that can be tied to a person. [PRIVACY.md](PRIVACY.md) lists every field each mode sends.

## Install

1. Get the local package, `Glitchless-0.4.0.yymps`: from the [0.4.0 release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-gamemaker/v0.4.0), or make it with `node gamemaker/tools/project.mjs package` (it lands in `gamemaker/dist/`).
2. In GameMaker: **Tools → Import Local Package**, pick the file, **Add All**, **Import**. It adds a *Glitchless* folder with nine scripts and two objects, `obj_glitchless` and `obj_glitchless_tail`. Don't place the objects in a room: `glitchless_init` makes them.
3. Call `glitchless_init` once, as early as you can: the first room's creation code, or the Create event of your first object.
4. For a sandboxed macOS build (the Mac App Store): **Game Options → macOS → Allow outgoing network connections**.

The SDK's own names all start with `glitchless_`, `__glitchless_` or `GLITCHLESS_`, so they won't clash with a game's.

## Use

```gml
glitchless_init("caverun", "", "prod", "https://glitchless.example.com"); // "" = GM_version, from Game Options

glitchless_level_start("cave_3", { difficulty: "hard" }); // only if rooms aren't your levels (see below)
glitchless_level_complete(undefined, score);    // undefined: the current level; duration measured since it started
glitchless_level_fail(undefined, "lost");          // lost it: died, ran out of time
glitchless_level_abandon();                     // left it: the menu, a restart. Never a fail
glitchless_death(x, y, "spikes");               // the place is sent only when positions are on
glitchless_track("play", "endless");            // one word, a number, or a struct
glitchless_count("kill", { enemy: "bat" });     // a stream: added up on the device, sent once a window
glitchless_set_properties({ rank: "gold" });    // the game's words about the session
glitchless_set_group("match", match_id);        // every event carries the match until it's ended
glitchless_set_zone("westfall");                // where the player is in an open world
glitchless_net_sample(ping_ms);                 // the game's own ping to its server, about once a second
glitchless_disconnect("timeout");               // the connection dropped
glitchless_set_context({ enemies: instance_number(obj_enemy) }); // in an End Step event
glitchless_set_position(obj_player.x, obj_player.y); // ignored unless positions are on
try { load_save(); } catch (_e) { glitchless_error(_e, { slot: 2 }); } // an error the game caught
glitchless_measure(5, function(_stats) { show_debug_message(json_stringify(_stats)); });
glitchless_open_bug_report();                   // the bug report form, from a pause menu
glitchless_report_bug(note);                    // or a report from the game's own form
glitchless_set_enabled(share_data);             // the player's "Share performance data" setting
glitchless_quit();                              // the Quit button: sends the last batch, then game_end()
```

`glitchless_track` is for the game's own metrics, whatever they are: `glitchless_track("open", "full")`, `glitchless_track("buy", { step: "done" })`. One word becomes the attribute `what`. The dashboard's Events page counts each event over time, breaks it down by attribute and builds funnels between events. Attributes are strings, numbers or booleans, at most 12 per event.

| function | |
| --- | --- |
| `glitchless_init(service, version, env, intake, options)` | who the game is and where to send. Nothing is measured or sent before it |
| `glitchless_level_start(level, [attrs])` | closes the current frame window, so a window never spans two levels. The first call turns rooms as levels off. `attrs` say what the attempt is ([below](#groups-level-attributes-and-zones)) |
| `glitchless_level_complete([level], [score], [duration_s])`, `glitchless_level_fail([level], [cause])` | |
| `glitchless_level_abandon([level])` | the player left the level before it ended (the menu, a restart): never counted as a fail or a rage quit. Quitting mid-level sends one by itself, before the session's end, and a `glitchless_level_fail` or `glitchless_level_abandon` for that level after that (from a Clean Up event, say) is dropped. A room level that ends with its room (back in a menu) closes without one |
| `glitchless_death(x, y, [cause], [z])` | |
| `glitchless_track(name, [what])` | |
| `glitchless_count(name, [what], [n])` | one more (or `n` more) of a stream of events: [Counters](#counters) |
| `glitchless_set_properties(struct)` | the game's words about the session: [Properties](#properties) |
| `glitchless_set_group(kind, [id], [attrs])`, `glitchless_set_zone(name)` | [Groups, level attributes and zones](#groups-level-attributes-and-zones) |
| `glitchless_net_sample(rtt_ms, [loss_pct], [jitter_ms])`, `glitchless_disconnect([reason])`, `glitchless_reconnect()` | [Multiplayer](#multiplayer-ping-and-disconnects) |
| `glitchless_set_context(struct)` | numbers that describe what is going on: the largest value in each window is sent, and the current ones go with each hitch |
| `glitchless_set_position(x, y, [z])` | sampled 4 times a second for heatmaps, when positions are on |
| `glitchless_error(message_or_exception, [attrs])` | |
| `glitchless_crash(exception)` | for a game with its own `exception_unhandled_handler` (see [Errors](#errors)) |
| `glitchless_report_bug([note], [screenshot], [callback])` | `callback({sent})`, or `{sent: false, reason: "offline", "off" or "error"}` |
| `glitchless_open_bug_report()`, `glitchless_bug_report_is_open()` | the form doesn't open while the player has Glitchless off |
| `glitchless_set_enabled(on)` | the player's own switch: `false` stops Glitchless at once and for every later launch, `true` turns it back on. [The player's off switch](#the-players-off-switch) |
| `glitchless_is_enabled()` | whether Glitchless is on now: this build sends and the player hasn't turned it off |
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
| `enabled` | off when run from the IDE | force sending on or off. The build's own switch: the player's can turn a build that sends off, never one that doesn't on |
| `opt_in` | `false` | `true`: a device where the player hasn't chosen yet starts off, until `glitchless_set_enabled(true)`. For a game that asks first ([below](#the-players-off-switch)) |
| `gzip` | `true` | gzip each batch (plain JSON in a web build, or where the runner's zlib can't make gzip) |
| `debug` | `false` | log what is sent with `show_debug_message` |
| `bug_reports` | `false` | `true`, or `{ hotkey: vk_f8, pause: true, screenshot: true, on_open, on_close }`: F8 opens the [bug report form](#bug-reports) |
| `exception_handler` | none | the game's own unhandled-exception function, called after Glitchless writes the crash down |
| `properties` | none | a struct of [properties](#properties) the session starts with |
| `hash_group_ids` | `true` | send match and party IDs hashed; `false` sends them as they are, to match against the game's own server logs |
| `net_transport` | `"gamemaker"` | the word `net.transport` sends for what the game's ping goes over |

### Rooms as levels

When a room starts, Glitchless asks whether its name reads as a level. Names with a word like `menu`, `title`, `boot`, `init`, `loading`, `splash`, `options`, `credits`, `lobby` or `game over` in them don't (`rm_main_menu`, `rmTitle`, `room_game_over`); others do, and the room's name is the level. A menu room leaves the level: its frames have none. The same words decide Unity scenes and Unreal maps.

A game whose levels aren't rooms (an endless runner, waves in one room) calls `glitchless_level_start` itself. The first call turns rooms as levels off for the session.

### Off when run from the IDE

A build run from the IDE (or Igor's `Run`, where `GM_build_type` is `"run"`) sends nothing unless it is run with `-glitchless`, so a developer's test runs and the agents' bot runs stay out of the players' numbers. Executables (`GM_build_type` `"exe"`) send by default.

### The player's off switch

Give players a "Share performance data" toggle in the game's settings and wire it to `glitchless_set_enabled`. When a player turns it off, nothing more is measured or sent from that moment: no frames, errors or events, and no request of any kind. What was waiting to go is dropped, the outbox in the save area too, and the session just ends (no `session_end`). Turned back on, a new session starts with the properties and groups still set. Keep the setting with the game's others and pass it at start too; a call that changes nothing does nothing:

```gml
// As the game starts, after glitchless_init (or before it: it's safe), with the game's own saved setting:
glitchless_set_enabled(global.settings.share_data);

// The settings menu shows the game's own setting...
draw_text(_x, _y, "Share performance data: " + (global.settings.share_data ? "On" : "Off"));

// ...and its toggle tells Glitchless when the player flips it.
global.settings.share_data = !global.settings.share_data;
save_settings(); // the game's own
glitchless_set_enabled(global.settings.share_data);
```

A game that asks before collecting anything starts with `opt_in`:

```gml
glitchless_init("caverun", "", "prod", intake, { opt_in: true }); // off until the player says yes
// the first launch's "Help us find bugs and stutters?" screen:
glitchless_set_enabled(_answer_yes);
```

- **Remembered.** The choice is saved as `on` or `off` in `glitchless/enabled` in the save area once the game has called `glitchless_set_enabled`, in every privacy mode, and `glitchless_init` reads it before anything else. A player who turned it off sends nothing at all at the next launch, not last launch's outbox (which is deleted unread) nor any other request, even if the game reads its own settings after `glitchless_init`.
- **Asking first.** With `opt_in: true`, a device where the player hasn't chosen yet starts off: nothing is measured, kept or sent until the game calls `glitchless_set_enabled(true)`. A saved choice wins over `opt_in`, so the question is asked once.
- **Kept while off:** the level, properties, groups, zone and gauges the game sets, in memory, so a later session carries them; the player ID file in install and full mode. An attempt at a level that was going when the player turned Glitchless off isn't part of the new session: its `glitchless_level_complete`, `glitchless_level_fail` or `glitchless_level_abandon` is dropped until the next level starts.
- **While off**, every call is safe and does nothing. The bug report form doesn't open, `glitchless_report_bug` answers `{sent: false, reason: "off"}`, `glitchless_measure` and `-glitchless-measure` answer with an `error` that says Glitchless is off, and `glitchless_quit` ends the game at once.
- **`glitchless_is_enabled()`** is false while the player has it off, and also in a build that sends nothing (run from the IDE without `-glitchless`, `enabled: false`, no intake), whatever the player chose: there, `glitchless_set_enabled(true)` saves the choice but sends nothing. So a settings menu shows the game's own saved setting, as above.
- **Run from the IDE**, every game shares the runner's save area, so a choice made in one is read by the next: delete `glitchless/enabled` there (`~/Library/Application Support/com.yoyogames.macyoyorunner/` on a Mac) to start over.

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

### Counters

`glitchless_track` is for moments: a match ending, a purchase, a boss beaten. A stream of events (every shot, kill, coin or tap) sent that way would fill the queue of 2,000 events in a minute, and the oldest events, frame windows included, would be dropped. `glitchless_count` queues nothing: it adds to an entry in the current frame window, and each window that counted anything sends one `counts` event.

```gml
glitchless_count("kill", { monster: "elite" });            // one more elite killed
glitchless_count("gold", { source: "loot", amount: 35 });  // amounts are added up: gold by source per hour played
glitchless_count("tap");
glitchless_count("shot", { weapon: "ar" }, 3);             // a burst of three
```

- **Entries.** The words and true/false values in `what` (at most 4, by name) say which entry a call adds to, so `kill` by `monster` is a breakdown on the dashboard. Its numbers (at most 4) are added up as given. `n` adds to the count, up to 1,000,000 a call.
- **Windows.** The window is the 5 s flush interval, and a level start, a group change or a zone change (once the window has run a second) closes it, so counts keep their level, match and zone.
- **Limits.** A window holds 64 entries. After that, a new group of a name already counted goes under that name with its words as `(other)`, and a new name is dropped and added to the window's `dropped`.
- **A debug build** (run from the IDE, or with `-glitchless-debug`) warns once about a name sent with `glitchless_track` more than 20 times a second.
- **Servers that don't take counters yet.** At launch Glitchless asks the server what it takes (`GET /v1/health`). One that answers without counters gets none, and the debug output says so once. With no answer (offline) counters stay on.

### Properties

Properties describe the session in the game's words, so any board can split by them (`$rank`) and a page can show only some sessions (the high ranks):

```gml
glitchless_init("caverun", "", "prod", intake, { properties: { mode: "squads", input: "controller" } });
glitchless_set_properties({ rank: "diamond", region: "eu-west" });   // after sign-in, at matchmaking
glitchless_set_properties({ level_band: "30-39" });                  // a band, not the exact level
glitchless_set_properties({ region: undefined });                    // removed
```

A property is for what holds for the whole session: rank tier, class, region, mode, input, a band. What changes from match to match (the hero, the deck, the map) goes on the events or as level attributes. The ones set before the first batch go with the session's start; later changes go as one `props` event a window, with each key's last value. They go in every privacy mode and are checked first: keys are lower-case words (at most 12 a session); values a word, a whole number or true/false; and keys such as `email` or `user_id`, and values shaped like an email address, a phone number, an ID or a link, are dropped. [PRIVACY.md](PRIVACY.md#properties-the-games-words-about-the-session) has the full rules.

### Groups, level attributes and zones

**Level attributes** say what an attempt is, so a level's clears and fails split by difficulty, mode or party size. The outcome and the deaths in the attempt don't repeat them:

```gml
glitchless_level_start("nmd_ghoa", { tier: "pit_80", party_size: 3, build: ["blood_surge", "corpse_explosion"] });
```

**Groups** mark every event from then on as part of a match, a party or a run, so a match can be seen from every player's side (did the whole lobby lag, or one player?):

```gml
glitchless_set_group("match", match_id, { mode: "squads" }); // an ID the game's server made, shared by everyone in the match
glitchless_set_group("party", party_id);                     // until the party breaks up
glitchless_set_group("match", undefined);                    // the match is over

global.run_id = glitchless_set_group("run");                 // a new run: Glitchless makes the ID (r_ and 12 characters)
glitchless_set_group("run", saved_run_id);                   // a run the game saved, on a later launch
```

- **IDs** are 8 to 64 letters, digits and `_ . : -`; anything else is dropped. A match or party ID comes from the game's servers, never an account, guild or friends-list ID.
- **Hashed.** Match and party IDs go as `h_` and 24 hex digits of SHA-1 of the service and the ID, the same for every player in the match. `hash_group_ids: false` sends them as they are.
- **Runs** resume under a saved ID in install and full mode only. In anonymous mode a saved run gets a new ID (the `group` event says `resumed`), so nothing ties two launches together.
- **Each change closes the frame window**, so no window spans two matches.

**Zones** are where a player is in an open world (an MMO region, a metroidvania room), apart from levels: a level has a start and an end, a zone doesn't. Every event and frame window carries the zone, so boards split by `$zone`. A change closes the frame window once it has run a second (so a player stepping back and forth over an edge doesn't send a window each time):

```gml
glitchless_set_zone("westfall");
glitchless_set_zone("");          // none
```

### Multiplayer: ping and disconnects

GameMaker's `network_*` functions don't measure the connection, so the game passes its own: a ping to its server about once a second, and a disconnect when it sees one. Each frame window then carries `net` (the round trip's percentiles and sketch, packet loss and jitter), and the dashboard shows ping and disconnects by level, version and region. A disconnect with a level going ends that level as an abandon with reason `disconnect`: never a fail.

```gml
#macro MSG_PING 1 // the game's own message types
#macro MSG_PONG 2

// obj_client, Create: connect, and ping once a second
socket = network_create_socket(network_socket_tcp);
network_connect_async(socket, server_ip, 6510);
ping = buffer_create(8, buffer_fixed, 1);
connected = false;

// obj_client, Async - Networking
var _type = async_load[? "type"];
if (_type == network_type_non_blocking_connect) {
    if (async_load[? "succeeded"]) {
        connected = true;
        last_pong = current_time;
        alarm[0] = 1;
    } else {
        glitchless_disconnect("failed_to_connect");
    }
} else if (_type == network_type_data) {
    var _b = async_load[? "buffer"];
    buffer_seek(_b, buffer_seek_start, 0);
    if (buffer_read(_b, buffer_u8) == MSG_PONG) {                        // the server sent our ping back
        last_pong = current_time;
        glitchless_net_sample(current_time - buffer_read(_b, buffer_u32)); // the round trip, in ms
    }
}

// obj_client, Alarm 0: ping, and give up after 10 s without an answer
if (connected) {
    buffer_seek(ping, buffer_seek_start, 0);
    buffer_write(ping, buffer_u8, MSG_PING);
    buffer_write(ping, buffer_u32, current_time);
    if (network_send_packet(socket, ping, buffer_tell(ping)) < 0) {
        connected = false;
        glitchless_disconnect("connection_lost");
    } else if (current_time - last_pong > 10000) {
        connected = false;
        glitchless_disconnect("timeout");
    } else {
        alarm[0] = game_get_speed(gamespeed_fps);
    }
}

// the server, Async - Networking, network_type_data: send a ping straight back as a pong
var _b = async_load[? "buffer"];
buffer_seek(_b, buffer_seek_start, 0);
if (buffer_read(_b, buffer_u8) == MSG_PING) {
    var _sent = buffer_read(_b, buffer_u32);
    var _pong = buffer_create(5, buffer_fixed, 1);
    buffer_write(_pong, buffer_u8, MSG_PONG);
    buffer_write(_pong, buffer_u32, _sent);
    network_send_packet(async_load[? "id"], _pong, 5);
    buffer_delete(_pong);
}
```

- **Loss and jitter.** `glitchless_net_sample(rtt_ms, loss_pct, jitter_ms)` takes them where the game knows them (a UDP game that numbers its packets can count the missing ones). Without jitter, Glitchless uses how much each round trip differs from the one before.
- **Reasons:** `timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect` or `other`. `glitchless_reconnect()` says the player got back in. At most 20 disconnects a session are sent.
- **Only clients ping.** A player hosting the game has no round trip of their own, so they send no samples. GameMaker can't read throughput or the kind of connection, so `in_kbps`, `out_kbps` and `link` are null. Samples closer than half a second to the last are ignored.
- **Another library** (Steamworks networking, a WebSocket extension): the same three calls, with `net_transport` naming it.
- Nothing about the server's address or the player's network is sent: [PRIVACY.md](PRIVACY.md#network-quality).

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

`POST {intake}/v1/intake?token=…` with the browser SDK's envelope and `sdk: "glitchless-gamemaker/0.4.0"`, as gzip with `Content-Type: text/plain` (the server knows gzip by its first bytes). GameMaker has no gzip, so the SDK wraps `buffer_compress`'s zlib stream in a gzip header and trailer. It checks once what `buffer_crc32` gives for a known input and corrects for it: runtime 2026.0.0.23 returns the inverted CRC-32. A runner where neither fits sends plain JSON. See [docs/SPEC.md](../docs/SPEC.md#5d-gamemaker-sdk) for what the GameMaker SDK adds; the browser fields it can't fill are sent as null or empty.

## Limits

- **GameMaker 2024.2 or later**: the project format, `texturegroup_get_status`, time sources and `debug_event`'s structs.
- **No draw calls, triangles or GPU time.** GameMaker doesn't report them to the game. The debug overlay (`show_debug_overlay(true)`) shows texture swaps and vertex batches.
- **Web and GX.games builds** are untested. They send plain JSON.
- **Phones** are untested beyond the background rule above.

## Tests

From the repo root:

- `npm run test:gamemaker:core` runs the SDK's GML in Node, with no GameMaker needed. `test/gml.mjs` turns the GML into JavaScript (it refuses JavaScript-only syntax, and reading a missing struct field throws, as in GameMaker). `test/core.test.mjs` checks that every GameMaker name the GML uses is a real one (`test/gml-builtins.txt`) and that the sketch, fingerprints, path scrubbing and gzip match the JavaScript SDK. It also plays whole sessions against a local server: offline and the outbox, install and full mode, hitches and their causes, rooms as levels, errors, a crash sent on the next launch, bug reports and measure, a batch whose reply never came (or that the game closed on) stored once, quitting mid-level, and the load event's time and `first_launch`. The genre tests read the batches the GML sends and check them against the design's wire format (`docs/design/genre-coverage.md`): counters and their limits, a server without counters, property checks and `props` events, level attributes, hashed match and party IDs, runs, zones, net samples, disconnects and their abandon. The off switch's tests read every request the GML makes: turning off drops the queue and the outbox and sends nothing more (no `session_end`), a reply already on its way changes nothing, turning on starts a new session with the properties and groups, a call that changes nothing does nothing, a saved choice read at the next launch (its outbox deleted unread), `opt_in`, a build that sends nothing staying off, bug reports and measure answering `off`, and no crash written while off.
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
