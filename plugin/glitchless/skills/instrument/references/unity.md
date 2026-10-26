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

Unity resolves it the next time the Editor has focus. Pin a release by adding `#gg.glitchless.sdk/v0.5.0`.

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
| a stream: shots, hits, kills, gold, taps | `Glitchless.Count("kill", "elite")`, `Glitchless.Count("gold", new Dictionary<string, object> { ["source"] = "loot", ["amount"] = 35 })` |
| what holds for the session: mode, rank tier, class, server region | `Glitchless.SetProperty("rank", "diamond")`, or `Properties` in the options |
| what kind of attempt a level is | `Glitchless.LevelStart("deadmines", new Dictionary<string, object> { ["difficulty"] = "heroic", ["party_size"] = 5 })` |
| where the player is in an open world | `Glitchless.SetZone("westfall")` |
| a purchase the store confirmed | `Glitchless.Track("purchase", new Dictionary<string, object> { ["amount"] = 4.99, ["currency"] = "USD", ["item"] = "gems_500" })` |
| counts of anything that scales, each frame | `Glitchless.SetContext("enemies", enemies.Count)` |
| the player's place, each frame | `Glitchless.SetPosition(player.position)` |
| a caught exception | `Glitchless.Error(e)` |

Uncaught exceptions, `Debug.LogError` and engine errors are reported without any code.

Track a moment, count a stream: anything that happens several times a second (each bullet, each coin) goes through
`Count`, which adds it up on the device; a `Track` for each would fill the SDK's queue. Properties hold for the whole
session: set them where the game knows them (after sign-in, at the menu, at matchmaking), as bands (`"30-39"`) rather
than exact numbers, and never anything that says who the player is (the SDK drops `email`, `user_id`, IDs and links).
What changes from match to match (hero, deck, map) goes on `LevelStart` or the event.

## 4c. Multiplayer

Look for the netcode first: `com.unity.netcode.gameobjects` in `Packages/manifest.json` (NGO, often with
`com.unity.services.multiplayer`, Relay or Lobby), or a `Mirror` folder or package.

- **NGO 2.x or Mirror:** nothing to add for ping and disconnects. The SDK finds them at run time and sends round trips,
  jitter, Relay or not, and disconnects with their reason; a level going ends as an abandon with reason `disconnect`.
- **Anything else** (Steam Networking Sockets, Photon, Fish-Net, EOS, the game's own): call
  `Glitchless.NetSample(rttMs: ping, lossPct: loss)` once a second where the game reads its ping,
  `Glitchless.Disconnect("timeout")` where it handles a drop (`timeout`, `connection_lost`, `kicked`, `server_closed`,
  `failed_to_connect`, `other`), and `Glitchless.Reconnect()` when it's back.
- **The match:** where every player joins one match or lobby, `Glitchless.SetGroup("match", id)` with an ID everyone in
  it shares (a Lobby's `lobby.Id`, a Multiplayer Services `session.Id`, or the game server's match ID), and
  `Glitchless.SetGroup("match", null)` when it ends. A party: `SetGroup("party", id)`, never a guild or friends list.
  A roguelite run: `var run = Glitchless.SetGroup("run")`, saved with the run if it survives a restart. The SDK hashes
  match and party IDs.
- **A dedicated server:** a build with the Dedicated Server target reports as `<service>.server` by itself, with its
  tick time, players and the players' ping, and never counts as a player; for a headless server built otherwise, add
  `--glitchless-server` to its command line or `Role = GlitchlessRole.Server` to its options. Set `ServerRegion` (in the
  game's words) and `MaxPlayers`, and `SessionPerMatch = true` when a server process hosts one match at a time. Call
  `Glitchless.SetPlayers(n)` only if the game counts players without NGO or Mirror. The server's code should set the
  same match group as its players.

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
For an online game, play one match with the console open: in the Editor the SDK says there if it dropped a property or
a group ID, or if the server doesn't take counters or a game server's sessions yet.
The **Glitchless** GameObject under DontDestroyOnLoad shows the SDK is running.
