# Directory listings

The directories and listing sites that AI answers cite for the questions game developers ask (checked 29 October
2026), and what to paste into each. Every text comes from [COPY.md](COPY.md). The owner submits: each needs an
account, and a listing is public the moment it's approved.

The sources AI trusted, by question:

- **"Best game analytics for indie devs"**: list sites (Toolradar, WifiTalents, FitGap, PeerPush).
- **"GameAnalytics alternatives"**: AlternativeTo and StackShare.
- **Godot crash reporting and analytics**: the Godot Asset Library and the Godot forum, where Sentry and Bugnet are.
- **"MCP server for game analytics"**: GameAnalytics' own MCP server, then lobehub, mcp.so and Glama.

Order: mcp.so (minutes), AlternativeTo, Toolradar, then the Godot Asset Library (it needs a small repo first).

| Status | Where | Effort |
| --- | --- | --- |
|  | mcp.so | 2 fields |
|  | AlternativeTo | a form, then mark it as an alternative to 3 apps |
|  | Toolradar | a form, reviewed within 48 hours |
|  | Godot Asset Library | a small repo with the addon at its root, then a form; reviewed in a few days |
|  | LobeHub | check whether it already lists Glitchless from the MCP Registry |
|  | Bing Webmaster Tools | check it's verified for www.glitchless.gg: ChatGPT's search leans on Bing |

## mcp.so

Submit at https://mcp.so/submit. It asks for two fields and indexes in about a day.

- **Repository URL:** `https://github.com/glitchless-gg/glitchless`
- **Name:** `Glitchless`

## AlternativeTo

Sign up, then use **Suggest new application** under the user menu (top right). Their FAQ asks for extra words in the
name when it's shared with another app, and "Glitchless" is also a speedrun term.

- **Name:** `Glitchless (game observability)`
- **Website:** `https://www.glitchless.gg`
- **Short description:** Coding agents can build a game. They can't see anyone play it. Glitchless lets them: real
  players' stutters, crashes and drop-offs, over MCP.
- **Description:**

  > Coding agents can build a game. They can't see anyone play it. Glitchless lets them. Your agent adds it to a
  > Three.js, Phaser, Unity, Godot, Unreal or GameMaker game, sees what real players hit (stutters, crashes, where
  > they quit) and fixes the next build. Free plan, open source (MIT).
  >
  > Every frame is timed on every player's device, and each hitch comes with its likely cause. Crashes come grouped
  > with what the player did just before. Level funnels, death heatmaps and rage quits show where players give up.
  > Coding agents (Claude Code, Codex, Cursor) read all of it over MCP, and playtest bots check a fix before it ships.
  >
  > On Starlift, a Godot game on iPhone and Android, it showed that 1 in 4 players who skipped the tutorial quit
  > without playing. The agent made a skip start a game, and all 26 who skipped since then played.

- **License:** Open source, MIT. **Pricing:** Freemium.
- **Platforms:** Online, Self-Hosted.
- **Tags:** game-analytics, game-development, crash-reporting, performance-monitoring, mcp, ai-agents, godot, unity,
  unreal-engine, threejs
- **Alternative to (after approval, on each app's page):** GameAnalytics, PostHog, Sentry, and Bugnet if it's listed.
- **Icon:** `assets/brand/glitchless/logo/png/glitchless-icon-256.png`
- **Screenshots:** `docs/screenshots/overview.png`, `docs/screenshots/performance.png`, `docs/screenshots/heatmaps.png`

## Toolradar

Submit at https://toolradar.com/company/submit (free, reviewed within 48 hours). Claim it after with a work email
(support@glitchless.gg) to answer reviews.

- **Name:** `Glitchless`
- **Website:** `https://www.glitchless.gg`
- **Tagline:** Game observability for coding agents.
- **Description:** the AlternativeTo description above.
- **Category:** Game analytics (also Developer tools / Monitoring if it asks for a second).
- **Pricing:** Free plan (5,000 play sessions a month) · Indie $19 a month · Studio $99 a month · open source (MIT) to
  run yourself.
- **Best for:** Games built with coding agents (Claude Code, Codex, Cursor), in Three.js, Phaser, Babylon.js,
  PlayCanvas, Unity, Godot, Unreal or GameMaker.

## Godot Asset Library

The Asset Library links to a Git repository and installs the commit's zip into the project, so the addon has to sit
at `addons/glitchless/` from the repository's root. In this repo it's under `godot/`, which would install to
`res://godot/addons/glitchless` and break the autoload. So it needs a small public repo,
`glitchless-gg/glitchless-godot`, with `addons/glitchless/`, `LICENSE` (MIT, the Asset Library requires one by that
name), a short README and a `.gitattributes` that leaves the README out of the zip. It's copied from
`godot/addons/glitchless` at each Godot release, the way `scripts/export-skills.mjs` fills the skills repo. Making
that repo is the owner's call.

Then, signed in at https://godotengine.org/asset-library/asset/submit:

- **Asset name:** `Glitchless: game observability for coding agents`
- **Category:** Tools (Misc if it asks for an add-on category).
- **Godot version:** 4.5 (it works on 4.5 and later).
- **Version:** `0.6.0` (the addon's `plugin.cfg`).
- **Repository host and URL:** GitHub, `https://github.com/glitchless-gg/glitchless-godot`
- **Issues URL:** `https://github.com/glitchless-gg/glitchless/issues`
- **Download commit:** the mirror's commit for 0.6.0.
- **Icon URL:** `https://raw.githubusercontent.com/glitchless-gg/glitchless/main/assets/brand/glitchless/logo/png/glitchless-icon-256.png`
  (square, at least 128 px).
- **License:** MIT.
- **Description:**

  > Coding agents can build a game. They can't see anyone play it. Glitchless lets them.
  >
  > Glitchless times every frame on every player's device and names each hitch's likely cause (a shader compile, a
  > scene change, slow `_process` code), groups errors and crashes with what the player did just before, and shows where
  > players quit. Your coding agent (Claude Code, Codex, Cursor) reads it over MCP and fixes the next build. Runs as
  > an autoload, anonymous by default, with an offline outbox and `--glitchless-measure` for agents.
  >
  > Free on Glitchless Cloud (5,000 play sessions a month), or run the open-source server yourself. Setup:
  > https://www.glitchless.gg/godot.html

The newer Godot Asset Store (store.godotengine.org) has its own publisher sign-up; list there too once the library
entry is approved.

## LobeHub

Search https://lobehub.com/mcp for "Glitchless". It may already list servers from the official MCP Registry, where
Glitchless is `io.github.glitchless-gg/glitchless`. If it isn't there, its pages say to let the team know and they
add it; a listing page also offers a "Publish" prompt for an agent.

## Already listed: keep them in the same words

- **GitHub About:** set from COPY.md's medium text (done 29 October 2026).
- **npm and the MCP Registry:** the new descriptions in `packages/sdk`, `packages/mcp` and `packages/mcp/server.json`
  go out with the next publish of each.
- **Claude's connector directory, Glama, Context7 and skills.sh:** Glama and Context7 read the GitHub repo. Claude's
  directory text was written at submission; if it can be edited, use the medium text.

## Later

StackShare and PeerPush showed up for "GameAnalytics alternatives" and "best analytics tools for gamers". Add them
once the four above are live.
