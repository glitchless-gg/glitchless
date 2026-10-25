# GameMaker

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


The Glitchless SDK for GameMaker (`gamemaker/` in the Glitchless repo; `~/.glitchless/gamemaker` if it's cloned
there) is GML: eight scripts and two objects. Its README (`gamemaker/README.md`) has the whole API; this is the
order to wire it in.

## 1. Read the project

Note: the `.yyp` (it must be GameMaker 2024.2 or later: `"$GMProject"` at its top; an older project needs opening
once in a newer GameMaker), the first room in `RoomOrderNodes` and its creation code, the controller objects that
live through the game (`persistent`), which rooms are levels and which are menus, the objects for the player, its
death and respawn, level complete and fail, pickups, and anything created in bulk (bullets, enemies, particles,
sparks). Check for an existing `exception_unhandled_handler` call and any analytics the game already sends.

## 2. Install

Without the IDE (an agent), from the Glitchless repo:

```bash
node ~/.glitchless/gamemaker/tools/install.mjs path/to/Game.yyp
```

It copies the scripts and objects into the project and lists them in the `.yyp` under a *Glitchless* folder; run it
again to update. In the IDE, **Tools → Import Local Package** with `Glitchless-<version>.yymps` does the same. Never
place `obj_glitchless` in a room: `glitchless_init` makes it.

## 3. Initialize

Once, as early as possible: the first room's creation code, or the Create event of the game's first persistent
controller.

```gml
glitchless_init("my-game", "", "prod", "<intake URL>", { client_token: "<client token>" }); // "" = GM_version
```

A build run from the IDE sends nothing without `-glitchless`; executables send. If the game sets its own
`exception_unhandled_handler`, move it into the `exception_handler` option, or call `glitchless_crash(ex)` first
thing in it, or crashes go unreported.

## 4. Levels and game semantics

- **Levels:** a room that reads as a level (`rm_cave_2`, not `rm_main_menu` or `rm_title`) starts that level on its
  own. A game whose levels aren't rooms calls `glitchless_level_start(id)` (the first call turns the rooms off), and
  every game calls `glitchless_level_complete(undefined, score)` and `glitchless_level_fail(undefined, cause)` where
  a level ends, and `glitchless_level_abandon()` where the player leaves one mid-level (the menu, a restart): never a
  fail. Quitting mid-level sends the abandon by itself.
- **Deaths:** `glitchless_death(x, y, cause)` where the player dies.
- **Gauges:** `glitchless_set_context({ enemies: instance_number(obj_enemy), bullets: instance_number(obj_bullet) })`
  in a controller's End Step: whatever is created in bulk. The SDK already sends `instances`, `surfaces`, `ds_maps`,
  `ds_lists` and `buffers`.
- **Errors the game catches:** `glitchless_error(_e)` in its `catch` blocks.
- **Quit button:** `glitchless_quit()` in place of `game_end()`, so the last batch goes now, not next launch.

## 4b. Bug reports from players (ask first)

As for [Three.js](threejs.md#4b-bug-reports-from-players-ask-first), and the same question to the user first. In GameMaker,
`bug_reports: true` in the options of `glitchless_init` adds the F8 form; it deactivates the game's instances while
it's open, so a game with its own pause passes `bug_reports: { pause: false, on_open: f, on_close: g }`. A pause menu
calls `glitchless_open_bug_report()`, and the game's own form `glitchless_report_bug(note, true, callback)`. The
screenshot is a PNG of the application surface. Privacy wording: `gamemaker/PRIVACY.md`.

## 5. Bots and measuring

Give the game an `-autoplay` flag (read it with `glitchless_has_flag("autoplay")`) that plays a few levels and
calls `glitchless_quit()`. Sessions run with `-autoplay` are synthetic. GameMaker must be set up once by a person
(`gamemaker/README.md`, "Setting up GameMaker for the end-to-end test"). Igor's `Run` (the IDE's, and `gm-cli run`)
starts the game with macOS's `open`, which passes no command line or environment on, so for a run from the IDE or
Igor put the flags in `glitchless/args.txt` in the runner's save area:

```bash
mkdir -p ~/Library/Application\ Support/com.yoyogames.macyoyorunner/glitchless
echo "-autoplay -glitchless-measure=10" > ~/Library/Application\ Support/com.yoyogames.macyoyorunner/glitchless/args.txt
npx @gamemaker/gm-cli@2.4.1 run Game.yyp --target=mac --runtime=vm   # or Run in the IDE
```

Or compile once and start the runner with the flags on its command line, as `gamemaker/test/e2e.mjs` does. The run
prints the stats as one line of JSON and where it saved them (`glitchless/measure.json` in the save area). Delete
`args.txt` afterwards. Measure before and after a change.

## 6. Verify

Run the game with `-glitchless` (from the IDE or gm-cli, in `args.txt` as above), play a level and die once, then
call `glitchless_list_games` or open the dashboard. `-glitchless-debug` logs each batch as it is sent.
