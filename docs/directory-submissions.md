# Listing Glitchless in the Claude and ChatGPT directories

What each directory's submission asks for, filled in for Glitchless, and what's left before submitting. Requirements
were read from the directories' own pages on 25 October 2026 (links at the end); check them again before you submit,
because both change often. Claude: submitted 25 October 2026 and approved the same day as a Community connector (automated review). ChatGPT: not submitted yet.

The server being listed is `https://api.glitchless.gg/mcp`: Streamable HTTP, OAuth 2.1 sign-in, 23 tools. How it
works and how people connect is in [remote-mcp.md](remote-mcp.md).

## Before submitting

These are the owner's to do, in this order.

1. **Deploy and smoke-test the endpoint.** After deploying, check from a shell, then as a custom connector in claude.ai
   (Customize → Connectors → Add custom connector) and in ChatGPT (Plugins → + → Add custom MCP server):

   ```bash
   curl -si -X POST https://api.glitchless.gg/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
   ```

   It should answer `401` with `Bearer resource_metadata="https://api.glitchless.gg/.well-known/oauth-protected-resource/mcp"`.
   Then validate the tools with the MCP Inspector, which Claude's form asks you to confirm:

   ```bash
   npx @modelcontextprotocol/inspector --cli https://api.glitchless.gg/mcp --transport http --method tools/list
   ```

2. **A reviewer account that signs in without codes.** Both directories want a test account with real-looking data,
   and ChatGPT rejects sign-ins that need MFA, an emailed or texted code, or a magic link. Glitchless signs people in
   with Google or GitHub only, and both can challenge a new device with a code. So the reviewer gets a
   username-and-password account in Auth0 (sign-ups off), and Glitchless Cloud lets only the account IDs on its
   deploy's allowlist sign in that way. Then give that account a workspace, "Glitchless Review",
   with one game, Zoomies, and fill it with Glitchless Cloud's review seed script: a week of sessions (the intake keeps
   at most 7 days back) with errors, deaths, two versions and a saved dashboard, which the test cases below describe.
   Seed it a day or two before submitting. Its credentials go into each portal's private reviewer field, never into
   this file or a manifest.
3. **Update the privacy policy** (https://www.glitchless.gg/privacy.html). It covers coding agents with a key, not
   apps connected by OAuth. Claude's policy asks what is collected, used and kept; ChatGPT rejects listings whose tools
   return data the policy doesn't name. Suggested change to the paragraph on where data goes: "If you connect an AI
   app such as Claude or ChatGPT, or a coding agent, it reads your games' data through the Glitchless MCP server: the
   findings, frame times, errors, sessions (with their device, level, positions and event timeline), bug reports and
   their screenshots, store reviews and revenue you ask about. The app's provider receives what it reads, under that
   provider's terms. Revoke a connection in Settings → Keys & access." Also list the sign-in records OAuth adds (the
   app's name and redirect address, and token hashes kept up to 30 days).
4. **ChatGPT's domain check.** When the plugin portal shows its verification token, deploy with
   `--openai-challenge <token>` (the cloud deploy script keeps it for later deploys) so it's served as plain text at
   `https://api.glitchless.gg/.well-known/openai-apps-challenge`.
5. **A public page** about connecting by URL, required by Claude by the publish date: publish
   [remote-mcp.md](remote-mcp.md) with the next public export, or put the same on www.glitchless.gg (and point
   `GLITCHLESS_MCP_DOCS_URL` at it).
6. **ChatGPT only:** record a short demo video (connect, approve, ask "What's wrong with my game this week?"), and
   verify the OpenAI organization's identity (Settings → Organization → General) in a project without EU data
   residency.
7. **Decide on OIDC.** ChatGPT Enterprise workspaces that restrict sign-in by email domain need `openid` and `email`
   scopes and a UserInfo endpoint that returns a verified email. Glitchless doesn't offer them yet; the listing works
   without them for everyone else.

## The listing, shared by both

| Field | Value |
| --- | --- |
| Name | Glitchless |
| Short line (ChatGPT subtitle, 30 characters at most) | Find what's wrong in your game |
| One-liner (Claude, 200 at most) | See how your game runs for real players: ranked findings, frame times, errors, where players die, store reviews and revenue, and a dashboard in your game's own terms. |
| Website | https://www.glitchless.gg |
| Documentation | https://www.glitchless.gg/docs.html, and the connection guide (step 5 above) |
| Privacy policy | https://www.glitchless.gg/privacy.html |
| Terms of service | https://www.glitchless.gg/terms.html |
| Support | support@glitchless.gg, https://www.glitchless.gg/support.html |
| Company | The Glitchless authors (use the legal name the owner publishes under), website https://www.glitchless.gg |
| Icon | 512 × 512 PNG: https://app.glitchless.gg/brand/glitchless-icon-512.png. Square SVG: `assets/brand/glitchless/logo/glitchless-icon.svg`. Both pass ChatGPT's rule (square, 48 to 4,096 px). Claude's size isn't published; use the PNG |
| Server URL | `https://api.glitchless.gg/mcp` (Streamable HTTP) |
| Authentication | OAuth 2.1, always required. Clients identify by Client ID Metadata Document (preferred) or Dynamic Client Registration; no client secret to hand over |
| Reads or writes | Both: 16 read-only tools; 4 that write (save a dashboard, create a game, make or revoke a share link) |
| Data source | Glitchless's own API (first party), no partner data, no health data, no sponsored content, no payments |

### Description

Use this for Claude (2,000 characters at most) and ChatGPT (4,000).

> Glitchless is observability for games made with Three.js, Phaser, Babylon.js, PlayCanvas, Unity, Godot, Unreal and
> GameMaker. Connect it and ask about your games in plain words: what's wrong this week, where players die, which
> error hits the most sessions, whether last night's build fixed the stutter on level 2.
>
> Answers come from what your players' sessions actually measured. Triage ranks findings by how many players they
> hit, each with its evidence and a suggested fix: frame-time spikes per level and what they correlate with, memory
> leaks, top errors with their stack and the gameplay right before them, difficulty spikes and rage quits, and version
> regressions. You can drill into frame times by level, GPU tier and browser, one error, one session's whole timeline,
> the game's own events and funnels, and bug reports players sent from inside the game, with their screenshots.
>
> For games connected to a store or a payments provider, it reads Steam, Google Play and App Store reviews and vitals
> next to what Glitchless measured on each build, and RevenueCat or Stripe revenue next to the players who made it.
>
> Each game has its own dashboard in its own terms, and the assistant can read it or design a new one. It can also
> create a game and make a read-only share link to a board.
>
> You sign in with your Glitchless account and choose the workspace and what the assistant may do. It acts as you,
> never deletes data and never touches billing or people, and you can disconnect it any time in Settings → Keys &
> access. You need a Glitchless account (free) with at least one game sending data.

### Example prompts

Claude asks for at least three; ChatGPT takes three starter prompts of 128 characters at most.

1. What's wrong with my game this week?
2. Where do players die most on level 2, and what kills them?
3. Design a dashboard for my game that fits how it's played.

More for the use-cases field: "Which error hits the most sessions, and what happened right before it?", "Did version
1.1.0 fix the stutter on level 2?", "What did Steam reviewers say about the last build, next to its frame rate?",
"Make a share link to my game's dashboard for my dev log".

### Tools

Both portals read the tools from the server; this is what they'll find. Titles and all four hints are set on every
tool.

| Tool | Title | Read-only | Destructive | Idempotent | Open world | Why the hints |
| --- | --- | --- | --- | --- | --- | --- |
| `glitchless_list_games` | List games | yes | no | yes | no | Reads the workspace's games |
| `glitchless_triage` | Triage | yes | no | yes | no | Reads findings |
| `glitchless_overview` | Overview | yes | no | yes | no | Reads headline numbers |
| `glitchless_performance` | Performance | yes | no | yes | no | Reads frame times |
| `glitchless_get_error` | Get error | yes | no | yes | no | Reads error issues |
| `glitchless_player_funnel` | Player funnel | yes | no | yes | no | Reads level funnels and retention |
| `glitchless_death_hotspots` | Death hotspots | yes | no | yes | no | Reads death positions |
| `glitchless_session` | Session | yes | no | yes | no | Reads one session |
| `glitchless_events` | Events | yes | no | yes | no | Reads the game's own events |
| `glitchless_compare_versions` | Compare versions | yes | no | yes | no | Reads versions side by side |
| `glitchless_dashboard` | Dashboard | yes | no | yes | no | Reads the dashboard and one board |
| `glitchless_bug_reports` | Bug reports | yes | no | yes | no | Reads players' bug reports |
| `glitchless_store_reviews` | Store reviews | yes | no | yes | no | Reads store reviews Glitchless already synced; calls no store |
| `glitchless_store_vitals` | Store vitals | yes | no | yes | no | Reads synced store vitals |
| `glitchless_revenue` | Revenue | yes | no | yes | no | Reads synced revenue |
| `glitchless_match` | Match | yes | no | yes | no | Reads a multiplayer game's matches |
| `glitchless_network` | Network | yes | no | yes | no | Reads ping, packet loss and disconnects |
| `glitchless_servers` | Servers | yes | no | yes | no | Reads the game's dedicated servers |
| `glitchless_list_share_links` | List share links | yes | no | yes | no | Reads a game's share links |
| `glitchless_set_dashboard` | Save dashboard | no | yes | yes | no | Replaces the saved dashboard (reset: true deletes it); saving the same pages twice changes nothing |
| `glitchless_create_game` | Create game | no | no | no | no | Adds a game inside the workspace; each call adds another |
| `glitchless_share_board` | Share board | no | no | no | yes | Publishes a board to anyone who has the link, signed out |
| `glitchless_revoke_share_link` | Revoke share link | no | yes | yes | no | Ends a link for everyone who has it |

The four that write need the `dashboard` or `manage` scope, and so does listing share links; a person who grants only
`read` gives the app the other 18 reads.
Tools that act on the computer the server runs on (`glitchless_sign_in`, `glitchless_playtest`,
`glitchless_deck_send`, `glitchless_deck_measure`) exist only in the stdio server and are never listed here.

## Claude: Connectors Directory

Submit at https://claude.ai/directory/manage → Submit new → MCP connector, from a paid Claude plan (an Owner submits
for a Team or Enterprise organization). A submission is scanned automatically and listed as a Community connector;
some get a person's review. Review time isn't published. Tool changes deploy without resubmitting; questions go to
mcp-review@anthropic.com.

| Form step | What to enter |
| --- | --- |
| Connection | `https://api.glitchless.gg/mcp`; users all connect to this one URL (not "different URLs") |
| Tools | Synced from the server (above). Every tool has a title and read-only or destructive hints, so none are flagged |
| Listing: server name (100) | Glitchless |
| Listing: one-liner (200) | The one-liner above |
| Listing: description (2,000) | The description above (about 1,600 characters) |
| Listing: categories (1 to 5) | Developer tools; Data and analytics (pick the closest names the form offers; the list isn't published) |
| Listing: documentation URL | The public connection page (step 5) |
| Listing: privacy policy URL | https://www.glitchless.gg/privacy.html |
| Listing: support contact | support@glitchless.gg |
| Listing: icon | The 512 px PNG |
| Listing: URL slug (permanent) | `glitchless` |
| Use cases | The example prompts above. Before connecting: a Glitchless account (free) and a game sending data. Reads and writes: both |
| Company | Company name, https://www.glitchless.gg, and the owner as primary contact for review updates |
| Authentication | Always required; OAuth sign-in. Leave the Anthropic-held client ID and secret empty: Claude identifies itself with its metadata document (Glitchless offers `none` as a token endpoint method, which Claude needs for that) and falls back to registering |
| Data handling | Your own API; no health data; no sponsored content |
| Test & launch | Reviewer steps (below) and the reviewer account's credentials in the private field; confirm every tool was run in the MCP Inspector or a custom connector |
| Compliance | The seven acknowledgments: directory guidelines, first-party API, financial transactions (none), AI media generation (none), prompt injection (descriptions only describe; no hidden text), conversation data (none collected), public documentation |

What Claude checks on the server, all met: a `401` with `resource_metadata` for a request with no token; `resource`
equal to the URL as typed; one authorization server; `S256` in `code_challenge_methods_supported`; refresh tokens that
rotate and an `invalid_grant` when one is dead; token endpoint answering form posts within 10 seconds; no redirect on
`/mcp`; no strict `Origin` check (Claude's requests come from `160.79.104.0/21`). Its callback is
`https://claude.ai/api/mcp/auth_callback`; Claude Code uses `http://localhost:<port>/callback`, which matches on any port.

## ChatGPT: Plugin directory

OpenAI moved its apps directory to the Plugin directory on 9 July 2026. Submit at https://platform.openai.com/plugins →
Upload new or existing plugin, from an organization whose identity is verified, as an owner or with Apps Management
Write. Upload a ZIP with the plugin manifest and the MCP server in the first version (an MCP server can't be added to a
plugin later). Automated checks, then the MCP connection, domain check and tool scan, then Review details and
attestations, then a person's review by email. Once approved, you press Publish. The server's origin can never change
afterwards, so list `https://api.glitchless.gg` only once that address is final.

### Manifest fields

The upload is built from [release/chatgpt-plugin](release/chatgpt-plugin/README.md): `plugin.json`, `mcp.json` and
the logo, checked against OpenAI's rules and zipped by `node docs/release/chatgpt-plugin/build.mjs`. Those files are
the source of truth; this table is what they hold. `extensions["com.openai"].interface` in `plugin.json`:

| Field | Value |
| --- | --- |
| `name` (64, `a-z0-9_-`) | `glitchless` |
| `version` | `1.0.0` |
| `description` (4,000) | The description above |
| `author` | name, `support@glitchless.gg`, `https://www.glitchless.gg` |
| `displayName` (30) | Glitchless |
| `shortDescription` (30) | Find what's wrong in your game |
| `longDescription` (4,000) | The description above |
| `developerName` (80) | Replaced by the verified identity |
| `category` | Developer Tools |
| `capabilities` (20 × 120) | Rank what's wrong in a game by how many players it hits · Frame times by level, GPU tier, browser and version · Errors with stacks and the gameplay before them · Where players die on each level · One play session's timeline · The game's own events and funnels · Bug reports players sent, with screenshots · Store reviews and vitals next to each build's numbers · Revenue next to the players who made it · Read and design the game's dashboard · Create games and read-only share links |
| `websiteURL` | https://www.glitchless.gg |
| `supportURL` | https://www.glitchless.gg/support.html |
| `privacyPolicyURL` | https://www.glitchless.gg/privacy.html |
| `termsOfServiceURL` | https://www.glitchless.gg/terms.html |
| `defaultPrompt` (3 × 128) | The three example prompts |
| `brandColor` / `brandColorDark` | `#14213D` on light (navy); `#2EE6A6` on dark (mint). Check the 2:1 contrast the form asks for |
| `logo` | The 512 px PNG (or the SVG) |
| Screenshots | None: Glitchless returns no UI, and screenshots are rejected without one |

`mcp.json`: one server, `"type": "streamable-http"`, `"url": "https://api.glitchless.gg/mcp"`, and
`extensions["com.openai"].auth` `{ "type": "oauth", "client": { "mode": "cimd" } }` (ChatGPT's document is
`https://chatgpt.com/oauth/client.json`; Glitchless offers only `none` and the client secret methods, so ChatGPT uses
`none` rather than `private_key_jwt`). No `headers`: the portal rejects them.

### Review fields

`extensions["com.openai"].review` needs exactly five positive and three negative test cases, a demo video URL, and
`commerce: false`. Run each against the reviewer account first; `plugin.json` has each case's expected answer in full.

| # | Prompt | Tools | Expected |
| --- | --- | --- | --- |
| 1 | What's wrong with Zoomies this week? | `glitchless_triage` | Ranked findings with evidence: the difficulty spike at the vacuum on level 2, the TypeError in about a fifth of sessions, and over the week level 2's shader-compile stutter that 1.1.0 removed |
| 2 | Where do players die most on level 2 of Zoomies, and what kills them? | `glitchless_death_hotspots` | Around x 38 to 43, about two thirds of the level's deaths, the vacuum |
| 3 | Which error hits the most Zoomies sessions, and what happened right before it? | `glitchless_get_error` | The TypeError reading 'velocity' in Player.update, about a fifth of sessions, and the events before it |
| 4 | Show me Zoomies' dashboard. | `glitchless_dashboard` | The pages and the Zoomies board's numbers |
| 5 | Compare Zoomies 1.0.0 and 1.1.0 over the past week. Did 1.1.0 fix the level 2 stutter? | `glitchless_compare_versions` | Level 2's hitches went from several a minute to none |

Negative (Glitchless should not be called): "Write a Python function that sorts a list." · "What's the weather in
Seattle tomorrow?" · "Recommend a good platformer to play this weekend."

Release notes: "First release: findings, frame times, errors, death hotspots, sessions, events, bug reports, store
reviews and vitals, revenue and dashboards for your games."

### Portal-only fields

- Reviewer credentials: the reviewer account, the sign-in URL https://app.glitchless.gg, and the workspace name.
- MCP connect drawer: the server URL, OAuth, and the domain check (step 4 above).
- A one-sentence justification for each tool's read-only, open-world and destructive hint: the package README has them
  ready to paste.
- Attestations, as the portal lists them.

What ChatGPT checks on the server, all met: PKCE `S256` advertised; `resource` echoed into the token's audience (tokens
work only at `/mcp`); `client_id_metadata_document_supported: true`; `iss` in every authorization response, success or
error, with `authorization_response_iss_parameter_supported: true` (which also gets the stable redirect
`https://chatgpt.com/connector_platform_oauth_redirect`); `401` with `WWW-Authenticate` for expired or malformed
tokens; explicit read-only, destructive and open-world hints on every tool; no plan or upgrade prompts in tool text.

Review risks to know about: tools return session ids, timestamps and level positions, which the guidelines ask to keep
to what a request needs (they're how an assistant drills from a finding into a session, and the privacy policy should
name them, step 3); and a reviewer must be able to sign in at once (step 2).

## Reviewer instructions

Paste into both portals' test instructions (the credentials go in the private fields):

1. Add the connector or plugin with the URL `https://api.glitchless.gg/mcp`. It asks you to sign in.
2. Sign in to Glitchless with the reviewer account. The page shows the app's name and where it will send you back.
   Keep the workspace "Glitchless Review", tick "Design and save dashboards" and "Create games and share links" (they
   are off by default), and press Connect.
3. Ask: "What's wrong with Zoomies this week?" The answer lists ranked findings with evidence.
4. Ask: "Show me Zoomies' dashboard", then "Where do players die most on level 2?"
5. To try a write: "Make a share link to Zoomies' Overview board", then "Revoke that share link".
6. To disconnect: in Glitchless, Agents & MCP (or Settings → Keys & access) → Disconnect on the app's row.

## Sources

- Claude: [submission](https://claude.com/docs/connectors/building/submission),
  [authentication](https://claude.com/docs/connectors/building/authentication),
  [review criteria](https://claude.com/docs/connectors/building/review-criteria),
  [testing](https://claude.com/docs/connectors/building/testing),
  [directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy),
  [publishing](https://claude.com/docs/directory/publish).
- ChatGPT: [submission](https://developers.openai.com/plugins/deploy/submission),
  [submission errors](https://developers.openai.com/plugins/deploy/submission-errors),
  [app review](https://developers.openai.com/plugins/deploy/app-review),
  [auth](https://developers.openai.com/plugins/build/auth),
  [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines),
  [connect from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt).
- MCP: [authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
