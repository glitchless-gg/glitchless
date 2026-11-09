# glitchless-jam

Jam rooms for [Glitchless](https://github.com/glitchless-gg/glitchless). At a game jam the organiser makes a room and
shares its code (like `K7Q2M`). Each maker's coding agent joins the room and publishes the game's build in one call,
then shows the maker a link and a QR code to play it on a phone. Everyone plays everyone's games from the room's
arcade, a big screen shows which games need players, and when the jam ends the room hands out awards and asks how it
went. An online jam's room runs up to 21 days, and its games can stay on itch.io: the maker links each version there
instead of publishing it, and the room counts its plays all the same.

It's a package of its own, apart from [`glitchless-mcp`](https://www.npmjs.com/package/glitchless-mcp) (the MCP server for the games you ship), and it runs
on your computer, since publishing reads your game's build folder there.

```bash
claude mcp add glitchless-jam -- npx -y glitchless-jam        # the MCP server, for your agent
npx -y glitchless-jam publish dist --room K7Q2M               # the same publish, from a terminal
npx -y glitchless-jam link https://you.itch.io/game --room K7Q2M --version 1.0.1   # a version on itch.io
```

## Signing in

`glitchless-jam` uses Glitchless's own sign-in, the same one as `glitchless-mcp`: if you ran
`npx -y glitchless-mcp login`, you're signed in here too, and `npx -y glitchless-jam login` signs in both. `whoami`
shows where you're signed in and `logout` signs out of both. On a self-hosted Glitchless server (a meetup's own box),
set `GLITCHLESS_URL` to it, and `GLITCHLESS_API_KEY` if it has a key; a saved Glitchless Cloud sign-in is never sent to
another server.

## For makers: `glitchless_jam`

The maker's tool, with an `action`:

| Action | Takes | Does |
| --- | --- | --- |
| `join` | `room`, `game?`, `title?`, `by?`, `service?` | joins the room with this game (with a Glitchless Cloud sign-in, `game` names the workspace game; the only one by default) |
| `publish` | `dir`, `room?`, `version?`, `game?`, `title?`, `by?`, `service?` | checks the built folder and uploads it, joining first if needed; answers with the game's link, its version and a QR code drawn in text, for the agent to show you |
| `link` | `url?`, `version?`, `dir?`, `room?`, `game?`, `title?`, `by?`, `service?` | for a game played on itch.io: registers a version, joining first if needed. Nothing is uploaded; the room counts that version's plays and the arcade sends players to the page. `url` the first time; `version` read from `dir` (the web export) when its scripts have it |
| `status` | `room?` | the room's games and their plays, which need players most, and your game's plays by version with the share that hit a problem; after the end, the awards and the survey link |
| `leave` | `room?` | takes your game out of the room |

It remembers the room and your game after `join`, `publish` or `link`. A room takes at most 60 versions a game and 12
an hour, published or linked, each version once, until the jam ends.

## A game on itch.io

For an online jam whose games are on itch.io: export the game for the web, zip the folder with `index.html` at the
root of the zip, and upload it to the game's itch.io page as an HTML5 game (kind of project: HTML, played in the
browser). Then link the version:

```bash
npx -y glitchless-jam link https://you.itch.io/your-game --room K7Q2M --dir dist   # or --version 1.0.0
```

The page is `https://<name>.itch.io/<game>`, nothing after it: no other site, not the `itch.zone` frame itch.io plays
the game in, and not a draft's secret link (make the page public first). Later links reuse it. The game must send to a
Glitchless address its players reach (Glitchless Cloud, or a server on the internet), not `localhost`. Before linking a
fix, bump the version passed to `Glitchless.init`, upload the new build to the same page, then link it: the "biggest
improvement" award compares the first version with the last. A game links or publishes, not both.

## What publish checks first

Before it sends anything, so your agent gets a fix it can act on:

- `index.html` is at the root of the folder (publish `dist`, not the project);
- the game loads its files with relative paths: build with `vite build --base ./`;
- every file is a type the room serves, at most 400 files, 4 MB a file and 25 MB in all, and no page has a password field;
- the version: `version` if given, else the one the build passes to `Glitchless.init({ service, version })`. Each
  publish needs a new version, so bump it before publishing a fix;
- source maps (`*.map`) stay out of the room and go to Glitchless instead, so errors show your original lines and your
  source stays private.

A build that never names a service in `Glitchless.init` still publishes, with a warning that its plays won't count.

## For organisers: `glitchless_jam_host`

The organiser's tool, in the same server. It works only for the jam's organiser: on Glitchless Cloud, workspaces the
service lets make rooms; on a self-hosted server, whoever holds its key. A maker's key gets "not an organiser".

| Action | Takes | Does |
| --- | --- | --- |
| `create` | `title`, `about?`, `hours?`, `max_games?`, `template?`, `online?` | makes a room: its code, the arcade, big-screen and join links, and the arcade's QR code as text. Put the big screen on the projector. `online: true`: a jam over days, up to 504 hours (21 days) instead of 168, kept 7 days after it ends |
| `list` | | your rooms, and past jams whose snapshots stay |
| `update` | `room`, `title?`, `about?`, `hours?`, `joining?` | changes a room: `hours` closes it that many hours from now, `joining: false` stops new games joining |
| `end` | `room` | ends the jam now: publishing and voting stop, the awards are given and the survey opens |
| `remove_game` | `room`, `game` | takes a game out for good, by its title or the end of its link |
| `delete` | `room` | deletes the room, its games, votes, survey answers and snapshot |
| `survey` | `room`, `template?` or `heading?`, `intro?`, `questions?` | sets the survey people answer when the jam ends (until its first answer, even after the end); with nothing to change, shows it as people will see it |
| `templates` | | your survey templates, the built-in `default` first |
| `save_template` | `id?`, `name`, `heading?`, `intro?`, `questions?`, `from_room?` | saves a template; `from_room` copies a room's survey as it is set |
| `delete_template` | `id` | deletes one of your templates |
| `report` | `room` | after the end, the jam's snapshot: how long it ran, the games from joined to fixed, plays, votes, the awards and the survey's answers (averages and counts), in plain words and then as JSON |

A room's pages (the arcade, the big screen, the join page and the survey) and the organiser's own page are on the
jam's own address, not the dashboard: jam.glitchless.gg on Glitchless Cloud, `/jam/` on a self-hosted server. The
tool and the commands give each room's links as the server answers them.

`end`, `delete`, `remove_game` and `delete_template` can't be undone, so the tool is marked destructive and tells the
agent to ask first. The same, from a terminal:

```bash
npx -y glitchless-jam host create "GenAI DC mini jam" [--hours 24] [--online] [--about "…"] [--max-games 60] [--template meetup]
npx -y glitchless-jam host list
npx -y glitchless-jam host update K7Q2M [--title "…"] [--about "…"] [--hours 2] [--joining off]
npx -y glitchless-jam host end K7Q2M
npx -y glitchless-jam host remove K7Q2M neon-dash
npx -y glitchless-jam host delete K7Q2M
npx -y glitchless-jam host survey K7Q2M [--template meetup] [--heading "…"] [--intro "…"] [--file questions.json]
npx -y glitchless-jam host template list
npx -y glitchless-jam host template save meetup --name "Meetup" [--file meetup.json] [--heading "…"] [--intro "…"] [--from-room K7Q2M]
npx -y glitchless-jam host template delete meetup
npx -y glitchless-jam host report K7Q2M [--csv]
```

`host create` prints the room's links and the arcade's QR code, and `host survey` with nothing to change prints the
survey as people will see it. `host report` prints the snapshot as JSON (or CSV, a row a game).

### A survey template

A template is a heading, an optional intro and up to 10 questions. `{room}` in the heading or intro is the room's
title. A question is a `scale` (1 to 5), a `choice` (2 to 8 options) or `text` (written, up to 1,000 characters).
Save it with `host template save meetup --file meetup.json`, or give `--file` a plain list of questions:

```json
{
  "name": "Meetup",
  "heading": "How was {room}?",
  "intro": "Three questions, then grab a slice.",
  "questions": [
    { "id": "rating", "kind": "scale", "text": "How was the jam?" },
    { "id": "next", "kind": "choice", "text": "Come to the next one?", "options": ["Yes", "Maybe", "No"] },
    { "id": "idea", "kind": "text", "text": "What should we make next time?" }
  ]
}
```

## Settings

| Variable | What |
| --- | --- |
| `GLITCHLESS_URL` | A self-hosted Glitchless server. Default: the signed-in workspace's, else `http://localhost:7777` |
| `GLITCHLESS_API_KEY` | Its key, if it has one. Overrides a sign-in |
| `GLITCHLESS_ROOM` | The room to use when a call doesn't name one |

MIT licensed.
