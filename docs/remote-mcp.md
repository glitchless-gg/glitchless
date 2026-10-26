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

The app sends you to Glitchless. Sign in, pick the workspace, and choose what the app may do. It reads; the other two
are yours to tick, and are never on by default:

| Scope | What the app may do |
| --- | --- |
| `read` | Read every game's data: findings, frame times, errors, players, events, dashboards, store reviews, revenue |
| `dashboard` | Design and save game dashboards |
| `manage` | Create games, and make and revoke read-only share links |

The page says who is asking. An app that publishes its details (Claude and ChatGPT do) shows the site that vouches
for its name; an app that registered itself is flagged as one Glitchless can't check, and the page shows the whole
address approving sends you back to. Names that pass for something else (a well-known app's, from somewhere that isn't
that app, or a web address other than its own) aren't accepted. An app that only sends you back to your own computer
(`localhost`, as Claude Code and VS Code do) keeps whatever name it gives: nothing it gets can leave that computer.

If the workspace has no games yet, the page asks for your first one: name it, or take the demo game (Zoomies with a
week of sample play, which takes no room from your plan), so the app has something to read straight away. The app can
then add Glitchless to your game with the game's client token and the
[setup steps](https://github.com/glitchless-gg/glitchless/blob/main/docs/agent-setup-prompt.md).

It acts as you, with your role in the workspace (a Viewer's connection can only read, and a Viewer can have 5 at once),
and it never deletes data or changes billing or people. The connection shows under the app's name in Agents & MCP and
in Settings → Keys & access, with when it was last used; Disconnect there takes effect within 5 seconds everywhere. A connection the app stops using
expires with its last refresh token, after 30 days. Connecting the same app again replaces its old connection.

## Tools

| Tool | Title | Needs | Read-only | Destructive | Idempotent | Open world |
| --- | --- | --- | --- | --- | --- | --- |
| `glitchless_list_games` | List games | read | yes | no | yes | no |
| `glitchless_triage` | Triage | read | yes | no | yes | no |
| `glitchless_overview` | Overview | read | yes | no | yes | no |
| `glitchless_performance` | Performance | read | yes | no | yes | no |
| `glitchless_get_error` | Get error | read | yes | no | yes | no |
| `glitchless_player_funnel` | Player funnel | read | yes | no | yes | no |
| `glitchless_death_hotspots` | Death hotspots | read | yes | no | yes | no |
| `glitchless_session` | Session | read | yes | no | yes | no |
| `glitchless_events` | Events | read | yes | no | yes | no |
| `glitchless_compare_versions` | Compare versions | read | yes | no | yes | no |
| `glitchless_dashboard` | Dashboard | read | yes | no | yes | no |
| `glitchless_bug_reports` | Bug reports | read | yes | no | yes | no |
| `glitchless_store_reviews` | Store reviews | read | yes | no | yes | no |
| `glitchless_store_vitals` | Store vitals | read | yes | no | yes | no |
| `glitchless_revenue` | Revenue | read | yes | no | yes | no |
| `glitchless_set_dashboard` | Save dashboard | dashboard | no | yes: it replaces the saved pages | yes | no |
| `glitchless_create_game` | Create game | manage | no | no | no | no |
| `glitchless_share_board` | Share board | manage | no | no | no | yes: a share link is public |
| `glitchless_list_share_links` | List share links | manage | yes | no | yes | no |
| `glitchless_revoke_share_link` | Revoke share link | manage | no | yes | yes | no |

An app sees only the tools its scopes allow. Every tool takes `game` (a name or id). Not served by URL, because they
act on the computer the server runs on: `glitchless_sign_in` (OAuth replaces it), `glitchless_playtest` (plays the game
in Chrome on that computer), `glitchless_deck_send` and `glitchless_deck_measure` (a Steam Deck on that network).

## For MCP client developers

| | |
| --- | --- |
| Transport | Streamable HTTP, stateless: POST only (GET answers 405). 2026-07-28 requests get a JSON body; older clients get the answer as a one-event SSE stream |
| Protocol versions | 2026-07-28, and 2025-11-25 and earlier through `initialize` |
| Protected resource metadata (RFC 9728) | `https://api.glitchless.gg/.well-known/oauth-protected-resource/mcp` (not at the root path, which would describe the origin); `resource` is `https://api.glitchless.gg/mcp`. A request without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="read dashboard manage"` |
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
