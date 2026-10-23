---
name: deck
description: Send a game build to the user's Steam Deck over the local network, put it in the Deck's library, start it, read its logs and measure it there with Glitchless, using the glitchless-deck command (macOS, Windows or Linux; Godot, Unity, Unreal or web games). Use when the user asks to put, send, deploy, install, run, play or test a build on the Steam Deck or "the Deck", to check how a game performs on the Deck, to set a project up for Deck testing, to pair a Deck, or when a Deck send fails.
---

# Glitchless Deck

`glitchless-deck` builds a game, checks it is something the Deck can run, sends it to the user's Steam Deck over the network and adds it to the Deck's library as "Devkit Game: <id>", playable in Gaming Mode. Only changed files travel, so repeat sends take seconds. It can start the game remotely, show what it printed, and measure it on the Deck with the Glitchless SDK, compared with a saved run.

Run it with `npx -y glitchless-deck <command>` (Node 20+), or `glitchless-deck <command>` if it is installed globally. `glitchless-deck guide` prints the full reference.

The MCP tools `glitchless_deck_send` and `glitchless_deck_measure` do the same as `send` and `measure` when the Glitchless MCP server is connected.

## 1. Check the Deck

```bash
glitchless-deck status
```

- `ready`: go on.
- `Not paired`: pair it (below). The user has to act on the Deck, so ask them.
- `not answering`: the Deck is asleep or on another network. Ask the user to wake it. Don't retry in a loop.
- `Steam is not running`: Gaming Mode is still loading, or the Deck is in Desktop Mode. Ask the user to switch to Gaming Mode.

## 2. Pair (once per computer, needs the user)

Pairing gives this computer full control of the Deck. Never pair without the user knowing. Ask them to:

1. Settings > System > Enable Developer Mode.
2. Settings > Developer > Pair new host, and leave that screen open.

When they say it is showing, run `glitchless-deck pair` (or `glitchless-deck pair <address>` with the address from the Deck's Settings > Internet) and tell them to approve the request on the Deck. A 403 means the screen was not open or the request was declined: ask them to open it again, then retry once. If several Decks answer, `pair` lists them; pass the name or address of the one the user means.

## 3. Set the project up (once)

In the project's root folder:

```bash
glitchless-deck init
```

It writes `glitchless.deck.json` with the engine it finds (`project.godot`, a Unity `ProjectSettings` folder, a `.uproject`, a `package.json`). Read it, then check what that engine needs on this computer:

| engine | What the build needs | Default folder and start |
| --- | --- | --- |
| `godot` | A Linux export preset (Project > Export > Add... > Linux, x86_64) and export templates. Godot on the PATH or `GODOT=/path/to/godot`. | `build/deck`, `./<id>.x86_64` |
| `unity` | Linux Build Support for the project's Unity version (Unity Hub > Installs > Add modules), and the Editor closed on the project. | `build/deck`, `./<id>.x86_64` |
| `unreal` | A Windows host (Win64, played through Proton) or a Linux host. `UE_ROOT` set to the engine folder. A Mac can't build for the Deck: build elsewhere and send the folder with `"build": false`. | `build/deck`, `./Windows/<Project>.exe` (Proton) or `./Linux/<Project>.sh` |
| `web` | `npm run build` making `dist/`. On the Deck, Google Chrome or Chromium from Discover; the game opens full screen in it. `"web": { "mode": "electron" }` sends an Electron app packaged for Linux x64 instead. | `dist`, the kiosk launcher |

Any field can be set by hand: `folder` (the build alone, never the project root), `run` (start command inside the folder), `build` (a shell command, or `false` to send as built), `proton`, `env`, `settings`, `artwork` (`capsule` 600x900, `wide` 920x430, `hero` 3840x1240, `logo`, `icon`: PNG or JPG paths). `id` is the name on the Deck: letters, digits, `_` and `.`, starting with a letter, unique across the user's projects.

Add the build folder and `.glitchless/` to `.gitignore`.

## 4. Send, start, read

```bash
glitchless-deck send                 # build, check, send, add to the library
glitchless-deck send --no-build      # send what is already built
glitchless-deck send --launch        # and start it
glitchless-deck launch               # start it (closes a copy already running)
glitchless-deck logs                 # what it printed on its last run
glitchless-deck stop                 # close it
```

Success ends with `Done in Ns. On the Deck: Library > Non-Steam > Devkit Game: <id>`. Report that line, or the message printed instead. The game name can be left out when the project has one game.

Checks before sending stop a build the Deck can't run: a macOS or ARM build, a Windows build without `"proton": true`, a script with Windows line endings, an empty or missing start file, or a folder that is the project itself. Fix the build or the entry; don't work around the check.

## 5. Measure on the Deck

For Unity, Godot and Unreal builds with the Glitchless SDK (the `instrument` skill adds it). Steam starts the game as "Devkit Game: <id>_measure" with `--glitchless-measure`, it records frame times for the given seconds and quits, and the numbers come back here.

```bash
glitchless-deck measure --save baseline       # BEFORE changing the code
# ...change the code...
glitchless-deck send
glitchless-deck measure                       # compared with baseline; exit 1 on a regression
```

- A FAIL is unfinished work: fix the regression it names, send, measure again.
- Frame time often hides a slower build behind vsync (the Deck runs at 60 Hz). Update CPU and render CPU per frame don't, so read those lines first.
- `--seconds 20 --warmup 5` measure longer or after a longer load. Game arguments go after `--`: `glitchless-deck measure -- --level=3 --autoplay`.
- Runs are saved in `.glitchless/deck/<id>/`; `glitchless-deck compare baseline latest` compares two again.
- Web games measure in the browser: use `glitchless-playtest` or the `glitchless_measure` WebMCP tool.

To have sessions from the Deck show up in the user's local Glitchless dashboard, add `--glitchless` to `send` or `measure`. It needs the Glitchless server running here (`npm run server`) and reachable from the Deck. If it says the Deck cannot reach the server, the firewall on this computer is blocking it: tell the user where to allow it (the message says).

## Rules

- `~/.config/glitchless-deck/` holds the pairing. Change it only through the commands. Don't pair again unless the user asks or `status` says the pairing is gone.
- Other games on the Deck are the user's. Only send, launch, stop or remove games listed in this project's `glitchless.deck.json`. `remove` takes a game's files, library entry and artwork off the Deck; ask the user before running it.
- A send replaces the Deck's copy of that game. Saves live in the game's own user folder on the Deck and are untouched.
- Edit only this project's `glitchless.deck.json`. A Deck Delivery `deck_delivery.json` is read the same way and can stay.
