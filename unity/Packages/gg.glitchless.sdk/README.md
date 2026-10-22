# Glitchless for Unity

Game observability for Unity 2022.3 LTS and Unity 6. Glitchless records how your game runs for real players and gives your coding agent the same data, over MCP, so it can fix what they hit.

- **Stutter.** Every frame is timed from `Time.unscaledDeltaTime`. Each frame window carries a mergeable frame-time sketch and where the time went: physics, your `Update` code, rendering, the GPU. Each hitch (a frame over 50 ms and twice the recent median) comes with its likely causes: a garbage collection, a shader compile, a scene load, a burst of new objects, or long script, physics or render work.
- **Errors.** Uncaught exceptions, `Debug.LogError`, assertions and engine errors, through `Application.logMessageReceivedThreaded`, grouped by the same fingerprint the web and Godot SDKs use, with the game events just before each one.
- **Levels and players.** Scenes are levels on their own. Deaths, level fails and quits feed the level funnel, death heatmaps and rage-quit detection.
- **Leaks.** Mesh, material, texture and object counts per level load, where a development build has them.
- **Anonymous by default.** No player ID, no device identifier, coarse device facts only. [PRIVACY.md](PRIVACY.md) lists every field.

It sends the same events as the [browser](https://github.com/glitchless-gg/glitchless/tree/main/packages/sdk) and [Godot](https://github.com/glitchless-gg/glitchless/tree/main/godot/addons/glitchless) SDKs, so the dashboard, the findings and the MCP tools work with a Unity game as they are.

## Install

In Unity: **Window → Package Manager → + → Add package from git URL…**, and paste:

```
https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk
```

Or add it to `Packages/manifest.json`, pinned to a release:

```json
"gg.glitchless.sdk": "https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk#gg.glitchless.sdk/v0.1.0"
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

Glitchless starts itself before the first scene loads, so frame times and errors from the very first frames are kept; nothing is sent until `Init`. Define `GLITCHLESS_DISABLE` in **Player Settings → Scripting Define Symbols** to stop that automatic start.

The Editor and development builds send too, with `Env` set to `dev` unless you set it, so you can check data arrives from Play mode. Release builds default to `prod`.

## Tell it about your game

| Game moment | Call |
| --- | --- |
| a level starts (a restart counts) | automatic for scenes, or `Glitchless.LevelStart("level-2")` |
| a level is beaten | `Glitchless.LevelComplete("level-2", score: 1200)` |
| the player gives up or runs out of lives | `Glitchless.LevelFail("level-2", "fell")` |
| the player dies | `Glitchless.Death(player.position, "spikes")`: short, low-cardinality causes |
| pickups, purchases, checkpoints | `Glitchless.Track("powerup", "magnet")` |
| counts of anything that scales, every frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, every frame | `Glitchless.SetPosition(player.position)` (sent only when positions are on) |
| an exception you caught | `Glitchless.Error(e)` |

Use the game's own words for names, causes and levels, never anything a player typed.

**Scenes as levels.** When a scene becomes the active one, it's a level and `level_start` is sent, unless its name reads as a menu, loader, overlay or end screen: `Boot`, `Bootstrap`, `Init`, `Preloader`, `Loading`, `Splash`, `Title`, `MainMenu`, `UI`, `HUD`, `Pause`, `GameOver`, `Settings`, `Credits`, `Shop`, `Empty` and the like (the words are matched after splitting camelCase). The level ends when its scene unloads. A menu made active on top doesn't end it. `SceneManager.LoadScene` of the same scene is a restart. Change it with:

- `LevelForScene = name => name.StartsWith("World") ? name : null` to choose yourself;
- `SceneLevels = false` to turn it off;
- any `Glitchless.LevelStart()` call, which turns scene levels off for the rest of the session. Use this when one scene plays many levels.

## What it measures, and where

| | Release build | Development build and Editor |
| --- | --- | --- |
| frame time, hitches, GC collections | yes | yes |
| physics, update and render time per frame (timing points in the player loop) | yes | yes |
| draw calls, SetPass calls, batches, triangles | yes | yes |
| GC heap and system memory | yes | yes |
| GPU time | with **Player Settings → Frame Timing Stats** on | the same |
| mesh, material, texture and object counts, allocation per frame, shader compiles | no | yes |

The counts come from Unity's profiler counters (`ProfilerRecorder`), which Unity only fills in development builds. That's where leaks show up, so run your playtest bots on a development build.

**Stack traces.** Mono builds report files and lines. IL2CPP builds report method names; for files and lines, set **Player Settings → IL2CPP Stacktrace Information** to *Method Name, File Name, and Line Number*.

**Error kinds.** `exception` is an exception nothing caught: Unity skipped the rest of that `Update` or coroutine, and the dashboard counts it as unhandled. `log_error` is `Debug.LogError` or an error from the engine, `assert` a failed assertion, `manual` what you pass to `Glitchless.Error`. Warnings are off unless `CaptureWarnings` is on.

## Sending

Events are summed up per 5-second frame window and sent every 15 seconds (the first batch after 2), gzipped, with `UnityWebRequest`. A batch that fails is retried with backoff (5 s, doubling to 5 minutes). Batches that couldn't be sent are saved in `Application.persistentDataPath/glitchless/` and sent on a later launch; in anonymous mode they're saved without any ID.

When a phone app goes to the background the session ends and the last batch is sent at once, waiting at most 1.5 s, because iOS and Android often stop a backgrounded app without warning. Back within 5 minutes, the session carries on; later, it's a new session. Quitting sends the last batch the same way.

WebGL builds send without gzip and keep nothing on disk. For a web game, the [browser SDK](https://github.com/glitchless-gg/glitchless/tree/main/packages/sdk) also measures the page itself.

## For coding agents

Run a built player with `--glitchless-measure=SECONDS` and it prints one line of JSON with frame stats over that many seconds, then quits: the same numbers as the browser SDK's `glitchless_measure` tool, for a before-and-after comparison of a fix.

| Flag | Does |
| --- | --- |
| `--glitchless-measure=SECONDS` | print `{"glitchless_measure": {...}}` and quit |
| `--glitchless-warmup=SECONDS` | with measure: wait this long first |
| `--glitchless-out=PATH` | with measure: write the JSON to a file too |
| `--glitchless-intake=URL` | send to this server instead |
| `--glitchless-synthetic` | mark the session as a bot's (`--autoplay` and batch mode do too) |
| `--glitchless-off` | send nothing |
| `--glitchless-debug` | log each batch as it is sent |

In the Editor, `Glitchless.Measure(5, r => Debug.Log(Json.Serialize(r)))` does the same from code, for example through an agent that can run C# in a live Editor.

## The sample

**Package Manager → Glitchless → Samples → Fetch! → Import** adds a small runner with an autoplay bot and four planted bugs for Glitchless to find: a mesh and material leak on every level load, confetti made of physics cubes that are never destroyed, an exception on the level 3 frisbee, and a jump almost nobody makes. Open `FetchBoot.unity` and press Play; set the intake on the **Fetch** GameObject. A built player takes `--autoplay --seed=7 --skill=0.9 --level=2`.

## Tests

The package has EditMode tests (the frame-time sketch and error fingerprints are checked bucket for bucket against the JavaScript SDK) and PlayMode tests. Add `"testables": ["gg.glitchless.sdk"]` to your `Packages/manifest.json` to see them in the Test Runner.
