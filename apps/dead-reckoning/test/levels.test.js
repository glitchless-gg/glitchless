// Every level is well formed and can be beaten: the bot at full skill plays its plan exactly, so if it
// gets through, a person can. Noisy bots must also die on every level, or the markers have nothing to show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, LEVEL_ROWS } from '../src/levels.js';
import { createBody, step } from '../src/physics.js';
import { createBot } from '../src/bot.js';

function attempt(lv, bot, maxSteps = 60 * 40) {
  const b = createBody(lv.spawn);
  bot.reset();
  for (let i = 0; i < maxSteps && !b.dead && !b.won; i++) {
    step(b, bot.input(b), lv);
    bot.after(b);
  }
  return b;
}

test('five levels, each 16 rows of one width, with a start and a goal', () => {
  assert.equal(LEVELS.length, 5);
  for (const lv of LEVELS) {
    assert.equal(lv.rows.length, LEVEL_ROWS, `level ${lv.id}`);
    assert.ok(lv.rows.every((r) => r.length === lv.w), `level ${lv.id} rows differ in width`);
    assert.ok(lv.solid[(lv.spawn.y - 1) * lv.w + Math.floor(lv.spawn.x)], `level ${lv.id} starts on ground`);
    assert.ok(lv.visible[(lv.spawn.y - 1) * lv.w + Math.floor(lv.spawn.x)], `level ${lv.id}: you can see the start pad`);
  }
});

for (const lv of LEVELS) {
  test(`level ${lv.id} (${lv.name}) can be beaten`, () => {
    const b = attempt(lv, createBot(lv, { skill: 1, seed: 1 }));
    assert.ok(b.won, `died: ${JSON.stringify(b.dead)} at ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
  });

  test(`level ${lv.id} kills sloppy players`, () => {
    const bot = createBot(lv, { skill: 0.4, seed: 7 });
    let deaths = 0;
    for (let i = 0; i < 30; i++) if (attempt(lv, bot).dead) deaths++;
    assert.ok(deaths > 0);
  });
}
