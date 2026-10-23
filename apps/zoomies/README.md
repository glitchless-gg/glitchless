# Zoomies!

A small 2.5D side-scrolling platformer in vanilla Three.js. It is the demo game for **Glitchless**,
game observability for players and coding agents. A purple pup in gaming headphones runs through
three levels collecting bones and chasing tennis balls.

The game is meant to look like a polished "I made this with AI over the weekend" Three.js game,
and it contains **four deliberate, realistic bugs** for Glitchless to find. They are listed below.
**Don't fix them**: the demo depends on them.

## Run it

From the repo root (npm workspaces):

```bash
npm install
npm run dev -w zoomies        # http://localhost:5173  (or: npm run game)
npm run build -w zoomies      # → apps/zoomies/dist (relative base './', deployable anywhere)
```

Telemetry goes to `http://localhost:7777` by default (`npm run server` from the root). If the
server isn't running the game still works; the SDK's intake requests fail without breaking anything.

## Controls

| Key | Action |
| --- | --- |
| `←` `→` / `A` `D` | run |
| `Space` / `W` / `↑` | jump (hold for a higher jump; ~100 ms coyote time + jump buffer) |
| `R` | restart level (reported as `levelFail{cause:'restart'}`) |
| `Esc` / `P` | pause |
| `M` | mute |
| `` ` `` | toggle the Glitchless overlay (bottom-right) |
| `F8` | report a bug: a note and a screenshot go to Glitchless's Bug Reports (the game pauses while you type) |

There are 5 lives per level. Losing them all restarts the level (`levelFail{cause:<last death cause>}`).
Deaths come from falling (`fell`) or touching an enemy from the side (`squirrel`, `vacuum`).
Landing on an enemy from above stomps it.

## Query params

| Param | Default | Meaning |
| --- | --- | --- |
| `level=1..3` | `1` | start at a level |
| `autoplay=1` | off | the bot plays (see below) |
| `skill=0..1` | `0.7` | bot skill (timing noise, hesitation, panic jumps and impatience scale with `1 - skill`) |
| `seed=N` | random | bot RNG seed (deterministic per seed) |
| `env=` | `dev` | Glitchless env (`dev` / `staging` / `prod`) |
| `intake=` | `VITE_GLITCHLESS_INTAKE` or `http://localhost:7777` | Glitchless API base URL |
| `dashboard=` | `http://localhost:7777` | `dashboardUrl` passed to the SDK |
| `nogd=1` | off | skip Glitchless completely |
| `mute=1` | off (autoplay is always muted) | no sound |

Example traffic: `http://localhost:5173/?autoplay=1&skill=0.3&seed=42&env=prod`

### Autoplay bot (`src/autoplay.js`)

The bot holds right. When it sees a ledge, wall, enemy or tennis ball ahead, it runs a few
"jump in *k* steps" what-if simulations with the real physics (`src/sim.js`), aims for the
middle of the window that works, and then adds Gaussian timing noise. At lower skill it also
hesitates more, makes panic jumps and gets impatient on moving platforms. Results from 30 headless
sessions per skill:

| skill | finishes all 3 levels | rage quits | avg deaths | #1 death spot |
| --- | --- | --- | --- | --- |
| 0.1 | 10/30 | 20 | 6.2 | Leap of Faith |
| 0.3 | 14/30 | 16 | 4.6 | Leap of Faith |
| 0.5 | 30/30 | 0 | 4.0 | Leap of Faith |
| 0.7 | 30/30 | 0 | 2.3 | Leap of Faith |
| 0.9 | 30/30 | 0 | 0.8 | Leap of Faith |

**Rage quit:** when `skill < 0.5` and the bot has died 3 times in the same 4-unit spot, it waits
about a second, halts the game loop and fires `window.dispatchEvent(new Event('pagehide'))`. The
SDK then sends `session_end`. After beating level 3, the bot also "closes the tab" the same way.
A harness can poll `window.zoomies.halted`. Autoplay sessions are tagged `sessionType: 'synthetic'`.

## Telemetry wiring (`src/telemetry.js`)

`src/glitchless-sdk.js` holds the imports exactly as the spec writes them
(`import { Glitchless } from 'glitchless'` and `import { instrumentThree } from 'glitchless/three'`).
`telemetry.js` loads that module with a dynamic `import()` and a 4 s timeout. The game only talks
to a facade, `gd`, which does nothing until the SDK is ready. It stays that way with `?nogd=1` or
if the SDK fails to load, and it wraps every call in try/catch, so telemetry can never break the game.

| Call | Where |
| --- | --- |
| `Glitchless.init({ service:'zoomies', version: GAME_VERSION, env, intake, clientToken:'gl_pub_dev', overlay:true, sessionType, dashboardUrl })` | `telemetry.js` |
| `instrumentThree(gd, { renderer, scene, camera, THREE })` (once) | `telemetry.js` |
| `levelStart` / `levelComplete({durationS, score})` / `levelFail({cause})` | `main.js` (`beginLevel`, `completeLevel`, `restartLevel`) |
| `death({x,y,z,cause})` | `main.js` `die()` |
| `setPosition(dog.position)` and `setContext({ particles: <live confetti meshes>, entities: <alive enemies> })` every frame | `main.js` `frame()` |
| `track('bone_collected', {golden})`, `track('powerup', {kind:'zoomies'})` | `main.js` `collectBone()` / `startZoomies()` |
| `captureMap(levelId, { axis:'xy', bounds })` once per level per session, right after the level is built | `main.js` `loadLevel()` |

`GAME_VERSION` lives in `src/version.js`. Bump it, for example to `1.0.1`, when you ship a fix,
so Glitchless can compare versions.

### Agent tools (WebMCP via `gd.registerTool`, in `src/agent-tools.js`)

| Tool | Input | Does |
| --- | --- | --- |
| `zoomies_get_state` | none | level, player pos/vel/grounded, lives/deaths, bones/score, zoomies, live confetti meshes, enemy count, UI state, renderer stats |
| `zoomies_load_level` | `{ level: 'level-1'\|'level-2'\|'level-3' }` | jump to a level (a normal `levelStart`) |
| `zoomies_trigger_zoomies` | none | runs the real tennis-ball pickup path at the player, so it includes the confetti bug |
| `zoomies_teleport` | `{ x: number }` | put the player on the ground at (or nearest to) `x` |
| `zoomies_set_paused` | `{ paused: boolean }` | pause or resume |

The same handlers are available from the console as `window.zoomies.api.*`.
`window.zoomies.info` prints `renderer.info` numbers.

## The deliberate bugs

Each one is marked in the code with `// GLITCHLESS-DEMO: <bug name>`. Search for `GLITCHLESS-DEMO`.

| # | Bug | Where | What happens | What Glitchless shows |
| --- | --- | --- | --- | --- |
| 1 | **Particle perf bomb** | `src/fx.js:45-70` (`confettiBurst`), called from `src/main.js:245-248` (`startZoomies`) | Each tennis ball spawns 800 confetti `Mesh`es. Every one gets its own `new SphereGeometry(…,16,12)` and `new MeshStandardMaterial({transparent:true})`, with `castShadow` and `frustumCulled = false`. They fade to opacity 0 but stay in the scene forever and are never disposed. Draw calls grow by about 1,600 per pickup (main + shadow pass). On an M3 Max at 60 Hz after 4 balls: ~290 → ~6,700 draw calls, renderer CPU 1.1 → ~20 ms per frame, 60 → ~48 fps (p95 33 ms), plus a hitch on every pickup. They also carry over into level 3. | frame-time regression and hitches on `level-2` that line up with `particles` in `ctx` and `powerup` in `recent` |
| 2 | **Geometry leak on level change** | `src/world.js:256-258` (per-tile geometry and material in `buildGroundPlatform` / `buildRoofPlatform`) and `src/world.js:1118-1124` (`unloadLevel`), called at `src/main.js:98-99` | Every 1-unit platform tile creates its own geometry and material (for a "hand-painted" color jitter). `unloadLevel` only calls `scene.remove()` and never `dispose()`s anything. | `geometries` keeps rising with every level change or restart: ~470 → ~1,200 → ~1,900 … ~4,000 by the end of a run |
| 3 | **Silent gameplay error** | `src/popups.js:39-45` (`spawnScorePopup`), caller `src/main.js:234-235` (`collectBone`) | Score popups come from a fixed pool of 8 that each live 1.5 s. Collect a 9th bone while 8 are still floating and `pool.find(p => !p.active)` returns `undefined`, so `popup.position.set(...)` throws `TypeError: Cannot read properties of undefined (reading 'position')`. The bone is already hidden and `bone_collected` is already tracked, but `game.score += value` never runs, so the player silently loses the points. The loop calls `requestAnimationFrame` first, so the game keeps running and the error reaches `window.onerror`. It shows up reliably on level 2's "bone river" (x 12.5–30 right after the first tennis ball, and again at x 149–162), especially with zoomies on. | the top error issue, plus `bone_collected` events that don't match `score` |
| 4 | **Design difficulty spike: The Leap of Faith** | `src/levels.js:144-146` (level 3) | The gap from x 42 to 48 is 6 units, and the landing roof is 1.8 units higher. It can only be cleared with a full-speed run and a jump pressed in a window of about 60 ms right at the edge, partly inside coyote time. At 94% speed it is effectively impossible. | the main death cluster on the `level-3` heatmap, with level 3 completion and rage quits concentrated there |

## Level reference

`src/levels.js` is plain data with no imports. Node can load it directly:
`import { LEVELS, levelBounds } from './apps/zoomies/src/levels.js'`.

Platforms are `{x, y, w, h}`: `x` is the left edge, `y` is the **top** surface and `h` is the depth below the top.

| Level | captureMap bounds (`min` → `max`) | Gaps (x ranges) | Hazards | Tennis balls | Checkpoints | Goal |
| --- | --- | --- | --- | --- | --- | --- |
| `level-1` Backyard | `[-9,-7]` → `[103,9]` | 18–20.5, 34.5–37.5, 54.5–58, 67–76 (plank 69.5–73 floats in it) | squirrels 44–53, 81–89 | none | 39.5, 77.5 | 97 |
| `level-2` Dog Park | `[-9,-7]` → `[183,12]` | 52–62 (mover), 78–88 (vertical mover), 102–106, 128–142 (twin movers) | vacuums 36–46, 70–77, 92–101, 164–169 | x 9, 68, 123, 146 | 64, 108, 143.5 | 177 |
| `level-3` Rooftops | `[-7,-8]` → `[128,9]` | 14–17.5, 30–33.5, **42–48 (The Leap of Faith)**, 62–66.5, 77–87 (scaffold 80.5–83.5), 103–107 | squirrels 21–29, 69–76, 112–118; vacuum 92–101 | none | 35, 50.5, 89 | 123 |

The golden bone is on level 2 at (118, 6.05). You reach it from the bench at x 112–115.
Kill planes: y −6 (levels 1–2) and y −7 (level 3).

## Files

```
index.html            HUD + screens (top-left/center/right only; bottom-right is left for the Glitchless overlay)
src/main.js           renderer, game state machine, fixed-step loop, pickups, agent API
src/physics.js        AABB platformer physics (pure, no THREE): coyote time, jump buffer, variable jump
src/sim.js            one fixed simulation step, shared by the game and the bot
src/levels.js         level data (plain data)
src/world.js          builds and unloads level meshes, sky, lights, decor
src/dog.js            the hero model + animation (squash & stretch, ears, tail, legs)
src/enemies.js        squirrel + robot vacuum
src/fx.js             dust, sparkles, zoomies trail, confetti (bug 1)
src/popups.js         "+10" popups (bug 3)
src/camera.js         follow camera, look-ahead, shake
src/hud.js, input.js, audio.js, rng.js, params.js, theme.js, version.js
src/telemetry.js      Glitchless facade + init; src/glitchless-sdk.js holds the SDK imports
src/agent-tools.js    WebMCP tools
src/autoplay.js       the bot
```
