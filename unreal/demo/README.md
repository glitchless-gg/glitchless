# Glitchless Unreal demo

A tiny Unreal Engine 5.8 game with three planted problems, there for Glitchless to find. It shows what an Unreal game
gets from Glitchless: hitches named by their cause, errors grouped with what led to them, and fixes in Unreal's own
terms.

It has two levels, each a short scene that plays itself:

| level | what happens | planted problem | what Glitchless says |
| --- | --- | --- | --- |
| **gallery** | statues in a ring; fireworks at 6 s and again at 12 s | The fireworks draw three materials (`Content/Demo/M_Fireworks_*`) that no frame has drawn yet. PSO precaching is off (`r.PSOPrecaching=0` in `Config/DefaultEngine.ini`), so the frame waits while their pipeline states are created. That's once per run, the first time | a `pso_compile` hitch on gallery, right after `fireworks`: keep PSO precaching on, ship a bundled PSO cache, and spawn first-use effects behind the loading screen |
| **forge** | an anvil and a furnace, with sparks every frame | Every spark is a `UObject` (`UDemoSpark`), made 60,000 a second and dropped half a second later, so each garbage collection has about 900,000 to purge. The demo collects every 15 s instead of Unreal's 61 so a short run sees it | `gc` spikes on forge, every collection: pool, keep short-lived data out of UObjects, cluster, collect behind loading screens |
| **forge** | at 4 s it opens the forge's gate | the gate is looked up by the tag `ForgeGate`, which no actor on the forge has: `ensureMsgf` fires, once per run | an `ensure` issue on forge with its stack: a UObject that is null or pending kill; test it with `IsValid()` and handle the case |

The levels are the engine's template maps (`Template_Default` and `TimeOfDay_Default`), so the demo carries no map
files. The game names them `gallery` and `forge` itself (`bMapLevels=False`, then `LevelStart`), builds the scene from
the engine's basic shapes, and tracks `fireworks`, `gate`, `respawn` and a death on forge. The only assets are the
three firework materials, which `GlitchlessDemo/Scripts/make_content.py` makes.

## Run it

You need UE 5.8 at the default path, or `UE_ROOT` set to it. `run.mjs` builds the editor target, makes the content
with the editor's Python, packages a Development build, starts a local Glitchless server, lets three bots play
(about a minute each), measures gallery once with `-glitchless-measure`, and checks the findings:

```bash
node unreal/demo/run.mjs
```

Later runs can skip the build with `--no-build`. `--serve` leaves the server and its dashboard running afterwards.

Each run starts with the demo's Metal shader cache cleared, the way a player's first launch would. macOS keeps the GPU
code it compiled for each app, so without that only the very first run would hitch. The script never starts a build
while another Unreal build or shader compile is running.

Play it by hand from the editor: open `GlitchlessDemo/GlitchlessDemo.uproject`, run the content script once (**Tools →
Execute Python Script** → `Scripts/make_content.py`), then press Play. Or run the packaged game:

| flag | |
| --- | --- |
| `-autoplay` | play both levels as a bot (a synthetic session), then quit |
| `-demo-level=forge` | start on the forge, for measuring the sparks alone |
| `-glitchless-warmup=1 -glitchless-measure=15` | frame stats for 15 s as one line of JSON, then quit: on gallery it catches the fireworks |
| `-glitchless-intake=http://127.0.0.1:7777` | send to that server (the default is the one in `Config/DefaultGame.ini`) |

## Fix it

Each fix is a line or two, which makes the demo a good before-and-after for an agent working from the findings:

1. **PSO:** delete `r.PSOPrecaching=0` from `Config/DefaultEngine.ini`. Precaching then compiles the fireworks'
   pipeline states in the background as the spheres are spawned, and draws them once they're ready, so the frame no
   longer waits. A bundled PSO cache would go further, compiling them behind the loading screen.
2. **GC:** keep the sparks in a `TArray<FSpark>` of plain structs, or use a Niagara system, instead of `NewObject` per
   spark. That leaves nothing to collect.
3. **ensure:** give the forge a gate. `BuildForge` spawns none; spawn one and tag it `ForgeGate`. Or, if a forge
   without a gate is fine, test it with `if (Gate)` instead of the ensure.

Bump `ProjectVersion` in `Config/DefaultGame.ini` after a fix, so Glitchless can compare the versions.
