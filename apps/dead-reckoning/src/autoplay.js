// ?autoplay=1: the bot plays, its sessions tagged session_type 'synthetic' (as the playtest bots are), so
// its deaths can seed the markers before launch and still be told apart from players'. It gives up on a
// level after `patience` deaths, as people do, and says it's done when it quits or beats level 5
// (window.__GLITCHLESS_PLAYTEST_DONE__, which scripts/bots.js waits for).
import { createBot } from './bot.js';

export function createAutoplay({ skill, seed, patience = 60 }) {
  let bot = null;
  return {
    patience,
    forLevel(lv) {
      bot = createBot(lv, { skill, seed: seed + Number(lv.id) * 1009 });
    },
    input: (body) => bot.input(body),
    after: (body) => bot.after(body),
    reset: () => bot.reset(),
    done(reason) {
      window.__GLITCHLESS_PLAYTEST_DONE__ = reason || true;
    },
  };
}
