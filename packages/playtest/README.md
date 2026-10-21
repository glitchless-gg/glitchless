# glitchless-playtest

Playtest every change. Autoplay bots play your web game on a saved baseline and on the current code,
and [Glitchless](https://github.com/glitchless-gg/glitchless) compares the two runs: slow frames,
render time, draw calls, hitches, errors, deaths and level completion. A regression exits with code 1,
so it can gate a pull request.

```bash
npx glitchless-playtest --save baseline   # before changing the code
npx glitchless-playtest                   # after: compares with "baseline"
```

## What it needs

- **Your game running**, by default at `http://localhost:5173/`, with the Glitchless SDK
  ([`glitchless`](https://www.npmjs.com/package/glitchless)) reporting to a Glitchless server.
- **An autoplay mode in the game.** Each scenario opens the game with URL parameters such as
  `?autoplay=1&seed=7&skill=0.95&level=1`. A fixed seed makes the bot play the same way on both builds,
  so the only thing that changes is the code. The bot's sessions should use `sessionType: 'synthetic'`,
  so they stay out of player numbers.
- **A Glitchless server**, by default `$GLITCHLESS_URL` or `http://localhost:7777`.
- **Playwright** installed in the game project (`npm install -D playwright`). It uses your installed
  Chrome by default, so frame times come from your real GPU.

A run ends after `max_s` seconds, or as soon as the page sets `window.__GLITCHLESS_PLAYTEST_DONE__ = true`.

## Options

```
--save NAME            save this run as NAME (e.g. baseline)
--compare NAME         compare with the saved run NAME (default: baseline, if saved)
--compare-only A B     compare two saved runs without playing
--baseline-url URL     play another running build as the baseline first (for CI)
--game URL             game to play (default http://localhost:5173/)
--server URL           Glitchless server (default $GLITCHLESS_URL or http://localhost:7777)
--service NAME         game service name (default: read from the page)
--api-key KEY          Glitchless API key (default $GLITCHLESS_API_KEY)
--quick                play only the first scenario
--max SECONDS          cap each run
--channel NAME         browser: chrome (default) or chromium
--headed               show the browser windows
--json                 print the full result as JSON instead of markdown
```

Saved runs go in `.glitchless/playtest/` (add it to `.gitignore`).

## Configuration

A `glitchless.playtest.json` in the project root can set any default: `game`, `server`, `scenarios`,
`thresholds`, `done_when` (a JavaScript expression that ends a run when it's true), `viewport` and
`runs_dir`.

```json
{
  "game": "http://localhost:3000/",
  "scenarios": [
    { "name": "speedrun", "params": { "autoplay": 1, "seed": 3, "skill": 0.95 }, "max_s": 60 }
  ]
}
```

A metric only counts as worse when it's worse by both its relative and its absolute margin, so noise
on a fast machine doesn't fail a build.

## From code or an agent

```js
import { playtest } from 'glitchless-playtest';
const result = await playtest({ saveAs: 'baseline' }); // later: playtest({ compareTo: 'baseline' })
```

The [glitchless-mcp](https://www.npmjs.com/package/glitchless-mcp) server exposes the same thing to
coding agents as the `glitchless_playtest` tool.

## License

MIT
