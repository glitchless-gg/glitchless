// What games of any genre ask of their own events (docs/design/genre-coverage.md, A1 to A4): rates per hour played,
// rates and averages by attribute (win rate by hero), distributions (the median match) and list attributes (decks),
// with the findings that read them off the game's boards. Each answer is checked against the raw events themselves,
// and every store gives the same answers as the raw events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { buildContext, sessionContext, overview, customEvents, eventFunnel, parseFunnel, sessionsList, indexSessions, versions } from '../src/analytics.js';
import { rollup, mergeCell, newCell, cellToJSON, cellFromJSON, smallAttrs, ATTRS, MAX_DISTS } from '../src/rollups.js';
import { validateBoard, evaluateBoard, eventQuery } from '../src/board.js';
import { findings } from '../src/findings.js';
import { foldDay, mergeDays, sessionDay, DAY } from '../src/daily.js';
import { genreSessions, HEROES } from './helpers/game-data.js';
import { STORES } from './helpers/stores.js';

const HOUR = 3_600_000;
const NOW = Date.now();
const START = Math.floor((NOW - 5 * HOUR) / 60_000) * 60_000;
const sessions = genreSessions({ start: START, spanMs: 3 * HOUR, sessions: 60 });
const events = sessions.flat().sort((a, b) => a.ts - b.ts);
const q = { service: 'arena', from: START - 60_000, to: NOW, type: 'all' };
const ctxOf = (list = events, extra = {}) => buildContext(list, { ...q, ...extra });
const board = (panels, ctx = ctxOf()) => evaluateBoard(ctx, validateBoard({ panels }));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const ends = events.filter((e) => e.name === 'match_end');
const flag = (e) => e.attrs.won === true || e.attrs.won === 1;
const hours = events.filter((e) => e.type === 'frame_window').reduce((h, e) => h + e.duration_s, 0) / 3600;
const exactQuantile = (values, q) => {
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
};

test('the data has what these tests need', () => {
  assert.ok(ends.length > 150, `${ends.length} matches`);
  assert.ok(ends.some((e) => e.attrs.won === 1) && ends.some((e) => e.attrs.won === true), 'flags as booleans and as 1 and 0');
  assert.ok(new Set(ends.map((e) => e.version)).size === 2);
  assert.ok(hours > 1, `${hours} hours played`);
});

// ───────────────────────────── A4: lists ─────────────────────────────

test('a list attribute keeps its first 16 distinct elements and is one of the 12 attributes', () => {
  const long = Array.from({ length: 30 }, (_, i) => `card_${i % 20}`);
  const attrs = smallAttrs({ deck: long, nested: [['a']], objects: [{ a: 1 }], mixed: ['a', 1, true, 'a'], won: true, name: 'x'.repeat(100) });
  assert.deepStrictEqual(attrs.deck, Array.from({ length: ATTRS.list }, (_, i) => `card_${i}`));
  assert.deepStrictEqual(attrs.mixed, ['a', 1, true]);
  assert.equal('nested' in attrs, false, 'lists inside lists are left out');
  assert.equal('objects' in attrs, false, 'lists of objects are left out');
  assert.equal(attrs.name.length, ATTRS.valueLength);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i ? i : ['a', 'b']]));
  assert.equal(Object.keys(smallAttrs(many)).length, ATTRS.keys);
});

test('a list counts each element: a breakdown has a row per card, and a filter matches decks that contain it', () => {
  const ctx = ctxOf();
  const e = customEvents(ctx, { name: 'match_end' }).events[0];
  const deck = e.attrs.find((a) => a.key === 'deck');
  assert.equal(deck.list, true);
  const withHog = ends.filter((x) => x.attrs.deck.includes('hog'));
  assert.equal(deck.values.find((v) => v.value === 'hog').count, withHog.length);
  assert.equal(deck.values.find((v) => v.value === 'hog').sessions, new Set(withHog.map((x) => x.session_id)).size);
  const [cards, hog, pair, trio, none, sent] = board([
    { type: 'breakdown', event: 'match_end', by: 'deck', limit: 20 },
    { type: 'stat', event: 'match_end:deck=hog' },
    { type: 'stat', event: 'match_end:deck=hog+fireball' },
    { type: 'stat', event: 'match_end:deck=hog+fireball+log' },
    { type: 'stat', event: 'match_end:deck=hog+nothing' },
    { type: 'sessions', sent: 'match_end:deck=hog+fireball', limit: 50 },
  ]);
  assert.equal(cards.list, true, 'the panel says each battle counts once under each card');
  assert.equal(cards.rows.reduce((n, r) => n + r.count, 0), ends.length * 4, 'rows add up to more than the events: four cards a deck');
  assert.equal(cards.rows.find((r) => r.value === 'hog').share, r1((withHog.length / ends.length) * 100));
  assert.equal(hog.value, withHog.length);
  const has = (...cs) => ends.filter((x) => cs.every((c) => x.attrs.deck.includes(c)));
  assert.equal(pair.value, has('hog', 'fireball').length, 'contains all of: a pair, from the occurrences, exact while no session sent more than 16');
  assert.equal(trio.value, has('hog', 'fireball', 'log').length);
  assert.equal(none.value, 0);
  assert.equal(sent.sessions.length, new Set(has('hog', 'fireball').map((x) => x.session_id)).size);
  // A funnel step and an events query take lists the same way.
  const [step] = eventFunnel(ctx, parseFunnel('match_end:deck=hog+fireball'));
  assert.equal(step.sessions, new Set(has('hog', 'fireball').map((x) => x.session_id)).size);
  assert.equal(sessionsList(ctx, { sent: parseFunnel('match_end:deck=golem')[0] }).length, new Set(has('golem').map((x) => x.session_id)).size);
});

test('a list element splits rates and sums: decks with hog win more', () => {
  const [rate, rows] = board([
    { type: 'breakdown', event: 'match_end', by: 'deck', rate: 'won', min: 1, limit: 20 },
    { type: 'breakdown', event: 'match_end', by: 'deck', avg: 'duration_s', min: 1, limit: 20 },
  ]);
  for (const card of ['hog', 'golem']) {
    const mine = ends.filter((x) => x.attrs.deck.includes(card));
    const row = rate.rows.find((r) => r.value === card);
    assert.equal(row.events, mine.length);
    assert.equal(row.rate, r1((mine.filter(flag).length / mine.length) * 100));
    assert.equal(rows.rows.find((r) => r.value === card).avg, r2(mine.reduce((s, x) => s + x.attrs.duration_s, 0) / mine.length));
  }
  assert.equal(rate.list, true);
  assert.ok(rate.rows[0].value === 'hog', 'hog decks win most');
});

// ───────────────────────────── A2: rates and averages ─────────────────────────────

test('a rate is the share of events where a flag holds, booleans and 1 or 0 alike, with its 95% interval', () => {
  const [stat, word, byHero, byWord, byVersion, byPlatform, avg] = board([
    { type: 'stat', event: 'match_end', rate: 'won' },
    { type: 'stat', event: 'match_end', rate: 'result=win' },
    { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won', min: 1 },
    { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'result=win', min: 1 },
    { type: 'breakdown', event: 'match_end', by: '$version', rate: 'won', order: 'value', min: 1 },
    { type: 'breakdown', event: 'match_end', by: '$platform', rate: 'won', min: 1 },
    { type: 'breakdown', event: 'match_end', by: 'hero', avg: 'duration_s', min: 1 },
  ]);
  const overall = r1((ends.filter(flag).length / ends.length) * 100);
  assert.equal(stat.value, overall);
  assert.equal(stat.unit, '%');
  assert.equal(stat.events, ends.length);
  assert.ok(stat.low < stat.value && stat.value < stat.high);
  assert.equal(word.value, overall, 'a word outcome gives the same rate as its flag');
  for (const hero of HEROES) {
    const mine = ends.filter((x) => x.attrs.hero === hero);
    const row = byHero.rows.find((r) => r.value === hero);
    assert.equal(row.rate, r1((mine.filter(flag).length / mine.length) * 100), hero);
    assert.equal(row.events, mine.length);
    assert.equal(row.sessions, new Set(mine.map((x) => x.session_id)).size);
    assert.ok(row.low <= row.rate && row.rate <= row.high);
    assert.equal(row.off, row.high < overall || row.low > overall);
    assert.deepStrictEqual(pick(byWord.rows.find((r) => r.value === hero), ['rate', 'events', 'low', 'high']), pick(row, ['rate', 'events', 'low', 'high']), 'words by an attribute read the occurrences, exactly here');
    assert.equal(avg.rows.find((r) => r.value === hero).avg, r2(mine.reduce((s, x) => s + x.attrs.duration_s, 0) / mine.length));
  }
  assert.equal(byHero.overall, overall);
  assert.equal(byHero.line, overall);
  assert.equal(byHero.rows[0].value, 'ember', 'highest rate first');
  assert.equal(byWord.from, 'occurrences');
  assert.equal(byHero.from, 'cells');
  assert.deepStrictEqual(byVersion.rows.map((r) => r.value), ['1.0', '1.1'], 'order: value');
  for (const r of byVersion.rows) assert.equal(r.rate, r1((ends.filter((x) => x.version === r.value && flag(x)).length / ends.filter((x) => x.version === r.value).length) * 100));
  const ios = sessions.filter((s) => s[0].device.os === 'iOS').flat().filter((x) => x.name === 'match_end');
  assert.equal(byPlatform.rows.find((r) => r.value === 'iOS').rate, r1((ios.filter(flag).length / ios.length) * 100));
  assert.equal(byPlatform.from, 'sessions');
});

test('rows under min events are left out and counted; expect marks the rows whose interval misses it', () => {
  const [small, expect, stat] = board([
    { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won', min: 100000 },
    { type: 'breakdown', event: 'pull', by: 'banner', rate: 'top', expect: 50, min: 1 },
    { type: 'stat', event: 'pull', rate: 'top', expect: 50 },
  ]);
  assert.equal(small.rows.length, 0);
  assert.equal(small.small.rows, HEROES.length);
  assert.equal(small.small.events, ends.length);
  assert.equal(expect.line, 50, 'the line is what the game expects');
  assert.ok(expect.rows.every((r) => r.off === true), 'top pulls are nowhere near 50%');
  assert.equal(stat.off, true);
});

test('a filtered event splits its rates by another attribute from the occurrences', () => {
  const [ranked] = board([{ type: 'breakdown', event: 'match_end:mode=ranked', by: 'hero', rate: 'won', min: 1 }]);
  const mine = ends.filter((x) => x.attrs.mode === 'ranked' && x.attrs.hero === 'ember');
  assert.equal(ranked.rows.find((r) => r.value === 'ember').rate, r1((mine.filter(flag).length / mine.length) * 100));
  assert.equal(ranked.from, 'occurrences');
  // Overall and by version, the cells count a filtered flag: won per mode value.
  const [overall] = board([{ type: 'stat', event: 'match_end:mode=ranked', rate: 'won' }]);
  const all = ends.filter((x) => x.attrs.mode === 'ranked');
  assert.equal(overall.value, r1((all.filter(flag).length / all.length) * 100));
  assert.equal(overall.from, 'cells');
});

test('a rate over time per bucket, and a rate that is not a flag says how to ask', () => {
  const ctx = ctxOf();
  const [series, notFlag, missing] = board(
    [
      { type: 'series', event: 'match_end', rate: 'won', by: '$version' },
      { type: 'stat', event: 'match_end', rate: 'hero' },
      { type: 'stat', event: 'match_end', rate: 'mvp' },
    ],
    ctx,
  );
  assert.deepStrictEqual(series.series.map((s) => s.label).sort(), ['1.0', '1.1']);
  assert.equal(series.unit, '%');
  assert.ok(series.series[0].values.some((v) => v != null && v >= 0 && v <= 100));
  assert.match(notFlag.why, /hero=<value>/);
  assert.match(missing.why, /no "mvp" attribute/);
});

// ───────────────────────────── A1: per hour played ─────────────────────────────

test('hours played add up every frame window, and counts and sums divide by them', () => {
  const ctx = ctxOf();
  assert.equal(overview(ctx).kpis.hours_played, r2(hours));
  const deaths = 0;
  const [h, perHour, gold, byVersion, bySource, series, deathsPerHour] = board(
    [
      { type: 'stat', metric: 'hours_played' },
      { type: 'stat', event: 'match_end', per: '$hours' },
      { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
      { type: 'breakdown', event: 'gold', sum: 'amount', by: '$version', per: '$hours' },
      { type: 'breakdown', event: 'gold', sum: 'amount', by: 'source', per: '$hours' },
      { type: 'series', event: 'match_end', per: '$hours' },
      { type: 'stat', metric: 'deaths', per: '$hours' },
    ],
    ctx,
  );
  assert.deepStrictEqual([h.value, h.unit], [r2(hours), 'h']);
  assert.deepStrictEqual([perHour.value, perHour.unit, perHour.count, perHour.hours], [r2(ends.length / hours), 'per hour', ends.length, r2(hours)]);
  const golds = events.filter((e) => e.name === 'gold');
  assert.equal(gold.value, r2(golds.reduce((s, e) => s + e.attrs.amount, 0) / hours));
  for (const v of ['1.0', '1.1']) {
    const own = events.filter((e) => e.version === v && e.type === 'frame_window').reduce((s, e) => s + e.duration_s, 0) / 3600;
    const row = byVersion.rows.find((r) => r.value === v);
    assert.equal(row.per_hour, r2(golds.filter((e) => e.version === v).reduce((s, e) => s + e.attrs.amount, 0) / own), 'each version over its own hours');
    assert.equal(row.hours, r2(own));
  }
  assert.equal(bySource.rows.find((r) => r.value === 'quest').per_hour, r2(golds.filter((e) => e.attrs.source === 'quest').reduce((s, e) => s + e.attrs.amount, 0) / hours), 'an attribute: every row over all hours');
  assert.equal(series.unit, 'per hour');
  assert.equal(series.hours.length, ctx.buckets.length);
  assert.equal(deathsPerHour.value, deaths);
  // Under 6 minutes of play there is no rate.
  const first = sessions[0].filter((e) => e.type !== 'frame_window' || e === sessions[0].find((x) => x.type === 'frame_window'));
  const [tiny] = board([{ type: 'stat', event: 'match_end', per: '$hours' }], ctxOf(first));
  assert.equal(tiny.empty, true);
  assert.match(tiny.why, /minutes played/);
});

// ───────────────────────────── A3: distributions ─────────────────────────────

test('a distribution: percentiles within 5% from the cells, exact from the occurrences, and a histogram that adds up', () => {
  const [all, byMode, byVersion, median, placement, levels] = board([
    { type: 'distribution', event: 'match_end', of: 'duration_s', bins: 10 },
    { type: 'distribution', event: 'match_end', of: 'duration_s', by: 'mode' },
    { type: 'distribution', event: 'match_end', of: 'duration_s', by: '$version' },
    { type: 'stat', event: 'match_end', of: 'duration_s', quantile: 50, unit: 's' },
    { type: 'distribution', event: 'match_end', of: 'placement' },
    { type: 'levels' },
  ]);
  const values = ends.map((x) => x.attrs.duration_s);
  assert.equal(all.count, values.length);
  for (const [k, q] of [['p50', 0.5], ['p90', 0.9], ['p99', 0.99]]) assert.ok(Math.abs(all[k] / exactQuantile(values, q) - 1) <= 0.05, `${k}: ${all[k]} vs ${exactQuantile(values, q)}`);
  assert.equal(all.mean, r2(values.reduce((a, b) => a + b, 0) / values.length), 'the mean is exact');
  assert.deepStrictEqual([all.min, all.max], [Math.min(...values), Math.max(...values)]);
  assert.equal(all.histogram.reduce((n, b) => n + b.count, 0) + all.under + all.over, all.count);
  assert.ok(all.histogram.length <= 20);
  const step = all.histogram[0].hi - all.histogram[0].lo;
  assert.ok([1, 2, 5].some((m) => Number.isInteger(Math.log10(step / m))), `a round step: ${step}`);
  for (const row of byMode.rows) {
    const mine = ends.filter((x) => x.attrs.mode === row.value).map((x) => x.attrs.duration_s);
    assert.deepStrictEqual([row.count, row.p50, row.p90], [mine.length, exactQuantile(mine, 0.5), exactQuantile(mine, 0.9)], 'exact from the occurrences');
  }
  assert.equal(byMode.from, 'occurrences');
  assert.equal(byVersion.from, 'cells');
  const v10 = byVersion.rows.find((r) => r.value === '1.0');
  const v11 = byVersion.rows.find((r) => r.value === '1.1');
  assert.ok(v11.p50 > v10.p50 * 1.2, 'matches in 1.1 are longer');
  assert.ok(Math.abs(median.value / exactQuantile(values, 0.5) - 1) <= 0.05);
  assert.equal(median.unit, 's');
  assert.equal(placement.whole, true);
  assert.ok(placement.histogram.every((b) => Number.isInteger(b.lo) && b.hi - b.lo === 1), 'whole placements get whole bins');
  assert.deepStrictEqual(placement.histogram.map((b) => b.count), Array.from({ length: 10 }, (_, i) => ends.filter((x) => x.attrs.placement === i + 1).length));
  // Clear times: the median and the slowest 1 in 10 of completed attempts.
  const arena = events.filter((e) => e.type === 'level_complete' && e.level === 'arena').map((e) => e.duration_s);
  const row = levels.rows.find((r) => r.level === 'arena');
  assert.deepStrictEqual([row.p50_complete_s, row.p90_complete_s], [exactQuantile(arena, 0.5), exactQuantile(arena, 0.9)]);
});

test('sessions that sent more than they keep make an occurrence answer estimated, and say how many', () => {
  const long = genreSessions({ start: START, spanMs: 2 * HOUR, sessions: 12, longEvery: 4, prefix: 'l' });
  const list = long.flat().sort((a, b) => a.ts - b.ts);
  const [byMode, pair, cells] = board(
    [
      { type: 'distribution', event: 'match_end', of: 'duration_s', by: 'mode' },
      { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'result=win', min: 1 },
      { type: 'distribution', event: 'match_end', of: 'duration_s' },
    ],
    ctxOf(list),
  );
  assert.equal(byMode.estimated, 3, 'three sessions played 20 matches');
  assert.equal(pair.estimated, 3);
  assert.equal(byMode.count, list.filter((e) => e.name === 'match_end').length, 'weighted, the count stays the events sent');
  assert.equal(cells.estimated, undefined, 'the cells never estimate');
});

test('cells keep at most 32 distributions; past that the event says partial', () => {
  const attrs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, i]));
  const list = [];
  for (let k = 0; k < 4; k++) list.push({ type: 'custom', ts: START + k, service: 'arena', session_id: 's', name: `e${k}`, attrs });
  const [c] = [...rollup(list).values().next().value.values()];
  assert.equal(Object.keys(c.evq).length, MAX_DISTS);
  assert.deepStrictEqual(c.evqc, { e2: 4, e3: 12 });
});

test('cells with rates, lists and distributions merge exactly in any order, and survive JSON', () => {
  const shuffled = [...events].sort((a, b) => (a.session_id < b.session_id ? -1 : 1) || a.ts - b.ts);
  const whole = (list) => {
    const c = newCell();
    for (const cells of rollup(list).values()) for (const x of cells.values()) mergeCell(c, cellFromJSON(JSON.parse(JSON.stringify(cellToJSON(x)))));
    return c;
  };
  const a = whole(events);
  const b = whole(shuffled);
  for (const k of ['evb', 'evl', 'evlb', 'evlx', 'evq', 'evs', 'evx']) assert.deepStrictEqual(sorted(a[k]), sorted(b[k]), k);
  assert.ok(Object.keys(a.evlb).length && Object.keys(a.evq).length);
});

// ───────────────────────────── versions and the events query ─────────────────────────────

test('a versions panel compares rates, percentiles and per-hour sums version by version', () => {
  const [, , , , cmp] = board([
    { type: 'stat', event: 'match_end', rate: 'won' },
    { type: 'stat', event: 'match_end', of: 'duration_s', quantile: 50 },
    { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
    { type: 'stat', event: 'match_end:deck=hog+fireball' },
    { type: 'versions' },
  ]);
  assert.deepStrictEqual(cmp.columns.map((c) => c.unit), ['%', null, 'per hour', 'per session']);
  for (const row of cmp.rows) {
    const mine = ends.filter((x) => x.version === row.version);
    assert.equal(row.values[0], r1((mine.filter(flag).length / mine.length) * 100));
    const own = events.filter((e) => e.version === row.version && e.type === 'frame_window').reduce((s, e) => s + e.duration_s, 0) / 3600;
    assert.equal(row.values[2], r2(events.filter((e) => e.version === row.version && e.name === 'gold').reduce((s, e) => s + e.attrs.amount, 0) / own));
    assert.equal(row.values[3], r2(mine.filter((x) => x.attrs.deck.includes('hog') && x.attrs.deck.includes('fireball')).length / row.sessions));
  }
  assert.ok(cmp.rows[1].values[1] > cmp.rows[0].values[1]);
});

test('the events query answers hours, percentiles per numeric attribute, and one rate or distribution', () => {
  const ctx = ctxOf();
  const params = (o) => new URLSearchParams(o);
  const rate = eventQuery(ctx, params({ name: 'match_end', rate: 'won', by: 'hero', min: '1' })).measure;
  assert.equal(rate.rows.find((r) => r.value === 'ember').events, ends.filter((x) => x.attrs.hero === 'ember').length);
  assert.equal(eventQuery(ctx, params({ name: 'match_end', avg: 'duration_s' })).measure.events, ends.length);
  const dist = eventQuery(ctx, params({ name: 'match_end', of: 'placement', by: '$version' })).distribution;
  assert.equal(dist.rows.length, 2);
  assert.deepStrictEqual(eventQuery(ctx, params({ name: 'match_end' })), {}, 'nothing more without rate, avg or of');
  assert.throws(() => eventQuery(ctx, params({ rate: 'won' })), /need name/);
});

// ───────────────────────────── boards: validation ─────────────────────────────

test('rates, averages, percentiles, per $hours and distributions are checked before they are saved', () => {
  const bad = (panel, re) => assert.throws(() => validateBoard({ panels: [panel] }), re, JSON.stringify(panel));
  bad({ type: 'stat', event: 'm', rate: 'won', avg: 'x' }, /rate or avg, not both/);
  bad({ type: 'stat', event: 'm', rate: 'won', sum: 'x' }, /sum, rate or avg/);
  bad({ type: 'stat', event: 'm', rate: '$version' }, /flag of the event/);
  bad({ type: 'stat', event: 'm', rate: 'result=' }, /word outcome/);
  bad({ type: 'stat', event: 'm', min: 3 }, /min goes with rate or avg/);
  bad({ type: 'stat', event: 'm', rate: 'won', min: 3 }, /breakdown's rows/);
  bad({ type: 'breakdown', event: 'm', by: 'hero', avg: 'x', expect: 3 }, /expect goes with rate/);
  bad({ type: 'breakdown', event: 'm', by: 'hero', rate: 'won', expect: 300 }, /0 to 100/);
  bad({ type: 'breakdown', event: 'm', by: 'hero', rate: 'won', order: 'best' }, /order is/);
  bad({ type: 'stat', event: 'm', of: 'x' }, /quantile/);
  bad({ type: 'stat', event: 'm', of: 'x', quantile: 100 }, /1 to 99/);
  bad({ type: 'stat', event: 'm', rate: 'won', per: '$hours' }, /per goes with a count or sum/);
  bad({ type: 'stat', metric: 'sessions', per: '$hours' }, /deaths or errors per hour played/);
  bad({ type: 'breakdown', event: 'm', by: 'hero', rate: 'won', per: '$hours' }, /per \$hours goes with a count or sum/);
  bad({ type: 'series', event: 'm', by: '$platform', per: '$hours' }, /breakdown/);
  bad({ type: 'distribution', event: 'm' }, /needs of/);
  bad({ type: 'distribution', event: 'm', of: 'x', bins: 41 }, /2 to 40/);
  bad({ type: 'distribution', event: 'm', of: 'x', limit: 9 }, /1 to 8/);
  const ok = validateBoard({ panels: [{ type: 'breakdown', event: 'battle_end', by: 'deck', rate: 'won', min: 200, limit: 20, expect: 50, order: 'count', note: 'n' }] }).panels[0];
  assert.deepStrictEqual(ok, { type: 'breakdown', note: 'n', event: 'battle_end', rate: 'won', min: 200, expect: 50, order: 'count', by: 'deck', limit: 20 });
});

// The example boards of docs/design/genre-coverage.md that need only A1 to A4 validate as they are written.
test("the design's example panels for A1 to A4 validate", () => {
  const panels = [
    { type: 'stat', event: 'match_end', per: '$hours', title: 'Matches per hour played', size: 's' },
    { type: 'stat', event: 'match_end', of: 'survived_s', quantile: 50, title: 'Median time alive', size: 's' },
    { type: 'distribution', event: 'queue', of: 'wait_s', by: 'mode', title: 'Time waiting for a match', size: 'm' },
    { type: 'breakdown', event: 'fight', by: 'weapon', rate: 'won', min: 200, title: 'Fights won, by weapon', size: 'm' },
    { type: 'stat', event: 'match_end', rate: 'won', title: 'Matches won', size: 's', note: 'Should sit near 50%' },
    { type: 'breakdown', event: 'match_end', by: 'items', rate: 'won', min: 100, limit: 20, title: 'Win rate of builds with each item', size: 'm' },
    { type: 'stat', event: 'reached_cap', of: 'played_h', quantile: 50, title: 'Hours to the level cap', size: 's' },
    { type: 'breakdown', event: 'gold_spent', by: 'sink', sum: 'amount', per: '$hours', title: 'Where gold goes, per hour played', size: 'm' },
    { type: 'breakdown', event: 'battle_end', by: 'opponent_deck', rate: 'won', min: 200, limit: 20, title: 'Win rate against decks with each card', size: 'm' },
    { type: 'stat', event: 'loot:rarity=legendary', per: '$hours', title: 'Legendaries per hour played', size: 's' },
    { type: 'stat', metric: 'deaths', per: '$hours', title: 'Deaths per hour played', size: 's' },
    { type: 'breakdown', event: 'run_end', by: 'heat', rate: 'won', order: 'value', title: 'Runs won, by heat', size: 'm' },
    { type: 'breakdown', event: 'boon_offer', by: 'boon', rate: 'picked', min: 50, limit: 20, title: 'Taken when offered', size: 'm' },
    { type: 'breakdown', event: 'pull', by: 'banner', rate: 'top', expect: 0.6, min: 1000, title: 'Top-rarity rate by banner', size: 'l' },
    { type: 'distribution', event: 'return', of: 'away_s', unit: 's', title: 'Time away before coming back', size: 'm' },
  ];
  assert.equal(validateBoard({ panels }).panels.length, panels.length);
});

test('a shared board shows rates and distributions, but no average or spread of money unless its link shows sums', () => {
  const shop = [...events, ...['gems', 'gems', 'pass'].map((item, i) => ({ ...events[0], type: 'custom', ts: events[0].ts + i + 1, name: 'purchase', attrs: { amount: 4.99 + i, currency: 'USD', item } }))];
  const ctx = ctxOf(shop);
  const spec = validateBoard({
    panels: [
      { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won', min: 1 },
      { type: 'stat', event: 'match_end', of: 'duration_s', quantile: 50 },
      { type: 'stat', event: 'purchase', avg: 'amount' },
      { type: 'distribution', event: 'purchase', of: 'amount' },
      { type: 'stat', event: 'purchase', of: 'amount', quantile: 50 },
      { type: 'versions' },
    ],
  });
  const [rate, length, avg, spread, median, cmp] = evaluateBoard(ctx, spec, { shared: { service: 'arena' } });
  assert.ok(!rate.empty && !length.empty);
  for (const p of [avg, spread, median]) assert.match(p.why, /not shown on this shared board/);
  assert.deepStrictEqual(cmp.columns.map((c) => !!c.hidden), [false, true, true], 'version columns of money averages and percentiles are hidden too');
  const [, , shown] = evaluateBoard(ctx, spec, { shared: { service: 'arena', sums: true } });
  assert.equal(shown.value, r2((4.99 + 5.99 + 6.99) / 3));
});

// ───────────────────────────── findings ─────────────────────────────

test("findings read the game's boards: a choice out of line, a rate off what the board expects, the economy and a distribution that moved", () => {
  const big = genreSessions({ start: START, spanMs: 4 * HOUR, sessions: 400, matches: [6, 10], prefix: 'f', seed: 9 });
  const ctx = ctxOf(big.flat().sort((a, b) => a.ts - b.ts));
  ctx.dashboard = {
    pages: [
      {
        id: 'heroes',
        title: 'Heroes',
        panels: validateBoard({
          panels: [
            { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won' },
            { type: 'breakdown', event: 'pull', by: 'banner', rate: 'top', expect: 10 },
            { type: 'stat', event: 'gold', sum: 'amount', per: '$hours', title: 'Gold per hour played' },
            { type: 'distribution', event: 'match_end', of: 'duration_s', unit: 's' },
          ],
        }).panels,
      },
    ],
  };
  const found = findings(ctx, []);
  const balance = found.find((f) => f.id === 'balance-match_end-hero-ember');
  assert.ok(balance, found.map((f) => f.id).join(', '));
  assert.ok(balance.evidence.events >= 500 && balance.evidence.low > balance.evidence.overall_pct + 5);
  assert.match(balance.title, /^hero ember: won in \d+(\.\d)?% of [\d,]+ match_end events, against \d+(\.\d)?% for all$/);
  assert.equal(balance.link.page, 'heroes');
  assert.ok(!found.some((f) => f.id === 'balance-match_end-hero-frost'), 'heroes within 5 points of the rest are not out of line');
  const expect = found.filter((f) => f.id.startsWith('expect-pull-'));
  assert.deepStrictEqual(expect.map((f) => f.id).sort(), ['expect-pull-summer', 'expect-pull-winter']);
  assert.equal(expect[0].severity, 'medium', 'no built-in verdict on odds: a medium finding that says what was measured');
  const economy = found.find((f) => f.id === 'economy-gold-1.1');
  assert.ok(economy);
  assert.match(economy.title, /^Gold per hour played went up [\d.]+× in 1\.1, most of it from source loot \(3×\)$/);
  const shift = found.find((f) => f.id === 'shift-match_end-duration_s');
  assert.ok(shift && shift.evidence.p50_change_pct > 30);
  // Without a saved dashboard there are none of these.
  assert.ok(!findings({ ...ctxOf(big.flat()), dashboard: null }, []).some((f) => /^(balance|expect|economy|shift)-/.test(f.id)));
});

// ───────────────────────────── over more than 31 days ─────────────────────────────

test('day rollups answer rates, lists, per-hour numbers and distributions as the raw events do at day resolution', () => {
  const D0 = Math.floor(NOW / DAY) * DAY - 3 * DAY;
  const list = genreSessions({ start: D0 + HOUR, spanMs: 2 * DAY - 3 * HOUR, sessions: 50, prefix: 'd' })
    .flat()
    .sort((a, b) => a.ts - b.ts);
  const states = [...indexSessions(list).values()];
  const days = [D0, D0 + DAY].map((day) => {
    const cells = rollup(list);
    return JSON.parse(JSON.stringify(foldDay(day, { cells, sessions: states.filter((s) => sessionDay(s) === day) }), (k, v) => (v instanceof Map ? [...v] : v)));
  });
  // Folded and merged as a store keeps them: through their parts (daily.js dayParts).
  const merged = mergeDays(
    [D0, D0 + DAY].map((day) => foldDay(day, { cells: rollup(list), sessions: states.filter((s) => sessionDay(s) === day) })),
    () => true,
  );
  assert.ok(days.length === 2);
  const range = { ...q, from: D0, to: D0 + 2 * DAY - 1 };
  const daily = sessionContext(range, new Map());
  Object.assign(daily, { daily: merged.daily, cells: merged.cells, facts: merged.facts, meta: { approximate: [] }, drill: { hitches: [] } });
  const raw = buildContext(list, range);
  const panels = [
    { type: 'stat', event: 'match_end', rate: 'won' },
    { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won', min: 1 },
    { type: 'breakdown', event: 'match_end', by: 'deck' },
    { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
    { type: 'distribution', event: 'match_end', of: 'duration_s', by: '$version' },
  ];
  const strip = (list) => list.map(({ sessions, ...p }) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'sessions' || k === 'ts' ? undefined : v))));
  assert.deepStrictEqual(strip(board(panels, daily)), strip(board(panels, raw)));
  // Splits that read occurrences come from the days' samples: every session here, so the same answer.
  const [byMode] = board([{ type: 'distribution', event: 'match_end', of: 'duration_s', by: 'mode' }], daily);
  const [rawMode] = board([{ type: 'distribution', event: 'match_end', of: 'duration_s', by: 'mode' }], raw);
  assert.deepStrictEqual(byMode.rows, rawMode.rows);
  const [platform] = board([{ type: 'breakdown', event: 'match_end', by: '$platform', rate: 'won' }], daily);
  assert.match(platform.why, /31 days or less/);
});

// ───────────────────────────── every store ─────────────────────────────

const BOARD = [
  { type: 'stat', event: 'match_end', rate: 'won', title: 'Matches won' },
  { type: 'stat', event: 'match_end', of: 'duration_s', quantile: 50, unit: 's' },
  { type: 'stat', event: 'gold', sum: 'amount', per: '$hours' },
  { type: 'stat', metric: 'hours_played' },
  { type: 'stat', event: 'match_end:deck=hog+fireball' },
  { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'won', min: 1 },
  { type: 'breakdown', event: 'match_end', by: 'hero', rate: 'result=win', min: 1 },
  { type: 'breakdown', event: 'match_end', by: 'deck', rate: 'won', min: 1, limit: 20 },
  { type: 'breakdown', event: 'match_end', by: '$platform', avg: 'duration_s', min: 1 },
  { type: 'breakdown', event: 'gold', by: '$version', sum: 'amount', per: '$hours' },
  { type: 'series', event: 'match_end', rate: 'won', by: '$level' },
  { type: 'distribution', event: 'match_end', of: 'duration_s', by: 'mode' },
  { type: 'distribution', event: 'match_end', of: 'placement', by: '$version' },
  { type: 'levels' },
  { type: 'versions' },
];
for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: rates, lists, hours played and distributions answer as the raw events do`, async () => {
    const { store, close: closeStore, settle } = await make({ legacyProject: null });
    const auth = { resolveIngest: () => ({ projectId: 'p1' }), resolveReader: () => ({ projectId: 'p1', scopes: ['read', 'dashboard'] }) };
    const server = http.createServer(createApp({ store, auth, logger: { warn() {}, error() {} } }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'x-glitchless-api-key': 'k' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    try {
      for (const list of sessions) {
        const { service, env, version, session_id, player_id } = list[0];
        for (let i = 0; i < list.length; i += 40) {
          const res = await fetch(`${base}/v1/intake?token=t`, { method: 'POST', body: JSON.stringify({ service, env, version, session_id, player_id, events: list.slice(i, i + 40).map(({ service: _, env: __, version: ___, session_id: ____, player_id: _____, ...e }) => e) }) });
          assert.equal(res.status, 202);
        }
      }
      await settle?.();
      await call('PUT', '/v1/dashboard?service=arena', { pages: [{ id: 'genre', title: 'Genre', panels: BOARD }] });
      const range = `service=arena&from=${START - 60_000}&to=${NOW + 1}`;
      const { meta, board: got } = await call('GET', `/v1/query/board?${range}&page=genre`);
      const inRange = events.filter((e) => e.ts >= meta.from && e.ts <= meta.to);
      const raw = buildContext(inRange, { ...q, from: meta.from, to: meta.to });
      // A store knows when it first saw each version (versions panels show it); the raw events alone don't.
      const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'first_seen_ever' ? undefined : v)));
      assert.deepStrictEqual(plain(got.panels), plain(evaluateBoard(raw, validateBoard({ panels: BOARD }))));
      assert.ok(got.panels.every((p) => !p.empty), got.panels.filter((p) => p.empty).map((p) => `${p.title}: ${p.why}`).join('; '));
      const ev = await call('GET', `/v1/query/events?${range}&name=match_end&rate=won&by=deck&min=1`);
      assert.deepStrictEqual(ev.measure, JSON.parse(JSON.stringify(eventQuery(raw, new URLSearchParams({ name: 'match_end', rate: 'won', by: 'deck', min: '1' })).measure)));
      assert.equal(ev.hours, r2(inRange.filter((e) => e.type === 'frame_window').reduce((s, e) => s + e.duration_s, 0) / 3600));
      assert.ok(ev.events[0].attrs.find((a) => a.key === 'duration_s').p50 > 0, 'each numeric attribute has its percentiles');
      const dist = await call('GET', `/v1/query/events?${range}&name=match_end&of=duration_s&by=hero`);
      assert.equal(dist.distribution.rows.length, 5);
      assert.equal((await call('GET', `/v1/query/events?${range}&name=match_end&rate=won&by=$Nope`)).error !== undefined, true, 'a bad split is a 400');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await closeStore?.();
    }
  });
}

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

function sorted(o) {
  return Object.fromEntries(Object.entries(o || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
