# Glitchless for Unity

Game observability for Unity 6.3 LTS and later. Glitchless records how your game runs for real players and gives your coding agent the same data, over MCP, so it can fix what they hit.

- **Stutter.** Every frame is timed from `Time.unscaledDeltaTime`. Each frame window carries a mergeable frame-time sketch and where the time went: physics, your `Update` code, rendering, the GPU. Each hitch (a frame over 50 ms and twice the recent median) comes with its likely causes: a garbage collection, a shader compile, a scene load, a burst of new objects, or long script, physics or render work. When none of those fit and the parts Glitchless times add up to little of the frame, the cause is `gpu_or_os`: the time went to the GPU, presenting the frame or the OS.
- **Errors.** Uncaught exceptions, `Debug.LogError`, assertions and engine errors, through `Application.logMessageReceivedThreaded`, grouped by the same fingerprint the web and Godot SDKs use, with the game events just before each one.
- **Levels and players.** Scenes are levels on their own. Deaths, level fails, levels left part-way and quits feed the level funnel, death heatmaps and rage-quit detection.
- **Leaks.** Mesh, material, texture and object counts per level load, where a development build has them.
- **Multiplayer.** Ping, jitter and disconnects from Netcode for GameObjects or Mirror, with nothing to set up; which match, party or run each event belongs to; and a server mode that measures a dedicated server's ticks and players without counting it as a player.
- **Bug reports from players**, when you turn them on: F8 (or your own button) opens a short form, and the report carries what the player typed, a screenshot, where they were and what had just happened.
- **Anonymous by default.** No player ID, no device identifier, coarse device facts only. `Privacy = Privacy.Install` adds a saved random player ID so retention (D1, D7, D30) can be counted, and nothing else. [PRIVACY.md](PRIVACY.md) lists every field.

It sends the same events as the [browser](https://github.com/glitchless-gg/glitchless/tree/main/packages/sdk) and [Godot](https://github.com/glitchless-gg/glitchless/tree/main/godot/addons/glitchless) SDKs, so the dashboard, the findings and the MCP tools work with a Unity game as they are.

## Install

In Unity: **Window → Package Manager → + → Add package from git URL…**, and paste:

```
https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk
```

Or add it to `Packages/manifest.json`, pinned to a release:

```json
"gg.glitchless.sdk": "https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk#gg.glitchless.sdk/v0.4.1"
```

Once it's listed on [OpenUPM](https://openupm.com): `openupm add gg.glitchless.sdk`.

## Set it up

Call `Glitchless.Init` once, as early as you can: the `Awake` of a script in your first scene.

```csharp
using GlitchlessSdk;
using UnityEngine;

public class Telemetry : MonoBehaviour
{
    void Awake()
    {
        Glitchless.Init(new GlitchlessOptions
        {
            Service = "my-game",                      // lowercase and stable
            Intake = "http://localhost:7777",         // your Glitchless server, or https://api.glitchless.gg
            ClientToken = "gl_pub_dev",               // public and write-only, fine inside the build
        });
    }
}
```

No code: add **Glitchless → Glitchless Bootstrap** to a GameObject in your first scene and fill in the same three fields.

**Retention needs install mode.** In anonymous mode (the default) nothing is kept between launches, so the dashboard can't tell a returning player from a new one. `Privacy = Privacy.Install` (or **Install ID** on the Bootstrap) keeps a random `p_…` player ID in `persistentDataPath/glitchless/player_id` (the one full mode uses; PlayerPrefs in WebGL builds) and sends it with every batch; nothing else changes. The Players page and `retention` board panels then show D1, D7 and D30. `Glitchless.ResetInstallId()` forgets it (for a "reset my ID" setting): this session keeps its ID, the next launch makes a new one. On a Steam Deck, `session_start` carries `steam_deck: true` and, on SteamOS, `os: "SteamOS"` (Linux players and Windows players under Proton).

Glitchless starts itself before the first scene loads, so frame times and errors from the very first frames are kept; nothing is sent until `Init`. Define `GLITCHLESS_DISABLE` in **Player Settings → Scripting Define Symbols** to stop that automatic start.

The Editor and development builds send too, with `Env` set to `dev` unless you set it, so you can check data arrives from Play mode. Release builds default to `prod`.

Bots are not players: sessions in batch mode, with `--autoplay` or `--glitchless-synthetic`, and on the Firebase Test Lab devices Google Play's pre-launch report plays every new build on (Android's `firebase.test.lab` setting, read on the device and not sent) are marked `synthetic`, unless `SessionType` says otherwise. The dashboard leaves them out of player counts. Nor are testers: a TestFlight or development install on iOS (a TestFlight build is a release build, so it reports `prod` like the App Store; the receipt Apple writes with every App Store install tells them apart, with no native plugin) is marked `tester`, which findings and share links leave out too.

## Tell it about your game

| Game moment | Call |
| --- | --- |
| a level starts (a restart counts) | automatic for scenes, or `Glitchless.LevelStart("level-2")` |
| a level starts, and what kind of attempt it is | `Glitchless.LevelStart("nmd_ghoa", new Dictionary<string, object> { ["tier"] = "pit_80", ["party_size"] = 3 })` |
| a level is beaten | `Glitchless.LevelComplete("level-2", score: 1200)` |
| the player loses it: runs out of lives or time | `Glitchless.LevelFail("level-2", "fell")` |
| the player leaves it: goes to the menu, restarts | `Glitchless.LevelAbandon("level-2")`, never a fail |
| the player dies | `Glitchless.Death(player.position, "spikes")`: short, low-cardinality causes |
| pickups, purchases, checkpoints | `Glitchless.Track("powerup", "magnet")` |
| shots, hits, kills, gold picked up: anything that happens many times a second | `Glitchless.Count("kill", "elite")`, `Glitchless.Count("gold", new Dictionary<string, object> { ["source"] = "loot", ["amount"] = 35 })` |
| what holds for this session: mode, rank tier, class, server region | `Glitchless.SetProperty("rank", "diamond")` |
| a match, party or run starts | `Glitchless.SetGroup("match", lobby.Id)`, `Glitchless.SetGroup("run")`; `null` ends it |
| the player moves to another part of an open world | `Glitchless.SetZone("westfall")` |
| counts of anything that scales, every frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, every frame | `Glitchless.SetPosition(player.position)` (sent only when positions are on) |
| an exception you caught | `Glitchless.Error(e)` |
| a player's bug report from your own UI | `Glitchless.ReportBug(note)`, or `Glitchless.OpenBugReport()` for the built-in form ([below](#bug-reports)) |

Use the game's own words for names, causes and levels, never anything a player typed.

**Leaving a level is not losing it.** Call `LevelAbandon()` when the player leaves a level before it ends, not `LevelFail()`: the funnel counts abandons apart, they are never rage quits, and walls are judged only on the sessions that played a level to an end. When the game goes to the background (phones) or quits with a level started and not yet completed, failed or abandoned, Glitchless sends the abandon itself, before the session's end, and drops a `LevelFail` or `LevelAbandon` the game sends for that level afterwards (from an `OnDestroy` as the game closes, say). Back from the background in the same session, the level carries on and the server takes the abandon back.

**Your own metrics.** `Track` takes any event: `Glitchless.Track("open", "full")`, `Glitchless.Track("play", "endless")`, or a `Dictionary<string, object>` of attributes. One word becomes the attribute `what`. The dashboard's Events page counts each event over time, breaks it down by attribute and builds funnels between events (`paywall` → `buy=done`), and the game's own dashboard, whose pages your coding agent designs with `glitchless_set_dashboard`, shows the ones that matter. Attributes are strings, numbers or booleans, at most 12 per event.

**Track a moment, count a stream.** `Track` sends an event each time, and the SDK keeps at most 2,000 waiting: a `Track` for every bullet fills that in a minute, and then the oldest events go, frame windows too. `Count` adds a stream up on the device instead and sends it once every 5 seconds: `Glitchless.Count("shot", "rifle")`, `Glitchless.Count("xp", new Dictionary<string, object> { ["source"] = "quest", ["amount"] = 1200 })`. Its words and booleans (at most 4) say which group a count goes in, its numbers (at most 4) are added up, and `n` says how many events one call stands for. Boards read a counter like any event: kills per hour played, damage by weapon. In the Editor and development builds, the console says when one name is tracked more than 20 times a second. A window holds 64 groups; past that, new groups of a name already counted go under `(other)`. Counters need a Glitchless server that takes them: against an older one the SDK sends none and says so once.

**Properties** say what holds for the whole session, in the game's words: `Glitchless.SetProperty("rank", "diamond")`, `SetProperties(…)`, or `Properties` in the options for what's known at start. Every board panel can then split or filter by them (`$rank`), so a page can show only the high ranks. Send them where the game knows them: after sign-in, at the menu, at matchmaking. A value is a word (up to 64 characters), a boolean or a whole number; send bands (`"30-39"`) rather than exact levels, and `null` removes one. They are never about who the player is: keys such as `email`, `user_id` or `steam_id`, and values that look like an email address, a phone number, an ID or a link, are dropped, with a warning in the Editor. At most 12 a session. What changes from match to match (the hero, the deck, the map) belongs on `LevelStart` or the event instead.

**Level attributes** say what kind of attempt a level is: `Glitchless.LevelStart("deadmines", new Dictionary<string, object> { ["difficulty"] = "heroic", ["party_size"] = 5 })`. The levels panel then shows clears and wipes by difficulty or group size. The outcome (`LevelComplete`, `LevelFail`) doesn't repeat them.

**Zones** are where the player is in an open world, an MMO region or a metroidvania room, which never ends in a win or a fail: `Glitchless.SetZone("westfall")`. Events and frame windows carry the zone as they carry the level, and boards split by `$zone`. Levels (a dungeon, a match) can still start and end inside a zone.

**Purchases** have one convention in every Glitchless SDK: `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" });` (with Unity IAP, `product.metadata.localizedPrice` as a `double` and `isoCurrencyCode`). Send it when the store confirms the purchase, with `amount` a number in the currency's units (4.99, not 499) and `currency` the ISO code the store charged in. Boards add the amounts up into revenue, revenue per player and revenue by item, in the game's one currency: purchases in another are listed as left out, not added in. Never send receipts, order ids or payment details. A purchase made in a TestFlight or development install on iOS is a free sandbox purchase: the SDK adds `sandbox: true` to it (to an event named `purchase`, or any with a `currency`), and boards count it but never add it into revenue. On Android, pass `sandbox: true` yourself when the billing library says the purchase was a test one (RevenueCat's `isSandbox`).

**Scenes as levels.** When a scene becomes the active one, it's a level and `level_start` is sent, unless its name reads as a menu, loader, overlay or end screen: `Boot`, `Bootstrap`, `Init`, `Preloader`, `Loading`, `Splash`, `Title`, `MainMenu`, `UI`, `HUD`, `Pause`, `GameOver`, `Settings`, `Credits`, `Shop`, `Empty` and the like (the words are matched after splitting camelCase). The level ends when its scene unloads. A menu made active on top doesn't end it. `SceneManager.LoadScene` of the same scene is a restart. Change it with:

- `LevelForScene = name => name.StartsWith("World") ? name : null` to choose yourself;
- `SceneLevels = false` to turn it off;
- any `Glitchless.LevelStart()` call, which turns scene levels off for the rest of the session. Use this when one scene plays many levels.

## Multiplayer

**Matches, parties and runs.** `Glitchless.SetGroup("match", id)` marks every event and frame window from then on with the match, so Glitchless can compare everyone who played it: a whole lobby lagging at minute 12 points at the server, one player lagging at their connection. The ID comes from your game's servers and is the same for everyone in the match: a Lobby or Multiplayer Services session ID works (`session.Id`). `SetGroup("party", id)` does the same for a party, never a guild or a friends list. `SetGroup("match", null)` ends it. Match and party IDs are hashed before they are sent (`h_` and 24 hex characters, with your service name as the salt, the same in every Glitchless SDK); `HashGroupIds = false` sends them as they are, to match them against your own server logs. For a roguelite, `var run = Glitchless.SetGroup("run")` starts a run and returns its ID; save it and pass it back (`SetGroup("run", saved)`) to carry a run across a restart. That works in install and full mode; in anonymous mode a passed run ID becomes a new one, so nothing ties two launches together.

**Ping and disconnects.** With [Netcode for GameObjects](https://docs-multiplayer.unity3d.com/netcode/current/about/) 2.x (Relay and Lobby included) or [Mirror](https://mirror-networking.com), every frame window while connected carries the round trip to the server, sampled once a second, its jitter, and whether the connection goes through Unity Relay (NGO). There is nothing to set up and no dependency: the SDK finds the library at run time, as it finds Steamworks. On a phone, `link` says Wi-Fi or mobile data. A host of a listen server has no round trip of its own and says `host: true`.

A dropped connection is a `disconnect` event with why (`timeout`, `connection_lost`, `kicked`, `server_closed`, `failed_to_connect` or `other`), how long it was connected and the ping just before. A level going ends as an abandon with the reason `disconnect`, never a fail, so walls aren't blamed for a bad connection; when the player reconnects and plays on, the level carries on. Leaving on purpose (`NetworkManager.Shutdown()`, Mirror's `StopClient()`) is not a disconnect.

Another library (Steam Networking Sockets, Photon, Fish-Net, Epic Online Services, your own): send what it knows yourself.

```csharp
Glitchless.NetSample(rttMs: ping, lossPct: loss);   // once a second; loss and jitter where you have them
Glitchless.Disconnect("timeout");                  // when the connection drops
Glitchless.Reconnect();                            // when it's back
```

With NGO or Mirror, `NetSample(null, lossPct)` adds packet loss, which neither reports. `Netcode = false` in the options stops the SDK reading them.

**Server mode.** A dedicated server built with the **Dedicated Server** build target, a player run with `--glitchless-server`, or `Role = GlitchlessRole.Server` in the options reports as a server, never as a player. It sends to your game's companion service, `my-game.server`, so no player number counts it. Every 5 seconds it sends a server window: its tick time against its budget, the tick rate it reached, ticks that ran late, players connected, networked objects, the players' ping as it sees them, CPU and memory. Ticks are NGO's network ticks (its `TickRate`), Mirror's server updates (one a frame), or `FixedUpdate`'s steps on a server with neither; a tick's time is the work of the frame it ran in, not the wait for the next. Players come from NGO's or Mirror's connections, or `Glitchless.SetPlayers(n)`. Errors, events, levels (the map) and groups (the match) go as from a player.

```csharp
Glitchless.Init(new GlitchlessOptions
{
    Service = "my-game",                 // the game's own name: the server reports as my-game.server
    Intake = "https://api.glitchless.gg",
    ClientToken = "gl_pub_…",
    ServerRegion = "eu-west",            // in your own words, never an address
    MaxPlayers = 16,
    SessionPerMatch = true,              // a server that hosts one match at a time: one session per match
});
```

Batch mode doesn't make a server's session a bot's (`--glitchless-synthetic` does, for a load test). A server sends nothing about players but their count and ping, and nothing about itself but its OS, cores, memory and the region you name. It sends nothing at all until the Glitchless server says it has server mode, so its sessions can't land among your players' on an older server. A session lasts as long as the process, cut every 6 hours.

**Code stripping.** As for Steam: at Low or higher Managed Stripping Level, keep what the SDK reads by reflection with a `link.xml` (`Unity.Netcode.Runtime` for NGO's `NetworkManager`, `NetworkConfig`, `NetworkTickSystem`, `NetworkSpawnManager` and `Transports.UTP.UnityTransport`; `Mirror` for `NetworkClient`, `NetworkServer`, `NetworkTime` and `NetworkManager`).

## Bug reports

Players and playtesters flag a problem where they see it, and you (or your coding agent, with the `glitchless_bug_reports` MCP tool) see it in Glitchless's Bug Reports view with the screenshot and a link to the session's replay. Turn the hotkey on in the options:

```csharp
Glitchless.Init(new GlitchlessOptions
{
    Service = "my-game",
    Intake = "https://api.glitchless.gg",
    ClientToken = "gl_pub_…",
    BugReports = new BugReportOptions(),               // F8 opens the form
});

Glitchless.OpenBugReport();                            // a pause menu's "Report a bug" (works without BugReports)
Glitchless.ReportBug(note, done: (sent, reason) => …); // your own form; reason is "offline" or "error" when not sent
if (Glitchless.IsBugReportOpen) return;                // input you read from UnityEngine.Input while the form is open
```

| `BugReportOptions` | default | |
| --- | --- | --- |
| `Hotkey` | `KeyCode.F8` | opens and closes the form; `KeyCode.None` for no hotkey. Read from the Input System when the game uses it, else from the Input Manager |
| `PauseGame` | `true` | while the form is open, `Time.timeScale` is 0 and the Input System's enabled actions are off, so the game neither moves nor acts on what the player types. Both come back on close. Set it to `false` if the game pauses itself in `OnOpen` |
| `Screenshot` | `true` | send a screenshot with each report |
| `OnOpen`, `OnClose` | | the form opened or closed: pause and resume the game, mute its music |

- **The screenshot** is `ScreenCapture.CaptureScreenshotAsTexture()` at the end of the frame, before the form is drawn, so the form is never in it. It is shrunk until it fits the server's 200,000-character limit: the longer side at most 960 px, then 800, 640, 480 and 320, at lower JPEG quality. The frame that reads it back isn't timed, so it never shows as a hitch. With `-nographics` nothing is drawn, so reports have no screenshot.
- **The form** is drawn with IMGUI, so the game needs no Canvas or EventSystem, and on top of the game's own `OnGUI`. It reads keys the way uGUI's input field does (`Event.PopEvent`) and clicks from the Input System or the Input Manager, so it works with either, or both. Esc cancels, Ctrl+Enter (Cmd+Enter) sends; on a phone the system keyboard opens. A locked cursor is freed while it's open.
- **What it can't hold back:** input the game reads straight from `UnityEngine.Input` or a device (`Keyboard.current.spaceKey`), and clicks on a uGUI Canvas behind it. Check `Glitchless.IsBugReportOpen` there, as the Fetch! sample does.
- **Sending:** a report goes on a request of its own straight away, from every session (`SampleRate` doesn't apply), with the last 20 game events and hitches, the last frame windows and the device. It waits in the outbox meanwhile, so a report made offline goes with a later batch, even on a later launch.
- **The note is the player's own words.** [PRIVACY.md](PRIVACY.md#bug-reports-the-players-own-words) says what to tell players, and the dashboard can delete a report a player asks about.

## Steam

If the game already uses [Steamworks.NET](https://steamworks.github.io) or [Facepunch.Steamworks](https://github.com/Facepunch/Facepunch.Steamworks), every session also says which Steam build and beta branch it ran, whether on a Steam Deck (or, with an SDK 1.65 wrapper, a Steam Machine or Steam Frame), under Proton, in Big Picture mode, with which kind of controller, in which Steam language, and whether through Family Sharing or a timed trial. There is nothing to set up and no dependency: the SDK finds the wrapper by reflection and reads only what the game has set up. Nothing is read until Steam is initialised (`SteamAPI.Init`, or Steamworks.NET's `SteamManager`, or `SteamClient.Init`), and the facts are read when the first batch goes, so a `SteamManager` that wakes up after `Glitchless.Init` still counts. The controller is known only once the game has started Steam Input. No Steam ID, owner or name is ever read ([PRIVACY.md](PRIVACY.md#steam-facts) has a paragraph for your privacy page).

**Versions are Steam builds.** Leave `Version` empty and a Steam build reports `steam-<build>` (`steam-18231`), so every upload to Steam is a version the Versions page and `glitchless_compare_versions` can compare, without bumping anything. Outside Steam (the Editor, a build you run yourself) it falls back to `Application.version`. A `Version` you set always wins.

**Branches.** Filter any dashboard query with `steam_branch=beta`, split a breakdown panel by `$steam_branch`, or compare branches with a versions panel `by: "$steam_branch"` or `glitchless_compare_versions` with `by: "steam_branch"`: the beta against `public` on the same numbers.

**Code stripping.** At the default Managed Stripping Level (Minimal) nothing more is needed. At Low or higher, keep the calls the SDK makes by reflection with a `link.xml` in your Assets folder (use the wrapper's assembly name: `com.rlabrecque.steamworks.net` for Steamworks.NET from a package, `Assembly-CSharp-firstpass` from the .unitypackage, `Facepunch.Steamworks.Win64` or `.Posix` for Facepunch):

```xml
<linker>
  <assembly fullname="com.rlabrecque.steamworks.net" ignoreIfMissing="1">
    <type fullname="Steamworks.SteamApps" preserve="all" />
    <type fullname="Steamworks.SteamUtils" preserve="all" />
    <type fullname="Steamworks.SteamInput" preserve="all" />
  </assembly>
</linker>
```

## What it measures, and where

| | Release build | Development build and Editor |
| --- | --- | --- |
| frame time, hitches, GC collections | yes | yes |
| physics, update and render time per frame (timing points in the player loop) | yes | yes |
| draw calls, SetPass calls, batches, triangles | yes | yes |
| GC heap and system memory | yes | yes |
| GPU time (`FrameTimingManager`, the latest frame the GPU has finished, which can be a few frames behind) | with **Player Settings → Frame Timing Stats** on | the same |
| mesh, material, texture and object counts, allocation per frame, shader compiles | no | yes |

The counts come from Unity's profiler counters (`ProfilerRecorder`), which Unity only fills in development builds. That's where leaks show up, so run your playtest bots on a development build.

**What a frame window's numbers mean.** Over the window's frames: `frames`, `fps` and the frame-time sketch and percentiles; `slow`, `jank`, `hitches` and `frozen` are counts, and `gc_collections` a total. `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `draw_calls`, `triangles`, `setpass_calls`, `batches` and `gc_alloc_kb` are averages per frame, and `draw_calls_max` and `ft_max` the highest. Each `ctx` gauge is its highest value in the window. The memory and object counts (`geometries` for meshes, `textures`, `materials`, `objects`, `game_objects`, `heap_mb`, `gc_reserved_mb`, `system_mb`) are their value as the window closed, sampled every 30 frames, so a window a level start cuts short keeps the sample from just before it.

**Refresh rates.** `hz` and `budget_ms` in each window are the rate the game ran at (60 Hz, 120 Hz, or a cap the game set), measured from its frames. A frame can take longer than the screen's interval but never less, so the fast frames tell the rate: their 20th percentile, a first guess after 30 frames, the answer at 120, then a look every 480 frames that only goes faster, and lowered when the OS reports a slower screen. `refresh_hz` in `session_start` is the screen's rate as the OS reports it, often the most the panel can do: a 120 Hz phone in Low Power Mode, or a game capped at 60, can still report 120.

**Stack traces.** Mono builds report files and lines. IL2CPP builds report method names; for files and lines, set **Player Settings → IL2CPP Stacktrace Information** to *Method Name, File Name, and Line Number*.

**Error kinds.** `exception` is an exception nothing caught: Unity skipped the rest of that `Update` or coroutine, and the dashboard counts it as unhandled. `log_error` is `Debug.LogError` or an error from the engine, `assert` a failed assertion, `manual` what you pass to `Glitchless.Error`. Warnings are off unless `CaptureWarnings` is on.

## Sending

Events are summed up per 5-second frame window and sent every 15 seconds (the first batch after 2), gzipped, with `UnityWebRequest`. A batch that fails is retried with backoff (5 s, doubling to 5 minutes). Batches that couldn't be sent are saved in `Application.persistentDataPath/glitchless/` and sent on a later launch; in anonymous mode they're saved without the session or player ID. Each batch keeps its own random `batch_id` through every retry and launch, so the server stores it once even when an answer was lost on the way back (a timeout, or a send cut short by going to the background or quitting). At `Init` the SDK asks the server what it takes (`GET /v1/health`), so it never sends counters or a server's sessions to a server that would drop them or count them wrong.

When a phone app goes to the background the session ends and the last batch is sent at once, waiting at most 1.5 s, because iOS and Android often stop a backgrounded app without warning. Back within 5 minutes, the session carries on; later, it's a new session. Quitting sends the last batch the same way.

WebGL builds send without gzip and keep nothing on disk (an install or player ID goes in PlayerPrefs). For a web game, the [browser SDK](https://github.com/glitchless-gg/glitchless/tree/main/packages/sdk) also measures the page itself.

## For coding agents

Run a built player with `--glitchless-measure=SECONDS` and it prints one line of JSON with frame stats over that many seconds, then quits: the same numbers as the browser SDK's `glitchless_measure` tool, for a before-and-after comparison of a fix.

| Flag | Does |
| --- | --- |
| `--glitchless-measure=SECONDS` | print `{"glitchless_measure": {...}}` and quit |
| `--glitchless-warmup=SECONDS` | with measure: wait this long first |
| `--glitchless-out=PATH` | with measure: write the JSON to a file too |
| `--glitchless-intake=URL` | send to this server instead |
| `--glitchless-synthetic` | mark the session as a bot's (`--autoplay` and batch mode do too) |
| `--glitchless-server` | run as a game server ([server mode](#multiplayer)) |
| `--glitchless-off` | send nothing |
| `--glitchless-debug` | log each batch as it is sent |

In the Editor, `Glitchless.Measure(5, r => Debug.Log(Json.Serialize(r)))` does the same from code, for example through an agent that can run C# in a live Editor.

## The sample

**Package Manager → Glitchless → Samples → Fetch! → Import** adds a small runner with an autoplay bot and four planted bugs for Glitchless to find: a mesh and material leak on every level load, confetti made of physics cubes that are never destroyed, an exception on the level 3 frisbee, and a jump almost nobody makes. Open `FetchBoot.unity` and press Play; set the intake on the **Fetch** GameObject. A built player takes `--autoplay --seed=7 --skill=0.9 --level=2`. F8 opens the bug report form; `--bug-report-at=5` sends a report from code five seconds in.

## Tests

The package has EditMode tests (the frame-time sketch and error fingerprints are checked bucket for bucket against the JavaScript SDK; bug reports' contents, sending and screenshot shrinking; counters, properties, groups, zones, ping and disconnects, Mirror through stand-ins, and server mode) and PlayMode tests (the runner, the bug report form pausing the game, and a real Netcode for GameObjects server and client in one run, which compiles only where NGO 2.x is installed). Add `"testables": ["gg.glitchless.sdk"]` to your `Packages/manifest.json` to see them in the Test Runner.
