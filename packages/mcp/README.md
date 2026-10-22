# glitchless-mcp

The [Glitchless](https://github.com/glitchless-gg/glitchless) MCP server. It lets any coding agent
(Claude Code, Codex, Cursor or another MCP client) read how your game runs for real players, from a
Glitchless server: ranked findings, frame-time breakdowns, errors, level funnels, death hotspots and
version comparisons. It can also run playtest bots before and after a change, to check a fix.

It's a stdio server. Run it with `npx`, no install needed:

```bash
npx -y glitchless-mcp
```

## Settings

| Variable | What |
| --- | --- |
| `GLITCHLESS_URL` | Your Glitchless server. Default `http://localhost:7777` |
| `GLITCHLESS_API_KEY` | A secret read key (`gl_sk_…`), if the server needs one. Keep it out of git and out of the game |
| `GLITCHLESS_SERVICE` | The game to use when a tool call doesn't name one. Optional |

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
| `glitchless_list_games` | Which games report to the server, with their versions and environments |
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
| `glitchless_playtest` | Autoplay bots play the game and compare with a saved baseline ([glitchless-playtest](https://www.npmjs.com/package/glitchless-playtest); needs Playwright in the game project) |

To let the agent drive the running game as well (measure frame times, inspect the scene, load a
level), add the WebMCP server beside this one: `npx -y @jason.today/webmcp@latest --mcp`.

## License

MIT
