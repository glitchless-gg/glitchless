# Demo video for OpenAI's review: shot list

OpenAI's one rule for the video is that it "shows the main use cases and tools across supported platforms". For
Glitchless the platforms are ChatGPT and Codex. Record it with the review account, so the reviewers see exactly the
data their test cases expect. Aim for about 4 minutes, screen only; a voiceover or on-screen captions both work.
The URL goes in `submission.json` as `review.demo_recording_url`.

## Before recording

- **Fresh data.** The review workspace holds a week of seeded play, and test case 5 needs version 1.0.0's sessions,
  which leave the 7-day window about 5 days after a seed. The seed of 25 October lasts to about 30 October. If you
  record or submit later, reseed first (the review workspace's seed script with `--round 2`) and wait 5 minutes for
  the data to arrive.
- **Dry run.** Ask the five prompts below once and compare the answers with `expected_behavior` in
  `submission.json`. Fix anything that differs before you record.
- **A clean screen.** A browser profile with nothing else signed in, the bookmarks bar hidden, ChatGPT's chat history
  collapsed, page zoom around 125%, recorded at 1920 × 1080. Close notifications.
- **The password stays off camera.** Pause the recording while you type it, or have the browser fill it.
- **No other Glitchless connection for this account.** In Glitchless, Agents & MCP: disconnect old test
  connections, so scene 15 shows only what this video made.

## Shot list

| # | Where | What you do | What must be on screen | About |
| --- | --- | --- | --- | --- |
| 1 | Title card | Text over a still: "Glitchless in ChatGPT and Codex. Observability for games: what real players' sessions measured." | The Glitchless logo and name | 0:05 |
| **ChatGPT** | | | | |
| 2 | chatgpt.com/plugins | **+** → Add custom MCP server. Name: Glitchless. Description: Find what's wrong in your game. Connection: `https://api.glitchless.gg/mcp`. Authentication: OAuth. Accept the risk notice, then Create as a plugin | The URL and OAuth chosen | 0:20 |
| 3 | The same page | Scroll the tools ChatGPT found | Tool names such as `glitchless_triage` and `glitchless_dashboard` | 0:05 |
| 4 | Glitchless sign-in | Install, and ChatGPT opens Glitchless. Sign in with the review account (pause for the password) | The Glitchless sign-in page | 0:10 |
| 5 | Glitchless approval page | Hold for a second on "An app calling itself ChatGPT…" and "Connecting sends you back to…". Keep the workspace "Glitchless Review", tick **Design and save dashboards** and **Create games and share links**, then Connect | The app's name, the address it returns to, the three choices | 0:15 |
| 6 | New ChatGPT chat | Type `@`, choose Glitchless, ask: **What's wrong with Zoomies this week?** Open the tool call | `glitchless_triage`; findings ranked, with the level 2 difficulty spike at the vacuum, the TypeError reading 'velocity', and the level 2 stutter that 1.1.0 removed | 0:25 |
| 7 | Same chat | **Where do players die most on level 2 of Zoomies, and what kills them?** | `glitchless_death_hotspots`; around x 38 to 43, about two thirds of the level's deaths, the vacuum | 0:15 |
| 8 | Same chat | **Which error hits the most Zoomies sessions, and what happened right before it?** | `glitchless_get_error`; the TypeError in Player.update, about a fifth of sessions, the events before it | 0:15 |
| 9 | Same chat | **Show me Zoomies' dashboard.** | `glitchless_dashboard`; its pages and the board's numbers | 0:15 |
| 10 | Same chat | **Compare Zoomies 1.0.0 and 1.1.0 over the past week. Did 1.1.0 fix the level 2 stutter?** | `glitchless_compare_versions`; level 2's hitches from several a minute to none | 0:15 |
| 11 | Same chat, then a new tab | **Make a share link to Zoomies' Zoomies board.** Confirm if ChatGPT asks. Open the link in a new tab | `glitchless_share_board`; the read-only board, signed out | 0:20 |
| 12 | Back in the chat | **Revoke that share link.** Confirm. Reload the link's tab | `glitchless_revoke_share_link`; the link no longer opens | 0:15 |
| 13 | New chat, no @ | **What's the weather in Seattle tomorrow?** | An answer with no Glitchless tool call | 0:10 |
| **Codex** | | | | |
| 14 | Terminal | `codex plugin marketplace add glitchless-gg/glitchless`, then `codex plugin add glitchless@glitchless`, then start `codex` and sign in to Glitchless the same way (scenes 4 and 5). If Codex doesn't open the sign-in by itself, run `codex mcp login glitchless` | The plugin installed; the approval page naming Codex | 0:30 |
| 15 | Codex | Show the plugin's three skills (instrument, dashboard, triage) in Codex's skills list | The skill names and one-line descriptions | 0:10 |
| 16 | Codex | **Use the Glitchless triage skill: what's the most important problem in Zoomies this week, and what should I check first?** | The triage skill loading, `glitchless_triage` (and `glitchless_get_error`) called, the answer | 0:30 |
| **Glitchless** | | | | |
| 17 | app.glitchless.gg, Agents & MCP | Show the ChatGPT and Codex connections with when each was last used, then Disconnect on ChatGPT | Both connections; ChatGPT's gone | 0:15 |

Scenes 6 to 10 are the five positive test cases, word for word; scene 13 is one of the negative ones. Scene 14 can
run in the ChatGPT desktop app's Plugins instead of a terminal, if you'd rather show that.

## After recording

1. Upload it to YouTube as **Unlisted** (anyone with the link can watch, no sign-in), or anywhere else a reviewer can
   open without an account.
2. Put the URL in `submission.json` as `review.demo_recording_url`, run `node docs/release/chatgpt-plugin/build.mjs`,
   and check it no longer says NOT READY.
3. Upload the zip in the portal, then the portal-only fields in [README.md](README.md): reviewer sign-in, domain
   check, annotation justifications, attestations.
