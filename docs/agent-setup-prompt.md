# Set-up prompt for any coding agent

The prompt below is what a developer pastes into their coding agent (Claude Code, Codex, Cursor,
Antigravity, OpenClaw, Pi, Hermes or any other) to add Glitchless to a game. The Claude Code plugin does
the same in two commands; this prompt is for every other agent, and works in Claude Code too.

The hosted service's Get started page shows the text between the two
`prompt` markers, with `{{INTAKE_URL}}`, `{{CLIENT_TOKEN}}` and `{{DASHBOARD_URL}}` filled in for the
project. Self-hosters use their own server's address for both URLs and a token from
`GLITCHLESS_CLIENT_TOKENS`.

It never contains the secret key: the agent reads it from the environment or asks for it, so the key
doesn't end up in a chat log or a pasted snippet. The repo address is the planned public one.

<!-- prompt:start -->
Add Glitchless to this game. Glitchless records how the game runs for real players (frame times and stutters, errors, deaths, where they quit) and has an MCP server that lets you, the coding agent, read that data and fix what players hit.

1. Get the Glitchless agent kit, outside this project so it never gets committed:
   git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless
   If that folder already exists, run `git -C ~/.glitchless pull` instead.

2. Work out the engine, then read the guide for it and follow it for this game:
   - a web game (Three.js, React Three Fiber or plain WebGL): ~/.glitchless/plugin/glitchless/skills/instrument/SKILL.md
   - a Godot 4.5+ game: ~/.glitchless/godot/addons/glitchless/README.md
   Use these settings:
   - intake URL: {{INTAKE_URL}}
   - client token: {{CLIENT_TOKEN}} (it's public and can only send data, so it's fine inside the game build)
   - privacy: keep the default anonymous mode. Ask me before turning on full mode, because full mode needs a line in the game's privacy policy.

3. Add two MCP servers to your own MCP settings, in whatever way your tool adds them. For example, `claude mcp add` in Claude Code, ~/.codex/config.toml in Codex, or .cursor/mcp.json in Cursor.
   - glitchless: command `node`, argument ~/.glitchless/plugin/glitchless/mcp/glitchless-mcp.mjs (written out as a full path), with the environment variables GLITCHLESS_URL={{INTAKE_URL}} and GLITCHLESS_API_KEY set to my secret key. Take the key from GLITCHLESS_API_KEY in my environment, or ask me for it. Never put the secret key in the game, in a file that gets committed, or in your reply.
   - webmcp: command `npx`, arguments `-y @jason.today/webmcp@latest --mcp`. It lets you drive the running game: measure frame times, inspect the scene and reproduce problems.
   If your tool needs a restart to load new MCP servers, tell me.

4. If your tool loads skills from a folder (for example ~/.claude/skills, ~/.codex/skills or the project's .agents/skills), copy ~/.glitchless/plugin/glitchless/skills/instrument and ~/.glitchless/plugin/glitchless/skills/triage there. If it doesn't, remember this for later: when I ask what's wrong with the game, read ~/.glitchless/plugin/glitchless/skills/triage/SKILL.md and follow it.

5. Check that it works. Run the game, play it or let it run for a minute, then confirm sessions arrive: call the glitchless_list_games tool, or ask me to look at {{DASHBOARD_URL}}.

6. Tell me what you changed, file by file, and anything you weren't sure about.
<!-- prompt:end -->

## Notes for whoever maintains this

- Keep step 2's paths in step with the repo. If the instrument skill gains a Godot section, point both
  engines at the skill.
- Name only config locations you're sure of as examples in step 3; the agent knows its own.
- An agent without MCP support can still do steps 1, 2 and 6. Triage then needs the dashboard.
