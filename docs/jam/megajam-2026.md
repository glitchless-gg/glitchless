# Glitchless for the Epic AI MegaJam 2026

Glitchless records how your Unreal game runs: stutters and what caused them, errors, ensures and crashes,
and bug reports with screenshots from your teammates and playtesters. Its MCP server lets your coding
agent read all of it and fix what people hit. Jam teams get a free jam tier on Glitchless Cloud.

This guide gets a team from nothing to telemetry before the jam starts, for Unreal Engine 5.8 with
Claude Code or another coding agent, with or without Epic's Unreal MCP.

- Jam announcement: https://www.unrealengine.com/news/2026-epic-ai-megajam
- Jam page, rules summary and submission: https://itch.io/jam/2026-epic-ai-megajam
- Official Rules: https://epicgames.box.com/s/a7xcgl07fqoieeb99sjtd3juhj4agc4z

| When | What |
| --- | --- |
| Nov 11, 11 AM PST / 2 PM EST | Kickoff livestream and theme reveal |
| Nov 12, 12:00 AM EST | The jam starts. Don't build your game before this |
| Nov 15, 5:59 PM PST / 8:59 PM EST | Submissions close. Late ones are disqualified |
| By Jan 29, 2027 | Winners announced |
| Jan 31, 2027, 23:59 UTC | The `MEGAJAM26` jam tier ends |

## The jam tier: `MEGAJAM26`

| | Free | With `MEGAJAM26` |
| --- | --- | --- |
| Play sessions a month | 5,000 | 50,000 |
| People in the workspace | 1 | 5 (the jam's team limit) |
| Data kept | 14 days | 90 days |
| Games, bot sessions, exporters | 1 game, 5,000 bot sessions, no exporters | the same |

It's free and needs no card. It runs until **January 31, 2027, 23:59 UTC**. Then the workspace goes back to
Free on its own: nothing is deleted, teammates stay but no one new can join, intake stops at 5,000 sessions
a month, and data older than 14 days ages out as usual.

On a paid plan (Indie or Studio) the code is kept but changes nothing: your plan's sessions, retention and
bill stay as they are. It applies if the workspace goes back to Free before the code ends. Each workspace
holds one promo at a time, and only its Owner can apply one.

## Before Nov 11: set up (about 20 minutes)

The rules let you set up tools, agents and MCP before the jam, but not start your game. So rehearse in a
throwaway Unreal project, and on Nov 12 copy two things into your jam project.

1. **Sign up with the code:** https://app.glitchless.gg/?promo=megajam26 (Google or GitHub). Already have
   an account? Settings → Plan & billing → Promo code → `MEGAJAM26`. Plan & billing then shows the jam
   allowance and its end date.
2. **Create your game** and name it after your jam game (you can rename it later). Get started shows its
   **ingest key** (`gl_pub_…`, goes in the game) and makes a **secret key** (`gl_sk_…`, for your agent;
   shown once, keep it out of git).
3. **Invite your team:** Settings → Members, up to four more people. Developers can make their own secret
   keys.
4. **Install the plugin** in the throwaway project (next section), play for a minute, and check the
   session shows on the Overview.
5. **Add the MCP server** to each teammate's agent (below).

## Install the Unreal plugin

1. Download `glitchless-unreal-0.3.0.zip` from the [glitchless-unreal 0.3.0 release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-unreal/v0.3.0) and unzip
   it so the folder is `<YourProject>/Plugins/Glitchless`.
2. **Edit → Plugins**, find Glitchless under Analytics, enable it, restart the editor.
3. The plugin is C++ source. A Blueprint-only project has to become a C++ project once: **Tools → New C++
   Class**, any class. You need Visual Studio 2022 with C++ on Windows, or Xcode on a Mac.
4. **Project Settings → Plugins → Glitchless:**
   - **Service:** your game's id, lowercase, for example `my-jam-game`
   - **Intake:** `https://api.glitchless.gg`
   - **Client Token:** your ingest key
   - **Send In Development Builds:** on. It is on by default; leave it on. Jam submissions are packaged
     Development builds, so with it off nothing would arrive from your build or from anyone who plays it.
   - **Bug Report Key** (under Advanced): `F8`

Those settings are saved in `Config/DefaultGame.ini`, so they travel with the project. The ingest key can
only send data, so it's fine to commit and ship:

```ini
[/Script/Glitchless.GlitchlessSettings]
Service=my-jam-game
Intake=https://api.glitchless.gg
ClientToken=gl_pub_...
Privacy=Anonymous
bSendInDevelopmentBuilds=True
```

Play In Editor and Development builds report as env `dev`. Anonymous mode, the default, keeps no player ID
and sends coarse device facts only. Mac and iOS Development builds can reach `https://api.glitchless.gg` as
they are.

Maps are levels on their own, and errors, ensures, Blueprint errors and crashes are caught with no code.
For deaths, level funnels and your own counters, ask your agent to add the calls from the plugin's README
(`Plugins/Glitchless/README.md`), or paste this:

```text
Glitchless is in Plugins/Glitchless and set up in Config/DefaultGame.ini. Read Plugins/Glitchless/README.md.
Call FGlitchless::LevelStart when a level starts and FGlitchless::Death where the player dies, and use
FGlitchless::Track for the few moments that matter in this game (ask me which). Leave the privacy setting
as it is. Then play in the editor for a minute and check the session arrived with glitchless_list_games.
```

## Add the MCP server to your agent

**Claude Code**, from your project folder:

```bash
claude mcp add glitchless -e GLITCHLESS_URL=https://api.glitchless.gg -e GLITCHLESS_API_KEY=gl_sk_... -- npx -y glitchless-mcp
```

That saves it for you on this machine, not in the project's `.mcp.json`, so the secret key stays out of
git. Or install the Claude Code plugin, which adds the MCP server and the instrument, dashboard and triage
skills:

```text
/plugin marketplace add glitchless-gg/glitchless
/plugin install glitchless@glitchless
```

and start Claude Code from a terminal where you've run:

```bash
export GLITCHLESS_URL=https://api.glitchless.gg
export GLITCHLESS_API_KEY=gl_sk_...
```

**Codex, Cursor and other agents:** Get started → "Any coding agent" has a prompt to paste. It adds the
same server (command `npx`, arguments `-y glitchless-mcp`, the two variables above) in your agent's own MCP
settings.

**Next to Epic's Unreal MCP.** They do different jobs, and one agent can use both:

- Unreal MCP runs inside the editor and drives it: actors, materials, automation tests. Turn on the Unreal
  MCP and All Toolsets plugins, start the server (Editor Preferences → Model Context Protocol → Auto Start
  Server, or `ModelContextProtocol.StartServer`), then run `ModelContextProtocol.GenerateClientConfig
  ClaudeCode` in the editor console. That writes `.mcp.json` in the project root, pointing at
  `http://127.0.0.1:8000/mcp`. Start your agent from the project root. Epic's guide:
  https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor
- Glitchless reads what happened when the game ran, on anyone's machine: hitches and their causes, errors,
  crashes, bug reports. Its secret key belongs in your own MCP settings, not in that `.mcp.json`.
- Optional: the **Glitchless Toolset** plugin (`glitchless-unreal-toolset-0.3.0.zip` from the same [release](https://github.com/glitchless-gg/glitchless/releases/tag/glitchless-unreal/v0.3.0), unzipped to `<YourProject>/Plugins/GlitchlessToolset`)
  adds two tools to Unreal MCP while you Play In Editor: `Status` (what Glitchless sees right now) and
  `Measure` (frame stats over the next few seconds). Enable it next to Unreal MCP and All Toolsets.

## Declare it in your submission

The rules ask you to declare anything made before November 12, including "prompts, scripts, or assets",
and to list assets you didn't make in your submission. They don't set a format, so add this to your
submission's description (or wherever you list your tools and assets), and edit it to match what you did:

```text
Set up before the jam: Glitchless (glitchless.gg), a third-party observability plugin for Unreal
(MIT licence, github.com/glitchless-gg/glitchless). It records frame times, errors, crashes and bug
reports from our builds, and its MCP server (glitchless-mcp) lets our coding agent read them. Before
November 12 we only installed it, set it up and connected it to our agent; all game code, prompts and
assets were made during the jam.
```

## Bug reports from teammates and playtesters (F8)

- With **Bug Report Key** set to `F8`, pressing F8 in the game opens a small box over it. The game pauses
  behind it, and the report sends a screenshot, the note, the level and the last few events. You can also
  open it from your own menu with the **Show Bug Report Dialog** Blueprint node.
- Read reports in the dashboard's Reports page, or ask your agent: "List the new bug reports for
  my-jam-game and fix the worst one" (it uses `glitchless_bug_reports`).
- Put "Press F8 to report a bug" on your itch page and in the game. The note is whatever the player types,
  so don't ask for names or emails in it.

## A share link for the Glass Box dev log

Glass Box is the prize for the best dev log showing how you built your game. The dev log link is optional,
but you need one to be considered for Glass Box.

- Open a board (the Overview, or a board your agent made for your game), press **Share**, give the link a
  name and an expiry ("Never" or "In 90 days" lasts through judging).
- Under **Shows**, choose **Fixed dates**, from Nov 12 to Nov 16, then copy the link. It shows jam week
  whenever it's opened, so judges reading your dev log in January see the week you built the game, not the
  last 30 days. (Dates are whole UTC days; Nov 12 to 16 covers the start at midnight EST and the close.)
- Anyone with the link sees that one board, read only and signed out. Session and player IDs, devices,
  stack traces and live events are left out. Revoke it from the same Share box.
- The jam tier keeps your data 90 days, so jam week stays on the link through judging. After the jam tier
  ends on Jan 31 a Free workspace keeps 14 days, and the link has nothing left to show for November.
- Good dev log material: a hitch your agent found and the `-glitchless-measure` numbers before and after
  its fix, the bug reports your teammates sent and the changes that fixed them, the crash-free rate on day 1
  against day 4.

## Quick perf checks: `-glitchless-measure` and bots

Any build measures itself and quits:

```bash
# Windows (a packaged game has no console, so read the file)
MyGame.exe -glitchless-warmup=2 -glitchless-measure=10 -glitchless-out=C:\Temp\measure.json

# Mac: run the binary inside the .app and read the one JSON line it prints
./MyGame.app/Contents/MacOS/MyGame -glitchless-warmup=2 -glitchless-measure=10
```

It waits for the first map plus the warmup, measures for 10 seconds and reports frame time percentiles,
fps, game, render, RHI and GPU time, hitches with their causes, memory and new errors. Ask your agent to
run it before and after a change and compare. In the editor, the Glitchless Toolset's `Measure` does the
same through Unreal MCP.

Measure runs count as bot sessions: they stay out of your player numbers and don't use your 50,000 (bots
get 5,000 a month). Glitchless's playtest bots play browser games; for an Unreal game the bot is your own.
If your game has an autoplay mode (an AI pawn that plays a level), have it start on `-autoplay`, a flag
Glitchless already treats as a bot's, so a measure run plays the same way before and after a change.

## Your first hour of the jam

- [ ] Make the jam project in UE 5.8 (a C++ project, or add one C++ class).
- [ ] Copy `Plugins/Glitchless` from your rehearsal project, and the `[/Script/Glitchless.GlitchlessSettings]`
      block into `Config/DefaultGame.ini`. Check Service, Intake, Client Token, Send In Development Builds
      and Bug Report Key in Project Settings.
- [ ] Turn on Unreal MCP if you use it, generate `.mcp.json`, and start your agent from the project root.
      Ask it to call `glitchless_list_games`.
- [ ] Play In Editor for a minute. The session shows on the Overview.
- [ ] Package a Development build for the platform you'll submit, run it once, press F8 and send a test
      report. It shows in Reports.
- [ ] Check every teammate is in the workspace and has Glitchless in their agent.
- [ ] Paste the declaration above into your submission draft, and start your dev log notes.
