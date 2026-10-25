# Unity

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The `gg.glitchless.sdk` package, for Unity 6.3 LTS and later (6.5 included).

## 1. Read the project

Note: the Unity version (`ProjectSettings/ProjectVersion.txt`; 6000.3 or later: on an older Unity, say Glitchless needs Unity 6.3 LTS or later), the first scene
(`ProjectSettings/EditorBuildSettings.asset`), which scenes are levels, the scripts for player death and respawn,
level complete and fail, pickups, and anything spawned in bulk; where the version lives (`bundleVersion` in
`ProjectSettings/ProjectSettings.asset` is `Application.version`).

## 2. Install

Add one line to `dependencies` in `Packages/manifest.json`:

```json
"gg.glitchless.sdk": "https://github.com/glitchless-gg/glitchless.git?path=unity/Packages/gg.glitchless.sdk"
```

Unity resolves it the next time the Editor has focus. Pin a release by adding `#gg.glitchless.sdk/v0.4.1`.

## 3. Initialize, without touching a scene file

Create `Assets/Scripts/GlitchlessSetup.cs`:

```csharp
using GlitchlessSdk;
using UnityEngine;

static class GlitchlessSetup
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Init() => Glitchless.Init(new GlitchlessOptions
    {
        Service = "<game-id>",
        Intake = "http://localhost:7777",
        ClientToken = "gl_pub_dev",
    });
}
```

It runs before the first scene loads, so no scene needs editing. (If the project has an assembly definition for
its scripts, add `GlitchlessSdk` to its references.) The Editor and development builds send with `Env` `dev`;
release builds with `prod`.

## 4. Levels and game semantics

Scenes are levels on their own: each scene that becomes active is a level unless its name reads as a menu, loader,
overlay or end screen (`Boot`, `Loading`, `MainMenu`, `UI`, `HUD`, `GameOver`…). If one scene plays many levels,
call `Glitchless.LevelStart("world-1-2")` where a level begins (that turns scene levels off), or set
`LevelForScene` in the options.

| Game moment | Call |
| --- | --- |
| level beaten | `Glitchless.LevelComplete("level-2", score: 1200)` |
| game over: the player lost the level | `Glitchless.LevelFail("level-2", "fell")` |
| the player leaves mid-level (the menu, a restart) | `Glitchless.LevelAbandon("level-2")`: never a fail; quitting or going to the background mid-level sends one by itself |
| player dies | `Glitchless.Death(player.position, "spikes")` |
| pickups, checkpoints | `Glitchless.Track("powerup", "magnet")` |
| a purchase the store confirmed | `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" })` |
| counts of anything that scales, each frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, each frame | `Glitchless.SetPosition(player.position)` |
| a caught exception | `Glitchless.Error(e)` |

Uncaught exceptions, `Debug.LogError` and engine errors are reported without any code.

## 4b. Bug reports from players (ask first)

As for [Three.js](threejs.md#4b-bug-reports-from-players-ask-first): ask the user first, since the note is free text the
player types, and point them at the privacy wording in the package's `PRIVACY.md`. Then add one line to the options:

```csharp
BugReports = new BugReportOptions(), // F8 opens the form; OnOpen / OnClose to pause, Hotkey to change the key
```

The form is IMGUI, so the game needs no Canvas or EventSystem, and it works with the Input Manager and the Input
System. While it's open, `Time.timeScale` is 0 and the Input System's actions are off (`PauseGame`). Input the game
reads straight from `UnityEngine.Input` or a device isn't held back: guard it with `if (Glitchless.IsBugReportOpen)
return;`. A pause menu can call `Glitchless.OpenBugReport()`, and the game's own form `Glitchless.ReportBug(note)`.

## 5. Bots and measuring

If the game has an autoplay or test mode, start it from the command line (`--autoplay --seed=N`): the SDK marks
those sessions synthetic. To measure a build before and after a change, run the player with
`--glitchless-measure=10 --glitchless-out=measure.json` (add `-batchmode -nographics` on a machine without a
screen); it writes frame stats as JSON and quits. In a live Editor you can drive, `Glitchless.Measure(5, r => Debug.Log(Json.Serialize(r)))`
does the same.

## 6. Verify

Press Play in the Editor, play a level and die once, then call `glitchless_list_games` or open the dashboard.
The **Glitchless** GameObject under DontDestroyOnLoad shows the SDK is running.
