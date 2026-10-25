# Glitchless for ChatGPT's plugin directory

The package uploaded to OpenAI's plugin portal (https://platform.openai.com/plugins → Upload new or existing plugin),
in the Agent Plugins layout: `plugin.json` (the listing, review test cases and release notes), `mcp.json` (the
server at `https://api.glitchless.gg/mcp`, OAuth with ChatGPT's Client ID Metadata Document) and `assets/logo.png`
(512 × 512). What each field is for, and what the portal asks besides, is in
[directory-submissions.md](../../directory-submissions.md).

```bash
node docs/release/chatgpt-plugin/build.mjs
```

It checks every field against the rules OpenAI publishes for a remote MCP submission (lengths, one-line fields, the
category, URLs, the brand colours' 2:1 contrast, a square logo, exactly 5 positive and 3 negative test cases, one
streamable-http server with no headers or secrets), then zips the files into `dist/chatgpt-plugin/` at the repo root
(git-ignored). It never uploads anything.

## Before it's ready

Two values only the owner can give are marked `OWNER-TODO` in `plugin.json`. While either is there, the zip is named
`glitchless-1.0.0-DRAFT.zip` and the build lists what's missing:

- `interface.developerName`: the verified developer or business name (the portal replaces it with the verified
  identity, but the package must carry one).
- `review.demo_recording_url`: a video a reviewer can open, showing the main use cases: connecting, approving in
  Glitchless, then the five test-case prompts.

Also decide `publication.countries` (left out: no restriction) and check the test cases against the seeded review
workspace; their expected answers describe that data.

## What goes in the portal, not the package

- **Reviewer sign-in**: the review account's email and password, the sign-in page `https://app.glitchless.gg`, and the
  workspace "Glitchless Review". The account must sign in without MFA, emailed codes or magic links.
- **Domain verification**: the portal shows a token; it's served at
  `https://api.glitchless.gg/.well-known/openai-apps-challenge` once deployed with it.
- **Annotation justifications**: one sentence for each tool's read-only, open-world and destructive hint (below).
- **Policy attestations**, as the portal lists them.

### Annotation justifications

| Tool | Read-only | Open world | Destructive |
| --- | --- | --- | --- |
| `glitchless_list_games` | true: lists the games in the person's workspace | false: reaches only the person's own Glitchless workspace | false: changes nothing |
| `glitchless_triage` | true: reads findings from the game's data | false: reads only the person's own game data | false: changes nothing |
| `glitchless_overview` | true: reads the game's headline numbers | false: reads only the person's own game data | false: changes nothing |
| `glitchless_performance` | true: reads frame-time measurements | false: reads only the person's own game data | false: changes nothing |
| `glitchless_get_error` | true: reads error reports the game sent | false: reads only the person's own game data | false: changes nothing |
| `glitchless_player_funnel` | true: reads level progress and retention | false: reads only the person's own game data | false: changes nothing |
| `glitchless_death_hotspots` | true: reads where players died | false: reads only the person's own game data | false: changes nothing |
| `glitchless_session` | true: reads one play session | false: reads only the person's own game data | false: changes nothing |
| `glitchless_events` | true: reads the game's own events | false: reads only the person's own game data | false: changes nothing |
| `glitchless_compare_versions` | true: reads two versions' numbers | false: reads only the person's own game data | false: changes nothing |
| `glitchless_dashboard` | true: reads the game's dashboard and its numbers | false: reads only the person's own workspace | false: changes nothing |
| `glitchless_bug_reports` | true: reads bug reports players sent | false: reads only the person's own game data | false: changes nothing |
| `glitchless_store_reviews` | true: reads store reviews already synced into Glitchless | false: calls no store; reads what the workspace already holds | false: changes nothing |
| `glitchless_store_vitals` | true: reads store vitals already synced into Glitchless | false: calls no store; reads what the workspace already holds | false: changes nothing |
| `glitchless_revenue` | true: reads revenue already synced into Glitchless | false: calls no payment provider; reads what the workspace already holds | false: changes nothing |
| `glitchless_list_share_links` | true: lists the game's share links | false: reaches only the person's own workspace | false: changes nothing |
| `glitchless_set_dashboard` | false: saves the game's dashboard | false: the dashboard stays in the person's workspace | true: it replaces the saved pages, and `reset` deletes them |
| `glitchless_create_game` | false: adds a game to the workspace | false: the game stays in the person's workspace | false: adds a game and removes nothing |
| `glitchless_share_board` | false: creates a share link | true: anyone with the link can see that board, signed out | false: adds a link and changes no data |
| `glitchless_revoke_share_link` | false: revokes a share link | false: acts on a link in the person's own workspace | true: the link stops working for everyone who has it, and can't be restored |
