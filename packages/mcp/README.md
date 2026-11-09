# glitchless-mcp

The [Glitchless](https://github.com/glitchless-gg/glitchless) MCP server. It lets any coding agent
(Claude Code, Codex, Cursor or another MCP client) read how your game runs for real players, from a
Glitchless server: ranked findings, frame-time breakdowns, errors, level funnels, death hotspots and
version comparisons. It can also run playtest bots before and after a change, to check a fix.

It's a stdio server. Run it with `npx`, no install needed:

```bash
npx -y glitchless-mcp
```

Apps that connect to a URL instead of starting a process (claude.ai, ChatGPT, Claude Code's HTTP servers) use
Glitchless Cloud's hosted copy at `https://api.glitchless.gg/mcp` and sign in with OAuth: see
[Glitchless by URL](../../docs/remote-mcp.md). It has the same tools, less the ones that act on your own computer.

## Sign in to a workspace (Glitchless Cloud)

```bash
npx -y glitchless-mcp login
```

It prints a link and a code; you approve the code in the Glitchless dashboard, and it saves a workspace key in
`~/.config/glitchless/credentials.json` (readable only by you). From then on the server reaches every game in that
workspace: `glitchless_list_games` lists them, `glitchless_create_game` makes one and returns its client token, and
every tool takes `game` (a name or id). The key acts as you, with your role in the workspace, and never deletes data
or touches billing or people. `npx -y glitchless-mcp whoami` shows where you're signed in, `logout` deletes the saved
key, and Settings → Keys & access in the dashboard lists and revokes keys. An agent can also sign in from inside a
chat with the `glitchless_sign_in` tool: it shows the link and code, and the running server switches over once you
approve. The saved key is only ever sent to the server it was saved for: point `GLITCHLESS_URL` at another one (a
meetup's own box) and the MCP server connects without it, so set `GLITCHLESS_API_KEY` if that server has a key.

## Serve it over HTTP yourself

```bash
npx -y glitchless-mcp serve [--port 3001] [--host 127.0.0.1]
```

The tools that work from a server (all but sign-in, playtests and the Steam Deck) at `http://127.0.0.1:3001/mcp`, over
Streamable HTTP, for clients of the 2026-07-28 protocol and older ones alike. It reads with the same settings as the
stdio server (below), for a self-hosted server or a signed-in workspace. It answers this computer only, and checks
`Host` and `Origin` so web pages can't reach it; to listen on another address, set `GLITCHLESS_MCP_TOKEN` and have
clients send it as `Authorization: Bearer`.

## Settings

| Variable | What |
| --- | --- |
| `GLITCHLESS_URL` | Your Glitchless server. Default: the signed-in workspace's, else `http://localhost:7777`. A saved sign-in goes only to the server it was saved for |
| `GLITCHLESS_API_KEY` | A key, if the server needs one: a workspace key (`gl_ws_…`) for every game, or a secret key (`gl_sk_…`) for one. Overrides a sign-in. Keep it out of git and out of the game |
| `GLITCHLESS_GAME` | With a workspace key, the game to use when a call doesn't name one. Optional |
| `GLITCHLESS_SERVICE` | The service to use when a call doesn't name one. Optional |

## Add it to your agent

Claude Code:

```bash
claude mcp add glitchless -e GLITCHLESS_URL=http://localhost:7777 -e GLITCHLESS_API_KEY=gl_sk_… -- npx -y glitchless-mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.glitchless]
command = "npx"
args = ["-y", "glitchless-mcp"]
env = { GLITCHLESS_URL = "http://localhost:7777", GLITCHLESS_API_KEY = "gl_sk_…" }
```

Cursor, in `.cursor/mcp.json` (add the file to `.gitignore` if it holds the key):

```json
{
  "mcpServers": {
    "glitchless": {
      "command": "npx",
      "args": ["-y", "glitchless-mcp"],
      "env": { "GLITCHLESS_URL": "http://localhost:7777", "GLITCHLESS_API_KEY": "gl_sk_…" }
    }
  }
}
```

Any other MCP client: the command is `npx`, the arguments are `-y glitchless-mcp`, and the settings
above go in its environment.

## Tools

| Tool | What it answers |
| --- | --- |
| `glitchless_list_games` | Which games report to the server, with their versions and environments; signed in to a workspace, every game in it with its client token |
| `glitchless_sign_in` | Connect to a Glitchless Cloud workspace: a link and a code for the person to approve |
| `glitchless_create_game` | A new game in the workspace, with its client token and intake URL (a name already there returns that game); with `engine`, or `files` (what's in the game's folder), also the steps that add Glitchless to the game's code for its engine, for a new game (`name`) or one already there (`game`): the instrument skill, for an agent without it; `demo: true` makes the demo game (a week of sample play); `rename` (with `game`) renames one instead, its client token, service and data unchanged |
| `glitchless_share_links` | A read-only link to one board page, for a dev log, Discord or a game's "Live stats" link (`page`); lists them, and revokes one (`revoke`) |
| `glitchless_triage` | The headline numbers (sessions, players, crash-free sessions, frame time, rage quits), then ranked findings: stutter per level and what it correlates with, leaks, top errors, difficulty spikes. Start here |
| `glitchless_mark_known` | Mark a finding the game's owner accepts as known, so the weekly summary stops listing it (triage shows it last, with the note); with `player` or `session` instead, the team's own play, read as testers in every tool; `clear: true` removes the mark |
| `glitchless_resolve_error` | Resolve an error issue the game's owner fixed or accepts: hidden from the Errors page, triage and the weekly summary until it fires again in a newer version (`any_version`: any); `clear: true` unresolves it |
| `glitchless_alerts` | A game's alerts: where they go, which rules are on, the weekly summary, the env, and the last sends; `glitchless_set_alerts` turns rules, the weekly summary and email on or off, sets the env, removes the webhook and sends a test (a webhook URL is added in Settings → Alerts) |
| `glitchless_performance` | Frame time per level, with draw calls, geometry counts and game gauges |
| `glitchless_get_error` | One error issue, with its stack and the gameplay before it |
| `glitchless_player_funnel` | Per level: starts, completions, deaths and their causes, disconnects, rage quits; split by what describes the attempt (tier, party size, class), runs per level, and retention; with `hotspots`, where players die on a level, in a zone or anywhere in the game (a hub with no levels), clustered in world coordinates |
| `glitchless_events` | The game's own events (whatever it sends with `track`, and the streams it counts with `count`): counts, attribute breakdowns, rates, distributions and funnels, and the session properties it sets |
| `glitchless_dashboard` | The game's dashboard: its pages, and one board's panels with their numbers; with `guide: true`, how to design one for the game (the dashboard skill, for an agent without it) |
| `glitchless_set_dashboard` | Save the game's pages: boards of panels in its own words, and the built-in views it keeps; and, each alone if you like, the boards' accent, logo and banner (the header behind each board's title) and a level's, zone's or the whole game's heatmap background (a picture from a file or base64 and its world bounds; over the hosted server a file is answered with a 10-minute, single-use upload link to send it to with one curl). Needs a key with the dashboard scope |
| `glitchless_compare_versions` | Two or more versions side by side, in the game's own stats first, to confirm a fix with real players |
| `glitchless_session` | One play session in detail, with its whole event timeline |
| `glitchless_bug_reports` | Bug reports players sent from inside the game: their notes, levels, positions and sessions, and one report's screenshot when asked |
| `glitchless_store` | For a game connected to a store (Glitchless Cloud: Steam, Google Play, the App Store, Roblox): what players wrote there, by store, build or version, sentiment, topic (stutter, lag, fps, freeze, crash), device and, on Steam, Steam Deck, each build with the frame-time p95 and crash-free sessions measured on it; with `show: "vitals"`, what Google Play (slow rendering, crash and ANR rates, the slowest devices and GPUs) or the App Store (hang rate, launch time, animation hitches, hang signatures) or Roblox (crash rate and frame rate by place version and platform, and its retention) measured of each version, next to what Glitchless measured, and where the two disagree |
| `glitchless_revenue` | For a game connected to RevenueCat, its own Stripe account or Roblox (Glitchless Cloud; `source` picks one, else each): its real revenue by day and revenue per player measured. RevenueCat's (production purchases only): installs (new customers) and active users, MRR, active subscriptions and trials, and revenue by version where RevenueCat splits it. Stripe's: refunds, disputes, fees and net, new paying customers, revenue by product, and by version and platform for purchases the game tied to a session. Roblox's: Robux earned (and what they'd be worth through DevEx), paying users, daily active and new users, and D1, D7 and D30 retention. All next to the sessions, players and new players Glitchless measured and what the game's own purchase events add up to |
| `glitchless_match` | A multiplayer game's matches (the worst by lag or disconnects on request), or one match from every side, 30 seconds at a time: each player's ping, frame time and outcome, the server's ticks, and whether the whole lobby lagged at once (the server) or one player did (their connection) |
| `glitchless_network` | Ping, lag (play over 150 ms), packet loss and disconnects by level, version, platform, kind of connection and region, with the worst matches and the network findings |
| `glitchless_servers` | A game's dedicated servers in server mode: servers running now and their players, tick time against its budget by players connected, map and version, crashes with the matches they ended, and memory that climbs. Every other tool reads them with service `<game>.server` |
| `glitchless_playtest` | The game's autoplay bot plays it and the run is compared with a saved baseline ([glitchless-playtest](https://www.npmjs.com/package/glitchless-playtest)): a Unity, Godot, Unreal or GameMaker build from its `command`, a Roblox game in the open Roblox Studio (`engine: "roblox"`, over Studio's MCP server), or a web game in Chrome (needs Playwright in the game project) |
| `glitchless_deck` | Build the game, send it to the paired Steam Deck, add it to the Deck's library and optionally start it ([glitchless-deck](https://www.npmjs.com/package/glitchless-deck); pair once with `npx glitchless-deck pair`); with `measure: true`, measure a Unity, Godot or Unreal build there and compare it with a saved run |

The reads take `hours`, `version`, `env` (e.g. `prod`), `session_type` (`user` for players only, `tester` for people on TestFlight and other test builds, `synthetic` for bots, playtests and store test devices, `all`) and `props`, the session properties the game sets (`{ rank: "diamond" }`, or a list of values). Unless `env` or `session_type` is given, findings read the production sessions of players and say so; the other numbers count every session in the window.

To let the agent drive the running game as well (measure frame times, inspect the scene, load a
level), add the WebMCP server beside this one: `npx -y @jason.today/webmcp@latest --mcp`.

## License

MIT
