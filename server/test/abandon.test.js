// Leaving a level is not failing it (SPEC §2 level_abandon, §4). Starlift sent level_fail(level, "left") when the
// player went home, retried or closed the app mid-run; as the app closed, the fail came after the session's end.
// That made 10 of its 11 non-bot rage quits, and walls out of runs nobody finished. An abandon is now its own
// outcome, a fail after the session's end is no rage quit, and walls count only sessions that played a level out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, funnel } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { foldDay, CAPS } from '../src/daily.js';
import { indexSessions } from '../src/analytics.js';

const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / DAY) * DAY - 2 * DAY + 3_600_000;
const q = { service: 'starlift', from: T0 - 3_600_000, to: T0 + DAY };

// One session: its events from [type, extra] pairs, a second apart unless an entry says `at` (seconds in).
function session(id, steps, { start = T0, sdk = 'glitchless-godot/0.3.0' } = {}) {
  const base = { service: 'starlift', env: 'prod', version: '1.1', session_id: id, player_id: id, sdk, level: null };
  let t = 0;
  return [{ ...base, type: 'session_start', ts: start, session_type: 'user', device: { os: 'iOS' } }].concat(
    steps.map(([type, extra = {}]) => {
      t = extra.at ?? t + 1;
      const { at, ...rest } = extra;
      return { ...base, type, ts: start + t * 1000, ...rest };
    }),
  );
}

const sessionsOf = (events) => buildContext(events.flat().sort((a, b) => a.ts - b.ts), q).sessions;

test('a fail logged after the session ended is not a rage quit; one just before the end still is', () => {
  const s = sessionsOf([
    // Starlift 1.1: the app closed mid-run, so the end comes first and the game's "left" fail after it.
    session('s_left', [['level_start', { level: 'endless_normal' }], ['session_end', { at: 30, reason: 'background' }], ['level_fail', { at: 31, level: 'endless_normal', cause: 'left' }]]),
    // A real one: died, and the session ended 5 s later.
    session('s_rage', [['level_start', { level: 'endless_normal' }], ['death', { at: 30, level: 'endless_normal', cause: 'meteor' }], ['level_fail', { at: 30.5, level: 'endless_normal', cause: 'dead' }], ['session_end', { at: 35, reason: 'background' }]]),
  ]);
  assert.equal(s.get('s_left').rage_quit, false);
  assert.equal(s.get('s_rage').rage_quit, true);
});

test('an abandon is its own outcome: not a fail, not a death, not play, and never a rage quit', () => {
  const s = sessionsOf([
    session('s_abandon', [['level_start', { level: 'endless_normal' }], ['level_abandon', { at: 40, level: 'endless_normal', duration_s: 39 }], ['session_end', { at: 40, reason: 'background' }]]),
    // The reserved cause works on an older SDK that has no level_abandon.
    session('s_cause', [['level_start', { level: 'endless_normal' }], ['level_fail', { at: 20, level: 'endless_normal', cause: 'abandon' }], ['session_end', { at: 21, reason: 'quit' }]]),
  ]);
  for (const id of ['s_abandon', 's_cause']) {
    const x = s.get(id);
    assert.deepEqual([x.fails, x.deaths, x.abandons, x.abandoned, x.rage_quit], [0, 0, 1, { endless_normal: 1 }, false], id);
  }
  assert.equal(s.get('s_abandon').last_play, T0 + 1000, 'the SDK sends abandons itself: they are not play');
});

test('an abandon the player came back from does not count; one before a retry does', () => {
  const s = sessionsOf([
    // To the background mid-level (the SDK records the abandon), back 20 s later, and the level is completed.
    session('s_back', [['level_start', { level: 'voyage_3' }], ['level_abandon', { at: 10, level: 'voyage_3' }], ['session_end', { at: 10, reason: 'background' }], ['custom', { at: 30, name: 'app_resume', attrs: { away_s: 20 } }], ['level_complete', { at: 60, level: 'voyage_3', score: 900 }]]),
    // Retry: the run is left, and the level starts again.
    session('s_retry', [['level_start', { level: 'voyage_3' }], ['level_abandon', { at: 10, level: 'voyage_3' }], ['level_start', { at: 11, level: 'voyage_3' }], ['level_abandon', { at: 20, level: 'voyage_3' }], ['level_abandon', { at: 21, level: 'voyage_3' }], ['session_end', { at: 21, reason: 'quit' }]]),
  ]);
  assert.deepEqual([s.get('s_back').abandons, [...s.get('s_back').completed]], [0, ['voyage_3']]);
  assert.equal(s.get('s_retry').abandons, 2, 'two attempts left; two abandons of one attempt are one');
});

test('the funnel and the daily rollups count abandons apart from fails', () => {
  const events = [
    session('a', [['level_start', { level: 'L1' }], ['level_abandon', { level: 'L1' }]]),
    session('b', [['level_start', { level: 'L1' }], ['death', { level: 'L1', cause: 'meteor' }], ['level_fail', { level: 'L1', cause: 'dead' }], ['level_start', { level: 'L1' }], ['level_abandon', { level: 'L1' }]]),
    session('c', [['level_start', { level: 'L1' }], ['level_complete', { level: 'L1' }]]),
  ];
  const row = funnel(buildContext(events.flat(), q)).find((l) => l.level === 'L1');
  assert.deepEqual([row.sessions, row.completed, row.fails, row.deaths, row.abandons, row.abandoned], [3, 1, 1, 1, 2, 1], 'b also failed, so only a left it and nothing else');
  const day = foldDay(Math.floor(T0 / DAY) * DAY, { sessions: [...indexSessions(events.flat()).values()] }, CAPS);
  const lv = [...day.groups.values()][0].lv.get('L1');
  assert.deepEqual([lv.ss, lv.sc, lv.fa, lv.de, lv.ab, lv.lo], [3, 1, 1, 1, 2, 1]);
});

test('a level players mostly leave mid-run is not a wall', () => {
  const events = [];
  for (let i = 0; i < 12; i++) {
    const steps = [];
    for (const level of ['L1', 'L2', 'L3']) {
      steps.push(['level_start', { level }]);
      // L2: 8 of 12 leave it mid-run (home, retry, the app closed); the 4 who play it out all get through.
      if (level === 'L2' && i < 8) {
        steps.push(['level_abandon', { level }]);
        break;
      }
      steps.push(['level_complete', { level, score: 100 }]);
    }
    events.push(session(`w${i}`, steps, { start: T0 + i * 600_000 }));
  }
  const ctx = buildContext(events.flat(), q);
  const l2 = funnel(ctx).find((l) => l.level === 'L2');
  assert.deepEqual([l2.sessions, l2.completed, l2.abandoned, l2.fails], [12, 4, 8, 0]);
  assert.equal(findings(ctx).some((f) => f.id === 'design-wall-L2'), false, 'only 4 sessions played L2 out, and all 4 got through');

  // The same runs ending in fails are a wall.
  const failed = events.map((evs) => evs.map((e) => (e.type === 'level_abandon' ? { ...e, type: 'level_fail', cause: 'dead' } : e)));
  const wall = findings(buildContext(failed.flat(), q)).find((f) => f.id === 'design-wall-L2');
  assert.ok(wall, 'failing runs make a wall');
  assert.equal(wall.evidence.completion_pct, 33.3);
});
