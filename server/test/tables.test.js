// Table panels (tables.js): one event's events listed one by one, grouped and sorted, for a game that wants to read
// them rather than add them up. Starlift's Daily Launch is the case: each daily_run under its day, the best score
// first, with the day's lowest, average and highest. The rows are the occurrences sessions keep, so every store answers
// the same; count() counters have none; a share link numbers sessions instead of naming them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { buildContext } from '../src/analytics.js';
import { validateBoard, evaluateBoard } from '../src/board.js';
import { STORES } from './helpers/stores.js';

const NOW = Date.now();
const START = NOW - 3 * 3_600_000;
const DAYS = ['24 Oct · Hollow · Squeeze · Prisms · Lucky', '25 Oct · Brine · Short Fuse · Bombs · Thrusters', '26 Oct · Ferrum · Downpour · Boosters · Slow Burn'];

// Starlift's Daily Launch, anonymous: three days, three sessions a day on iOS and Android, one to three runs each
// (attempt 1 to 3), and one older build's run that has no day_label yet. Scores are spread so no two tie.
function dailyRuns({ service = 'starlift', start = START } = {}) {
  const sessions = [];
  let n = 0;
  DAYS.forEach((label, d) => {
    const [, world, twist, items, boon] = label.split(' · ');
    for (let k = 0; k < 3; k++) {
      const base = { service, env: 'prod', version: d < 2 ? '1.3.0' : '1.4.0', session_id: `day${d}-${k}`, player_id: null };
      let ts = start + (d * 3 + k) * 600_000;
      const events = [{ ...base, type: 'session_start', ts, session_type: 'user', device: { os: k % 2 ? 'Android' : 'iOS' } }];
      for (let attempt = 1; attempt <= 1 + k; attempt++) {
        events.push({ ...base, type: 'custom', name: 'daily_run', ts: (ts += 60_000), attrs: { world, twist, items, boon, score: 1000 * ((++n * 37) % 200) + n, day_label: label, attempt } });
      }
      events.push({ ...base, type: 'session_end', ts: (ts += 1000), reason: 'pagehide' });
      sessions.push(events);
    }
  });
  const old = { service, env: 'prod', version: '1.2.0', session_id: 'old-build', player_id: null };
  sessions.push([
    { ...old, type: 'session_start', ts: start + 5000, session_type: 'user', device: { os: 'iOS' } },
    { ...old, type: 'custom', name: 'daily_run', ts: start + 9000, attrs: { world: 'Aerie', score: 5270 } },
  ]);
  return sessions;
}

const ctxOf = (events, q = {}) => buildContext(events, { service: 'starlift', from: START - 60_000, to: NOW, type: 'all', ...q });
const runs = dailyRuns();
const all = runs.flat();
const STARLIFT = { type: 'table', title: 'Daily runs by day', event: 'daily_run', group_by: 'day_label', columns: ['score', 'attempt', '$version', '$platform'], sort: '-score', of: 'score', limit: 20, size: 'l' };

test('a table panel is checked before it is saved, and says what to fix', () => {
  const good = validateBoard({ panels: [{ ...STARLIFT, extra: 'dropped' }, { type: 'table', event: 'daily_run', columns: ['$time', { key: 'duration_s', unit: 's' }, { key: 'score' }, '$session'], sort: '$time', limit: 100 }] });
  assert.deepStrictEqual(good.panels[0], { type: 'table', title: 'Daily runs by day', size: 'l', event: 'daily_run', columns: ['score', 'attempt', '$version', '$platform'], group_by: 'day_label', sort: '-score', of: 'score', limit: 20 });
  assert.deepStrictEqual(good.panels[1].columns, ['$time', { key: 'duration_s', unit: 's' }, 'score', '$session'], 'a column without a unit is kept as its key');
  for (const [panel, why] of [
    [{ type: 'table' }, /needs event/],
    [{ type: 'table', event: 'a,b' }, /one event/],
    [{ type: 'table', event: 'daily_run', columns: [] }, /columns is a list of 1 to 12/],
    [{ type: 'table', event: 'daily_run', columns: 'score' }, /columns is a list/],
    [{ type: 'table', event: 'daily_run', columns: Array.from({ length: 13 }, (_, i) => `a${i}`) }, /1 to 12/],
    [{ type: 'table', event: 'daily_run', columns: ['$player'] }, /"\$player" is not one of \$time, \$version, \$platform, \$level, \$session/],
    [{ type: 'table', event: 'daily_run', columns: ['score', 'score'] }, /"score" twice/],
    [{ type: 'table', event: 'daily_run', columns: [{ key: 'score', unit: '' }] }, /unit is a short word/],
    [{ type: 'table', event: 'daily_run', columns: [{ unit: 's' }] }, /columns\[0\] is an attribute/],
    [{ type: 'table', event: 'daily_run', group_by: '$session' }, /group_by is an attribute of the event or one of \$version, \$level, \$platform/],
    [{ type: 'table', event: 'daily_run', sort: '-$session' }, /sort: "\$session" is not among/],
    [{ type: 'table', event: 'daily_run', sort: '-' }, /sort is an attribute/],
    [{ type: 'table', event: 'daily_run', of: '$version' }, /of is a numeric attribute/],
    [{ type: 'table', event: 'daily_run', limit: 0 }, /limit is the rows per group, 1 to 100/],
    [{ type: 'table', event: 'daily_run', limit: 101 }, /1 to 100/],
  ]) {
    assert.throws(() => validateBoard({ panels: [panel] }), why, JSON.stringify(panel));
  }
});

test('a table lists each event under its group: newest group first, rows in sort order, (none) last, with each group\'s lowest, average and highest', () => {
  const [p] = evaluateBoard(ctxOf(all), validateBoard({ panels: [STARLIFT] }));
  assert.equal(p.title, 'Daily runs by day');
  assert.deepStrictEqual(p.columns.map((c) => c.label), ['score', 'attempt', 'Version', 'Platform']);
  assert.deepStrictEqual(p.groups.map((g) => g.value), [...DAYS].reverse().concat('(none)'), 'the newest day on top, the run without a day_label under (none), last');
  const runsOf = (label) => all.filter((e) => e.name === 'daily_run' && (e.attrs.day_label ?? '(none)') === label);
  for (const g of p.groups) {
    const list = runsOf(g.value);
    const scores = list.map((e) => e.attrs.score);
    assert.equal(g.events, list.length);
    assert.equal(g.sessions, new Set(list.map((e) => e.session_id)).size);
    assert.deepStrictEqual(g.rows.map((r) => r[0]), [...scores].sort((a, b) => b - a), 'the best score first');
    assert.equal(g.min, Math.min(...scores));
    assert.equal(g.max, Math.max(...scores));
    assert.equal(g.avg, Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 100) / 100);
    assert.equal(g.more, 0);
  }
  const [newest] = p.groups;
  assert.deepStrictEqual(newest.rows.find((r) => r[1] === 3).slice(2), ['1.4.0', 'iOS'], 'version and platform come from the session that sent it');
  assert.deepStrictEqual(p.groups.at(-1).rows, [[5270, null, '1.2.0', 'iOS']], 'an attribute the event lacks is null');
  assert.equal(p.events, all.filter((e) => e.name === 'daily_run').length);
  assert.equal(p.sessions, runs.length);
  assert.equal(p.more_groups, 0);
  assert.equal(p.unlisted, undefined);
  assert.equal(p.counted, undefined);
});

test('a table defaults to the event\'s own attributes in the game\'s order, the newest first; it sorts ascending, by a built-in, and with values missing last', () => {
  const ctx = ctxOf(all);
  const [plain, grouped, oldest, byAttempt, byVersion] = evaluateBoard(
    ctx,
    validateBoard({
      panels: [
        { type: 'table', event: 'daily_run' },
        { type: 'table', event: 'daily_run', group_by: 'day_label' },
        { type: 'table', event: 'daily_run', columns: ['$time', '$session', '$level'], sort: '$time' },
        { type: 'table', event: 'daily_run', columns: ['attempt', 'score'], sort: 'attempt' },
        { type: 'table', event: 'daily_run', columns: ['$version', 'score'], group_by: '$version', sort: '-$version' },
      ],
    }),
  );
  assert.deepStrictEqual(plain.columns.map((c) => c.key), ['world', 'score', 'twist', 'items', 'boon', 'day_label', 'attempt'], 'the attributes in the order the earliest events sent them');
  assert.equal(plain.groups.length, 1);
  assert.equal(plain.groups[0].value, null, 'without group_by, one group');
  const times = all.filter((e) => e.name === 'daily_run').map((e) => e.ts);
  assert.equal(plain.groups[0].rows.length, times.length);
  assert.equal(plain.groups[0].more, 0);
  assert.equal(plain.title, 'daily_run');
  assert.equal(grouped.title, 'daily_run by day_label');
  assert.equal(grouped.columns.some((c) => c.key === 'day_label'), false, 'the attribute the rows are grouped by is in the group header, not a column');
  assert.deepStrictEqual(oldest.groups[0].rows.map((r) => r[0]), [...times].sort((a, b) => a - b), 'sort "$time": the oldest first');
  assert.equal(oldest.groups[0].rows[0][1], 'old-build', '$session is the session ID for members');
  assert.equal(oldest.groups[0].rows[0][2], null, 'no level');
  const attempts = byAttempt.groups[0].rows.map((r) => r[0]);
  assert.deepStrictEqual(attempts.slice(0, -1), [...attempts.slice(0, -1)].sort((a, b) => a - b));
  assert.equal(attempts.at(-1), null, 'the run without an attempt goes last, ascending too');
  assert.deepStrictEqual(byVersion.groups.map((g) => g.value), ['1.4.0', '1.3.0', '1.2.0']);
});

test('a table keeps at most limit rows a group and 30 groups, and counts the rest', () => {
  // 40 seeds, the newest with 5 runs: limit 2 cuts every group past 2, and 10 seeds are left out.
  const events = [];
  for (let i = 0; i < 40; i++) {
    const base = { service: 'starlift', env: 'prod', version: '1.4.0', session_id: `seed-${i}`, player_id: null };
    events.push({ ...base, type: 'session_start', ts: START + i * 60_000 });
    for (let k = 0; k < (i === 39 ? 5 : 1); k++) events.push({ ...base, type: 'custom', name: 'daily_run', ts: START + i * 60_000 + 1000 + k, attrs: { seed: `s${i}`, score: k } });
  }
  const [p, plain] = evaluateBoard(ctxOf(events), validateBoard({ panels: [{ type: 'table', event: 'daily_run', group_by: 'seed', sort: '-score', limit: 2 }, { type: 'table', event: 'daily_run' }] }));
  assert.equal(p.groups.length, 30);
  assert.equal(p.more_groups, 10);
  assert.equal(p.groups[0].value, 's39', 'the newest seed first');
  assert.deepStrictEqual(p.groups[0].rows, [[4], [3]]);
  assert.equal(p.groups[0].more, 3);
  assert.equal(p.groups[0].events, 5, 'a group counts all its events, not only the rows shown');
  assert.equal(p.groups.at(-1).value, 's10');
  assert.equal(p.events, 44);
  assert.equal(plain.groups[0].rows.length, 20, 'the default limit');
  assert.equal(plain.groups[0].more, 24);
  assert.equal(plain.more_groups, 0);
});

test('a table honours the event filter and the env, version, session type and property filters', () => {
  const tagged = runs.map((s, i) => s.map((e) => ({ ...e, env: i === 0 ? 'dev' : 'prod', ...(e.type === 'session_start' ? { session_type: i === 1 ? 'synthetic' : 'user', props: { look: i % 2 ? 'light' : 'full' } } : {}) })));
  const events = tagged.flat();
  const board = validateBoard({ panels: [{ type: 'table', event: 'daily_run:world=Ferrum', columns: ['world', '$session'] }, { type: 'table', event: 'daily_run=Brine', columns: ['world'] }, { type: 'table', event: 'daily_run:world=Vesper' }] });
  const [ferrum, brine, none] = evaluateBoard(ctxOf(events), board);
  assert.ok(ferrum.groups[0].rows.every((r) => r[0] === 'Ferrum'));
  assert.equal(ferrum.events, events.filter((e) => e.name === 'daily_run' && e.attrs.world === 'Ferrum').length);
  assert.ok(brine.groups[0].rows.length && brine.groups[0].rows.every((r) => r[0] === 'Brine'), '"name=value" matches any attribute');
  assert.deepStrictEqual(none, { ...none, empty: true, why: 'No "daily_run:world=Vesper" events in this window.' });
  const ids = (q) => new Set((evaluateBoard(ctxOf(events, q), board)[0].groups ?? []).flatMap((g) => g.rows.map((r) => r[1])));
  const sessionOf = (i) => tagged[i][0].session_id;
  // Day 2 is Ferrum: sessions 6, 7 and 8. Each filter keeps only the sessions it names.
  assert.deepStrictEqual([...ids({ version: '1.4.0' })].sort(), [sessionOf(6), sessionOf(7), sessionOf(8)]);
  assert.deepStrictEqual([...ids({ version: '1.3.0' })], []);
  const props = ids({ props: { look: ['light'] } });
  assert.deepStrictEqual([...props].sort(), [sessionOf(7)]);
  const dev = buildContext(events, { service: 'starlift', from: START - 60_000, to: NOW, type: 'all', env: 'dev' });
  assert.equal(evaluateBoard(dev, board)[0].empty, true, 'the dev session ran Hollow, not Ferrum');
  const synthetic = evaluateBoard(ctxOf(events, { type: 'synthetic' }), validateBoard({ panels: [{ type: 'table', event: 'daily_run', columns: ['$session'] }] }))[0];
  assert.deepStrictEqual([...new Set(synthetic.groups[0].rows.map((r) => r[0]))], [sessionOf(1)]);
});

test('count() events have no rows, and a session that sent more than it keeps has the rest counted', () => {
  const base = { service: 'starlift', env: 'prod', version: '1.4.0', player_id: null };
  const events = [
    // A game that counts its daily runs (count()): totals per window, no events.
    { ...base, session_id: 'c', type: 'session_start', ts: START },
    { ...base, session_id: 'c', type: 'counts', ts: START + 5000, duration_s: 5, counts: [{ name: 'daily_run', n: 4, attrs: { world: 'Ferrum' }, first_ts: START + 1000 }, { name: 'boost', n: 3, attrs: {}, first_ts: START + 2000 }] },
    // A long session: 20 tracked runs, of which it keeps the first 16.
    { ...base, session_id: 'long', type: 'session_start', ts: START },
    ...Array.from({ length: 20 }, (_, i) => ({ ...base, session_id: 'long', type: 'custom', name: 'daily_run', ts: START + 10_000 + i * 1000, attrs: { world: 'Brine', score: i } })),
  ];
  const board = validateBoard({ panels: [{ type: 'table', event: 'boost' }, { type: 'table', event: 'daily_run', columns: ['score', '$session'], limit: 100 }, { type: 'table', event: 'daily_run:world=Ferrum' }, { type: 'table', event: 'missing' }] });
  const [boost, mixed, counted, missing] = evaluateBoard(ctxOf(events), board);
  assert.equal(boost.empty, true);
  assert.match(boost.why, /"boost" is counted with count\(\), which sends totals per window rather than each event, so there are no rows to list/);
  assert.equal(mixed.events, 16);
  assert.deepStrictEqual(mixed.groups[0].rows.map((r) => r[0]), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], 'the first 16 the session kept, newest first');
  assert.ok(mixed.groups[0].rows.every((r) => r[1] === 'long'), "the counter's session has no rows");
  assert.deepStrictEqual(mixed.unlisted, { events: 4, sessions: 1, keep: 16 });
  assert.equal(mixed.counted, 4, 'the counted runs are said, not listed');
  assert.equal(counted.empty, true, 'a filter only counters match');
  assert.equal(counted.why, 'The "daily_run:world=Ferrum" events in this window were counted with count(), which sends totals per window rather than each event, so there are no rows to list. Send it with track() to list each one.');
  assert.deepStrictEqual(missing, { ...missing, empty: true, why: 'No "missing" events in this window.' });
});

test('over more than 31 days a table asks for a shorter range', () => {
  const ctx = ctxOf(all);
  ctx.daily = { samples: [] };
  const [p] = evaluateBoard(ctx, validateBoard({ panels: [STARLIFT] }));
  assert.equal(p.empty, true);
  assert.match(p.why, /31 days or less/);
});

test('on a share link a table numbers sessions instead of naming them, and leaves out amounts unless the link shows sums', () => {
  const purchases = runs.slice(0, 4).flatMap((s, i) => [s[0], { ...s[0], type: 'custom', name: 'purchase', ts: s[0].ts + 2000, attrs: { item: i % 2 ? 'gems' : 'pass', amount: 4.99 + i, currency: 'USD' } }]);
  const events = [...all, ...purchases];
  const board = validateBoard({ panels: [{ ...STARLIFT, columns: ['score', '$session', '$time'] }, { type: 'table', event: 'purchase', columns: ['item', 'amount', '$session'], group_by: 'item', of: 'amount' }] });
  const ctx = ctxOf(events);
  const [member] = evaluateBoard(ctx, board);
  const [runsShared, buysShared] = evaluateBoard(ctx, board, { shared: true });
  const text = JSON.stringify([runsShared, buysShared]);
  for (const s of runs) assert.equal(text.includes(s[0].session_id), false, `a shared table names session ${s[0].session_id}`);
  assert.deepStrictEqual(runsShared.columns[1], { key: '$session', label: 'Session', unit: null, numbered: true });
  // Numbered in the order the table first shows them, the same number wherever a session comes back.
  const numberOf = new Map();
  member.groups.forEach((g, i) =>
    g.rows.forEach((r, j) => {
      const n = runsShared.groups[i].rows[j][1];
      if (!numberOf.has(r[1])) {
        assert.equal(n, numberOf.size + 1);
        numberOf.set(r[1], n);
      }
      assert.equal(n, numberOf.get(r[1]));
      assert.equal(runsShared.groups[i].rows[j][0], r[0], 'scores are not money: kept');
    }),
  );
  assert.equal(runsShared.groups[0].max, member.groups[0].max);
  // Money: the amounts and each group's lowest, average and highest are left out; what was bought and when stay.
  assert.equal(buysShared.empty, undefined);
  assert.deepStrictEqual(buysShared.columns.map((c) => !!c.hidden), [false, true, false]);
  assert.ok(buysShared.groups.every((g) => g.min === null && g.avg === null && g.max === null && g.rows.every((r) => r[1] === null && typeof r[0] === 'string')));
  const [, buysWithSums] = evaluateBoard(ctx, board, { shared: { sums: true } });
  assert.ok(buysWithSums.groups.every((g) => g.min > 4 && g.rows.every((r) => typeof r[1] === 'number')), 'a link made to show sums shows them');
});

const KEYS = { writer: 'gl_sk_writer', reader: 'gl_sk_reader' };
const auth = {
  resolveIngest() {
    return { projectId: 'p1' };
  },
  resolveReader(req) {
    const key = req.headers['x-glitchless-api-key'];
    if (key === KEYS.writer) return { projectId: 'p1', scopes: ['read', 'dashboard'] };
    if (key === KEYS.reader) return { projectId: 'p1', scopes: ['read'] };
    throw new AuthError(401, 'no key');
  },
};

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a table panel lists the same runs, grouped and sorted, as the raw events say`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, key, body) => {
      const res = await fetch(base + p, { method, headers: { 'x-glitchless-api-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() };
    };
    try {
      for (const events of runs) {
        const { service, env, version, session_id, player_id } = events[0];
        const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: events.map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
        assert.ok(res.ok, `intake ${res.status}`);
      }
      await settle?.();
      const panels = [STARLIFT, { type: 'table', event: 'daily_run:world=Ferrum', columns: ['score', '$session'], sort: '$time' }];
      assert.equal((await call('PUT', '/v1/dashboard?service=starlift', KEYS.writer, { pages: [{ id: 'daily', title: 'Daily Launch', panels }] })).status, 200);
      const { body } = await call('GET', `/v1/query/board?service=starlift&from=${START - 3_600_000}&to=${Date.now() + 1}`, KEYS.reader);
      const inRange = (e) => e.ts >= body.meta.from && e.ts <= body.meta.to;
      const expected = evaluateBoard(ctxOf(all.filter(inRange)), validateBoard({ panels }));
      const [table, ferrum] = body.board.panels;
      assert.equal(table.empty, undefined, table.why);
      assert.deepStrictEqual(table.groups, expected[0].groups, `${kind}: the same groups and rows as the raw events`);
      assert.deepStrictEqual(ferrum.groups, expected[1].groups);
      assert.equal(table.events, all.filter((e) => e.name === 'daily_run').length);
      // Only one session type kept: read from the raw events on a store that keeps summaries.
      const users = (await call('GET', `/v1/query/board?service=starlift&session_type=user&from=${START - 3_600_000}&to=${Date.now() + 1}`, KEYS.reader)).body;
      assert.deepStrictEqual(users.board.panels[0].groups, expected[0].groups);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}
