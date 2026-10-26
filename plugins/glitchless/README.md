# Glitchless plugin for Codex, ChatGPT, Cursor and Antigravity

Glitchless is observability for games made with Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal and
GameMaker. This plugin connects your agent to Glitchless Cloud's MCP server, `https://api.glitchless.gg/mcp` (you sign
in through the browser and pick what the agent may do), and adds three skills:

| Skill | What it does |
| --- | --- |
| `instrument` | Adds Glitchless to a game in any of the eight engines: the SDK, levels, events, bots, privacy settings |
| `dashboard` | Works out what you want to know about your game, adds what's needed to measure it, and designs its dashboard |
| `triage` | Finds the problem that hits the most players, fixes it, and checks the fix with the next version |

Ask "what's wrong with my game this week?" once your game sends data. A workspace with no games can start on the
demo game, a week of sample play.

## Install

```bash
# Codex
codex plugin marketplace add glitchless-gg/glitchless
codex plugin add glitchless@glitchless
# Antigravity
git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless
agy plugin install ~/.glitchless/plugins/glitchless
```

In Cursor, add `"glitchless": { "url": "https://api.glitchless.gg/mcp" }` under `mcpServers` in `.cursor/mcp.json`.
In Claude Code, the [Claude Code plugin](../../plugin/glitchless) has the same skills plus a local server.

## What's here

| File | Read by |
| --- | --- |
| `plugin.json`, `mcp.json` | The [Agent Plugins](https://agent-plugins.org) manifest and server, read by Codex and ChatGPT (with the listing under `extensions["com.openai"]`) |
| `.cursor-plugin/plugin.json`, `.cursor-plugin/mcp.json` | Cursor |
| `mcp_config.json` | Antigravity |
| `skills/` | All of them. Copies of [`plugin/glitchless/skills`](../../plugin/glitchless/skills): edit those, then run `node scripts/sync-agent-plugin.mjs` (`npm test` fails while they differ) |

The marketplace files that point at this folder are at the repo root: `.agents/plugins/marketplace.json` (Codex) and
`.cursor-plugin/marketplace.json` (Cursor). [`docs/release/chatgpt-plugin`](../../docs/release/chatgpt-plugin)
builds the upload for OpenAI's plugin directory from this folder.

Privacy: [glitchless.gg/privacy](https://www.glitchless.gg/privacy.html). Support: support@glitchless.gg.
