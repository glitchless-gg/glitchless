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
  privacy: 'anonymous',            // default. 'full' adds a stored player ID, GPU/CPU detail and positions (packages/sdk/PRIVACY.md)
  sampleRate: 1,                   // 0..1 fraction of sessions that send data
  positionHz: 4,                   // player position sampling rate for heatmaps / replay (positions are on in 'full' mode)
  windowMs: 5000,                  // frame stats are summarised per window
  flushIntervalMs: 15000,          // batches go out this often, gzipped, on a window boundary
  datadog: null,                   // optional { applicationId, clientToken, site } → mirrors to Datadog RUM
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
| `glitchless.captureMap(levelId, { axis: 'xy' \| 'xz', bounds, exclude })` | after a level is built: renders an orthographic thumbnail used as the heatmap background. `bounds = {min:[a,b], max:[a,b]}` in world units for the two axes; `exclude` = objects to hide while capturing (player, sky dome, effects) |
| `glitchless.registerTool(name, description, inputSchema, handler)` | expose a game-specific tool to coding agents over WebMCP |
| `glitchless.error(err, attrs)` | manually report a handled error |
| `glitchless.flush()` | force send (SDK also flushes on `pagehide`) |

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
| `session_start` | `device {browser, browser_version, os, mobile, gpu, gpu_vendor, gpu_tier, cores, memory_gb, screen:[w,h], dpr, webgl}`, `page {url, referrer}` |
| `frame_window` | every window (5 s; sent in batches every 15 s): `frames, fps, ft {sketch}, ft_p50, ft_p95, ft_p99, ft_max, jank` (frames > 33.3ms), `hitches` (frames > 50ms), `render_ms` (avg CPU ms inside `renderer.render`), `draw_calls, draw_calls_max, triangles, geometries, textures, programs, heap_mb, ctx {…gauges}` |
| `hitch` | single frame > 50ms: `duration_ms, draw_calls, triangles, ctx, recent [last 5 game events], loaf [{source, fn, ms}]` |
| `load` | `ttff_ms` (navigation → first rendered frame), `assets {count, bytes, ms, slowest:[{url, ms, bytes}]}` |
| `error` | `kind` (`js` \| `promise` \| `webgl_context_lost` \| `manual`), `message, stack, source, line, col, fingerprint` |
| `level_start` | — |
| `level_complete` | `duration_s, score` |
| `level_fail` | `cause` |
| `death` | `x, y, z, cause` |
| `pos` | `pts: [[ts, x, y, z], …]` (batched samples) |
| `custom` | `name, attrs` |
| `map` | `axis, bounds, image` (JPEG data URL, ≤ 60 KB) |
| `session_end` | `reason` (`pagehide` \| `hidden_timeout`), `duration_s` |

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
| `errors` | `{issues:[{fingerprint, message, kind, count, sessions, players, first_seen, last_seen, versions, levels, stack, sample_session}]}` |
| `players` | `{funnel, deaths_by_level, rage_quits, session_length, retention}` |
| `heatmap` | `{level, map, deaths:[{x,y,z,cause,version}], density:{…}}` (requires `level`) |
| `sessions` | `{sessions:[…]}` ; `session?id=` → `{session, events}` |
| `versions` | `{versions:[{version, sessions, crash_free_pct, frame_p95, level_completion_pct, rage_quit_pct, errors_per_session, …, board:[…], events:{name: per_session}}], has:{frames, levels, deaths, fails, geometry}, board:[{title, unit}]}`. `board` holds each version's value of the stats on the game's boards (each once, in the order of the top-level `board`, §3b); `has` says which built-in measures the game reports |
| `findings` | Ranked findings with evidence — what the MCP server hands to coding agents |
| `events` | The game's own metrics (`custom` events): `{ts, sessions, events:[{name, count, sessions, players, per_session, series, attrs:[{key, values:[{value, count, sessions}], avg}]}]}`. `name=` keeps one event, `sdk=1` adds the SDKs' own; `funnel=open,paywall,buy=done` adds `funnel:[{step, sessions, pct_of_first, pct_of_previous, median_s_from_previous}]` |
| `dashboard` | The game's pages, in order: `{dashboard:{source, updated_at, updated_by, spec:{pages}, pages:[{id, title, icon, view, options} or {id, title, icon, panels: count}]}}`, `source` being `saved` or `auto` (§3b) |
| `board` | One board page with each panel's data: `page=` its id (default: the first board) → `{board:{page, title, source, updated_at, updated_by, spec:{panels}, panels:[…]}}`; a built-in view's id gives `{error, view}` |

### 3b. Dashboards and boards

Every game gets a dashboard that fits it (`server/src/board.js`): its list of pages, in the order the sidebar shows
them, the first opening first. A page is a board (`panels`, below) or one of the built-in views (`view`: events,
performance, errors, players, heatmaps, sessions, versions, live), which a game keeps, renames, reorders or drops:

```json
{ "pages": [
  { "id": "overview", "title": "Overview", "icon": "overview", "panels": [ … ] },
  { "id": "money", "title": "Paywall", "icon": "bolt", "panels": [ … ] },
  { "id": "purchases-live", "title": "Purchases, live", "view": "live", "options": { "events": ["paywall", "buy"] } },
  { "id": "errors", "title": "Errors", "view": "errors" }
] }
```

`id` (default: from the view or the title) is the page's address, `#/<id>`; `icon` is one of board, overview,
events, perf, errors, players, heatmap, sessions, versions, live, flag, bolt, play, clock. At most 20 pages and 24
panels a board. A built-in view a dashboard leaves out still opens from links (`#/errors/<fingerprint>`,
`#/sessions/<id>`). The live view takes `options.events`: names or types to show.

A dashboard is saved per game: `GET /v1/dashboard?service=` needs the read scope; `PUT /v1/dashboard?service=` with
`{pages}` and `DELETE` (back to the automatic dashboard) need the `dashboard` scope. A game without a saved one gets
the automatic dashboard, made from the data it sent in the last week: an Overview board (the stats every game has,
findings, its own events, then levels, frame time, errors and deaths only if it reports them), then Events if it
sends custom events, Performance if it sends frame times, Errors, Players, Heatmaps if it sends positions, Sessions,
Versions and Live Tail. Versions are compared on the stat panels of every board.

| panel `type` | fields | shows |
| --- | --- | --- |
| `stat` | `metric` (sessions, players, avg_session_s, crash_free_pct, error_free_pct, frame_p95, avg_fps, hitches_per_min, errors, deaths, rage_quit_pct) or `event`, optional `per` | one number; `event` per `per` is a percentage |
| `series` | `event`, optional `by`, `limit` | the event's count over time, split by an attribute's top values; `by` can also be `$version` or `$level` |
| `breakdown` | `event`, `by`, `limit` | the attribute's values with counts and sessions |
| `funnel` | `steps` | sessions through the steps, in order |
| `levels` | `label` | starts, completion, fails, deaths and times per level; columns only for what the game reports |
| `frame_time`, `errors`, `deaths`, `events` | `limit` (errors) | frame-time p50/p95, top errors, deaths by level and cause, every custom event |
| `findings` | `limit` | the ranked findings |
| `sessions` | `sent`, `limit` | recent sessions, or only those that sent an event, each opening its replay |
| `versions` | none | the board's own stat panels, version by version |
| `live` | `events` | events as they arrive, optionally only these names or types |

Every panel takes `title`, `note` and `size` (`s`, `m` or `l`). An event is written like a funnel step: `name`,
`name=value` (any attribute) or `name:key=value`. A panel with no data in the window says why instead of showing
zeros.

Custom events are counted in the per-minute cells (by name, and by name, attribute and value) and in the session
states (the first 16 occurrences of each name with their attributes, for ordered funnels), so every event store
answers the same. Names, attributes and values are the game's own, so each is capped: 200 names and 400 values a
minute, 64 names a session and 40 values per attribute. Past a cap the rest is counted as `(other)`.

## 4. Derived concepts

- **Crash-free session**: a session with zero `error` events of kind `js`/`promise`/`webgl_context_lost`/`script` (Godot).
- **Rage quit**: session ends ≤ 20s after a `death`/`level_fail` with no later `level_start` or `level_complete`.
- **Hitch**: a single frame > 50ms. **Jank**: a frame > 33.3ms (misses two 60Hz vsyncs).
- **GPU tier**: `high` (discrete NVIDIA/AMD, Apple M-Pro/Max), `mid` (Apple M base, recent Intel Iris/Arc), `low` (old Intel HD/UHD, mobile Mali/Adreno/PowerVR), `software` (SwiftShader/llvmpipe).

## 5. Godot SDK

`godot/addons/glitchless` sends the same envelope with `"sdk": "glitchless-godot/0.1.0"` and the same event types. See its [README](../godot/addons/glitchless/README.md) and [PRIVACY.md](../godot/addons/glitchless/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default); the server files the session under `session_id` |
| `session_start.device` | `browser: "Godot"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer`, `driver`, `screen`, `dpr`, `refresh_hz`; full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | adds `gpu_ms`, `process_ms`, `physics_ms`, `objects`, `nodes`, `orphan_nodes`, `resources`, `video_mb`, `texture_mb`, `screen`, `window`; `heap_mb` is static memory (debug builds only, else null); `geometries`, `textures`, `programs` are null; `ctx` also holds `nodes`, `orphan_nodes`, `objects`. A window never spans two levels |
| `hitch` | `causes` from `shader_compile`, `scene_change`, `node_spawn`, `script`, `physics`, `render`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `pipeline_compiles`, `nodes_added`; `loaf` is empty |
| `error` | `kind`: `script` (GDScript runtime error; unhandled, like `js`), `engine`, `push_error`, `shader`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on (full mode or `positions: true`); the server leaves unplaced deaths off heatmaps and hotspots |
| `session_end` | `reason`: `background`, `close`, `quit`, `measure` |
| `custom` | also `screen_change`, `app_resume` |

## 5b. Unity SDK

`unity/Packages/gg.glitchless.sdk` (Unity 2022.3 and 6) sends the same envelope with `"sdk": "glitchless-unity/0.1.0"`. See its [README](../unity/Packages/gg.glitchless.sdk/README.md) and [PRIVACY.md](../unity/Packages/gg.glitchless.sdk/PRIVACY.md). Differences:

| | |
| --- | --- |
| envelope | `player_id` is null in anonymous mode (the default) |
| `session_start.device` | `browser: "Unity"`, `browser_version` (engine), `os`, `mobile`, `device_tier`, `gpu_tier`, `renderer` (`built-in`, `urp`, `hdrp`), `driver` (graphics API), `screen`, `dpr` (null), `refresh_hz`; full mode adds `model`, `os_version`, `gpu`, `gpu_vendor`, `cores`, `memory_gb`. `page` and `nav_ms` are null |
| `frame_window` | frame times from `Time.unscaledDeltaTime`; adds `process_ms` (Update to LateUpdate), `physics_ms` (FixedUpdate and physics), `render_ms` (PostLateUpdate), `gpu_ms`, `setpass_calls`, `batches`, `gc_collections`, `gc_alloc_kb`, `materials`, `objects`, `game_objects`, `gc_reserved_mb`, `system_mb`, `screen`, `window`; `geometries` is the mesh count and `heap_mb` the GC heap; counts Unity only has in development builds are null in release builds. `ctx` also holds `game_objects`, `meshes`, `materials`. A window never spans two levels |
| `hitch` | `causes` from `gc`, `shader_compile`, `scene_change`, `object_spawn`, `script`, `physics`, `render`, `frozen`; adds `process_ms`, `physics_ms`, `render_ms`, `gpu_ms`, `gc_collections`, `gc_alloc_kb`, `shader_compiles`, `objects_added`; `loaf` is empty |
| `level_start` | also sent when a scene that reads as a level becomes active |
| `error` | `kind`: `exception` (uncaught; unhandled, like `js`), `log_error`, `assert`, `manual`, `warning`; adds `recent` (last 6 game events) |
| `death` | `x`, `y`, `z` only when positions are on |
| `session_end` | `reason`: `background` (phones), `quit`, `measure` |
| `custom` | also `screen_change`, `app_resume` |

## 6. Projects, keys and storage

A **project** is the tenancy boundary. The server resolves every request to one project through two
hooks passed to `createApp({ auth })` ([`server/src/auth.js`](../server/src/auth.js)):

| hook | called for | returns | refuses with |
| --- | --- | --- | --- |
| `resolveIngest(token, req)` | `POST /v1/intake?token=` | `{ projectId, keyId?, rps? }` | `AuthError(403)` |
| `resolveReader(req)` | every other `/v1/` route but `/v1/health` | `{ projectId, scopes }` (`read`: queries and live tail; `delete`: `DELETE /v1/data`) | `AuthError(401 \| 403)` |

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

**Storage.** Every store method takes the `projectId`: `put`, `query`, `rollups`, `getMaps`, `services`,
`clear` ([`server/src/stores/file.js`](../server/src/stores/file.js) lists them). DynamoDB keys:

| pk | sk | holds |
| --- | --- | --- |
| `P#<project>#<service>#<YYYY-MM-DDTHH>` | `<ts>#<session>#<batch><seq>` | events |
| `P#<project>#MAP#<service>` | `<level>#<version>` | level map thumbnails |
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
  partitioning on the record's `p`). Level maps go straight to DynamoDB, and a new service, version or env is
  registered at once. The ingest hook's `plan` sets retention.
- **Compactor.** A Lambda (`server/src/lake/compactor.js`) every 1 to 5 minutes reads the new objects with
  DuckDB and writes, per (project, service, hour), per-minute **summaries** to DynamoDB: rollup cells (§6)
  and facts per (env, version, level), and the state of every session per minute and per hour. It keeps the
  events of sessions in progress in a spill file and writes **one file per finished session**. An hour that
  has closed is consolidated into one set of items and rewritten as **Parquet** (sorted by type, level, time).
  Late events reopen the hour and the session file. Runs are idempotent and one runs at a time.
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
  its retention (`meta.retention_days`).
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
    day, weighted), GPUs past the top 30 a day, difficulty hotspots past 100 deaths per level a day.
    Findings' engine-specific advice follows the SDK most of the range's sessions use.
  - **Over the last 31 days of the range** (`meta.note`): heatmaps and session-type filters, which read raw
    rows; recent hitches.
  - **Cost** (`scripts/lake-loadtest.js --long`): a day of 7,200 sessions keeps about 140 KB of rollups
    (its hour summaries: 27 MB) and costs about $0.0002 to build; a 90-day board reads about 1,300 RRU
    ($0.0002) and a 365-day one about 5,300 RRU.

- **Retention** per plan: S3 lifecycle rules on `events/plan=<plan>/` and `sessions/plan=<plan>/`, raw files
  after 3 days, and a TTL on DynamoDB items.
