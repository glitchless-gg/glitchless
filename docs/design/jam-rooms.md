# Jam rooms: a room code, an arcade, a big screen, awards and one-command publishing (design)

Status: approved by the owner on 5 November 2026 (with the decisions in section 10) and built the same day.
[`docs/SPEC.md`](../SPEC.md) §3j and §6 describe what is built; [section 14](#14-built-5-november-2026) says where
the build differs from this design.

A jam room is what a 90-minute mini jam needs (a hands-on workshop pitched to conferences for 2027, piloted at a
meetup first): an organiser makes a room and gets a short code, makers join it from their agent, publish their game
in one command, and everyone plays each other's games on their phones from an arcade page full of QR codes. A big
screen shows which games need players. When the jam ends the room hands out awards, three from what players did
and one the room votes for, keeps a snapshot of what everyone did, and asks everyone how it went. It works the same
on the open-source server (a meetup's own Docker box) and on Glitchless Cloud, which runs the same code.

Jam rooms are a jam tool, kept apart from the production MCP server (`glitchless-mcp`) that developers use on the
games they ship. They get a package of their own, `glitchless-jam` (§5).

## 1. Where the pieces live

| Piece | Where | Open source? |
| --- | --- | --- |
| Rooms, games in a room, uploads, votes, numbers, awards, the snapshot, the survey, the API | `server/src/rooms.js` (new), routes in `server/src/app.js` | yes |
| QR codes (SVG for pages, text for terminals), no dependencies | `server/src/qr.js` (new) | yes |
| Serving games (a second port on the open-source server) | `server/src/play.js` (new), started by `server/src/local.js` | yes |
| Arcade page with voting, big screen, survey page, an organiser's Rooms page with past jams | `apps/dashboard/src/pages/Room.jsx` (new); the arcade, big screen and survey open before any sign-in | yes |
| `glitchless-jam` on npm: its own MCP server (one tool, `glitchless_jam`) and CLI | `packages/jam` (new). Nothing in `glitchless-mcp` changes | yes |
| Glitchless Cloud's side: rooms and survey templates in its control table, files in S3, who may organise, who votes, the join page after sign-in, jam events in Glitchless's own analytics | the hosted service | no |
| The bucket and the `/r/*` path on play.glitchless.gg | prepared with the hosted service's infrastructure, created by the owner | no |

The core never imports from the hosted service: Glitchless Cloud passes its own store, file host and hooks into
`createApp({ rooms })`, as it does today for `auth`, `stores` and `known`.

## 2. Data model

**Nothing is built on Glitchless's side.** The maker's agent builds the game on the maker's own computer, as it
always does (`npm run build` → `dist/`). Publishing uploads that folder of static files. Glitchless stores the files
and a static host serves them: CloudFront from S3 on Glitchless Cloud, so players' requests never reach a Glitchless
server, and the open-source server's second port. In this document an **upload** is one such folder, published
once.

**Room**

```js
{
  code: 'K7Q2M',          // 5 characters from 23456789ABCDEFGHJKMNPQRSTVWXYZ (no 0/O, 1/I/L, U): 24 million codes.
                          // Shown in capitals, read in any case.
  title: 'Generative AI DC mini jam', about: '…',   // ≤ 80 and ≤ 280 characters, shown on the arcade
  owner: 'default',       // who organises it: the host's id (open source: the project; Cloud: 'ws:<workspaceId>')
  created_at,
  closes_at,              // the jam ends here at the latest (default 24 h after it's made, at most 7 days)
  ended_at: null,         // when it ended: the organiser pressed End the jam, or closes_at passed
  joining: true,          // the organiser can stop new games joining while the joined ones keep publishing
  max_games: 60,          // up to 200
}
```

**Game in a room** (an entry: one game, in one room)

```js
{
  slug: 'neon-dash',      // [a-z0-9-], 2–32, unique in the room, made from the title; the path part of its URL
  title: 'Neon Dash', by: 'Banjo',   // what the arcade shows; `by` is optional free text, never an email
  project: 'p_…', service: 'neon-dash',   // which game it is. Private: never in a public answer
  joined_at,
  uploads: [{ n: 1, version: '1.0.0', files: 23, bytes: 812345, published_at, agent: 'claude-code' }],
                          // in publish order; `agent` is the MCP client that published it (or 'cli')
  current: 1,             // the upload its URL plays
  pending: null,          // an upload in progress: { n, version, manifest, received, expires_at }
}
```

**Vote**: `{ voter, slug, at }`, one per voter per room, changed as often as the voter likes until the jam ends.
`voter` is the host's id for the person (§7); it never leaves the server.

**Files on disk or in S3**: a static layout any static host can serve, the way Glitchless% lays out rounds:

```
<CODE>/<slug>/<n>/…            the upload's files (index.html at its root), never changed
<CODE>/<slug>/index.html       a copy of the current upload's index.html with <base href="/r/<CODE>/<slug>/<n>/">
```

Moving a game to its new upload is one write (the copy), and the uploaded files are cached for good. Because of
the `<base>` copy, games must be built with **relative paths** (`vite build --base ./`); publish checks for it
(§5). The open-source server keeps rooms in `<data>/rooms/<CODE>.json` and the layout under `<data>/rooms/files/`;
Glitchless Cloud keeps rooms in its control table and the layout in a private bucket.

**Ending and deleting.** When the jam ends, publishing and voting stop, the numbers freeze, the awards appear, the
room writes its **snapshot** (§7b) and opens its **survey** (§7c). **24 hours later the room is deleted**: its
files, games and each person's vote. The snapshot stays (§10, decision 6). Makers keep their own games' data in their
own workspaces, as for any game. The organiser can delete a room, and its snapshot, sooner. A code is never given
to another room while its snapshot is kept.

## 3. Addresses

| What | Glitchless Cloud | Open-source server |
| --- | --- | --- |
| The organiser's home (signed in) | `jam.glitchless.gg` | `http://<host>:7777/jam/` |
| Arcade, with voting (public) | `jam.glitchless.gg/K7Q2M` | `http://<host>:7777/jam/K7Q2M` |
| Big screen (public) | `jam.glitchless.gg/K7Q2M/live` | `http://<host>:7777/jam/K7Q2M/live` |
| Join page (signed in) | `jam.glitchless.gg/K7Q2M/join` | the same page, with the server's own setup steps |
| Survey (public, for 7 days after the end) | `jam.glitchless.gg/K7Q2M/survey` | `http://<host>:7777/jam/K7Q2M/survey` |
| A game (public) | `play.glitchless.gg/r/K7Q2M/neon-dash/` | `http://<host>:7778/r/K7Q2M/neon-dash/` |

Games never share an origin with the dashboard or the API: on the open-source server they are on their own port
(`GLITCHLESS_PLAY_PORT`, default 7778), which browsers treat as another origin for storage. All of a room's games
do share one origin with each other (§10, decision 1).

## 4. API

Every route is in the core. Public reads need nothing, are cached for 15 seconds (`Cache-Control: public`) and are
rate limited per address. Writes go through the host's hooks.

| Route | Who | Does |
| --- | --- | --- |
| `GET /v1/rooms/{code}` | anyone | the arcade: the room's title, about, whether it has ended, and each published game's title, by, URL, version and when it was last published |
| `GET /v1/rooms/{code}/live` | anyone | the big screen's numbers (§6); after the end, the awards (§7) |
| `GET /v1/rooms/{code}/qr.svg?game={slug}` | anyone | the QR code of the arcade, or of one game |
| `GET /v1/rooms/{code}/vote` | a voter | their own vote, and the games they can't vote for (their own) |
| `PUT /v1/rooms/{code}/vote` | a voter | `{slug}` (or `null` to take it back), until the jam ends |
| `GET /v1/rooms/{code}/survey` | anyone | the survey's questions, and the caller's own answers if they gave some |
| `PUT /v1/rooms/{code}/survey` | anyone, once each | `{answers: {question: answer}}`, for 7 days after the end; answering again replaces them |
| `GET /v1/rooms/{code}/snapshot` | its organiser | the snapshot (§7b) as JSON, or `?format=csv` for one row a game |
| `PATCH /v1/rooms/{code}/survey` | its organiser | sets the survey's heading, intro and questions, by hand or from a template (§7c), until its first answer |
| `GET`, `PUT`, `DELETE /v1/rooms/templates[/{id}]` | an organiser | their survey templates, beside the built-in default |
| `POST /v1/rooms` | an organiser | `{title, about?, hours?, max_games?}` → the room and its code |
| `GET /v1/rooms` | an organiser | their rooms, past jams (snapshots) included |
| `PATCH /v1/rooms/{code}` | its organiser | `{title?, about?, closes_at?, joining?, end: true}`; `end` ends the jam now |
| `DELETE /v1/rooms/{code}` | its organiser | the room, its games, files and votes, gone |
| `POST /v1/rooms/{code}/games` | a game's maker | joins: `{title?, by?, service?}` → the entry (Cloud: the game named by `x-glitchless-project`; open source: `service` names it) |
| `PATCH /v1/rooms/{code}/games/{slug}` | its maker | `{title?, by?}` |
| `DELETE /v1/rooms/{code}/games/{slug}` | its maker, or the organiser | leaves (maker) or removes (organiser); its files are deleted and its URL says the game is gone |
| `GET /v1/rooms/{code}/games/{slug}` | its maker | its uploads and its plays by version, for the improve step |
| `POST /v1/rooms/{code}/games/{slug}/uploads` | its maker | starts an upload: `{version, files: [{path, bytes, sha256}]}` → `{n, send: [paths]}`; every limit in §8 is checked here, from the list |
| `PUT /v1/rooms/{code}/games/{slug}/uploads/{n}/files/{path}` | its maker | one file, at most 4 MB (Glitchless Cloud's request limit); its size and SHA-256 must match the list |
| `POST /v1/rooms/{code}/games/{slug}/uploads/{n}/publish` | its maker | once every file is in, the game plays this upload → `{url, version, n, qr_text, qr_svg}` |

- **Makers** are any reader with the `dashboard` scope on the game's project: a workspace key from signing in, a
  game's secret key with that scope, or a member's dashboard session. No new scope, so nobody signs in again.
- **Organisers** come from a new optional hook, `auth.resolveOrganiser(req) → { owner, limits }`. The open-source
  default is whoever passes `resolveReader` (with `GLITCHLESS_API_KEY` set, whoever holds it). Glitchless Cloud's
  answers for a workspace key or a dashboard session, only for workspaces on an allow-list in its config
  (`GLITCHLESS_ROOM_ORGANISERS`).
- **Voters** come from another, `auth.resolveVoter(req) → { voter, own }` (§7).
- **Publishing joins.** A first publish to a room the game hasn't joined joins it, so one command is enough.
- An upload not published within 30 minutes is dropped with its files.

## 5. `glitchless-jam`: the jam's MCP server and CLI

A package of its own, so the production MCP server stays about the games developers ship. Its sign-in is
Glitchless's: it uses the same saved sign-in file as `glitchless-mcp login` (signing in to either signs in both), or
`npx -y glitchless-jam login`, or `GLITCHLESS_URL` and `GLITCHLESS_API_KEY` for a self-hosted server. It runs on the
maker's computer only, since publishing reads the game's folder there; it is not on the hosted MCP server.

```bash
claude mcp add glitchless-jam -- npx -y glitchless-jam        # the MCP server, for the agent
npx -y glitchless-jam publish dist --room K7Q2M               # the same publish, from a terminal
```

**One tool for makers**, `glitchless_jam`, with an `action`:

| Action | Does |
| --- | --- |
| `join` | `{room, game?, title?, by?}`: joins the room with this game (the workspace's only game, or `game`) |
| `publish` | `{dir, room?, version?}`: checks and uploads the folder, and answers with the link, the version and the QR code as text, which the agent shows the person |
| `status` | the room: its games and their plays, whether it has ended, the awards and the survey link once it has; and this game's plays by version and what share hit a problem |
| `leave` | takes the game out of the room |

The tool remembers the room after `join`. Reading what hurts players stays with the production tools
(`glitchless_triage`, `glitchless_compare_versions`), which work on jam games like any other.

**The organiser's side** is the dashboard's Rooms page (make a room, see its games, remove one, End the jam,
delete; the survey and its templates; past jams with their snapshots and survey answers), and for the organiser's
own agent a second tool in the same server, `glitchless_jam_host` (§10, decision 8), with the same commands in the CLI:
`glitchless-jam host create "Title" [--hours 24] [--template meetup]`, `host list`, `host remove K7Q2M neon-dash`,
`host end K7Q2M`, `host survey K7Q2M …`, `host template …`, `host report K7Q2M [--csv]`. It stays out of the makers' tool, so a maker's agent
never sees it.

**What publish checks before it sends anything** (on the maker's computer, so the agent gets a fix it can act on):

1. `index.html` is at the root of the folder.
2. Relative paths: an `index.html` that loads `/assets/…` fails with "rebuild with `vite build --base ./`".
3. The version: `version` if given, else the one in the game's `Glitchless.init({ service, version })`, which
   minified bundles keep as a string. A version this game already published to the room fails ("bump the version
   passed to Glitchless.init, or both uploads' players count as one version"), since awards and the improve step
   compare versions.
4. Instrumented: a game that never names its service still publishes, with a warning that its plays won't count.
5. Source maps (`*.map`) stay out of the upload and go to `/v1/sourcemaps` instead, so errors show original lines
   and the source stays private.
6. The limits in §8, so nothing is refused half way.

The server checks every limit again on its own (§8).

## 6. What the big screen counts

For each game, from its first publish in the room until the jam ends (then frozen):

- **plays**: sessions of players (`session_type` user; no bots, playtests or test phones) on the versions it
  published to the room. A play is one person's session. Jam games keep the default anonymous mode, which has no
  player ID, so the big screen says plays; a game that keeps a player ID also shows its players.
- **playing now**, minutes played, plays on phones (iOS and Android), and when it was last published.
- Room totals: games published, games joined but not published yet ("still building"), plays, minutes played, and
  the share of plays on phones.

The big screen leads with **"Needs players"**: published games, the fewest plays first, each with its QR code, so
nobody's game sits unplayed. Then the three most played. When the jam ends it turns into the awards.

The numbers come from each game's own data through the same code the queries use (the store's summaries; no raw
event reads), one game at a time, at most once every 15 seconds a room. On Glitchless Cloud the counts trail by the
lake's compaction, a few minutes; playing now is live.

## 7. Awards

Worked out when the jam ends, from the frozen numbers and the votes. Each has a minimum, so a game with two plays
can't win, and none is given when no game qualifies. A tie for the vote is shared; the others go to the game with
more plays.

| Award | Who wins | Minimum | In plain words |
| --- | --- | --- | --- |
| Crowd favourite | the most votes | 3 votes | "Neon Dash: 9 votes" |
| Most played | the most plays; a tie goes to more minutes played | 3 plays | "Neon Dash: 23 plays, 41 minutes played" |
| Biggest improvement | the largest drop in the share of plays that hit a problem, from a game's first version in the room to its latest. A problem is an error, a crash, stutter (more than 1 in 10 frames late for the screen it ran on) or a rage quit | 3 plays on each version, a drop of at least 10 points | "Neon Dash: before the fix, 5 of 8 plays hit a problem; after it, 1 of 9" |
| Smoothest on phones | the most frames on time, over every play on a phone | 3 plays on phones | "Neon Dash: 97 of every 100 frames on time, over 12 plays on phones" |

**Voting** (for the crowd favourite, the fun or creative one):

- Each card on the arcade has a Vote button while the jam is on. One vote a person a room; voting again moves it.
- **You can't vote for your own game.** On Glitchless Cloud a voter is a signed-in person, and their own games are
  every game in the room from a workspace they're a member of: the arcade marks those "Your game" and the server
  refuses a vote for one. In a workshop every maker is already signed in on their laptop; someone else signs in
  with one button (and counts as a new sign-up).
- **No counts until the end.** No answer carries a tally before the jam ends, the organiser's included; a voter
  sees only their own vote. When it ends, the big screen shows the votes with the awards.
- The open-source server has no accounts, so its default `resolveVoter` counts one vote per browser and can't tell
  a maker's own game; a host can plug in its own hook.

## 7b. The snapshot

When the jam ends the room writes down what everyone did, so the organiser (and, on Glitchless Cloud, Glitchless)
can look back at a jam after its games are gone. It holds counts and the room's own records, never a player's data:

- **The room**: title, when it was made, ended, and how long it ran.
- **Each game**: title, by, when it joined, each upload (version, when, files, size, and the agent that published it:
  Claude Code, Codex, Cursor, goose or the CLI), and whether it left or was removed.
- **Each game's numbers**, frozen at the end: plays (and players where the game keeps an ID), minutes played, plays
  on phones, the most playing at once, and per version its plays and the share that hit a problem, by kind (errors,
  crashes, stutter, rage quits).
- **The room's funnel**: games joined, published, sending data (a play arrived), improved (a second version
  published), and fixed (a second version with fewer problems).
- **Votes**: each game's count and how many people voted. Who voted for what is never kept.
- **The awards**, and **the survey's answers** as they come in (§7c).

The organiser reads it on the Rooms page (past jams), downloads it as JSON or CSV, or asks for it with
`glitchless-jam host report`. On the open-source server it is the room's own file, with the games' files gone.

On Glitchless Cloud the jam also shows in Glitchless's own analytics (the owner's "glitchless.gg" game), as the
product's other steps do: `jam_joined`, `jam_published` (with the agent), `jam_voted` and `jam_survey_answered`
(with the answers to the multiple-choice questions, never what anyone typed). So the owner's board can split
developers by whether they came from a jam, and show whether jam makers keep building a week later.

## 7c. The survey

When the jam ends, the room asks everyone how it went: makers, and players who don't make games. The survey is part
of the snapshot, so it stays open for its 7 days after the room's games are deleted.

**Where people find it: right there in the room** (§10, decision 7). Nothing is emailed.

- When the jam ends, the big screen's biggest thing after the awards is the survey's QR code: people scan it and
  answer on their phone while they're still in the room.
- On a phone, the arcade puts "Tell us how it went" at the top once the jam has ended, for the 7 days it is open.
- `glitchless_jam status` gives its link after the end, so a maker's agent hands it to them.

**Templates.** A survey is a heading (default "How was {room}?", `{room}` being the room's title), an intro and up to 10
questions. An organiser keeps named templates of their own (a meetup's, a conference's) beside the built-in default,
picks one when making a room, and changes a room's survey (by hand, or from a template) until its first answer, after
the jam ends too.

**The questions** (the default template's):

| Question | Answer |
| --- | --- |
| How was the jam? | 1 to 5 |
| What did you like most? | text |
| What got in the way? | text |
| Do you want to make a game after this? | Yes, I'll keep building this one / Yes, a new one / Maybe / No |
| Would you use Glitchless on your next game? | Yes / Maybe / No |
| Which coding agent did you use? | Claude Code / Codex / Cursor / goose / Another (filled in from the agent that published, if there was one) |
| May Glitchless email you about your answers? | Yes / No |

**Who and how often.** One set of answers a person: on Glitchless Cloud a signed-in person (with their game, if they
made one), otherwise one a browser, rate limited per address. Answers can be changed while the survey is open.
Text answers are at most 1,000 characters. They go into the snapshot, which only the organiser reads. A person's
email goes in with their answers only when they said yes to the last question.

## 8. Abuse limits

Anyone with a free account could otherwise put any page on a glitchless.gg address, so the first version keeps
room-making narrow and treats every upload as hostile.

**Who can make rooms.** On Glitchless Cloud, only allow-listed workspaces (the owner's, to start). Makers can only
join a room whose code they have, while it is on and joining. Opening room-making to every workspace waits for a
separate domain for games (§10, decision 1).

**Limits** (the server's; an organiser can lower the games a room takes):

| Limit | Value |
| --- | --- |
| An upload | 25 MB, 400 files, 4 MB a file, paths of `[A-Za-z0-9._-/]` up to 200 characters, no `..`, no dotfiles |
| File types | an allow-list by extension, served with the type the server picks (never the uploader's): html, js, mjs, css, json, txt, csv, xml, png, jpg, gif, webp, avif, svg, ico, glb, gltf, bin, ktx2, hdr, wasm, pck, data, mp3, ogg, wav, m4a, opus, webm, mp4, woff, woff2, ttf, otf, and game data such as tmj, tsj, tmx, atlas, fnt |
| Pages | an HTML file with a password field is refused: a game never needs one, a phishing page always does |
| Rate | 12 uploads a game an hour, 60 a game in one room; public reads, votes and survey answers per address |
| A room | 60 games (up to 200), 2 GB of files, on for at most 7 days, deleted 24 hours after it ends |
| An organiser | 3 rooms on at once |

**How games are served** (the same headers from the open-source server and from CloudFront):

- `Content-Security-Policy`: scripts, styles and fonts from the page itself and four CDNs (jsdelivr, unpkg, cdnjs,
  esm.sh; vibe-coded games load three.js and Phaser from them), Google Fonts; network calls only to the page,
  those CDNs and the host's intake; `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`. It can't stop
  a hostile page, but it stops a game calling other hosts from players' phones (trackers, ads, mining pools).
- `Permissions-Policy` off for the camera, microphone, location, payments, USB, serial and Bluetooth (motion,
  gamepads, fullscreen and vibration stay on), `Cross-Origin-Opener-Policy: same-origin` so one game's window can't
  reach another's, `X-Content-Type-Options: nosniff`, and `X-Robots-Tag: noindex` on games and the arcade.

**Taking something down.**

- The organiser removes a game on the Rooms page, or with `glitchless-jam host remove`: off the arcade and the big
  screen, its files deleted, its URL says the game was taken down, and it can't rejoin that room.
- The maker leaves the same way.
- Every arcade card has a **Report** link: an email to the host's abuse address (Glitchless Cloud:
  support@glitchless.gg; open source: `GLITCHLESS_ABUSE_EMAIL`, else no link) with the room and the game in it.
- Glitchless staff remove any room or game with a takedown script in the hosted service, which deletes the files
  and invalidates their paths on CloudFront.
- The 24-hour delete runs on a schedule that already exists on Glitchless Cloud (no new AWS resource) and hourly on
  the open-source server; a lifecycle rule on the bucket deletes anything older than 9 days in case it misses.

## 9. What the public pages show, and never show

- **Arcade** (phone first; a grid of large QR codes at projector width): the room's title and about, whether the
  jam is on, each published game's title, by, a Play button, its QR code, its version, "new" for a publish in the
  last 10 minutes, a Vote button while the jam is on, and a Report link. A line for makers: "Making a game? Tell
  your agent to join room K7Q2M." After the end: the awards and the survey link, until the room is deleted.
- **Big screen**: §6, the room's own QR code (to the arcade) large, and when the jam ends, the awards and the
  survey's QR code.
- **Survey** (§7c): the questions, one screen on a phone, and "Thanks" after.
- **Join page** (the attendee's first ten minutes; signed in): on Glitchless Cloud, sign in with one button (the code
  is kept through sign-in, as a promo code is), make a game with one button or pick one, join, then copy one prompt
  that adds `glitchless-jam` and the Glitchless MCP server to the agent and names the room. On the open-source
  server it shows the server's own MCP commands and the code.
- **Never**: workspaces, projects, emails, keys, voters, vote counts before the end, survey answers, the snapshot (the organiser's only), session or player IDs, devices
  beyond phone or computer, error messages, or anything about a game that hasn't joined. A removed game disappears
  from all of them.
- **The words.** Players play games and the room counts plays; nowhere says Glitchless sees or watches anyone.

## 10. The owner's decisions (5 November 2026)

1. **Where games live: approved.** `play.glitchless.gg/r/<CODE>/<slug>/`, one more path on Glitchless%'s
   distribution, from a bucket of its own. Every game in every room then shares one origin: games'
   `localStorage` keys can collide (the jam starter prefixes them with the slug), the SDK's stored player ID and off
   switch are shared across games (harmless in the anonymous mode jam games use), and one phishing page could get
   play.glitchless.gg flagged, which the allow-list makes unlikely. Before room-making opens to everyone, games move
   to a separate domain with a subdomain per game (`neon-dash--k7q2m.<domain>`), which removes all three.
2. **Who makes rooms: approved.** An allow-list on Glitchless Cloud (the owner's workspace), and whoever holds the
   server's key on the open-source server.
3. **How long games stay: 24 hours after the jam ends**, then the room, its games' files and each person's vote are
   deleted. Only the snapshot stays (decision 6).
4. **Crowd favourite: an award, by vote.** Nobody votes for their own game, and no counts show until the end (§7).
5. **A separate jam tool.** Rooms and publishing are `glitchless-jam`, not tools in `glitchless-mcp`, and makers
   get one tool for everything they do in a jam (§5).
6. **A snapshot of every jam, and a survey** (§7b, §7c), asked for the same day. Open: how long the snapshot stays.
   Recommended: a year, then it is deleted, which the privacy policy says. It holds counts, but also what people
   typed into the survey, and the emails of those who agreed to be contacted.
7. **The survey is a page, not an email** (the owner, later that day): people scan it from the big screen as the
   jam ends and answer while they're still there. Organisers keep survey templates (a heading, an intro, questions)
   to change per event.
8. **The organiser's agent runs the jam too**: `glitchless-jam` has `glitchless_jam_host` beside the makers' tool, for
   rooms, the survey and its templates, ending the jam and the report.

## 11. What the owner creates on AWS (prepared, not created)

- A private S3 bucket for games' files, encrypted, public access blocked, a lifecycle rule that deletes objects
  after 9 days, with the cloud function's role allowed to put, get, list and delete in it.
- On the play.glitchless.gg distribution (Glitchless%'s stack): a `/r/*` behaviour with that bucket as its origin
  (origin access control), a viewer-request function that maps `/r/<CODE>/<slug>/` onto `<CODE>/<slug>/index.html`,
  the response headers in §8, and the cloud function's role allowed to invalidate it.
- Config: `GLITCHLESS_ROOMS_BUCKET`, `GLITCHLESS_PLAY_URL=https://play.glitchless.gg/r/`,
  `GLITCHLESS_PLAY_DISTRIBUTION`, `GLITCHLESS_ROOM_ORGANISERS`.
- The first npm publish of `glitchless-jam` (2FA in a terminal tab).
- Not AWS, but the owner's: a line in Glitchless's privacy policy for jams (the snapshot, the survey's answers and how
  long they're kept).

The local cloud (`glitchless-cloud`, port 7788) needs none of these: it keeps files in a folder and serves them on a
second port, as the open-source server does.

## 12. Docs, skills and tests

- **SPEC**: "3j. Jam rooms" (the API, the layout, the counts, voting, the awards, the snapshot, the survey, the
  limits and headers) and the rooms store, `resolveOrganiser` and `resolveVoter` in §6.
- **Setup prompt** (`docs/agent-setup-prompt.md`): a short "In a jam room" step: add `glitchless-jam`, build with
  relative paths, instrument, publish, and bump the version before publishing a fix.
- **Skills**: the instrument skill gets the same step; triage says "publish again" after a fix in a jam. Boards don't
  change, so the dashboard skill stays as it is. `node scripts/sync-agent-plugin.mjs` after. `glitchless-jam` is not
  bundled into the Claude plugin; the jam's setup prompt adds it.
- **Tests**:
  - the core: rooms, joining, every limit, the publish checks, the pointer and its `<base>`, the counts, each award
    and its minimums, voting (own game refused, no tallies before the end), ending, the snapshot (and that it keeps
    no voter's choice), the survey (one set a person, closing after 7 days), the 24-hour delete leaving the snapshot,
    and the public answers leaving out what §9 says;
  - the QR encoder against fixed codes;
  - `glitchless-jam`'s tool and CLI against a local server;
  - the cloud's store, the organiser allow-list, voters, games from several workspaces in one room, survey templates
    in the control table, no survey email, and the jam events in own analytics;
  - an e2e on the local cloud: a room, two browser games published from two workspaces, plays from a desktop
    browser and a 375 px phone viewport, both games on the arcade and the big screen with working QR codes, votes,
    End the jam, the awards, a survey answered, and the snapshot.

## 13. Not in the first version

Multiplayer servers or WebSockets to other hosts; Unity and Godot web exports that need compressed files served with
`Content-Encoding` or cross-origin isolation; a subdomain per game; voting without an account on Glitchless Cloud
(a pass scanned from the laptop to the phone); a room with several rounds; uploading straight to S3 with presigned
URLs (per-file uploads through the API fit a jam's games).

9. **The jam has its own address**, apart from the dashboard (the owner, later that day): jam.glitchless.gg on
   Glitchless Cloud (the organiser's home at its root, rooms at jam.glitchless.gg/<CODE>), `/jam/` on a self-hosted
   server. People sign in on it through the app with a one-time code, so the cloud's sign-in needs no new callback.

## 14. Built (5 November 2026)

Where the build differs from the design above:

- **The open-source server's games port** is `PORT + 1000` (8777 for 7777; `GLITCHLESS_PLAY_PORT`), not 7778, so it
  never lands on another local server's port; the local cloud's is 8788. A port in use leaves rooms without games, not
  the server down. `GLITCHLESS_PUBLIC_URL` is where phones reach the server (the arcade's links and QR codes).
- **Rate limits.** A room's phones usually share the venue's one address, so public reads are limited loosely per
  address (20 a second) and votes and survey answers per person (5 a second), with a loose limit per address.
- **Removing a game**: the organiser sends `DELETE …/games/{slug}?by=organiser`; without it, the maker leaves.
- **QR codes** are drawn by `server/src/qr.js`, which runs in the browser too: the arcade draws its codes without a
  request each. Its output matches the `qrcode` npm package module for module.
- **On a laptop**, Glitchless Cloud lets anyone signed in organise when `GLITCHLESS_ROOM_ORGANISERS` is empty;
  production with no list lets nobody.
- **AWS** is prepared as its own stack, `glitchless-rooms` (the hosted service's rooms stack script, run with the owner's `--yes`), which
  the deploy picks up once it exists; until then rooms are off in production. The play distribution's `/r/*`
  behaviour is described for the Glitchless% stack, not changed there.
