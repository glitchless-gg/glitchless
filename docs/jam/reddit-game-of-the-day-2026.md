# Glitchless for Reddit's Game of the Day Hackathon 2026

Reddit's hackathon (Reddit also calls it the Daily Games Hackathon) asks for a daily game that runs inside a
Reddit post, built on Devvit Web. Glitchless lets your coding agent understand the people who play it: whether they
get through today's puzzle and where they stop, how long a daily takes, which day was too hard, what breaks on their
phones, and how the game runs on them. Your agent reads all of it over MCP and fixes what players hit, starting with
your own playtests. Jam teams get the jam tier free with the code `JAM26`.

- Hackathon page: https://redditgameofday2026.devpost.com/
- Official rules: https://redditgameofday2026.devpost.com/rules
- Devvit Web: https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview

| When | What |
| --- | --- |
| Nov 11, 2026, 12:00 PM PT | Submissions open |
| Dec 8, 2026, 6:00 PM PT | Submissions close |
| Dec 9 to 16 | Judging |
| Around Dec 17, 3:00 PM PT | Winners announced |
| Jan 31, 2027, 23:59 UTC | The `JAM26` jam tier ends |

$35,000 in prizes: Best Daily Game ($15,000), Best Ported Daily Game ($6,000, for a game whose original you own; say
it's a port), ten honorable mentions ($1,000 each), six Devvit Helper awards ($500, for helping others on r/Devvit and
in Reddit's Discord) and five feedback awards ($200, for Reddit's developer survey). A project wins one prize at most.
Judges score four things equally: Delightful UX, Polish, how Reddit-y it is, and Daily Content.

## What the rules mean for Glitchless

- **Outside services are allowed** when you use them within their own terms (the rules' "Third Party Integrations").
  Glitchless's SDKs are open source (MIT).
- **It must run on Reddit and follow Devvit's rules.** A post can't reach outside services itself, so your app's own
  server passes the game's data on to Glitchless. For that the app asks Reddit for one domain, `api.glitchless.gg`,
  its README gets a "Fetch Domains" section, and its details on developers.reddit.com link your Terms and Privacy
  Policy. Your agent writes the README part and the privacy wording; the Terms are yours.
- **Upload and playtest, don't publish.** Reddit reviews a new domain the first time you playtest or upload the app,
  usually in 1 to 2 business days. Do that on day one, so data flows while you build.
- **Players stay anonymous.** Every session that comes through Reddit has no player ID, Reddit usernames and user IDs
  are scrubbed out, and the subreddit and post it was played in come along, so you can compare posts and days.
- **Journeys count.** The hackathon page lists "Journey Event Instrumentation" with Devvit Journeys among what makes
  a daily game stand out. Fire them from the same places the game tells Glitchless a level started or ended (below).
- **Engines.** Reddit names web games (React, Phaser, Three.js) and engines (Unity, Godot, GameMaker). Glitchless
  sends from a web game, a Unity web build and a Godot web export in a post. Not from GameMaker yet: GameMaker's web
  runner sends its requests without the token Reddit's `/api/` routes need, and Glitchless's GameMaker SDK can't add
  it yet.

## The jam tier: `JAM26`

| | Free | With `JAM26` |
| --- | --- | --- |
| Play sessions a month | 5,000 | 50,000 |
| People in the workspace | 1 | 5 |
| Data kept | 14 days | 90 days |

It's free, needs no card and runs until **January 31, 2027, 23:59 UTC**. Then the workspace goes back to Free on its
own: nothing is deleted.

## Set up (about 20 minutes, then a wait for Reddit)

1. **Sign up with the code:** https://app.glitchless.gg/?promo=jam26 (Google or GitHub). Already have an account?
   Settings → Plan & billing → Promo code → `JAM26`.
2. **Connect Glitchless to your coding agent.** In Claude, add the Glitchless connector; in any other agent, paste the
   prompt from Get started → "Any coding agent". Either way your agent can then make the game and its keys itself.
3. **Set it up.** Open your agent in your Devvit app's folder (the one with `devvit.json`) and paste:

   ```text
   Set up Glitchless for my Reddit game in this folder: call glitchless_create_game with the game's name and
   files: the files at this folder's root and package.json's dependencies (devvit.json among them), and follow the
   steps it returns, for the relay in the app's server and the game in the post. Show me the devvit.json change and
   the README's Fetch Domains section before you finish.
   ```

   For a Unity or Godot game, add which one it is: the steps for Reddit and for your engine come together.
4. **Start Reddit's review now:** run your playtest (`npm run dev`) once the agent is done. Until Reddit approves
   `api.glitchless.gg`, nothing reaches Glitchless from the post; the game plays as normal.
5. **Check it:** once it's approved, play a daily in your playtest post, close it, and ask your agent: "Did my
   playtest arrive in Glitchless, with the subreddit and post?" Your own playtests count as a player's at first: ask
   it to mark your player as the team's, so your numbers start with real players.

## While you build: questions for your agent

- "Where do players stop in today's puzzle, and how many finish it?" Name each daily's level after its date
  (`daily-2026-11-20`), so each day is its own row.
- "How long does a daily take, and which day was too hard?"
- "What errors do players hit, and on which phones?" Most redditors play in Reddit's app on iOS and Android.
- "Does it hold its frame rate on a low-end phone?"
- "I shipped a fix: did it work for players?" Bump the version you pass to Glitchless each time you upload.
- "Make me a dashboard for this game", and a read-only link to it for your dev log.

## Journeys, next to Glitchless

Devvit Journeys feed your app's Analytics tab on developers.reddit.com. Your agent adds them where the game already
calls Glitchless (with `"journeys": true` in `devvit.json`'s permissions and Reddit's telemetry router in the app's
server, as Reddit's Journeys docs show):

```js
import { telemetry } from '@devvit/analytics/client/reddit';

telemetry.appReady();                                   // the first frame is drawn

// the player presses Play on today's puzzle (never on page load)
glitchless.levelStart(`daily-${day}`);
telemetry.startJourney();

// a checkpoint: 3 of 5 words found
glitchless.track('word_found', { n: 3 });
telemetry.progress({ progress: 0.6, action: 'word_found' });

// solved
glitchless.levelComplete(`daily-${day}`, { score });
telemetry.endJourney({ complete: true, game: { win: true, score } });

// out of tries
glitchless.levelFail(`daily-${day}`, { cause: 'out_of_tries' });
telemetry.endJourney({ complete: false, game: { win: false, score } });
```

Nothing personal goes in a Journey's `action` either.

## Who comes back

A daily game lives on players coming back, and on Reddit that number is Reddit's: the Analytics tab and Journeys
count sessions per player each day. Glitchless keeps no player ID for a game in a post. A hash of each redditor's
user ID would let it count them, but Devvit's rules ask apps not to process data about redditors beyond what the app
needs or to keep anything that could be turned back into who they are, and a hash of a known ID is one lookup away
from the ID. So Glitchless answers what happens inside a play (where players stop, how long a daily takes, what
breaks), and Reddit answers who returns.

## Your submission

- **App link:** `developers.reddit.com/apps/<your-app>`, made when you first upload.
- **Demo post:** in a public test subreddit with fewer than 200 members (or install Reddit's `dr-admin-approve` app),
  running your game. Judges score from it.
- **README.md** at the app's root, describing the game and how to play. The "Fetch Domains" section for
  `api.glitchless.gg` goes in this same README.
- **Privacy Policy and Terms** linked in the app's details: Glitchless's PRIVACY.md (in the `glitchless` npm package)
  has a paragraph for your privacy policy.
- Optional: a video under one minute, and a public repo.
- Don't submit the app for publishing: upload and playtest only, as the rules ask.

## If Reddit turns the domain down

Reddit decides each domain. If `api.glitchless.gg` is refused, the game still works but sends nothing from posts. You
can still measure playtests outside Reddit, with the game's web build in a normal browser page sending straight to
`https://api.glitchless.gg`. Tell us at support@glitchless.gg, so we can take it up with Reddit.

Glitchless's Reddit support is new this month and was tested on a page built like Reddit's, not yet in a live post.
Tell us what breaks.
