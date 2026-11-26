# Glitchless by URL: the remote MCP server

Glitchless Cloud runs the Glitchless MCP server at:

```
https://api.glitchless.gg/mcp
```

Use it from apps that connect to an MCP server by URL: claude.ai and the Claude apps, Claude Code, ChatGPT, or any
client that speaks Streamable HTTP. It answers clients of the current MCP protocol (2026-07-28) and older ones that
open with `initialize`. You sign in with your Glitchless account in the browser, pick a workspace, and the app can
then work with every game in it.

For coding agents that start a local process instead, [glitchless-mcp](../packages/mcp/README.md) over stdio does the
same and also runs playtests and sends builds to a Steam Deck.

To look something up in Glitchless's docs, no sign-in needed, an agent can search them:
`https://www.glitchless.gg/.well-known/search?q=<query>` answers with the passages that match, in Markdown, each with
its source address ([SPEC §3n](SPEC.md#3n-search-for-agents-glitchless-cloud)).

## Connect

**claude.ai, Claude Desktop and the mobile apps**: Customize → Connectors → Add → Add custom connector. Name it
Glitchless, paste the URL, and press Add. Claude opens Glitchless to sign in.

**Claude Code**:

```bash
claude mcp add --transport http glitchless https://api.glitchless.gg/mcp
```

Then run `/mcp` in Claude Code and choose Glitchless to sign in.

**ChatGPT**: Plugins → + → Add custom MCP server, paste the URL, and choose OAuth.

**Any other client**: give it the URL. If it supports MCP's OAuth sign-in, it finds Glitchless's sign-in by itself.
If it can only send a fixed header, make a workspace key in Settings → Keys & access and send it as
`Authorization: Bearer gl_ws_…`.

## Signing in

The app sends you to Glitchless. Sign in, pick the workspace, and choose what the app may do. It reads; designing
dashboards and managing games are on unless you untick them (Change what it can do), and deleting games is off unless
you tick it:

| Scope | What the app may do |
| --- | --- |
| `read` | Read every game's data: findings, frame times, errors, players, events, dashboards, store reviews, revenue; and send the Glitchless team feedback (`glitchless_feedback`) |
| `dashboard` | Design and save game dashboards |
| `manage` | Create games, and make and revoke read-only share links |
| `delete_games` | Delete games and their data, for good, when you ask it to (it repeats the game's name first). Only an Owner or Admin can tick it |

The page says who is asking. An app that publishes its details (Claude and ChatGPT do) shows the site that vouches
for its name; an app that registered itself is flagged as one Glitchless can't check, and the page shows the whole
address approving sends you back to. Names that pass for something else (a well-known app's, from somewhere that isn't
that app, or a web address other than its own) aren't accepted. An app that only sends you back to your own computer
(`localhost`, as Claude Code and VS Code do) keeps whatever name it gives: nothing it gets can leave that computer.

If the workspace has no games yet, the page asks for your first one: name it, or take the demo game (Zoomies with a
week of sample play, which takes no room from your plan), so the app has something to read straight away.

Adding Glitchless to your game takes a coding agent in the game's folder. One that has this connection needs nothing
else: say "Set up Glitchless for my game in this folder", and `glitchless_create_game` hands it the steps for the
game's engine, with the game's client token in them (it finds the game you named here, or makes it). Claude Code
signed in to the same Claude account has the connection already. An agent without it follows the
[setup steps](https://github.com/glitchless-gg/glitchless/blob/main/docs/agent-setup-prompt.md), as does one that
can't create games (a read-only one).

It acts as you, with your role in the workspace (a Viewer's connection can only read and send the Glitchless team
feedback, and a Viewer can have 5 at once),
and it never changes billing or people. It deletes data only with `delete_games`, which you tick yourself, and then
only a whole game you asked it to delete, with the game's name repeated back. A connection made before that scope
existed doesn't have it: connect the app again to give it. The connection shows under the app's name in Agents & MCP
and in Settings → Keys & access, with when it was last used; Disconnect there takes effect within 5 seconds
everywhere. A connection the app stops using expires with its last refresh token, after 30 days. Connecting the same
app again replaces its old connection.

## Tools

| Tool | Title | Needs | Read-only | Destructive | Idempotent | Open world |
| --- | --- | --- | --- | --- | --- | --- |
| `glitchless_list_games` | List games | read | yes | no | yes | no |
| `glitchless_triage` | Triage | read | yes | no | yes | no |
| `glitchless_performance` | Performance | read | yes | no | yes | no |
| `glitchless_get_error` | Get error | read | yes | no | yes | no |
| `glitchless_player_funnel` | Player funnel | read | yes | no | yes | no |
| `glitchless_session` | Session | read | yes | no | yes | no |
| `glitchless_events` | Events | read | yes | no | yes | no |
| `glitchless_compare_versions` | Compare versions | read | yes | no | yes | no |
| `glitchless_dashboard` | Dashboard | read | yes | no | yes | no |
| `glitchless_bug_reports` | Bug reports | read | yes | no | yes | no |
| `glitchless_store` | Store | read | yes | no | yes | no |
| `glitchless_revenue` | Revenue | read | yes | no | yes | no |
| `glitchless_match` | Match | read | yes | no | yes | no |
| `glitchless_network` | Network | read | yes | no | yes | no |
| `glitchless_servers` | Servers | read | yes | no | yes | no |
| `glitchless_set_dashboard` | Save dashboard | dashboard | no | yes: it replaces the saved pages, and removes a background, logo or banner | yes | no |
| `glitchless_create_game` | Create, set up, rename or delete game | manage | no | yes: `delete` deletes a game and everything stored for it (a connection with `delete_games`, an Owner's or Admin's, with the game's name again) | no | no |
| `glitchless_share_links` | Share links | manage | no | yes: it revokes a link | no | yes: a share link is public |
| `glitchless_mark_known` | Mark known | manage | no | yes: it replaces a note, clears one, and marks or unmarks a tester | yes | no |
| `glitchless_resolve_error` | Resolve error | manage | no | yes: it hides an issue, and unresolves one | no: resolving again starts it over | no |
| `glitchless_alerts` | Alerts | read | yes | no | yes | no |
| `glitchless_set_alerts` | Change alerts | manage | no | yes: it replaces settings and removes a webhook | no | yes: a test alert posts to Discord, Slack or email |
| `glitchless_feedback` | Send feedback | read | no | no | no: each call is a report | yes: the report goes to the Glitchless team |

An app sees only the tools its scopes allow. Every tool takes `game` (a name or id). Not served by URL, because they
act on the computer the server runs on: `glitchless_sign_in` (OAuth replaces it), `glitchless_playtest` (plays the game
in Chrome, or runs its build, on that computer) and `glitchless_deck` (a Steam Deck on that network).

An app on protocol 2026-07-28 that can show a form (MCP elicitation, as Claude can) is asked to confirm before
`glitchless_create_game` deletes a game: "Delete <game> for good?", with a box to tick. The game goes only when the
person ticks it and accepts, and still only with `delete_games`. The question and the answer are two requests, with
nothing held between them. An older app, or one that can't show forms, deletes as before.

`glitchless_feedback` is the agent telling the Glitchless team about a bug, a dead end, something missing or an idea
while it works, at most 4,000 characters a report and 20 a day from a workspace. It's kept a year, or until the person
closes their account, with the ids of their account and workspace: never a name, an email address or a game's data,
and keys pasted in by mistake are removed. The agent tells the person what it sent and the report's ID, and that they
can write to support@glitchless.gg for an answer.

**Pictures by upload link.** The server can't read files on the agent's computer, and an app connected over OAuth
holds no key to upload with. So `glitchless_set_dashboard` answers a `logo`, `banner` or heatmap `background` given as
a `file` with an upload link, and the agent sends the picture itself with one command and no key:

```bash
curl -X PUT --data-binary @key-art.jpg 'https://api.glitchless.gg/v1/uploads/gl_up_…'
```

A link is shown once, lasts 10 minutes and takes one picture for its one slot (the logo, the banner, or one place's
background with the bounds it was made with), then stops working; a used or expired link answers `410`. curl's answer
says what was saved, or what to fix: a picture refused for its size or type (a logo at most 100 KB and 1024 × 1024
pixels, a banner 300 KB and 4096 × 2048, a background 256 KB and 4096 × 4096; PNG, JPEG or WebP) can go to the same
link again until it expires. Making one needs the dashboard scope, a game makes at most 30 an hour, and Glitchless keeps
only each link's hash. `upload: true` asks for a link without a file named; base64 (`image`) still works for a small
picture. The routes are in [SPEC §3b Upload links](SPEC.md#3b-dashboards-and-boards).

## Skills

The server also serves the Glitchless skills, the same ones the Claude Code plugin carries, over MCP's
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview):

| Skill | What it does | Needs |
| --- | --- | --- |
| `instrument` | Adds Glitchless to a game, in its engine | manage |
| `dashboard` | Works out what the game's developer wants to know, and designs the game's dashboard | dashboard |
| `triage` | Finds the most important problem in a game, fixes it and checks the fix | read |

An app gets the skills its scopes have the tools for. In Claude Code (v2.1.331 or later) they show under the server's name: `/glitchless:triage` for a server added as
`glitchless` (the command above), `/claude_ai_Glitchless:triage` when it comes from a claude.ai connector named
Glitchless. Apps without skills over MCP get the same text from the tools: `glitchless_create_game` with `engine`
returns the instrument skill for that engine, and `glitchless_dashboard` with `guide: true` the dashboard skill.

## For MCP client developers

| | |
| --- | --- |
| Transport | Streamable HTTP, stateless: POST only (GET answers 405). 2026-07-28 requests get a JSON body; older clients get the answer as a one-event SSE stream |
| Protocol versions | 2026-07-28, and 2025-11-25 and earlier through `initialize` |
| Skills | The Skills extension (`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, each file at `skill://<skill>/<path>` through `resources/read` (and `resources/directory/read`), with its size and SHA-256 digest in the listing; the `SKILL.md` files are in `resources/list` too. `/mcp?skills=off` serves none (no extension, no resources), for a client whose plugin carries the skills; the OAuth resource is still `/mcp` |
| Change notifications | None: the server never sends `notifications/tools/list_changed` or `notifications/resources/list_changed`, and says so (`tools.listChanged` and `resources.listChanged` are `false`), so there is no stream to hold open. A `subscriptions/listen` is acknowledged with an empty filter and ended at once with its result: a clean end, not a dropped connection to open again. `tools/list` answers carry `ttlMs: 0`: read the list again when you need it, or on reconnecting, and you get the tools of the latest release |
| Protected resource metadata (RFC 9728) | `https://api.glitchless.gg/.well-known/oauth-protected-resource/mcp` (not at the root path, which would describe the origin); `resource` is `https://api.glitchless.gg/mcp`. A request without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="read dashboard manage delete_games"` |
| Authorization server metadata (RFC 8414) | `https://api.glitchless.gg/.well-known/oauth-authorization-server`, issuer `https://api.glitchless.gg` |
| Client identification | Client ID Metadata Documents, preferred: an HTTPS `client_id` with a path and no query, on a host other than Glitchless's; fetched with no redirects, 5 KB at most, cached five minutes. Or Dynamic Client Registration at `/oauth/register` (RFC 7591): a name of 60 characters at most, 1 to 5 redirect URIs of 512 at most; a client that gets no token within a day is dropped, one in use lasts 90 days past its last token |
| Rate limits | Per address, an IPv6 address by its /64: 30 authorizations and 30 metadata-document fetches an hour, 10 registrations an hour (1,000 accepted from everyone, not counting Anthropic's range), 120 token and revocation requests a minute. Anthropic's published range gets 20 times as many. Re-reading a metadata document that checked out in the last day isn't counted, and its last good copy is used while its host can't answer. Over the limit: `429` |
| Flow | Authorization code with PKCE, `S256` only. Authorize at `https://app.glitchless.gg/oauth/authorize`; the response carries `iss` (RFC 9207). Send `resource` (RFC 8707). An error in the authorization request shows a page in the browser rather than redirecting back to the client (RFC 9700 §4.11.2); turning the request down returns `access_denied` to the client |
| Redirect URIs | https; loopback `http://localhost`, `127.0.0.1` or `[::1]`, which match on any port (RFC 8252 §7.3); or an app's own scheme, reverse-domain (`com.example.app:`, RFC 8252 §7.1) or one of `cursor:`, `vscode:`, `vscode-insiders:`, `windsurf:`. Otherwise an exact match |
| Tokens | Access tokens last an hour and work only at `/mcp`. Refresh tokens last 30 days and rotate on every use; presenting a used one again later ends the connection, and so does presenting a used code. `offline_access` is accepted and not needed |
| Token endpoint auth | `none` (PKCE) for every client; registered clients may also use `client_secret_post` or `client_secret_basic` |
| Revocation (RFC 7009) | `/oauth/revoke`: an access token ends alone; a refresh token ends the connection |
| CORS | Any `https` origin, or a page on `localhost`, may call `/mcp`, the metadata and the token, registration and revocation endpoints; no cookies are involved |

## Self-hosting

A self-hosted Glitchless server can be served by URL too: `npx -y glitchless-mcp serve` reads it (with
`GLITCHLESS_URL` and, if it needs one, `GLITCHLESS_API_KEY`) and serves the same tools at
`http://127.0.0.1:3001/mcp`. It has no OAuth: it answers this computer only, or clients that send the token in
`GLITCHLESS_MCP_TOKEN`. See [glitchless-mcp](../packages/mcp/README.md#serve-it-over-http-yourself).
