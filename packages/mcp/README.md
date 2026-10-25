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
approve.

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
| `GLITCHLESS_URL` | Your Glitchless server. Default: the signed-in workspace's, else `http://localhost:7777` |
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
| `glitchless_create_game` | A new game in the workspace, with its client token and intake URL |
| `glitchless_share_board` | A read-only link to one board page, for a dev log, Discord or a game's "Live stats" link; `glitchless_list_share_links` and `glitchless_revoke_share_link` manage them |
| `glitchless_triage` | Ranked findings: stutter per level and what it correlates with, leaks, top errors, difficulty spikes. Start here |
| `glitchless_overview` | Headline numbers: sessions, players, crash-free sessions, frame time against the budget, rage quits |
| `glitchless_performance` | Frame time per level, with draw calls, geometry counts and game gauges |
| `glitchless_get_error` | One error issue, with its stack and the gameplay before it |
| `glitchless_player_funnel` | Per level: starts, completions, deaths and their causes, rage quits |
| `glitchless_death_hotspots` | Where players die on a level, clustered in world coordinates |
| `glitchless_events` | The game's own events (whatever it sends with `track`): counts, attribute breakdowns and funnels |
| `glitchless_dashboard` | The game's dashboard: its pages, and one board's panels with their numbers |
| `glitchless_set_dashboard` | Save the game's pages: boards of panels in its own words, and the built-in views it keeps. Needs a key with the dashboard scope |
| `glitchless_compare_versions` | Two or more versions side by side, in the game's own stats first, to confirm a fix with real players |
| `glitchless_session` | One play session in detail, with its whole event timeline |
| `glitchless_bug_reports` | Bug reports players sent from inside the game: their notes, levels, positions and sessions, and one report's screenshot when asked |
| `glitchless_store_reviews` | For a game connected to a store (Glitchless Cloud: Steam, Google Play, the App Store): what players wrote there, by store, build or version, sentiment, topic (stutter, lag, fps, freeze, crash), device and, on Steam, Steam Deck, each build with the frame-time p95 and crash-free sessions measured on it |
| `glitchless_store_vitals` | What Google Play (slow rendering, crash and ANR rates, the slowest devices and GPUs) or the App Store (hang rate, launch time, animation hitches, hang signatures) measured of each version, next to what Glitchless measured, and where the two disagree |
| `glitchless_revenue` | For a game connected to RevenueCat or to its own Stripe account (Glitchless Cloud; `source` picks one, else both): its real revenue by day and revenue per player measured. RevenueCat's (production purchases only): installs (new customers) and active users, MRR, active subscriptions and trials, and revenue by version where RevenueCat splits it. Stripe's: refunds, disputes, fees and net, new paying customers, revenue by product, and by version and platform for purchases the game tied to a session. All next to the sessions, players and new players Glitchless measured and what the game's own purchase events add up to |
| `glitchless_playtest` | Autoplay bots play the game and compare with a saved baseline ([glitchless-playtest](https://www.npmjs.com/package/glitchless-playtest); needs Playwright in the game project) |
| `glitchless_deck_send` | Build the game, send it to the paired Steam Deck, add it to the Deck's library and optionally start it ([glitchless-deck](https://www.npmjs.com/package/glitchless-deck); pair once with `npx glitchless-deck pair`) |
| `glitchless_deck_measure` | Measure a Unity, Godot or Unreal build on the Steam Deck and compare it with a saved run |

The reads take `hours`, `version`, `env` (e.g. `prod`) and `session_type` (`user` for players only, `tester` for people on TestFlight and other test builds, `synthetic` for bots, playtests and store test devices, `all`). Unless `env` or `session_type` is given, findings read the production sessions of players and say so; the other numbers count every session in the window.

To let the agent drive the running game as well (measure frame times, inspect the scene, load a
level), add the WebMCP server beside this one: `npx -y @jason.today/webmcp@latest --mcp`.

## License

MIT
