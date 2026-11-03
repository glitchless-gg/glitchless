// The Steam Deck tool: send a build to the paired Deck (and start it), or measure it there with the Glitchless SDK's
// --glitchless-measure, compared with a saved run. Both act on the Deck and write files (the build on the Deck,
// .glitchless/deck/<id>/<name>.json in the project), so it isn't read-only, and both act on this computer's network,
// so it isn't served over HTTP.
// Pairing is not a tool: it needs the person to approve it on the Deck (glitchless-deck pair).

import path from 'node:path';
import { z } from 'zod';
import { gameNamed, send, launch, measure, Problem } from 'glitchless-deck';
import { define, fail } from '../context.js';

const common = {
  game: z.string().optional().describe('Game id from glitchless.deck.json (optional when the project has one game)'),
  project: z.string().optional().describe('Folder with the glitchless.deck.json (default: the folder the agent works in)'),
};

function progress(ctx) {
  const token = ctx?.mcpReq._meta?.progressToken;
  let step = 0;
  const lines = [];
  const log = (message) => {
    lines.push(message);
    if (token != null) ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {});
  };
  return { log, lines };
}

function find(game, project) {
  return gameNamed(game, { cwd: path.resolve(project || process.cwd()) });
}

// What the person has to do is the answer, not a stack trace.
const problem = (err, lines) => (err instanceof Problem ? { content: [{ type: 'text', text: `${lines.length ? `${lines.join('\n')}\n\n` : ''}${err.message}` }], isError: true } : fail(err));

define(
  'glitchless_deck',
  {
    title: 'Steam Deck',
    description:
      'The Steam Deck paired with this computer. By default, sends the game there and puts it in the Deck\'s library as "Devkit Game: <id>": runs the build (Godot Linux export, Unity Linux64, Unreal, a web build, or the project\'s own command), checks it is something the Deck runs (Linux x86-64, or Windows x64 through Proton), copies only what changed, and optionally starts it. With measure: true, measures what is on the Deck instead: Steam starts it (as "Devkit Game: <id>_measure") with --glitchless-measure, the Glitchless SDK records frame time, slow frames, hitches, render and update CPU, draw calls and new errors, then the game quits and the numbers come back here, saved in .glitchless/deck/<id>/ and compared with a saved run (by default "baseline") using the same thresholds as glitchless_playtest; a FAIL lists the regressions. The loop: measure with save_as "baseline" BEFORE changing code, send the new build, then measure again. Measuring is for Unity, Godot and Unreal builds with the Glitchless SDK (web games: glitchless_playtest), and takes the warm-up plus the seconds plus about 10 seconds. Reads glitchless.deck.json in the project (glitchless-deck init writes one). Needs the Deck awake on this network and paired once with `glitchless-deck pair`, which the user approves on the Deck.',
    inputSchema: {
      ...common,
      measure: z.boolean().optional().describe('Measure the build on the Deck instead of sending one'),
      build: z.boolean().optional().describe('Sending: run the build first (default true); false sends what is already built'),
      launch: z.boolean().optional().describe('Sending: start the game on the Deck once it is there'),
      intake: z.string().optional().describe('Sending: report to this Glitchless server instead (a URL the Deck can reach)'),
      glitchless: z.boolean().optional().describe('Sending: start it with --glitchless --glitchless-intake=http://<this computer>:7777 so it reports to the local Glitchless server. Measuring: also report the run there'),
      seconds: z.number().min(2).max(300).optional().describe('Measuring: how long (default 10)'),
      warmup: z.number().min(0).max(120).optional().describe('Measuring: seconds to wait first, for loading (default 3)'),
      save_as: z.string().optional().describe('Measuring: save this run under a name, e.g. "baseline" before a change'),
      compare_to: z.string().optional().describe('Measuring: saved run to compare with (default "baseline" when saved)'),
      args: z.array(z.string()).optional().describe('Measuring: extra arguments for the game, e.g. ["--", "--level=3", "--autoplay"]'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ game, project, measure: measuring, build, launch: start, intake, glitchless, seconds, warmup, save_as, compare_to, args } = {}, ctx) => {
    const { log, lines } = progress(ctx);
    try {
      const g = find(game, project);
      if (measuring) {
        const r = await measure(g, { seconds: seconds ?? 10, warmup: warmup ?? 3, saveAs: save_as, compareTo: compare_to, args: args || [], glitchless: !!glitchless, log });
        const files = Object.entries(r.files || {}).map(([k, f]) => `${k}: ${f}`).join('\n');
        return { content: [{ type: 'text', text: `${r.report}\n\nVerdict: ${r.verdict.toUpperCase()}\nSaved runs:\n${files}` }] };
      }
      const r = await send(g, { build: build !== false, glitchless: !!glitchless, intake, log });
      if (start) r.launch = await launch(g, { log });
      return { content: [{ type: 'text', text: `${lines.join('\n')}\n\n${JSON.stringify(r, null, 2)}` }] };
    } catch (err) {
      return problem(err, lines);
    }
  },
  { local: true },
);
