# Glitchless technical spec (v0.1)

This is the contract between the pieces of Glitchless: the browser SDK, the intake/query API,
the dashboard, the MCP server and the demo game. If you change a shape here, change it everywhere.

## 1. Browser SDK — `glitchless`

```js
import { Glitchless } from 'glitchless';
import { instrumentThree } from 'glitchless/three';

const glitchless = Glitchless.init({
  service: 'zoomies',              // game id (required)
  version: '1.0.0',                // build version (required — powers version compare)
  env: 'dev',                      // dev | staging | prod
  intake: 'http://localhost:7777', // Glitchless API base URL. Omit → offline/overlay-only mode
  clientToken: 'gl_pub_dev',       // public, write-only token: safe to ship inside the game
  overlay: true,                   // in-game HUD, toggle with the backtick (`) key. Default: on unless env is prod
  privacy: 'anonymous',            // default. 'install' adds a stored random player ID (retention, §4b); 'full' that, GPU/CPU detail and positions (packages/sdk/PRIVACY.md)
  sampleRate: 1,                   // 0..1 fraction of sessions that send data
  positionHz: 4,                   // player position sampling rate for heatmaps / replay (positions are on in 'full' mode)
  windowMs: 5000,                  // frame stats are summarised per window
  flushIntervalMs: 15000,          // batches go out this often, gzipped, on a window boundary
  datadog: null,                   // optional { applicationId, clientToken, site } → mirrors to Datadog RUM
  bugReports: null,                // { hotkey: 'F8', onOpen, onClose } (or true): an in-game form players send bug reports from (§2 bug_report)
});

instrumentThree(glitchless, { renderer, scene, camera, THREE }); // THREE is optional (enables LoadingManager hooks)
```

### Game-semantic API (call these from game code)

| Call | When |
| --- | --- |
| `glitchless.levelStart(levelId)` | a level/stage begins (also sets current level on every event) |
| `glitchless.levelComplete(levelId, { durationS, score })` | level beaten |
| `glitchless.levelFail(levelId, { cause })` | level failed / player gave up / restart |
| `glitchless.death({ x, y, z, cause })` | player died; `cause` is a short string (`fell`, `squirrel`, …) |
| `glitchless.track(name, attrs)` | any custom design event (`bone_collected`, `powerup`) |
| `glitchless.setPosition({ x, y, z })` | every frame; SDK samples at `positionHz` |
| `glitchless.setContext({ particles, entities, ... })` | numeric gauges attached to frame windows and hitches |
| `glitchless.captureMap(levelId, { axis: 'xy' \| 'xz', bounds, exclude })` | after a level is built: renders an orthographic thumbnail used as the heatmap background, with the renderer's own tone mapping and output colour space (three.js r155+), so it looks like the game. `bounds = {min:[a,b], max:[a,b]}` in world units for the two axes; `exclude` = objects to hide while capturing (player, sky dome, effects) |
| `glitchless.registerTool(name, description, inputSchema, handler)` | expose a game-specific tool to coding agents over WebMCP |
| `glitchless.error(err, attrs)` | manually report a handled error |
| `glitchless.flush()` | force send (SDK also flushes on `pagehide`) |
| `glitchless.reportBug({ note, screenshot })` | send a player's bug report from the game's own UI (`screenshot: false` sends none); resolves `{ sent, reason? }` |
| `glitchless.openBugReport()` | open the built-in bug report form (from a pause menu, say) |
| `glitchless.resetInstallId()` | forget the stored player ID (§4b), for a "reset my ID" setting: this page load keeps its ID, the next makes a new one |

Everything else (frames, hitches, errors, device/GPU, load timing, memory, session lifecycle) is automatic.

### Phaser adapter (`glitchless/phaser`)

```js
import { instrumentPhaser } from 'glitchless/phaser';
const game = new Phaser.Game(config);
instrumentPhaser(glitchless, { game, Phaser, levels: 'auto' }); // Phaser 3.60+ and Phaser 4
```

The same SDK, with Phaser's own loop as the frame clock. Differences on the wire:

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-phaser/<version>"`, so findings give Phaser advice |
| `session_start` | adds `engine: { name: 'phaser', version, renderer: 'webgl' \| 'canvas' \| 'headless' }` |
| `frame_window` | one frame per Phaser step (`prestep` to `prestep`), so an fps limit or a `setTimeout` loop is measured as drawn; adds `process_ms` (scene updates, `prestep` to `poststep`); `render_ms` is `prerender` to `postrender`; `draw_calls` and `triangles` are counted on the WebGL context (the Canvas renderer's `drawCount` otherwise); `textures` is the texture manager's key count; `programs` counts WebGL programs linked; `geometries` is null; `ctx` adds `game_objects`, `particles`, `physics_bodies`, `tweens`, `listeners`, `sounds` |
| `hitch` | `causes` adds `scene_change`, `object_spawn` (50+ objects added in one step), `texture_upload`, `shader_compile` (a program linked), `script`, `render`; adds `process_ms`, `render_ms`, `objects_added`, `textures_added`, `programs_linked` |
| `level_start` | sent when a scene that reads as a level starts (`levels: 'auto'`); a scene's shutdown sets the level to null. `levels` can be an array of keys, a function, or `false` |
| `error` | adds `kind: 'asset'` (a loader `loaderror`) and `kind: 'game_loop_stopped'`: the loop stopped stepping after an uncaught error, with that error's stack. The server counts that session as crashed |

### Babylon.js adapter (`glitchless/babylon`)

```js
import { instrumentBabylon } from 'glitchless/babylon';
instrumentBabylon(glitchless, { engine, scene, BABYLON, levels: 'auto', gauges: true, gpuTime: true }); // Babylon.js 5+, WebGL or WebGPU
```

The same SDK, with Babylon's own frame loop and counters. `BABYLON` (the namespace) is optional: `captureMap` needs it.

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-babylon/<version>"`, so findings give Babylon.js advice |
| `session_start` | adds `engine: { name: 'babylon', version, renderer: 'webgl' \| 'webgpu' \| 'headless' }` |
| `frame_window` | one frame per engine frame (`onBeginFrameObservable` to the next), so work Babylon does just after drawing (a shader compiled in a promise) belongs to the frame; `render_ms` is each scene's render targets to `onAfterRenderObservable`, `process_ms` the rest of the frame's CPU time (before-render observers, animations, physics, the game's render-loop code); `draw_calls` from the engine's draw-call counter, `triangles` from the scenes' active indices; `geometries` and `textures` are the scenes' counts and `programs` the compiled effects; `ctx` adds `meshes`, `active_meshes`, `materials`, `textures`, `particles`, `render_observers` |
| `hitch` | `causes` adds `shader_compile` (compiles in the frame or the second before it: with `KHR_parallel_shader_compile` the stall comes a few frames after the compile), `scene_change` (a scene created, disposed, first drawn, or a level start), `object_spawn` (50+ meshes added), `texture_upload`, `geometry_upload` (as Three.js, on WebGL), `script`, `render`; adds `process_ms`, `render_ms`, `gpu_ms`, `shaders_compiled`, `shader_compile_ms`, `meshes_added`, `materials_added`, `textures_added`, `textures_uploaded`, `buffers_uploaded` |
| `level_start` | when a scene whose `metadata.level` is set first renders, or when that name changes; disposing the scene sets the level to null. `levels` can be a function `(scene) => name` or `false`; a manual `levelStart` turns scene levels off |
| `error` | adds `kind: 'shader'` (an effect that failed to compile; `attrs.errors` holds the compiler's message), `kind: 'asset'` (a texture that failed to load), `kind: 'webgl_context_lost'` (also a lost WebGPU device) and `kind: 'game_loop_stopped'`: the render loop queued no frame after an uncaught error, with that error's stack. The server counts that session as crashed |

### PlayCanvas adapter (`glitchless/playcanvas`)

```js
import { instrumentPlayCanvas } from 'glitchless/playcanvas';
instrumentPlayCanvas(glitchless, { app, pc, levels: 'auto', gauges: true }); // the PlayCanvas engine 2.x, WebGL2 or WebGPU
```

`pc` (the namespace) is optional: `captureMap` and the engine version need it.

| | |
| --- | --- |
| envelope | `"sdk": "glitchless-playcanvas/<version>"`, so findings give PlayCanvas advice |
| `session_start` | adds `engine: { name: 'playcanvas', version, renderer: 'webgl' \| 'webgpu' \| 'headless' }` |
| `frame_window` | one frame per app tick (`frameupdate` to the next); `process_ms` is `frameupdate` to `framerender` (scripts, animation, physics), `render_ms` is `prerender` to `postrender`; `draw_calls` is the device's per-frame count, `triangles` are counted at `device.draw`; `geometries` counts vertex buffers, `textures` the device's textures, `programs` its shaders; `ctx` adds `entities`, `mesh_instances`, `materials`, `textures`, `lights` |
| `hitch` | `causes` adds `shader_compile` (a shader created in the frame or the second before it), `scene_change` (a scene loaded, or a level start), `object_spawn` (50+ render, model, sprite, element or particle components added), `texture_upload`, `geometry_upload`, `script`, `render`; adds `process_ms`, `render_ms`, `shaders_compiled`, `shader_compile_ms`, `objects_added`, `textures_added`, `buffers_added`, `textures_uploaded`, `buffers_uploaded`, `buffer_kb` |
| `level_start` | when `app.scenes.changeScene()` or `loadSceneHierarchy()` loads a scene whose name reads as a level (as Phaser's scene keys do); `changeScene()` to any other scene sets the level to null. `levels` can be an array of names, a function `(name) => name` or `false`; a manual `levelStart` turns scene levels off |
| `error` | adds `kind: 'asset'` (the asset registry's `error`), `kind: 'webgl_context_lost'` (also a lost WebGPU device) and, for a script error the debug build caught (it turns the script off), `kind: 'js'` with `attrs: { script, method, script_disabled: true }`: the same kind and message as the production build's uncaught error (with source maps uploaded, the same issue) |

## 2. Wire format

`POST {intake}/v1/intake?token={clientToken}` with `Content-Type: text/plain` (avoids CORS preflight; `sendBeacon` compatible).

```json
{
  "service": "zoomies", "env": "dev", "version": "1.0.0",
  "session_id": "s_8f2c…", "player_id": "p_19ab…",
  "sdk": "glitchless-browser/0.1.0",
  "events": [ { "type": "frame_window", "ts": 1760540000000, "level": "level-2", "…": "…" } ]
}
```

Every event has `type`, `ts` (epoch ms) and `level` (current level or `null`). The server adds
`project_id` from the client token (§6); a payload can't set it.

| type | fields |
| --- | --- |
| `session_start` | `privacy` (`anonymous`, `install`, `full`), `device {browser, browser_version, os, mobile, gpu, gpu_vendor, gpu_tier, cores, memory_gb, screen:[w,h], dpr, webgl, steam_deck}`, `page {url, referrer}`. The browser sends `steam_deck: true` only when it can tell it runs on a Steam Deck (§4b) |
| `frame_window` | every window (5 s; sent in batches every 15 s): `frames, fps, ft {sketch}, ft_p50, ft_p95, ft_p99, ft_max, jank` (frames > 33.3ms), `hitches` (frames > 50ms), `render_ms` (avg CPU ms inside `renderer.render`), `draw_calls, draw_calls_max, triangles, geometries, textures, programs, heap_mb, ctx {…gauges}`, `budget_ms` (from the display's refresh rate, read off the fastest frames and checked again as the session goes). A window never spans two levels: `levelStart` closes it, with the positions sampled so far |
| `hitch` | single frame > 50ms: `duration_ms, draw_calls, triangles, ctx, recent [last 5 game events], loaf [{source, fn, ms}], causes` (`script`, `shader_compile`, `gc`, `asset_load`, `frozen`). With `instrumentThree`, what the frame sent to the GPU, counted on the WebGL context: `causes` adds `shader_compile` (a program linked), `texture_upload` (4+ textures uploaded or re-uploaded, or a megapixel), `geometry_upload` (32+ buffers or 4 MB), `render` (`renderer.render` took 40% of the frame); adds `render_ms`, `textures_uploaded`, `texture_mpx`, `buffers_uploaded`, `buffer_kb`, `programs_linked` |
| `load` | `ttff_ms` (navigation → first rendered frame), `assets {count, bytes, ms, slowest:[{url, ms, bytes}]}` |
| `error` | `kind` (`js` \| `promise` \| `webgl_context_lost` \| `manual`), `message, stack, source, line, col, fn, fingerprint`. See below |
| `level_start` | — |
| `level_complete` | `duration_s, score` |
| `level_fail` | `cause` |
| `death` | `x, y, z, cause` |
| `pos` | `pts: [[ts, x, y, z], …]` (batched samples) |
| `custom` | `name, attrs` |
| `map` | `axis, bounds, image` (JPEG data URL, ≤ 60 KB) |
| `session_end` | `reason` (`pagehide` \| `hidden_timeout`), `duration_s` |
| `bug_report` | `note` (typed by the player), `screenshot` (JPEG data URL, ≤ 200,000 characters; dropped when larger, keeping the note), `x, y, z`, `recent` (last game events), `frames` (the last windows' fps and p95), `device`. See below |

**`error`.** `fingerprint` groups occurrences into one issue: the kind, the message (numbers of 3+ digits and hex
masked) and the function of the top frame, the first frame that isn't in a `glitchless*` file. File names are left
out, so a dev server's `fx.js` and a bundle's `index-3f2a.js` group alike. `stack` is the browser's own stack
string (at most 4,000 characters; Chrome, Firefox and Safari write it differently). In a minified web build the
top frame's function is a minified name that changes from build to build; when the build's source maps are
uploaded (§3d) the server stores the original `fn`, `source`, `line` and `col` instead, with a fingerprint on the
original function, and keeps what the SDK sent as `minified: {fingerprint, fn, source, line, col}`. The SDK
doesn't change.

**`bug_report`.** A player's report from inside the game. Reports are off until the game turns them on: in the
browser, `bugReports` in init options adds a hotkey (F8) and an overlay button that open a short form (a
screenshot preview, the note, Send and Cancel), and `reportBug()` sends one from the game's own UI. While the form
is open the game gets no keys, clicks, mouse or touch input (key releases still pass); `onOpen`/`onClose` let it
pause. Every SDK sends the same event:

| field | |
| --- | --- |
| `ts`, `level` | when the player opened the form (or called `reportBug`), and the level then |
| `note` | what the player typed, up to 2,000 characters. Free text: see each SDK's PRIVACY.md |
| `screenshot` | the game's view as a JPEG data URL of at most 200,000 characters. SDKs shrink it until it fits (960, 800, 640, 480, then 320 px wide, lower quality); the server drops a larger one, or one that isn't `data:image/`, and keeps the rest |
| `x, y, z` | where the player was, only when positions are on (as `death`) |
| `recent` | the last 20 game events and hitches, oldest first: `{ts, type, level}` plus whichever of `name, cause, kind, message, reason, duration_s, score, duration_ms, causes, x, y, z, attrs` the event had |
| `frames` | the last frame windows (up to 6, the one in progress last), oldest first: `{ts, level, fps, p95}` |
| `device` | the `session_start` device at the session's privacy level. Optional: without it the server shows the session's |

A report goes on a request of its own as soon as it is sent, from every session (`sampleRate` doesn't apply);
a failed send goes out with the next batch. Its id is a hash of project, service, session, `ts` and note, so a
batch sent twice stores it once.

Reports never join the events, rollups or summaries: each store keeps a small record (everything but the
screenshot) to list, and the screenshot apart, as it keeps level maps. FileStore: `reports.jsonl` and
`reports/<id>.jpg`, kept 14 days like events. DynamoDB: `P#<project>#BUG#<service>` (§6). Hosted: the same items in
the lake's table and the screenshot in S3 under `reports/` (§7), kept for the plan's retention. They are read
through the `reports` and `report` queries (§3), the Bug Reports view and `reports` panel (§3b), each session's
timeline (`{type: 'bug_report', ts, level, id, note, has_screenshot}`), a finding once a level has three in the
range (`reports-<level>`, quoting the notes), and the `glitchless_bug_reports` MCP tool. `DELETE
/v1/report?service=&id=` (the `delete` scope) removes one report and its screenshot. The live tail shows reports
without their screenshot, and exporters (Datadog, OTLP) don't send them.

`ft.sketch` is a DDSketch-style mergeable histogram of frame times (relative accuracy 2%):
`{ "a": 0.02, "b": { "<index>": count }, "n": totalCount, "z": zeroCount }` where
`index = ceil(log(ms) / log(gamma))`, `gamma = (1 + a) / (1 - a)`. The server merges sketches across
sessions to compute exact-within-2% global percentiles (never average percentiles).

## 3. Query API

`GET {api}/v1/query/{name}?service=zoomies&from={ms}&to={ms}[&version=][&env=][&level=]`
Header `x-glitchless-api-key: …` when the server has a read key configured. Every query reads only the project
its key belongs to (§6); `service` picks a game inside that project.

| name | returns |
| --- | --- |
| `services` | `{services:[{service, versions[], envs[], last_seen}], max_range_days}`: the longest range this store answers for the reader (the plan's retention on Glitchless Cloud; `null`: no limit) |
| `overview` | `{kpis, series, top_errors, funnel, findings}` |
| `performance` | `{distribution, by_level, by_gpu_tier, by_browser, by_version, hitches, memory, load}` |
| `errors` | `{issues:[{fingerprint, message, kind, location, fn, source, line, count, sessions, players, first_seen, last_seen, first_version, versions, levels, stack, sample_session, breadcrumbs}]}`; for a web build with source maps (§3d), original frames with `frames` and `minified` |
| `players` | `{kpis, funnel, session_length, death_causes, rage_quits, retention}`. `retention: {status, id_sessions_pct, new_players, d1, d7, d30, cohorts:[{day, players, d1, d7, d30, returned:{d1, d7, d30}}], first_seen}` (§4): cohorts oldest first, `dN` a percentage (null until day N has ended in the range), `returned` the counts; `d1`… over all cohorts that have one. `status` is `ok`, `anonymous` (no session in the range sent a player ID: nothing to count, not zero) or `empty`; `first_seen` is `index` (the store's first-seen index) or `range` (a store without one: new on the first day in the range) |
| `players_now` | `{players_now, window_s}`: sessions of the game that sent anything in the last two minutes (§4), whatever the range |
| `heatmap` | `{level, map, deaths:[{x,y,z,cause,version}], density:{…}, stats}` (requires `level`); `stats` is the level's funnel row plus `no_win`, true for a game nobody wins (§4), which has runs rather than a completion rate |
| `sessions` | `{sessions:[…]}` ; `session?id=` → `{session, events}` (its timeline includes its bug reports) |
| `reports` | Players' bug reports, newest first (at most 500): `{reports:[{id, ts, session_id, level, version, env, note, position: {x, y, z} \| null, device (one line), has_screenshot}]}`. Filters: `env`, `version`, `type`, `sessions` |
| `report` | One bug report: `id=` → `{report:{…as listed, sdk, recent, frames, screenshot}}` (`screenshot=0` leaves the picture out), from any time the store still keeps; `{error}` if there is none |
| `versions` | `{versions:[{version, sessions, crash_free_pct, frame_p95, level_completion_pct, rage_quit_pct, errors_per_session, …, board:[…], events:{name: per_session}}], has:{frames, levels, deaths, fails, geometry}, board:[{title, unit, metric, event, per, sum?, currency?}]}`. `board` holds each version's value of the stats on the game's boards (each once, in the order of the top-level `board`, §3b); `unit` is `per session` for counts and sums compared per session, `per player` for a sum per player, `%` or a metric's unit, and a sum that is money has its `currency`; `has` says which built-in measures the game reports |
| `findings` | Ranked findings with evidence — what the MCP server hands to coding agents |
| `events` | The game's own metrics (`custom` events): `{ts, sessions, events:[{name, count, sessions, players, per_session, series, attrs:[{key, values:[{value, count, sessions}], avg}], sums:[{attr, currency, sum, events}]}]}`. `sums` adds up each numeric attribute, per currency (null for events sent without one, §3b), the most sent first. `name=` keeps one event, `sdk=1` adds the SDKs' own; `funnel=open,paywall,buy=done` adds `funnel:[{step, sessions, pct_of_first, pct_of_previous, median_s_from_previous}]` |
| `dashboard` | The game's pages, in order: `{dashboard:{source, updated_at, updated_by, spec:{currency?, pages}, pages:[{id, title, icon, view, options} or {id, title, icon, panels: count}]}}`, `source` being `saved` or `auto` (§3b) |
| `board` | One board page with each panel's data: `page=` its id (default: the first board) → `{board:{page, title, source, updated_at, updated_by, spec:{panels}, panels:[…]}}`; a built-in view's id gives `{error, view}` |

### 3b. Dashboards and boards

Every game gets a dashboard that fits it (`server/src/board.js`): its list of pages, in the order the sidebar shows
them, the first opening first. A page is a board (`panels`, below) or one of the built-in views (`view`: events,
performance, errors, players, heatmaps, sessions, versions, live, reports), which a game keeps, renames, reorders or drops:

```json
{ "currency": "USD", "pages": [
  { "id": "overview", "title": "Overview", "icon": "overview", "panels": [ … ] },
  { "id": "money", "title": "Paywall", "icon": "bolt", "panels": [ … ] },
  { "id": "purchases-live", "title": "Purchases, live", "view": "live", "options": { "events": ["paywall", "buy"] } },
  { "id": "errors", "title": "Errors", "view": "errors" }
] }
```

`id` (default: from the view or the title) is the page's address, `#/<id>`; `icon` is one of board, overview,
events, perf, errors, players, heatmap, sessions, versions, live, flag, bolt, play, clock, bug. At most 20 pages and 24
panels a board. A built-in view a dashboard leaves out still opens from links (`#/errors/<fingerprint>`,
`#/sessions/<id>`, `#/reports/<id>`). The live view takes `options.events`: names or types to show. The reports view
(Bug Reports) lists what players sent, newest first, with each screenshot, its session's replay (opened at the
report's moment) and the events and frame rate before it.

A dashboard is saved per game: `GET /v1/dashboard?service=` needs the read scope; `PUT /v1/dashboard?service=` with
`{currency?, pages}` and `DELETE` (back to the automatic dashboard) need the `dashboard` scope. `currency` (an ISO
4217 code such as `USD`) is the game's one currency for money (below). A game without a saved one gets
the automatic dashboard, made from the data it sent in the last week: an Overview board (the stats every game has,
findings, its own events, then levels, frame time, errors and deaths only if it reports them), then Events if it
sends custom events, Performance if it sends frame times, Errors, Bug Reports if players sent bug reports, Players,
Heatmaps if it sends positions, Sessions, Versions and Live Tail. Versions are compared on the stat panels of every board.

| panel `type` | fields | shows |
| --- | --- | --- |
| `stat` | `metric` (sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct, players_now) or `event`, optional `per`, optional `sum` | one number; `event` per another event is a percentage; per `$players` or `$sessions`, the share of them that sent the event (conversion). With `sum`, the attribute added up (revenue), per `$players` or `$sessions` divided by them (revenue per player). `players_now` is the sessions playing now, whatever the range, and is left out of version comparisons |
| `series` | `event`, optional `by`, `limit`, `sum` | the event's count (or its `sum`) over time, split by an attribute's top values; `by` can also be `$version` or `$level` |
| `breakdown` | `event`, `by`, `limit`, `sum` | the attribute's values with counts and sessions, or with each value's `sum`, largest first (revenue by item) |
| `funnel` | `steps` | sessions through the steps, in order |
| `levels` | `label` | starts, completion, fails, deaths and times per level; columns only for what the game reports |
| `frame_time`, `errors`, `deaths`, `events` | `limit` (errors) | frame-time p50/p95, top errors, deaths by level and cause, every custom event |
| `findings` | `limit` | the ranked findings |
| `sessions` | `sent`, `limit` | recent sessions, or only those that sent an event, each opening its replay |
| `reports` | `limit` | the latest bug reports players sent, each opening its report |
| `retention` | `limit` (days, 1 to 90; default 14) | D1, D7 and D30 by first-seen day (§4), the latest days; a game that sends no player IDs gets `anonymous: true` and a line on turning install mode on |
| `versions` | none | the board's own stat panels, version by version |
| `live` | `events` | events as they arrive, optionally only these names or types |

Every panel takes `title`, `note` and `size` (`s`, `m` or `l`). An event is written like a funnel step: `name`,
`name=value` (any attribute) or `name:key=value`. A panel with no data in the window says why instead of showing
zeros.

Custom events are counted in the per-minute cells (by name, and by name, attribute and value) and in the session
states (the first 16 occurrences of each name with their attributes, for ordered funnels), so every event store
answers the same. Names, attributes and values are the game's own, so each is capped: 200 names and 400 values a
minute, 64 names a session and 40 values per attribute. Past a cap the rest is counted as `(other)`.

**Sums, purchases and money** (`server/src/sums.js`). The per-minute cells also add up every numeric attribute of
custom events, in fixed point (thousandths): per name, attribute and currency (`[sum, events]`), and the same per
string or boolean attribute value of the event (revenue by item, by store). Hour summaries and daily rollups merge
the cells, so a sum is exact over any range and every store gives the same one. At most 400 sums of each kind a cell;
past that the rest goes under `(other)` and a daily answer names `event_sums` in `meta.approximate`. Cells written
before sums existed carry none, so sums start from then.

Purchases follow one convention in every SDK: `track('purchase', { amount: 4.99, currency: 'USD', item: 'gems_500' })`.
An event's `currency` (upper-cased) keeps each currency's sums apart, and a sum is money when its events carry one.
A game has one currency: the dashboard's `currency`, else the one most of its events were sent in. Events without a
currency count in it; amounts in another currency are never added in: a money panel answers `currency` and lists
them in `mismatch: [{currency, sum, events}]`. A sum of events that never carry a currency (coins, seconds) is a
plain number. The dashboard shows money with the currency's symbol and two decimals.

```json
[ { "type": "stat", "event": "purchase", "sum": "amount", "title": "Revenue" },
  { "type": "stat", "event": "purchase", "sum": "amount", "per": "$players", "title": "Revenue per player" },
  { "type": "stat", "event": "purchase", "per": "$players", "title": "Players who bought" },
  { "type": "breakdown", "event": "purchase", "sum": "amount", "by": "item", "title": "Revenue by item" },
  { "type": "series", "event": "purchase", "sum": "amount", "by": "$version" } ]
```

A stat with `sum` answers `{value, currency, mismatch?, events}`, or with `per` `{value, currency, total, base}`; a
conversion `{value, unit: '%', count, base}`. A sum split `by` an attribute takes the event by name only (the cells
add up one attribute value at a time); by `$version` or `$level` it can be filtered (`purchase:store=ios`). Over
more than 31 days, players who sent an event are counted per name (a conversion per `$players` of `purchase=gems`
says so instead of answering); `$sessions` always answers. In a version comparison a sum is per session unless its
`per` says per player.

**CSV.** Every board panel with data, and the tables of the Errors, Sessions, Events, Players and Versions views,
download what they show as `<game>-<panel>-<from>-<to>.csv` (UTC minutes, `2026-10-23T1530Z`), built in the page from
the data it already has: a header row with the columns on screen, times in ISO 8601, durations in seconds, money
in its currency's units. A shared board exports only what it shows. (`?format=csv` on tabular queries may come
later.)

### 3c. Share links

A read-only link to one board page of one game, for a dev log, a Discord server or a publisher: anyone who has
it sees that board without signing in, and nothing else. Glitchless Cloud makes the links; the core enforces what
they read for any reader its auth hook marks with `share` (§6), so a self-hosted control plane can offer them too.

**Making one.** On Glitchless Cloud, members who may manage the game (Owner, Admin, Developer) press Share on a
board, or call the control API:

| route | does |
| --- | --- |
| `POST /api/projects/{p}/shares` | `{service, page, pageTitle?, name?, days?, from?, to?, sums?}` → `{share, token, url}`. `days` is 1, 7, 30, 90 or 365; without it the link lasts until it's revoked. `from` and `to` pin the window it shows (below). `sums: true` shows the board's sums such as revenue, which a link leaves out otherwise. At most 25 live links a game |
| `GET /api/projects/{p}/shares` | the game's links: `{id, name, service, page, pageTitle, hint, status, from, to, sums, createdAt, createdBy, expiresAt, revokedAt}`, `status` being Active, Expired or Revoked, `from` and `to` (ISO times) the pinned window or null, and `sums` whether it shows sums |
| `DELETE /api/projects/{p}/shares/{id}` | revokes it: at once on the server that revoked it, within 15 s on the others |

The link is `https://app.glitchless.gg/#/share/gl_share_…` (32 base64url characters after the prefix). Like a
secret key it is shown once: the control table keeps its SHA-256 and the last four characters.

**Rolling or pinned.** A link without `from` and `to` shows the last days, from whenever it's opened: the viewer
picks the past hour up to the past 30 days. A pinned link always shows its own window, such as a jam's week for a
dev log that judges read two months later. `from` and `to` are times in ms or ISO strings; a date without a time
is that whole UTC day, so `{from: "2026-11-12", to: "2026-11-16"}` is five days. Both or neither; the window is at
most 30 days and falls between 400 days ago and a year from now. A pinned window still stops at what the reader's
plan keeps, counted back from now (§7), so once those days have aged out the board shows nothing for them.

**Reading.** The token goes in `x-glitchless-share` (or `?share=`). The reader hook answers
`{projectId, scopes: ['read'], share: {service, page, from?, to?, sums?}, keyId, rps}` (`from` and `to` in ms for a
pinned link; `sums: true` for one made with sums). A link outranks a session cookie, so a member
who opens one sees what everyone sees. A share reader may only:

- `GET /v1/query/board`, for its page, and
- `GET /v1/query/services`, which lists its service only, with `max_range_days` at most 30 and `window`: a
  pinned link's `{from, to}`, or null.

Everything else is 403: other pages, services and queries, `/v1/live`, `/v1/dashboard` and `/v1/data`. The
request's parameters are replaced by `service`, `page`, `from` and `to` (a pinned link's own, whatever the request
asked), with `from` no earlier than 30 days before `to`, so env, version, session-type and session-id filters never
reach the query. Share readers are rate limited per link (10 requests a second per server process with bursts of
20 by default; `GLITCHLESS_SHARE_RPS` on Glitchless Cloud), and their answers are cached apart from members' (and
pinned links' apart from rolling ones', and links with sums apart from those without).

**What a shared board leaves out** (`evaluateBoard(…, { shared: true })` in `server/src/board.js`):

- sessions panels: session and player ids, and devices (browser, OS, GPU, GPU tier)
- errors panels: anything but the message, kind, counts, last seen and levels (no stacks)
- findings: their evidence; an error finding's summary becomes its counts, with no breadcrumbs, code location
  or suggested fix, and a bug-report finding's becomes its counts, without the players' notes
- live panels, and any panel type not listed as safe. Stat, series, breakdown, funnel, levels, frame_time, deaths,
  events, versions and retention panels show counts and the game's own event names (retention: new players and
  returns per day, never an id), and pass as they are; a new panel type stays off shared boards until it is added
  there.
- sums (revenue, revenue per player, revenue by item), unless the link was made with `sums: true`: a panel with
  `sum` says it isn't shown, and a versions panel marks its sum columns `hidden` and leaves their values out.
  Conversion (a share of players or sessions) is shown: it is a rate, not an amount.

**The page.** `#/share/<token>` opens before the sign-in gate and renders the board read only, with no sidebar,
editor or links into other views. Its filters are fixed, its range picker goes from an hour to 30 days (a pinned
link shows its dates instead, as UTC days: "Nov 12 – 16, 2026"), and it links to glitchless.gg ("Made with
Glitchless"). A revoked or expired link says so. The token sits in the URL
fragment, which browsers never send to a server or in a Referer. Pages can't be framed (`frame-ancestors 'none'`):
CloudFront never sees the fragment, so allowing embeds for shared boards alone would need a path of their own.

### 3d. Source maps

A minified web build's errors read `e (index-3f2a.js:1:48213)`. With the build's source maps uploaded, the server
shows them as `fireShotgun (weapons.js:141)`, with the original stack and line of code, and groups an error the
same way in every build. The SDK doesn't change: the server reads the stack string it already gets
(`server/src/sourcemaps.js`).

**Uploading.** One map per request. The `glitchless-sourcemaps` package (`packages/sourcemaps`: a CLI and a Vite
plugin) uploads a whole build directory.

| route | scope | does |
| --- | --- | --- |
| `POST /v1/sourcemaps?service=&version=&file=` | `sourcemaps` | the body is the `.map` file, as JSON or gzipped (recognised by its magic bytes). `file` is the minified script's path in the build, e.g. `assets/index-3f2a.js` (default: the map's own `file`); `version` is the one the game passes to `init`. → 201 `{service, version, file, bytes, sources, sources_with_content, pruned?}` |
| `GET /v1/sourcemaps?service=[&version=]` | `read` | `{service, sourcemaps:[{version, file, size, uploaded_at}]}` |
| `DELETE /v1/sourcemaps?service=&version=` | `sourcemaps` | deletes that version's maps; 404 when it had none |

An upload must be a version 3 map (`sources` a list of paths, `mappings` valid base64 VLQ, or an index map with
`sections` placed by offset) of at most 10 MB on the wire (a host passes `createApp` a smaller `maxUploadBytes`: the hosted service takes 4 MB,
under its web function's 6 MB) and 40 MB unpacked, with `file` a relative path that
doesn't climb out (`..`); otherwise 400 or 413. A version holds at most 200 maps, and a game keeps the 50 versions
uploaded most recently: an upload past that deletes the oldest (`pruned`).

**Storage.** Per project, service, version and file, apart from the events. FileStore:
`sourcemaps/<project>/<service>/<version>/<file>.map`. DynamoDB: an item `F#<version>#<file>` under
`P#<project>#SMAP#<service>` naming the current upload, and the map's gzip in chunks of 300,000 base64 characters
(`C#<version>#<file>#<upload>#<n>`), with a 400-day TTL. Hosted: the same `F#` items in the lake's table and the
gzip in S3 under `sourcemaps/` (§7), expired 400 days after the upload; a version stays in players' hands far
longer than a plan keeps its events. `DELETE /v1/data` deletes a game's maps with its data.

**Matching a frame.** A stack line (Chrome `at fn (url:line:col)`, Firefox and Safari `fn@url:line:col`) belongs
to the longest uploaded `file` of the event's version that its URL path ends with, so the game can be served from
any host or folder. Its line and column are looked up in the map's `mappings`, giving the original source (made
relative: `../../src/weapons.js` is `src/weapons.js`), line and column. The function's name is read from
`sourcesContent`: the function around that position, named as V8 names it (`fireShotgun`, `Player.update`,
`new Player`, `<anonymous>` for a callback; TypeScript return types and generics are understood). A source without
`sourcesContent` takes the `names` entry at the caller's call site, then the minified name.

**At ingest.** For a browser error (not Godot, Unity or Unreal) whose version has maps, the server maps the stack,
takes the first frame that isn't Glitchless's own (as the SDK picks its top frame), and stores that frame's
original `fn`, `source` (the file name), `line` and `col`, with a fingerprint worked out as the SDK's on the
original function (`file:line` when no name could be read). Minified variables that engines quote in a message
are masked for it (`t.getPos is not a function` groups as `?.getPos is not a function`; property names stay). So
one bug in 1.2.0 and 1.2.1 is one issue. What the SDK sent stays in `minified` (§2). Each server process keeps a
game's list of maps for a minute and parsed maps up to 96 MB, so a game without maps costs one cached lookup and a
map is read once. An error that arrives before its version's maps keeps the SDK's fingerprint; it is still mapped
when shown.

**At query time.** `errors`, `findings`, `overview`, `board` and `playtest` map each issue's stack (its first
occurrence's, with that version's maps): `location`, `fn`, `source`, `line` and `stack` become the original ones,
and the issue gains

- `frames: [{fn, file, line, col, mapped, code?, minified?}]`, one per stack frame: `code` is the original line of
  source (trimmed, at most 200 characters) for the first 5 mapped frames, `minified` where the frame was in the
  build;
- `minified: {location, stack}`, what the browser reported.

A stability finding's evidence and advice name the original location, and a board's errors panel shows it. A
`session` timeline's errors are mapped the same way (with `minified.stack`). `glitchless_get_error` returns all of
it. Share links (§3c) show none of it: a shared errors panel keeps the message and counts only and findings lose
their evidence, so no file, function or line of source reaches a shared board.

### 3e. Alerts

A game's alerts tell its developers when it gets worse, in Discord, Slack or email, with a line to paste into their
coding agent. The rules, the check and the messages are the core's
([`server/src/alerts.js`](../server/src/alerts.js)). Glitchless Cloud keeps settings per game and checks every
15 minutes; a self-hosted server posts to one webhook (`GLITCHLESS_ALERT_WEBHOOK`, README "Alerts").

**A check** reads each service that sent data in the last day, over the last day: the range `glitchless_triage`
reads by default, so the finding an alert names is in the agent's triage. It reads summaries only (no drill-downs).

| rule | fires when | holds while | key |
| --- | --- | --- | --- |
| `new_error` | an error first occurred after alerts went on and within the last day, and has reached `newErrorSessions` sessions (default 3; 1–1,000) | it occurs in the last day | `error-<fingerprint>` |
| `crash_free` | of the two newest versions with 5+ sessions (as the version finding picks them), each has 20+ sessions in the day, and the newer one's crash-free sessions are 2+ points lower with z ≥ 2 (two-proportion test) | the drop is 1+ point | `crash-free-<prev>-<cur>` |
| `frame_p95` | the same two versions, 20+ sessions each, and the newer one's p95 frame time is 20% and 2 ms worse | it is 10% worse | `frame-p95-<prev>-<cur>` |
| `finding` | a finding (§4) is high or critical. Version findings belong to the two rules above while either is on | it is medium or above | the finding's id |

An error without a fingerprint is skipped. The finding an alert names is `error-<fingerprint>`,
`version-<prev>-<cur>` (the version finding also names a crash-free drop of 2 points or more) or the finding's own.
`env` narrows a check to one env's sessions (default: all).

**Firing once.** Rules give one signal per key: a new error that is also a high error finding is one alert, said as
the new error. A key fires when it starts to hold: it is claimed with a conditional write, so checks running at
once send it once. It stays claimed while it holds at the lower bar, and clears after it has not held for 24 hours;
then it can fire again. The first check after alerts are turned on (or on again) is the **baseline**: what already
holds is claimed without a message. New errors are the exception: whether they are new comes from their first
occurrence, which a 7-day read of errors on a service's first check provides. Fingerprints are remembered (first
and last seen) for 30 days, at most 2,000 a service. A check sends at most 5 alerts a service; the rest wait for
the next.

**The message**: a title (one line: what changed), facts (the numbers), a link to the dashboard page, the finding id
and the line to paste: `Use glitchless_triage on <service>, then look at finding <id>.` (a new error adds
`(glitchless_get_error with fingerprint <fp> has its stack)`).

- Discord: `content` is the title in bold; one embed has the facts, the finding, the paste line in a code block,
  the page as `url`, and a colour by severity. `allowed_mentions: {parse: []}`.
- Slack: Block Kit sections (title, facts, paste line, a context line with the link and the finding), no unfurls.
- Email: plain text and simple HTML, from `Glitchless alerts <alerts@glitchless.gg>`, saying why the reader gets it
  and linking to Settings → Alerts.

Text from a game (error messages, level and version names) is cut to one line without control characters, then
escaped for each channel (Discord markdown and `@`, Slack's `&<>`, HTML), so it can't ping, link or format.

**Glitchless Cloud.** Settings → Alerts, per game: a webhook URL, email to every active member of the workspace,
which rules, the new-error sessions and an env. Changing them, and the test button, needs the exporters' permission
(Owner, Admin). Discord (`discord.com/api/webhooks/…`) and Slack (`hooks.slack.com/services/…`) URLs are
recognised; any other public https URL takes the format chosen (Slack's suits Mattermost, Discord's Guilded). The
URL is sealed like an exporter's secrets (KMS, encryption context `{project}`) and never returned: the dashboard
gets the host and its last four characters. Sends go through the exporters' guarded fetch: https, no redirects,
and no private, loopback, link-local or metadata address after DNS. A send's result is `HTTP <status>` or why it
could not connect, never the URL. Links open the game: `https://app.glitchless.gg/?ws=<workspace>&game=<project>#/<page>`.

| route | does |
| --- | --- |
| `GET /api/projects/{p}/alerts` | `{alerts: {on, onSince, webhook: {format, host, hint} \| null, email, emailRecipients, rules, newErrorSessions, env}, log, defaults, mail, permissions}`; `log` is the last 20 sends, tests included, each with what every channel answered |
| `PATCH /api/projects/{p}/alerts` | any of `{webhookUrl, webhookFormat, email, rules: {rule: bool}, newErrorSessions, env}`; `webhookUrl: null` removes the webhook. Alerts are on when there is a channel and a rule |
| `POST /api/projects/{p}/alerts/test` | sends a test alert to every channel → `{sent: [{channel, ok, to?, error?}]}`; 10 an hour |
| `POST /api/dev/alerts/check` | the dev server only: runs the check now |

The `glitchless-alerts` Lambda checks every game with alerts on, every 15 minutes, one run at a time.

## 4. Derived concepts

- **Crash-free session**: a session that didn't crash. A session crashed when the run broke: the WebGL context
  was lost for good, the game stopped (`game_loop_stopped`, or an Unreal `crash`, sent on the next launch), the
  session ended inside a frozen frame (its last `frame_window` has `frozen`), or it ended ≤ 10s after an unhandled
  error (`js`, `promise`, `script`, `exception`) with nothing played after it (a level event, a death, or one of the
  game's own events; the SDKs' own events don't count). A frozen frame the game recovers from is a hitch, and an
  error the player plays through is an error, not a crash.
- **Rage quit**: session ends ≤ 20s after a `death`/`level_fail` with no later `level_start` or `level_complete`.
  It counts at the death behind it (a `level_fail` right after a death is the same moment). A game nobody wins
  (5+ sessions in the range, levels started and failed, none completed: an endless or flappy game) has no rage
  quits: every run ends in a death, and leaving after one is the end of a run.
- **Climbing gauge**: a `setContext` gauge that, over a session's frame windows (3 or more), ends within 10% of
  its peak, at least 4× and 50 above where it started, and was last at its low point in the first half. Enemies
  come and go between waves; a leak only grows. A gauge that climbs in 60% of the sessions that report it (3 or
  more) is a memory finding, unless it is a progress counter by name (score, time, kills, wave and the like).
- **Hitch**: a single frame > 50ms. **Jank**: a frame > 33.3ms (misses two 60Hz vsyncs).
- **GPU tier**: `high` (discrete NVIDIA/AMD, Apple M-Pro/Max), `mid` (Apple M base, recent Intel Iris/Arc), `low` (old Intel HD/UHD, mobile Mali/Adreno/PowerVR, a Steam Deck), `software` (SwiftShader/llvmpipe).
- **Retention** (D1, D7, D30): of the players first seen on a UTC day (a cohort), the share that played again on the
  1st, 7th and 30th day after it. Only players with an ID count (install or full mode, §4b): an anonymous session is
  filed under its own ID. A player's first-seen day is the day of their first event the store has (its first-seen
  index, which lasts as long as the store keeps data: the plan's retention on Glitchless Cloud, so a player gone
  longer than that is new again). They join that day's cohort
  when a session of theirs in the selection (env, version) started on it, as sessions count on the day they start
  (§7). A cohort is a whole day of the range, and its Dn is null until day N has ended inside the range. Up to 31
  days it is exact from session states; past 31 days the hosted store reads each day's sample of new players against
  the days' samples of active players, exact while small and named in `meta.approximate` (`retention`) once capped.
- **Players now**: sessions that sent anything in the last two minutes, counted as batches arrive. The open-source
  server counts in memory, per process; Glitchless Cloud counts across every server instance (whole minutes: this
  one and the two before) through the `auth.playersNow` hook.
- **Platform**: a Steam Deck (`steam_deck`), whatever OS the build is for, else the OS. Performance breaks frame times
  down by it (`by_platform`).

## 4b. Privacy levels

This is the one definition every SDK follows (the browser, Godot, Unity and Unreal SDKs, and any SDK added later):
the same levels, the same ID and the same Steam Deck rule. `session_start` says which level (`privacy`), and each
SDK's PRIVACY.md lists exactly what it sends at each.

| | anonymous (default) | install | full |
| --- | --- | --- | --- |
| `player_id` | null: the server files the session under its session ID | the **player ID**: random `p_` + 12 characters `[a-z0-9]`, made on first launch and kept on the device | the same stored ID |
| kept in | nothing; an ID another build left is deleted | browser `localStorage['glitchless.pid']`; Godot `user://glitchless/player_id`; Unity `persistentDataPath/glitchless/player_id` (PlayerPrefs `glitchless.player_id` in WebGL builds); Unreal `Saved/Glitchless/player_id` | the same |
| session ID | random per launch, in memory only | random per launch, saved with unsent batches until they go | the same as install |
| device | coarse: OS, tiers, screen, renderer, `steam_deck` | as anonymous | adds model, OS version, GPU, cores, memory |
| positions | off (on with `positions`) | as anonymous | on |
| unsent batches on the device (engine SDKs; the browser keeps none) | without IDs | with their session and player IDs | the same as install |

Install mode adds one thing to anonymous mode, the stored player ID (and, since that ID is on the device anyway,
unsent batches keep their IDs), so retention (D1, D7, D30, §4) can be counted without knowing who the player is: the
ID is random, made by the SDK, and tied to no account, device or advertising ID. Install and full mode share it, so a
game that moves between them keeps its players; anonymous mode deletes it. The browser, Godot and Unity SDKs can
reset it (`resetInstallId()`, `reset_install_id()`, `Glitchless.ResetInstallId()`): that deletes the stored ID, the
session in progress keeps sending the ID it started with (so it is never split), and the next launch makes a new ID
that nothing links to the old one. Where nothing can be stored (a browser that blocks localStorage) the ID lasts one
launch.

**Steam Deck.** A Steam Deck is one when Steam says so (`SteamDeck=1`, set under Steam and Proton), the board is
Valve's Jupiter (LCD) or Galileo (OLED) (`/sys/class/dmi/id/board_vendor` and `board_name`), or the OS is SteamOS
(`ID=steamos` in `/etc/os-release`); a Windows build under Proton reads the same files through Wine's `Z:` drive. On
one, in every mode, the engine SDKs send `steam_deck: true` (and `false` elsewhere), `gpu_tier: "low"`, and
`os: "SteamOS"` when it runs SteamOS or Steam set `SteamDeck` (a Deck under another Linux keeps its OS name). The
browser SDK sends `steam_deck: true` when the browser shows the Deck's GPU (AMD Custom GPU 0405 or 0932,
"vangogh") or a user agent names it, with `gpu_tier: "low"`, and nothing when unsure. Only these fields are sent,
never what they were read from.

## 5. Godot SDK

`godot/addons/glitchless` sends the same envelope with `"sdk": "glitchless-godot/0.2.0"` and the same event types. See its [README](../godot/addons/glitchless/README.md) and [PRIVACY.md](../godot/addons/glitchless/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default), and the server files the session under `session_id`; install and full mode send the stored `p_…` player ID (`user://glitchless/player_id`, §4b) |
| `session_start.device` | `browser: "Godot"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer`, `driver`, `screen`, `dpr`, `refresh_hz`, `steam_deck` (§4b: `os` is `SteamOS` on a Deck running it); full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | adds `gpu_ms`, `process_ms`, `physics_ms`, `objects`, `nodes`, `orphan_nodes`, `resources`, `video_mb`, `texture_mb`, `screen`, `window`; `heap_mb` is static memory (debug builds only, else null); `geometries`, `textures`, `programs` are null; `ctx` also holds `nodes`, `orphan_nodes`, `objects`. A window never spans two levels |
| `hitch` | `causes` from `shader_compile`, `scene_change`, `node_spawn`, `script`, `physics`, `render`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `pipeline_compiles`, `nodes_added`; `loaf` is empty |
| `error` | `kind`: `script` (GDScript runtime error; unhandled, like `js`), `engine`, `push_error`, `shader`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on (full mode or `positions: true`); the server leaves unplaced deaths off heatmaps and hotspots |
| `session_end` | `reason`: `background`, `close`, `quit`, `measure` |
| `custom` | also `screen_change`, `app_resume` |
| `bug_report` | `bug_reports` in init options adds the F8 form: a `CanvasLayer` that pauses the tree while open, with `bug_report_opened` and `bug_report_closed` signals. `report_bug(note)` sends one from the game's own UI. `screenshot` is the root viewport's last frame with its longer side at most 960 px (the browser caps the width), none in headless runs |

## 5b. Unity SDK

`unity/Packages/gg.glitchless.sdk` (Unity 2022.3 and 6) sends the same envelope with `"sdk": "glitchless-unity/0.2.0"`. See its [README](../unity/Packages/gg.glitchless.sdk/README.md) and [PRIVACY.md](../unity/Packages/gg.glitchless.sdk/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); `Privacy.Install` and `Privacy.Full` send the stored `p_…` player ID (§4b) |
| `session_start.device` | `browser: "Unity"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer` (`built-in`, `urp`, `hdrp`), `driver` (graphics API), `screen`, `dpr` (null), `refresh_hz`, `steam_deck` (§4b: `os` is `SteamOS` on a Deck running it); full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | frame times from `Time.unscaledDeltaTime`; adds `process_ms` (Update to LateUpdate), `physics_ms` (FixedUpdate and physics), `render_ms` (PostLateUpdate), `gpu_ms`, `setpass_calls`, `batches`, `gc_collections`, `gc_alloc_kb`, `materials`, `objects`, `game_objects`, `gc_reserved_mb`, `system_mb`, `screen`, `window`; `geometries` is the mesh count and `heap_mb` the GC heap; counts Unity only has in development builds are null in release builds. `ctx` also holds `game_objects`, `meshes`, `materials`. A window never spans two levels |
| `hitch` | `causes` from `gc`, `shader_compile`, `scene_change`, `object_spawn`, `script`, `physics`, `render`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `gc_collections`, `gc_alloc_kb`, `shader_compiles`, `objects_added`; `loaf` is empty |
| `level_start` | also sent when a scene that reads as a level becomes active |
| `error` | `kind`: `exception` (uncaught; unhandled, like `js`), `log_error`, `assert`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on |
| `session_end` | `reason`: `background` (phones), `quit`, `measure` |
| `custom` | also `screen_change`, `app_resume` |
| `bug_report` | `BugReports` in the options adds the F8 form: IMGUI (no EventSystem), with `Time.timeScale` 0 and the Input System's actions off while open, and `OnOpen`/`OnClose`. `Glitchless.ReportBug(note)` sends one from the game's own UI. `screenshot` is `ScreenCapture` at the end of the frame with its longer side at most 960 px, none with `-nographics` |

## 5c. Unreal SDK

`unreal/Plugins/Glitchless` (Unreal Engine 5.8; 5.7 is guarded but not built) sends the same envelope with `"sdk": "glitchless-unreal/0.1.0"` and the same event types. See its [README](../unreal/Plugins/Glitchless/README.md) and [PRIVACY.md](../unreal/Plugins/Glitchless/PRIVACY.md). Positions are in metres with y up (x = X/100, y = Z/100, z = Y/100). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); install and full mode send a stored random `p_…` ID |
| `session_start` | `privacy` (`anonymous`, `install`, `full`). `device`: `browser: "Unreal"`, `browser_version` (`5.8.4`), `os` (`Windows`, `macOS`, `Linux`, `SteamOS`, `iOS`, `Android`), `mobile`, `device_tier`, `gpu_tier` (`low` on a Steam Deck), `renderer` (`deferred`, `forward`, `mobile`), `driver` (`D3D12`, `Metal`, `Vulkan`), `screen`, `dpr` (null), `refresh_hz` (phones only), `steam_deck`; full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | frame times from a clock at the start of each frame. Adds `game_ms` (game thread, GGameThreadTime), `process_ms` (the same, under the name the playtest gate reads), `render_ms` (render thread), `rhi_ms` (null without an RHI thread), `gpu_ms`, `gc_collections`, `gc_ms`, `pso_compiles` (pipeline states created at draw time that took over 20 ms, UE 5.8), `shader_compiles` (the editor only), `packages_loaded`, `objects` (UObjects), `actors`, `heap_mb` (the process), `texture_mb`, `screen`, `window`. `draw_calls` and `triangles` only while the RHI counts them (usually null in a packaged build); `geometries`, `textures`, `programs` are null. `ctx` also holds `objects` and `actors`. A window never spans two levels |
| `hitch` | `duration_ms` is the frame's time on the clock (Unreal leaves waits out of its thread times, so a frame stalled on a pipeline state, the GPU or the disk would look short by them). `causes` from `pso_compile`, `shader_compile`, `gc`, `map_load`, `level_stream`, `asset_load`, `script` (game thread at 40% of the frame), `render` (render, RHI or GPU at 40%), `frozen` (over 700 ms). Adds `bound` (the slowest of `game`, `render`, `rhi`, `gpu`), `game_ms`, `process_ms`, `render_ms`, `rhi_ms`, `gpu_ms`, `gc_collections`, `gc_ms`, `pso_compiles`, `shader_compiles`, `packages_loaded`; `loaf` is empty |
| `level_start` | also sent when a map that reads as a level loads (not `Entry`, `MainMenu`, `Lobby`, `Loading`…); the game's first `LevelStart` turns that off |
| `error` | `kind`: `crash` (fatal; written to the outbox as the game dies and sent on the next launch, with `session_end` reason `crash`; in anonymous mode under a fresh session ID), `ensure` (an error, not fatal: the game carries on, and each ensure reports once a run), `script` (a Blueprint runtime error such as Accessed None; Unreal stops that Blueprint function, so it is unhandled, like `js`), `log_error` (`UE_LOG` Error; `fn` is the log category), `warning`, `manual`; adds `recent` (last 6 game events) and, for `script`, `attrs.blueprint` |
| `death`, `pos` | positions only when they are on (full mode, or Positions) |
| `session_end` | `reason`: `quit`, `background` (phones), `measure`, `crash` |
| `custom` | also `screen_change`, `app_resume`, `rage_input` |
| `bug_report` | a **Bug Report Key** (F8) in the plugin's settings, or `ShowBugReportDialog()`, opens a Slate box that takes the game's input and pauses it (Pause For Bug Report); `ReportBug(note)` sends one from the game's own UI. `screenshot` is the viewport read back, its longer side at most 960 px. A report is its own one-event batch in the outbox, sent after the session's events; neither the read-back frame nor the box's first draw is timed |

`-glitchless-measure=S` (with `-glitchless-warmup`, `-glitchless-out`) prints `{"glitchless_measure": {…}}` as Unity and Godot do, plus `session_id`; `-autoplay` and `-glitchless-synthetic` mark the session synthetic. The optional GlitchlessToolset plugin gives Unreal MCP (UE 5.8, Experimental) `Status` and `Measure` tools for Play In Editor.

On the server, findings for an `unreal` game name Unreal's fixes (PSO precaching and bundled caches, GC pooling and clustering, streaming budgets, Insights and `stat` commands, scalability groups). `crash` is a fatal kind that halts its session, so the session counts as crashed (§4), like `game_loop_stopped`.

## 6. Projects, keys and storage

A **project** is the tenancy boundary. The server resolves every request to one project through two
hooks passed to `createApp({ auth })` ([`server/src/auth.js`](../server/src/auth.js)):

| hook | called for | returns | refuses with |
| --- | --- | --- | --- |
| `resolveIngest(token, req)` | `POST /v1/intake?token=` | `{ projectId, keyId?, rps? }` | `AuthError(403)` |
| `resolveReader(req)` | every other `/v1/` route but `/v1/health` | `{ projectId, scopes, keyId?, rps?, share? }` (`read`: queries and live tail; `delete`: `DELETE /v1/data` and `DELETE /v1/report`; `dashboard`: save or reset a dashboard; `sourcemaps`: upload source maps). `rps` rate-limits the reader per `keyId`; `share: { service, page }` limits it to one board (§3c) | `AuthError(401 \| 403)` |

Client tokens ship inside game builds, so they are write-only: a reader hook never accepts one. Intake
stamps `project_id` on every event and stores it under that project; queries, the live tail, the agent
activity feed and the query cache are all per project.

- **Open-source default** (`envAuth`): one project, `default`. `GLITCHLESS_CLIENT_TOKENS` (comma-separated,
  default `gl_pub_dev`) may write; `GLITCHLESS_API_KEY`, if set, is needed for everything else (header
  `x-glitchless-api-key` or `?api_key=`), and must differ from every client token. No API key means open reads.
- **Hosted**: a control plane implements the same hooks with hashed per-project keys and Auth0/Cognito sessions.
- **Rate limit**: a token bucket per ingest key, per server process, of `rps` requests/s with bursts of 2 s
  worth; 429 with `Retry-After` past it. `GLITCHLESS_INGEST_RPS` sets the default (1000; 0 turns it off). The
  payload caps still apply: 1 MB per request, 500 events, 4000-character strings.

**Storage.** Every store method takes the `projectId`: `put`, `query`, `rollups`, `getMaps`, `reports`,
`getReport`, `deleteReport`, `putSourcemap`, `getSourcemap`, `sourcemaps`, `deleteSourcemaps`, `services`, `clear`
([`server/src/stores/file.js`](../server/src/stores/file.js) lists them), and optionally `cohorts` (the players first
seen on each day of a range, for retention): the file store keeps that first-seen index in memory over everything it
holds, the hosted store's compactor writes it (§7), and the DynamoDB store has none, so its retention counts players
as new on their first day in the range (`first_seen: 'range'`). DynamoDB keys:

| pk | sk | holds |
| --- | --- | --- |
| `P#<project>#<service>#<YYYY-MM-DDTHH>` | `<ts>#<session>#<batch><seq>` | events |
| `P#<project>#MAP#<service>` | `<level>#<version>` | level map thumbnails |
| `P#<project>#BUG#<service>` | `T#<ts>#<id>` \| `I#<id>` | bug report records: by time to list them, by id with the screenshot |
| `P#<project>#SMAP#<service>` | `F#<version>#<file>` \| `C#<version>#<file>#<upload>#<n>` | a web build's source maps (§3d): one item each, and their gzip in chunks |
| `P#<project>#SVC` | `<service>` | versions, envs, last_seen |
| `P#<project>#R#<service>#<YYYY-MM-DD>` | `<minute>#<writer>` | rollup cells |
| `P#<project>#META` | `rollups#<service>` | `since`: first minute with complete rollups |

Data written before projects existed (JSONL lines without `project_id`; DynamoDB keys `<service>#<hour>`,
`MAP#<service>`, `SERVICE`) is read as the `default` project, so no migration is needed; old DynamoDB items
expire with their 30-day TTL.

**Rollups.** Intake also folds every event into per-minute cells per (project, service, env, version, level):
a merged frame-time sketch, event counts by type, frames, seconds, hitches, frozen frames, frame-budget
counts, and sums, counts and maxima of draw calls, render ms, triangles, geometries, heap and context gauges
([`server/src/rollups.js`](../server/src/rollups.js)). `overview`, `performance`, `versions` and
`findings` take their frame-time and count sections from the stored minutes that lie fully inside the range,
and fold raw events for the partial minutes at each end. Without stored rollups (filters by session type or
ids, or ranges before `since`) they fold every raw event the same way. Sums are fixed-point, so both paths
give identical numbers in any arrival order. On the file and DynamoDB stores, session-level numbers
(crash-free, rage quits, players), device breakdowns, hitch context and findings evidence are folded from the
raw range, into the same mergeable forms the hosted store keeps (§7).

The file store rebuilds rollups from its event files at startup. On DynamoDB each server process keeps a
running rollup per minute and rewrites its own item after every batch, so items have one writer and need no
locking; a query merges all writers' items. `since` is set at a project's first rollup write, 2 hours ahead,
because servers from before rollups may still be writing.

Every answer carries `meta`: the range answered (`from`, `to`, `bucket_ms`), the filters, and from the hosted
store `resolution: 'day'` for ranges of more than 31 days, `approximate` (the parts estimated from sketches or
samples, §7), `note` (a view answered over less of the range) and `retention_days` (the reader's plan).

## 7. Hosted event store (Glitchless Cloud)

The hosted service stores events without one DynamoDB item per event
([`server/src/stores/lake.js`](../server/src/stores/lake.js), keys in
[`server/src/lake/layout.js`](../server/src/lake/layout.js); the AWS stack itself is part of the hosted service):

- **Ingest.** Each intake batch is one Amazon Data Firehose record (`PutRecordBatch`): the envelope once, then
  the events. Firehose writes gzip JSON lines to S3 under `raw/dt=…/hour=…/project=…/` (dynamic
  partitioning on the record's `p`). Level maps go straight to DynamoDB, bug reports to DynamoDB (`P#<p>#BUG#<s>`,
  as §6) with their screenshots in S3 under `reports/plan=<plan>/project=<p>/service=<s>/`, so neither waits for the
  compactor. Uploaded source maps (§3d) go to S3 under `sourcemaps/project=<p>/service=<s>/version=<v>/`, each
  listed by an item in DynamoDB (`P#<p>#SMAP#<s>`); a new service, version or env is registered at once. The ingest hook's `plan` sets retention.
- **Compactor.** A Lambda (`server/src/lake/compactor.js`) every 1 to 5 minutes reads the new objects with
  DuckDB and writes, per (project, service, hour), per-minute **summaries** to DynamoDB: rollup cells (§6)
  and facts per (env, version, level), and the state of every session per minute and per hour. It keeps the
  events of sessions in progress in a spill file and writes **one file per finished session**. An hour that
  has closed is consolidated into one set of items and rewritten as **Parquet** (sorted by type, level, time).
  Late events reopen the hour and the session file. Runs are idempotent and one runs at a time.
- **First-seen index.** Each compactor run notes when it first saw each player with an ID (install or full
  mode) under `P#<p>#N#<s>`: an `I#<player>` item with the first time and the last day seen, and a
  `D#<day>#<player>` item under the day first seen, both expiring with the plan's retention after the day they
  name. Taking the earliest is idempotent, and a late event that moves a player's first day earlier moves their D
  item. Retention reads the D items of the range's days (one Query); a day's rollups keep a sample of its new
  players from them.
- **Queries.** `overview`, `performance`, `versions`, `findings`, `players`, `errors` and `sessions` merge
  the summaries of the range. They read hour states for whole hours and minute states at the edges.
  Session states and facts merge exactly, so they answer as the raw events of the same range would
  (`server/test/lake.test.js` compares every query). `session` (detail and replay) and `playtest` read
  session files.
- **Drill-downs.** Recent hitches, error breadcrumbs and heatmap positions read one project's Parquet and
  not-yet-compacted gzip files with DuckDB. So do session-type filters (`type=user|synthetic|simulated`).
  If an optional drill-down fails, the query answers without it and lists it in `meta.partial`.
- **Ranges** are answered in whole minutes, up to the compactor's watermark: data Firehose may still be
  buffering is left out. `meta.from` and `meta.to` give the range answered. The reader's plan caps a range at
  its retention (`meta.retention_days`), counted back from now: a range that ends in the past (a pinned share
  link, §3c) starts no earlier than what the plan still keeps.
- **Daily rollups** ([`server/src/daily.js`](../server/src/daily.js)) answer ranges of more than 31 days, in
  whole days (`meta.resolution: 'day'`, day buckets). Once a day has closed (3 hours into the next day, plus
  half an hour), the compactor folds it into one set of items under `P#<p>#Y#<s>#<year>`: the day's cells and
  facts merged per (env, version, level), and the sessions that **started** that day folded per (env,
  version) into counts, sums, quantile maps, device breakdowns, the level funnel, custom events, players and a
  sample of sessions for ordered funnels; their latest sessions go in separate items (`R`), read only by
  session lists. A session counts on the day it started, with all its events (up to 3 hours past midnight).
  Late data reopens a day. Days the compactor has not built yet (the last day or two, and days before it kept
  rollups: `meta` item `df`) are folded from the hour summaries the same way, at query time.
  `server/test/daily.test.js` checks every query against the raw events at day resolution.
  - **Exact**: everything from cells and facts, session counts, rates, sums and averages, the level funnel's
    counts, custom events' sessions and values, the latest sessions and rage quits.
  - **Exact while small, then estimated** (named in `meta.approximate`): distinct players (overall, per
    level, per event, per error) and error sessions (HyperLogLog past 128–512 per day), returning players
    (a uniform sample of 512 players a day), medians of per-session values (time to first frame, session
    length, memory growth: 3 then 2 significant digits past 512 values), ordered funnels (256 sessions a
    day, weighted), GPUs past the top 30 a day, difficulty hotspots past 100 deaths per level a day. A
    sessions list reads no days, so it tells a game nobody wins from the sessions it read.
    Findings' engine-specific advice follows the SDK most of the range's sessions use.
  - **Over the last 31 days of the range** (`meta.note`): heatmaps and session-type filters, which read raw
    rows; recent hitches.
  - **Cost** (`scripts/lake-loadtest.js --long`): a day of 7,200 sessions keeps about 140 KB of rollups
    (its hour summaries: 27 MB) and costs about $0.0002 to build; a 90-day board reads about 1,300 RRU
    ($0.0002) and a 365-day one about 5,300 RRU.

- **Retention** per plan: S3 lifecycle rules on `events/plan=<plan>/`, `sessions/plan=<plan>/` and `reports/plan=<plan>/`, raw files
  after 3 days, and a TTL on DynamoDB items. The `plan` the hooks pass is the one whose retention applies: a
  Free workspace with the `MEGAJAM26` jam tier passes `indie` (90 days) until 2027-01-31 23:59 UTC, then
  `free` again, so new data gets 14 days and reads stop at 14 days (cloud README, MegaJam). Source maps expire 400 days after their upload, whatever the plan.
