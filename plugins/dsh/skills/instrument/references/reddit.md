# Reddit

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.

For a game in a Reddit post, on Reddit's Developer Platform (Devvit Web): `devvit.json` at the root, `src/client`
(a web game, or a Unity or Godot web build) and `src/server` (the app's Node server, Hono in Reddit's templates). The
game in the post may fetch only its own app's `/api/` routes, so it sends to `/api/glitchless`, and the app's server
passes that on with `glitchless/devvit`, adding the subreddit and the post. Set up that relay here, then the game with
its engine's steps.

## 1. Let the app's server reach Glitchless (first: Reddit reviews it)

In `devvit.json`, merged into what's there:

```json
"permissions": { "http": { "enable": true, "domains": ["api.glitchless.gg"] } }
```

Reddit reviews a new domain when the app is next playtested or uploaded, usually in 1 to 2 business days; until
then the relay answers 502 and the SDKs keep the batches. Reddit games send to Glitchless Cloud: Reddit approves
documented APIs, not a server on the developer's own domain, and a playtest runs on Reddit's servers, which can't reach
`localhost`. With no Glitchless Cloud workspace, say so and stop here.

## 2. Mount the relay in the app's server

In the app's folder: `npm install glitchless` (0.8.0 or later, the first with the relay). It has no dependencies and goes into the server's bundle. In Reddit's
templates the API routes are `src/server/routes/api.ts`, mounted at `/api`:

```ts
import { context } from '@devvit/web/server';
import { glitchlessRelay } from 'glitchless/devvit';

const glitchless = glitchlessRelay({ clientToken: '<the game client token>', context });
api.all('/glitchless/*', (c) => glitchless.fetch(c.req.raw));
```

On the app itself (no `/api` sub-router) it's `app.all('/api/glitchless/*', …)`. Node's own server (the hello-world
template): first thing in its request handler, `if (req.url?.startsWith('/api/glitchless/')) return glitchless.node(req, res);`.
Express: `app.use('/api/glitchless', glitchless.node)`. The intake defaults to `https://api.glitchless.gg`; pass
`intake` only if `glitchless_create_game` gave another.

## 3. Send from the game to `/api/glitchless`

Set the game up with its engine's steps (they follow this part when the files named the engine; otherwise call
`glitchless_create_game` again with `engine` and `files: ["devvit.json"]`), with these changes:

- intake URL `/api/glitchless`, a path on the post's own page: `intake: '/api/glitchless'` (web games); Unity
  `Intake = "/api/glitchless"`; Godot `Glitchless.init("<game-id>", version, "prod", "/api/glitchless")`. The client
  token stays in the init as the steps show.
- A web game installs `glitchless` in the client too (the same package).

In a post the SDKs send the batches left as the page goes by the page's own fetch, which carries the app's token (a
beacon can't), keep the `webmcp.dev` widget out, and draw the overlay under the post's Content-Security-Policy. A Godot
export's HTML shell has an inline script: if the post stays blank and the console says an inline script was refused,
move it into a `.js` file next to the page. Unreal web builds aren't tested in a post yet. GameMaker can't send from a
post yet: its HTML5 runner's `http_request` doesn't carry the app's token, and the GameMaker SDK can't add it; say so.

## 4. Privacy, and what Reddit asks for

- Every session through Reddit is anonymous: the relay drops a stored player ID (install mode becomes anonymous;
  Reddit also clears a post's browser storage with each app version, so the ID wouldn't last), and replaces the
  playing redditor's username and user IDs with `<redditor>` wherever the game put them. Still, never pass a Reddit
  username, user ID, snoovatar or flair to Glitchless (properties, events, errors). For players coming back, Reddit's
  own numbers answer: the app's Analytics tab and Devvit Journeys (step 5).
- The player's off switch is kept in browser storage, which an app update clears: a game with the setting keeps the
  choice itself (Redis, per user, through its own `/api/` route) and calls `setEnabled` with it at start.
- Devvit's rules ask for an app README written for players, with a "Fetch Domains" section, and links to the app's
  own Terms and Privacy Policy in its details on developers.reddit.com (Reddit's own policies aren't accepted). Add this
  to `README.md`:

```markdown
## Fetch Domains

- `api.glitchless.gg`: Glitchless (https://www.glitchless.gg), which measures how the game runs and is played. The
  app's server sends it how each play session ran (frame times, loading time, errors), what happened in the game
  (levels started and finished, the game's own events), the browser, OS and screen size, and the subreddit and post
  it was played in. No Reddit username, user ID or other personal data is sent, and nothing ties one session to
  another. API: https://github.com/glitchless-gg/glitchless/blob/main/docs/SPEC.md
```

  The game's privacy policy says the same to players, linking Glitchless's (https://www.glitchless.gg/privacy.html).
  The Terms are the user's own; Glitchless's (https://www.glitchless.gg/terms.html) are between them and Glitchless.

## 5. Devvit Journeys, from the same places

Reddit's Journeys feed its Analytics tab and its hackathons' judging. Offer to fire them where the game calls
Glitchless (`"journeys": true` in `devvit.json`'s permissions, and Reddit's telemetry router on the server, as its
Journeys docs show; nothing personal in `action`):

```js
import { telemetry } from '@devvit/analytics/client/reddit';
telemetry.appReady(); // the first frame
glitchless.levelStart(day); telemetry.startJourney(); // the player's Play, never the page load
telemetry.progress({ progress: 0.6, action: 'checkpoint' }); // 0 to 1
glitchless.levelComplete(day, { score }); telemetry.endJourney({ complete: true, game: { win: true, score } });
glitchless.levelFail(day); telemetry.endJourney({ complete: false, game: { win: false, score } });
```

## 6. Verify

`npm run dev` (a playtest) prints a URL; open it, play a level, and leave the post. Then `glitchless_session` lists
the session with the properties `subreddit` and `post`. Nothing yet: in the browser's network tab, a 502 from
`/api/glitchless/v1/intake` means Reddit hasn't approved `api.glitchless.gg` yet (or the server can't reach it); a
404 means the relay isn't mounted at that path; a 401 or 403, that the client token isn't the relay's.
