#!/usr/bin/env node
// glitchless-playtest: autoplay bots play your game, and Glitchless compares the result with a baseline.
//
//   glitchless-playtest --save baseline        # before changing the code
//   glitchless-playtest                        # after: compares with "baseline", exits 1 on a regression
//   glitchless-playtest --compare-only baseline latest
//   glitchless-playtest --baseline-url http://localhost:5174/   # CI: main build vs this branch's build
//
// Needs the game and a Glitchless server running, and Playwright installed in the game project.

import { playtest, compareSaved } from '../src/index.js';

const HELP = `Usage: glitchless-playtest [options]

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
  --channel NAME         browser: chrome (default, uses your real GPU) or chromium
  --headed               show the browser windows
  --json                 print the full result as JSON instead of markdown

Scenarios, thresholds and URLs can also be set in glitchless.playtest.json.
Exit code: 0 pass (or nothing to compare), 1 regression, 2 error.`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

if (has('help') || has('h')) {
  console.log(HELP);
  process.exit(0);
}

const log = (msg) => process.stderr.write(`${msg}\n`);
const config = { game: val('game'), server: val('server'), service: val('service'), api_key: val('api-key'), channel: val('channel'), headed: has('headed') || undefined };

try {
  let result;
  const only = argv.indexOf('--compare-only');
  if (only >= 0) {
    const [a, b] = argv.slice(only + 1, only + 3);
    if (!a || !b) throw new Error('--compare-only needs two saved run names, e.g. --compare-only baseline latest');
    result = compareSaved(a, b, { config });
  } else {
    result = await playtest({ saveAs: val('save'), compareTo: val('compare'), baselineUrl: val('baseline-url'), quick: has('quick'), maxSeconds: val('max') ? Number(val('max')) : undefined, config, log });
  }
  if (has('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.report);
  process.exit(result.verdict === 'fail' ? 1 : 0);
} catch (err) {
  log(`glitchless-playtest: ${err.message}`);
  process.exit(2);
}
