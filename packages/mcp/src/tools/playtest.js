// Unlike the read tools, this one acts: it launches browsers and writes .glitchless/playtest/<name>.json
// in the project, so it is registered without the read-only hint.
import { z } from 'zod';
import { playtest } from 'glitchless-playtest';
import { define, base, apiKey, defaultService, fail } from '../context.js';

define(
  'glitchless_playtest',
  {
    description:
      "Playtest the game with its autoplay bots and compare against a saved baseline. Bots play fixed-seed scenarios in real Chrome, one at a time, against the running game; Glitchless then compares frame time (overall and per level), render CPU, draw calls, errors, crashes, completion and deaths with the baseline. Regressions fail; warnings and improvements are listed. Call with save_as \"baseline\" BEFORE changing code, then without arguments AFTER the change. Takes 1–5 minutes (quick: about 1). Needs the game and the Glitchless server running and Playwright installed in the project.",
    inputSchema: {
      save_as: z.string().optional().describe('Save this run under a name, e.g. "baseline" before a change'),
      compare_to: z.string().optional().describe('Saved run to compare with (default "baseline" when saved)'),
      quick: z.boolean().optional().describe('Play only the first scenario (about a minute)'),
      game_url: z.string().optional().describe('Game URL to play (default http://localhost:5173/ or glitchless.playtest.json)'),
      max_seconds: z.number().min(10).max(600).optional().describe('Cap each run at this many seconds'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ save_as, compare_to, quick, game_url, max_seconds } = {}, ctx) => {
    const token = ctx?.mcpReq._meta?.progressToken;
    let step = 0;
    const log = (message) => {
      if (token != null) ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {});
    };
    try {
      const r = await playtest({
        saveAs: save_as,
        compareTo: compare_to,
        quick,
        maxSeconds: max_seconds,
        config: { server: base(), api_key: apiKey() || undefined, service: defaultService() || undefined, game: game_url },
        log,
      });
      const files = Object.entries(r.files || {}).map(([k, f]) => `${k}: ${f}`).join('\n');
      return { content: [{ type: 'text', text: `${r.report}\n\nVerdict: ${r.verdict.toUpperCase()}\nSaved runs:\n${files}` }] };
    } catch (err) {
      return fail(err);
    }
  },
  // It plays the game in Chrome on this computer, so it is not served over HTTP.
  { local: true },
);
