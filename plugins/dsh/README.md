# Glitchless for DeepSeek Harness

**Let your agent understand your players.** Glitchless is game observability for coding agents. Your game sends how
each play session went (frame times and what caused each hitch, errors, levels, where players quit, your own events),
and your agent reads it: what's wrong this week, which error hits the most players, whether last night's build fixed
the stutter on level 2.

This plugin adds Glitchless to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):

- **25 tools** from the `glitchless-mcp` server, shown to the model as `mcp__glitchless__*`: ranked findings, frame
  times by level and device, errors, one session's timeline, your game's own events and funnels, bug reports players
  sent, store reviews and revenue, each game's dashboard, playtest bots, share links, and its alerts (which rules are
  on, the weekly summary, findings you accept as known, and errors you resolve).
- **3 skills**, also as slash commands:

| Skill | What it does |
| --- | --- |
| `glitchless-setup` | Adds Glitchless to a game in Unity, Godot, Unreal, Three.js, Phaser, Babylon.js, PlayCanvas or GameMaker: the SDK, levels, events, bots, privacy settings |
| `glitchless-dashboard` | Works out what you want to know about your game, adds what's needed to measure it, and designs its dashboard |
| `glitchless-triage` | Finds the problem that hits the most players, fixes it, and checks the fix with the next version |

## Install

Before you add it:

- Node.js 22 or newer has to be on the `PATH` that DSH runs with. DSH starts the Glitchless server with `npx`, and
  without Node the 25 tools never appear and nothing says why, so it looks like a broken plugin. `node --version` in
  the shell you start DSH from should print v22 or later.
- Glitchless Cloud is a third-party service, not part of DSH or DeepSeek. It has a
  [free plan](https://www.glitchless.gg), and you sign in by approving a code in your browser (see Sign in). You can
  also run your own server instead (see Self-hosted).

```bash
dsh plugin --profile web add glitchless-dsh
```

Restart DSH. Use `--profile tui` or `--profile headless` for those profiles.

## Sign in

Ask DSH to "sign in to Glitchless". It calls `glitchless_sign_in`, which shows a link and a code; approve the code in
the Glitchless dashboard and the agent reaches every game in your workspace. No key goes in a config file: the server
keeps a workspace key in `~/.config/glitchless/credentials.json`, readable only by you, and `npx -y glitchless-mcp
logout` deletes it. A new workspace has a demo game, so you can try it before your game sends anything.

## Use it

Open DSH in your game's folder and say:

- "Set up Glitchless for my game" (the `glitchless-setup` skill)
- "What's wrong with my game this week?"
- "Build my game a dashboard: I want to know where players quit and which mode they play"

Tested with DSH 0.2.1-rc.5 and DeepSeek V4.1 Flash on macOS.

## Permissions

The tools read your games' data and can create a game, save a game's dashboard and make or revoke read-only share
links. They act as you, with your role in the workspace, and never delete data or touch billing or people. Settings →
Keys & access in the dashboard lists and revokes the key. `glitchless_playtest` runs bots against a build on your
computer, and the setup skill edits your game's code when you ask it to.

## Self-hosted

Glitchless is open source, and its server runs on your own machine:
`docker run -p 7777:7777 -v glitchless-data:/data ghcr.io/glitchless-gg/glitchless`. DSH doesn't pass keys from its
own environment to MCP servers, so give the server's address and key to the `glitchless-mcp` row. Add this to the end
of your profile's patch file, `~/.dsh/profiles/web/cordis.patch.yml` (it replaces the row's whole config, so keep the
other lines):

```yaml
- id: glitchless-mcp
  config:
    serverName: glitchless
    transport: stdio
    command: npx
    args: ['-y', 'glitchless-mcp']
    cwd: !!js process.cwd()
    toolCallTimeoutMs: 600000
    failOnStartupError: false
    env:
      GLITCHLESS_URL: http://localhost:7777
      GLITCHLESS_API_KEY: gl_sk_…
```

## Links

- [glitchless.gg](https://www.glitchless.gg) · [Docs and source](https://github.com/glitchless-gg/glitchless) ·
  [Privacy](https://www.glitchless.gg/privacy.html) · support@glitchless.gg
- The same skills for Claude Code, Codex, Cursor and Antigravity are in the
  [Glitchless repo](https://github.com/glitchless-gg/glitchless).

MIT licensed.
