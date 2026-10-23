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
Add Glitchless to this game. Glitchless shows how the game runs and plays for real players: stutters and what causes them, crashes and errors, the game's own moments (modes, rounds, levels, purchases), where players get stuck or quit, who comes back, and bug reports players send. Its MCP server lets you, the coding agent, read that data, fix what players hit and check that the fix worked.

1. Get the Glitchless agent kit, outside this project so it never gets committed:
   git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless
   If that folder already exists, run `git -C ~/.glitchless pull` instead.
   If the intake URL in step 2 starts with http://localhost, start a local Glitchless server and leave it running: in ~/.glitchless run `npm install && npm run build`, then `npm run server` in the background. It's ready when {{INTAKE_URL}}/v1/health answers, and the dashboard is at the same address.

2. Read ~/.glitchless/plugin/glitchless/skills/instrument/SKILL.md and follow it for this game. It covers Three.js (and React Three Fiber), Phaser 3 and 4, Babylon.js, PlayCanvas, Unity 2022.3 or later, Godot 4.5 or later, Unreal Engine 5.8, and GameMaker 2024.2 or later; for Godot it sends you to ~/.glitchless/godot/addons/glitchless/README.md.
   Use these settings:
   - intake URL: {{INTAKE_URL}}
   - client token: {{CLIENT_TOKEN}} (it's public and can only send data, so it's fine inside the game build)
   - privacy: keep the default anonymous mode. Ask me before turning on install mode (what retention, D1/D7/D30, needs) or full mode, because either needs a line in the game's privacy policy.
   If the game already reports its own analytics or counters, list them for me and send the same moments to Glitchless with track(), under the same names. Remove the old reporting only when I say so.
   If the game sells anything, send each purchase as track('purchase', { amount, currency, item }), so the dashboard can show revenue and conversion.
   Ask me whether players should be able to send bug reports from inside the game (a hotkey or a button, with a note and a screenshot). If yes, turn them on as the skill describes; the note is whatever the player types, so it needs a line in the privacy policy too.
   For a web game with a production build (Vite or another bundler), also add the source map upload the skill describes (glitchless-sourcemaps), so errors from the minified build show the real file and line. It uploads with a secret key that can upload source maps, read from GLITCHLESS_API_KEY at build time; ask me for one.

3. Add two MCP servers to your own MCP settings, in whatever way your tool adds them. For example, `claude mcp add` in Claude Code, ~/.codex/config.toml in Codex, or .cursor/mcp.json in Cursor.
   - glitchless: command `npx`, arguments `-y glitchless-mcp`, with the environment variables GLITCHLESS_URL={{INTAKE_URL}} and GLITCHLESS_API_KEY set to my secret key. Take the key from GLITCHLESS_API_KEY in my environment, or ask me for it. Never put the secret key in the game, in a file that gets committed, or in your reply.
   - webmcp, for a game that runs in a browser (Three.js, Phaser, Babylon.js, PlayCanvas): command `npx`, arguments `-y @jason.today/webmcp@latest --mcp`. It lets you drive the running game: measure frame times, inspect the scene and reproduce problems. Unity, Godot, Unreal and GameMaker builds don't need it: they measure themselves with --glitchless-measure (-glitchless-measure in Unreal and GameMaker).
   - For an Unreal game, Epic's Unreal MCP (UE 5.8, Experimental) can sit beside Glitchless: it is your hands in the editor (open maps, look inside Blueprints, edit actors, start Play In Editor), and Glitchless says what is wrong and whether a change fixed it. If the project uses it, or I ask for it, follow the "Agents in the editor: Unreal MCP" part of the instrument skill: it adds the Glitchless Toolset plugin, so Unreal MCP can also measure the game in Play In Editor. Unreal MCP listens on http://localhost:8000/mcp; the Glitchless server stays on its own address.
   If your tool needs a restart to load new MCP servers, tell me.

4. If your tool loads skills from a folder (for example ~/.claude/skills, ~/.codex/skills or the project's .agents/skills), copy ~/.glitchless/plugin/glitchless/skills/instrument, ~/.glitchless/plugin/glitchless/skills/dashboard and ~/.glitchless/plugin/glitchless/skills/triage there. If it doesn't, remember this for later: when I ask what's wrong with the game, read ~/.glitchless/plugin/glitchless/skills/triage/SKILL.md and follow it; when I ask for a dashboard or for metrics, read ~/.glitchless/plugin/glitchless/skills/dashboard/SKILL.md.

5. Check that it works. Run the game, play it or let it run for a minute, then confirm sessions arrive: call the glitchless_list_games tool, or ask me to look at {{DASHBOARD_URL}}.

6. Give the game its own dashboard: follow ~/.glitchless/plugin/glitchless/skills/dashboard/SKILL.md. Ask me what I want to know about my players (where they get stuck, which modes they play, whether they come back, what they buy), add the events that answer it, then save pages that fit this game with the glitchless_set_dashboard tool.

7. Tell me what you changed, file by file, the events you track, and anything you weren't sure about. If I use Glitchless Cloud, also tell me I can turn on alerts (Discord, Slack or email) in Settings → Alerts, and share a board with a read-only link.
<!-- prompt:end -->

## Notes for whoever maintains this

- Keep step 2's path in step with the repo. The instrument skill is the one entry point for every engine;
  if Godot gets a section there, drop the pointer to its README.
- Name only config locations you're sure of as examples in step 3; the agent knows its own.
- An agent without MCP support can still do steps 1, 2 and 6. Triage then needs the dashboard.
