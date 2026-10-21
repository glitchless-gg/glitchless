<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/glitchless/logo/png/glitchless-lockup-dark.png">
    <img src="assets/brand/glitchless/logo/png/glitchless-lockup-light.png" width="300" alt="Glitchless">
  </picture>
</p>

# Glitchless

Glitchless shows you how your game plays for real players, and gives your coding agent the same data so it can fix what they hit. It works with Three.js games in the browser and Godot 4.5+ games on phones and desktops.

- **Stutter.** Every frame is timed on every player's device, and each hitch comes with its likely cause: a long script, a shader compile, garbage collection or an asset load.
- **Crashes.** Errors are grouped into issues, each with the gameplay just before it.
- **Where players give up.** Level funnels, death heatmaps and rage-quit detection.
- **Your coding agent.** An MCP server for production data, WebMCP tools exposed by the running game, and autoplay bots that check a fix before it ships.

It's open source and runs anywhere: one Node server with a file store on a laptop, or Lambda and DynamoDB in your own AWS account. It's anonymous by default ([what it sends](packages/sdk/PRIVACY.md)), and it can pass the same data on to Datadog or any OpenTelemetry backend.

<p align="center">
  <img src="assets/brand/glitchless/diagram/glitchless-architecture.png" width="900" alt="Your game, with the Glitchless SDK, sends play sessions to Glitchless (dashboard and findings), which can export to Datadog or OpenTelemetry. Your coding agent reads player data from Glitchless over MCP and drives the running game over WebMCP.">
</p>

![The Glitchless dashboard: frame time by release, and findings ranked worst first](docs/screenshots/overview.png)

*The dashboard on simulated history from [`scripts/seed.js`](scripts/seed.js). Also: [performance](docs/screenshots/performance.png) and [death heatmaps](docs/screenshots/heatmaps.png).*

## What's in the box

| Path | What |
| --- | --- |
| [`packages/sdk`](packages/sdk) | `glitchless`: SDK, Three.js adapter, overlay, WebMCP tools, Datadog RUM bridge. ~80 KB as one `<script>` |
| [`godot`](godot) | Glitchless for **Godot 4.5+** (`addons/glitchless`): the same events from native Godot games, with errors through Godot's loggers, an anonymous mode and `--glitchless-measure` for agents. A demo game and end-to-end test sit alongside |
| [`server`](server) | Intake, query API and findings. Runs locally (`npm run server`) or on **AWS Lambda Web Functions** + DynamoDB ([`server/web/deploy.js`](server/web/deploy.js)) |
| [`apps/dashboard`](apps/dashboard) | The dashboard: Overview, Performance, Error Tracking, Player Analytics, Heatmaps, Sessions & Replay, Versions, Live Tail, Agents |
| [`apps/zoomies`](apps/zoomies) | **Zoomies!**, a vibe-coded Three.js platformer that ships with four realistic bugs for the demo |
| [`packages/mcp`](packages/mcp) | Glitchless MCP server: `glitchless_triage`, `glitchless_performance`, `glitchless_get_error`, `glitchless_death_hotspots`, `glitchless_compare_versions`, … |
| [`packages/playtest`](packages/playtest) | `glitchless-playtest`: autoplay bots play every change and Glitchless compares it with a saved baseline. Also the `glitchless_playtest` MCP tool |
| [`plugin/glitchless`](plugin/glitchless) | Claude Code plugin: `/glitchless:instrument` and `/glitchless:triage` skills + both MCP servers |
| [`datadog`](datadog) | Datadog dashboard + monitors JSON and a setup script |
| [`scripts/seed.js`](scripts/seed.js) | Simulated player history generated from the game's real level data (tagged `simulated`) |
| [`docs`](docs) | [Technical spec](docs/SPEC.md), [set-up prompt for any coding agent](docs/agent-setup-prompt.md) |

## Quickstart (local, no cloud)

```bash
npm install
npm run build -w glitchless -w glitchless-dashboard
node scripts/seed.js --reset      # a day of simulated history (optional)
npm run server                    # http://localhost:7777  → dashboard
npm run game                      # http://localhost:5173  → Zoomies (press ` for the overlay)
```

Datadog forwarding switches on automatically when `DD_API_KEY` (or `DATADOG_KEY`) is in `.env`, and OpenTelemetry export when `OTEL_EXPORTER_OTLP_ENDPOINT` is (see [Exporters](#exporters-datadog-or-any-opentelemetry-backend)).

### Add it to your game

```bash
npm install glitchless
```

```js
import * as THREE from 'three';
import { Glitchless, instrumentThree } from 'glitchless';

const glitchless = Glitchless.init({ service: 'my-game', version: '1.0.0', intake: 'http://localhost:7777' });
instrumentThree(glitchless, { renderer, scene, camera, THREE });

glitchless.levelStart('level-1');
glitchless.death({ ...player.position, cause: 'fell' });
glitchless.setContext({ particles, enemies });   // correlated with hitches
glitchless.captureMap('level-1', { axis: 'xy', bounds: { min: [0, -6], max: [180, 12] } });
```

Or ask your agent: `/glitchless:instrument`.

For a Godot game, copy [`godot/addons/glitchless`](godot/addons/glitchless) into it, add the `Glitchless` autoload and call `Glitchless.init("my-game", "", "prod", "http://localhost:7777")`. See its [README](godot/addons/glitchless/README.md).

## Connect your coding agent

```bash
# production telemetry + ranked findings
claude mcp add glitchless -e GLITCHLESS_URL=http://localhost:7777 -- npx -y glitchless-mcp
# the live game as a tool server (WebMCP); ask Claude for a token, paste it into the WebMCP widget
claude mcp add webmcp -- npx -y @jason.today/webmcp@latest --mcp
# or both at once, plus the skills
/plugin marketplace add glitchless-gg/glitchless
/plugin install glitchless@glitchless
```

## Playtest every change

Vibe-coded games rarely have tests. Their autoplay bots can stand in: `glitchless-playtest` plays fixed-seed runs in real Chrome on the current code, asks Glitchless for the numbers from exactly those sessions, and compares them with a saved baseline. Add it to your game's project with `npm install -D glitchless-playtest playwright`, then:

```bash
npx glitchless-playtest --save baseline   # before the change
npx glitchless-playtest                   # after it: PASS, or FAIL with what got worse (exit code 1)
npx glitchless-playtest --compare-only baseline latest
```

A metric only counts as worse when it moves past both a relative and an absolute margin (slow frames: +50% and +2 percentage points), so noise on a fast machine doesn't fail a build. The share of slow frames, render CPU and draw calls are checked overall and per level; any new error type or crashed run fails too. Frame time p95, hitches, deaths, completion and geometry growth produce warnings. p95 is only a warning because with vsync, frame times cluster at 16.7 and 33.3 ms, so p95 jumps between them when about 5% of frames are slow. A quick run is compared with the matching runs of a full baseline. Scenarios, thresholds and URLs can be overridden in `glitchless.playtest.json`. Runs are saved in `.glitchless/playtest/`.

For your own game, give the playtest URL parameters that start your autoplay bot and an expression that is true when a run is over:

```json
{
  "game": "http://localhost:5173/",
  "scenarios": [
    { "name": "speedrun", "params": { "bot": 1, "seed": 3 }, "max_s": 120 },
    { "name": "careful player", "params": { "bot": 1, "seed": 9, "skill": 0.5 }, "max_s": 120 }
  ],
  "done_when": "window.myGame?.over === true",
  "thresholds": { "draw_calls": { "label": "Draw calls per frame", "higher": true, "pct": 40, "abs": 100, "severity": "warn" } }
}
```

The bots run one at a time, because parallel browsers compete for the GPU and wreck frame times. Compare runs from the same machine. Coding agents get the same check as the `glitchless_playtest` MCP tool, and the triage skill uses it before reporting a fix as done. For CI, [`docs/playtest-github-action.yml`](docs/playtest-github-action.yml) plays the main branch and the pull request on one runner and posts the report on the PR.

## Exporters: Datadog or any OpenTelemetry backend

The server can send every game's telemetry on to other backends. Switch on either, both or neither in `.env`. With neither, nothing leaves the server. `/v1/health` and the dashboard's **Agents & MCP** page show each exporter's status: what it has sent, failures and the last error. Credentials never appear there.

| Exporter | Switch it on | What arrives |
| --- | --- | --- |
| Datadog | `DD_API_KEY` (or `DATADOG_KEY`), `DD_SITE`. `GLITCHLESS_DATADOG=off` turns it off | `glitchless.frame.time` as a distribution metric; gauges and counts tagged `service`, `env`, `version`, `level`, `gpu_tier`, `browser`; logs with `error.*` for Error Tracking; an event for each new version |
| OpenTelemetry (OTLP/HTTP, JSON) | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`. `GLITCHLESS_OTLP=off` turns it off | `glitchless.frame.time` as an exponential histogram; counters `glitchless.frame.count`, `glitchless.frame.slow`, `glitchless.frame.hitches`, `glitchless.sessions`, `glitchless.level.starts`/`completes`/`fails`, `glitchless.deaths`, `glitchless.errors`; log records for gameplay events and errors |

How Glitchless maps onto OpenTelemetry:

- **Resource:** the game build: `service.name`, `service.version` and `deployment.environment.name`, plus a `service.instance.id` for the Glitchless server process.
- **Metric attributes:** `game.level`, `game.gpu_tier`, `user_agent.name` (the browser, or `godot`) and `game.session_type`. Deaths add `game.cause` and errors add `error.type`. Sessions aren't metric attributes, because one stream per session would swamp any backend.
- **Log records:** `session.id` and `user.id`, then the event's own fields under `game.*`, with event names like `glitchless.death`. Errors are `ERROR` records with `exception.type`, `exception.message` and `exception.stacktrace`.

The standard variables work as they do in any OpenTelemetry SDK:

- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` set one signal's endpoint, and only signals with an endpoint are sent.
- `OTEL_METRICS_EXPORTER=none` and `OTEL_LOGS_EXPORTER=none` turn one signal off.
- `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is `cumulative` (the default) or `delta`.
- `OTEL_METRIC_EXPORT_INTERVAL` holds metrics for that many ms. Without it, metrics go out after every intake request, which is the safe choice on Lambda.
- `OTEL_RESOURCE_ATTRIBUTES` adds resource attributes.

Glitchless only speaks OTLP/HTTP with JSON bodies, so it needs no OpenTelemetry packages. Not every vendor accepts JSON, so the dependable setup is an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) (or Grafana Alloy) next to the server, re-exporting in whatever your backend prefers:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318          # the Collector's OTLP/HTTP receiver
```

Sending straight to a vendor works where its OTLP endpoint takes JSON. Grafana Cloud does, though it recommends JSON only for light traffic. For anyone else, check their docs or try it: a rejected request shows up as a failure on the Agents page.

Datadog's OTLP metrics intake takes JSON, with delta temporality only. Its OTLP logs intake documents protobuf only. The native exporter (`DD_API_KEY`) is still the fuller path into Datadog. Don't point both at the same org, or every `glitchless.*` metric arrives twice. To try metrics over OTLP instead:

```bash
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp.datadoghq.com/v1/metrics   # use your Datadog site's endpoint
OTEL_EXPORTER_OTLP_HEADERS=dd-api-key=YOUR_API_KEY
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
```

`npm run test:otlp` checks the exporter end to end against a real Collector (`otel/opentelemetry-collector` in Docker, with the debug exporter), or against a small local OTLP receiver when Docker isn't running. The exporters live in [`server/src/exporters`](server/src/exporters). Each takes plain JSON settings, so a hosted server could build them per project from stored settings.

## Deploy to AWS (Lambda Web Functions + DynamoDB)

```bash
node server/web/deploy.js      # builds, creates table/role/bucket/function, prints the URL + read key
node server/web/teardown.js    # deletes all of it
```

The same `server/src/app.js` runs in both places. Web Functions run a normal Node HTTP server on `AWS_LAMBDA_HTTP_ENDPOINT`. The endpoint is public (`ApplicationManaged`) and capped at 100 req/s. DynamoDB is on-demand with a 30-day TTL.

## How the numbers are computed

- **Frame time.** The SDK infers the display refresh rate (60/120/144 Hz) to set the frame budget. Every 5 s it ships a **DDSketch-style mergeable histogram** (2% relative error). The server merges sketches across players, so global p95s are exact rather than averages of averages. Datadog receives the same data as a **distribution metric**, and OpenTelemetry backends as an **exponential histogram**.
- **Hitches.** A hitch is a frame over 50 ms *and* more than 2× the recent median, so a stutter counts but a slow device doesn't. Each hitch is attributed to a long script (Long Animation Frames API: function plus file), a shader compile (program count changed), GC (heap dropped) or an asset load in flight. It's also tagged with the game-context gauges and the gameplay events in the preceding 1.5 s, ranked by **lift over base rate**.
- **Crash-free (game-aware).** A crash is WebGL context loss with no restore, a frozen frame (>700 ms), or an unhandled error followed by the player leaving within 10 s. *Error-free* sessions are reported separately.
- **Rage quit.** The session ends within 20 s of a death or fail without the player continuing.

See [docs/SPEC.md](docs/SPEC.md) for the wire format.
