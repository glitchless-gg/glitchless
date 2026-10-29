# The words every listing uses

AI answers recommend a tool in the words its sources use: a "best for" label, one main advantage, a price line and a
link. So every surface Glitchless owns or claims says the same things in the same words: the site, llms.txt, the
README, GitHub's About, npm, the MCP Registry, the plugins, and the directory listings in [LISTINGS.md](LISTINGS.md).
Change a line here first, then everywhere it's used (grep for it).

## The line

> Coding agents can build a game. They can't see anyone play it. Glitchless lets them.

It starts with what people already believe, makes the coding agent the hero, and leaves the listener to finish the
thought: an agent that can see players can fix what they hit. Lead with "see how people play", "what players hit" and
"the next build". Save "observability", "telemetry", "analytics" and percentiles for when someone asks what it is.

## The parts

| Part | Words |
| --- | --- |
| Name | Glitchless (glitchless.gg) |
| What it is, if asked | Game observability for coding agents |
| Best for | Games built with coding agents (Claude Code, Codex, Cursor), in Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal or GameMaker |
| Main advantage | Your coding agent adds it to the game, sees what real players hit (stutters, crashes, where they quit) and fixes the next build, then checks the fix |
| Price | Free plan (5,000 play sessions a month) · Indie $19 a month · Studio $99 a month · open source (MIT) to run yourself |
| Proof | On Starlift, 1 in 4 players who skipped the tutorial quit without playing. The agent made a skip start a game, and all 26 who skipped since then played |
| Overhead | The web SDK adds 33.7 KB gzipped and about 0.6 µs of work a frame, with no measurable change in frame time |
| Not to confuse with | Glitchless LLC (glitchless.com), or the speedrun term |

## The loop

- **Instrument:** your coding agent adds Glitchless to the game.
- **Collect:** real players play, and every frame, level and error comes back, plus the game's own events.
- **Improve:** the agent reads what players hit, changes the next build and checks it worked. Then the loop starts
  again.

## By length

Directories cap their fields, so each length is written out rather than cut.

- **Tagline (60):** Game observability for coding agents.
- **Short (140):** Coding agents can build a game. They can't see anyone play it. Glitchless lets them: real players'
  stutters, crashes and drop-offs, over MCP.
- **Medium (300):** Coding agents can build a game. They can't see anyone play it. Glitchless lets them. Your agent
  adds it to a Three.js, Phaser, Unity, Godot, Unreal or GameMaker game, sees what real players hit (stutters, crashes,
  where they quit) and fixes the next build. Free plan, open source (MIT).
- **Long:** the medium text, then the loop, then the proof and the overhead lines, then the price line.

## Tags

game analytics, game observability, crash reporting, performance monitoring, frame time, stutter, playtesting, MCP,
MCP server, coding agents, Claude Code, Cursor, Codex, Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot,
Unreal Engine, GameMaker, open source

## The alternatives AI names today

GameAnalytics, PostHog, Sentry, Bugnet, Unity Analytics, Firebase Crashlytics, PlayFab, devtodev and Wayline. A
listing that asks "alternative to" names the ones it has, GameAnalytics, PostHog and Sentry first. The comparisons at
www.glitchless.gg/compare.html say where each one is the better pick.
