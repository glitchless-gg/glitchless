// Known findings (known.js): the ones a game's owner accepts. The weekly summary leaves them out and fills its three
// with the next; triage keeps them, marked, after the rest; "until it gets worse" brings one back. Built on a week like
// Starlift's at the start of November 2026, whose owner accepts its slow first iPhone launch and lesson 1's freeze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { buildContext } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { markKnown, knownEntry, knownSnapshot, gotWorse, KNOWN_LIMITS } from '../src/known.js';
import { weeklySummary, weeklyMessage, plainFinding, weekStart } from '../src/alerts.js';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T15:00:00Z'); // a Monday, after the summary's 14:00
const WEEK = weekStart(NOW) - 7 * DAY; // Monday 26 October
const GODOT = 'glitchless-godot/0.6.0';

function session(i, events = []) {
  const ts = WEEK + DAY + i * 3_600_000;
  const base = { service: 'starlift', env: 'prod', version: '1.1.3', session_id: `s_${i}`, player_id: `s_${i}`, sdk: GODOT };
  return [{ type: 'session_start', ts, session_type: 'user', device: { browser: 'Godot', os: 'iOS', gpu_tier: 'high' } }, ...events.map((e) => ({ ...e, ts: ts + e.ts }))].map((e) => ({ level: null, ...e, ...base }));
}

function frames(level, ts, values) {
  const sk = new Sketch();
  values.forEach((v) => sk.add(v));
  return { type: 'frame_window', ts, level, duration_s: 5, frames: values.length, budget_ms: 8.33, ft: sk.toJSON(), hitches: values.filter((v) => v > 50).length };
}

const error = (fingerprint, message) => ({ type: 'error', ts: 9000, kind: 'engine', fingerprint, message, fn: '_ready', source: 'main.gd', line: 40 });

// 40 player sessions: half wait 6 to 11 s for the first frame; lesson 1 freezes as its shaders compile; Endless runs a
// little slow; two errors.
function starliftWeek() {
  const evs = [];
  for (let i = 0; i < 40; i++) {
    const own = [{ type: 'load', ts: 50, ttff_ms: i % 2 ? 600 : 6000 + (i % 10) * 500 }];
    if (i < 20) own.push({ type: 'level_start', ts: 1000, level: 'tutorial_1_up_and_down' }, frames('tutorial_1_up_and_down', 5000, [...Array(25).fill(8.3), ...Array(5).fill(1400)]));
    own.push({ type: 'level_start', ts: 7000, level: 'endless_normal' }, frames('endless_normal', 12_000, [...Array(27).fill(8.3), ...Array(3).fill(28)]));
    if (i % 5 === 0) own.push(error('aa11bb22', 'Invalid call. Nonexistent function in base Nil.'));
    if (i % 10 === 3) own.push(error('cc33dd44', 'Condition "!is_inside_tree()" is true.'));
    evs.push(...session(i, own));
  }
  return evs;
}

// The summary's store: the events in each range it asks for.
const storeOf = (evs) => ({ query: async (projectId, q) => evs.filter((e) => e.ts >= q.from && e.ts < q.to), rollups: async () => null });

const KNOWN = [
  { id: 'load-ttff', note: 'The first iPhone launch compiles shaders; accepted', by: 'Owner', at: '2026-11-02T12:00:00.000Z' },
  { id: 'perf-level-tutorial_1_up_and_down', note: "Lesson 1's shader compile; accepted", by: 'Owner', at: '2026-11-02T12:00:00.000Z' },
];

test("a weekly summary leaves out the findings marked known and lists the next ones", async () => {
  const store = storeOf(starliftWeek());
  const plain = await weeklySummary(store, 'p', { service: 'starlift', name: 'Starlift', now: NOW });
  assert.deepEqual(plain.fixes.slice(0, 2).map((f) => f.id).sort(), ['load-ttff', 'perf-level-tutorial_1_up_and_down'], `without known: ${plain.fixes.map((f) => f.id)}`);
  assert.deepEqual(plain.known, []);

  const w = await weeklySummary(store, 'p', { service: 'starlift', name: 'Starlift', now: NOW, known: KNOWN });
  const ids = w.fixes.map((f) => f.id);
  assert.equal(ids.length, 3);
  assert.ok(!ids.includes('load-ttff') && !ids.includes('perf-level-tutorial_1_up_and_down'), `fixes: ${ids}`);
  assert.equal(ids[0], plain.fixes[2].id, "the next one moves up into the first place");
  assert.ok(ids.includes('perf-level-endless_normal') && ids.includes('error-aa11bb22') && ids.includes('error-cc33dd44'), `fixes: ${ids}`);
  assert.deepEqual(w.known.sort(), ['load-ttff', 'perf-level-tutorial_1_up_and_down']);

  const m = weeklyMessage(w, { link: () => 'https://app.example/' });
  assert.match(m.title, /3 things worth fixing\.$/);
  assert.equal(m.lines.at(-1), 'Left out: 2 findings marked as known.');
  assert.ok(!m.fixes.some((f) => /slow to start|tutorial_1_up_and_down/.test(f.text)), m.fixes.map((f) => f.text).join(' | '));
  assert.match(m.agent.at(-1), /^Left out as known: (load-ttff, perf-level-tutorial_1_up_and_down|perf-level-tutorial_1_up_and_down, load-ttff)\.$/);
});

test('triage keeps known findings, marked with the note, after the rest in their order', () => {
  const ctx = buildContext(starliftWeek(), { service: 'starlift', from: WEEK, to: WEEK + 7 * DAY, type: 'all' });
  const plain = findings(ctx);
  ctx.known = { entries: KNOWN, now: NOW };
  const marked = findings(ctx);
  assert.equal(marked.length, plain.length, 'none is dropped');
  const rest = plain.filter((f) => !KNOWN.some((k) => k.id === f.id));
  assert.deepEqual(marked.map((f) => f.id), [...rest, ...plain.filter((f) => !rest.includes(f))].map((f) => f.id));
  const ttff = marked.find((f) => f.id === 'load-ttff');
  assert.deepEqual(ttff.known, { id: 'load-ttff', note: 'The first iPhone launch compiles shaders; accepted', by: 'Owner', at: '2026-11-02T12:00:00.000Z' });
  assert.equal(ttff.severity, plain.find((f) => f.id === 'load-ttff').severity, 'severity is what it measures, known or not');
});

test('an entry covers the findings whose id starts with it, the longest entry winning, through its until day', () => {
  const list = [
    { id: 'perf-level-a', severity: 'high', impact: 0.5 },
    { id: 'perf-level-tutorial_1_up_and_down', severity: 'critical', impact: 0.4 },
    { id: 'perf-level-tutorial_2_boost', severity: 'medium', impact: 0.3 },
    { id: 'error-ff', severity: 'medium', impact: 0.2 },
  ];
  const entries = [
    { id: 'perf-level-tutorial_', note: 'every lesson compiles its shaders' },
    { id: 'perf-level-tutorial_1_up_and_down', note: 'lesson 1 most of all' },
    { id: 'error-ff', note: 'until the fix ships', until: '2026-11-08' },
  ];
  assert.equal(knownEntry('perf-level-tutorial_1_up_and_down', entries).note, 'lesson 1 most of all');
  assert.equal(knownEntry('perf-level-tutorial_2_boost', entries).note, 'every lesson compiles its shaders');
  assert.equal(knownEntry('perf-level-a', entries), null);
  const marked = markKnown(list, { entries, now: Date.parse('2026-11-08T23:59:00Z') });
  assert.deepEqual(marked.map((f) => [f.id, f.known?.id ?? null]), [
    ['perf-level-a', null],
    ['perf-level-tutorial_1_up_and_down', 'perf-level-tutorial_1_up_and_down'],
    ['perf-level-tutorial_2_boost', 'perf-level-tutorial_'],
    ['error-ff', 'error-ff'],
  ]);
  assert.equal(marked[3].known.until, '2026-11-08');
  const after = markKnown(list, { entries, now: Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(after[1].id, 'error-ff', 'from the day after its until day, it is back among the rest');
  assert.equal(after[1].known, undefined);
  assert.equal(markKnown(list, { entries: [], now: NOW }), list);
});

test('"until it gets worse" brings a finding back a quarter worse, more severe, or new under its prefix', () => {
  const f = (o = {}) => ({ id: 'load-ttff', severity: 'high', impact: 0.44, evidence: { ttff_p95: 10_600 }, ...o });
  const was = knownSnapshot(f());
  assert.deepEqual(was, { severity: 'high', impact: 0.44, value: 10_600 });
  assert.equal(gotWorse(f({ impact: 0.5, evidence: { ttff_p95: 12_000 } }), was), null, 'a week that moves a little');
  assert.match(gotWorse(f({ evidence: { ttff_p95: 13_250 } }), was), /^p95 time to first frame \(ms\) 10600 → 13250 since it was marked known$/);
  assert.match(gotWorse(f({ impact: 0.56 }), was), /^impact 44% → 56% of sessions/);
  assert.equal(gotWorse(f({ impact: 0.05 }), { ...was, impact: 0.03 }), null, `${KNOWN_LIMITS.worsePoints} points more at least, not just ${KNOWN_LIMITS.worseTimes}×`);
  assert.match(gotWorse(f({ id: 'error-ab', severity: 'high', evidence: {} }), { severity: 'medium', impact: 0.44 }), /^severity medium → high/);

  const entries = [{ id: 'perf-level-tutorial_', note: 'shaders compile', worse: true, was: { 'perf-level-tutorial_1_up_and_down': { severity: 'critical', impact: 0.2, value: 1400 } } }];
  const list = [
    { id: 'perf-level-tutorial_1_up_and_down', severity: 'critical', impact: 0.22, evidence: { p95: 1500 } },
    { id: 'perf-level-tutorial_3_items', severity: 'medium', impact: 0.1, evidence: { p95: 30 } },
  ];
  const [back, known] = markKnown(list, { entries, now: NOW });
  assert.equal(back.id, 'perf-level-tutorial_3_items');
  assert.deepEqual(back.came_back, { known: 'perf-level-tutorial_', note: 'shaders compile', why: 'new since findings like it were marked known, so there is nothing to compare it with', new: true });
  assert.equal(known.known.until_worse, true);
  const [worse] = markKnown([{ ...list[0], evidence: { p95: 1800 } }], { entries, now: NOW });
  assert.match(worse.came_back.why, /^p95 frame time \(ms\) 1400 → 1800/);
  assert.equal(plainFinding({ ...worse, evidence: { level: 'tutorial_1_up_and_down', p95: 1800, hitches_per_min: 10 }, impact_pct: 22 }, 'Starlift').text, 'tutorial_1_up_and_down stutters: it freezes for a moment about 10 times a minute, for the 22% of sessions that play it. It was marked as known, and has got worse since.');
});

test('a mixed version finding says what got better and what got worse, in plain words', () => {
  const v = (verdict, changes) => ({ id: 'version-1.1.2-1.1.3', severity: 'medium', title: `1.1.3 vs 1.1.2: ${verdict} — x`, evidence: { previous: { version: '1.1.2' }, current: { version: '1.1.3' }, verdict, changes } });
  const mixed = v('mixed', [
    { name: 'hitches', worse: false },
    { name: 'rage quits', worse: false },
    { name: 'level completion', worse: true },
  ]);
  assert.equal(plainFinding(mixed, 'Starlift').text, '1.1.3 is better than 1.1.2 in some ways and worse in others: fewer freezes and fewer players quitting right after losing, but fewer players finishing levels.');
  const regressed = v('regressed', [
    { name: 'crash-free sessions', worse: true },
    { name: 'frame time', worse: true },
  ]);
  assert.equal(plainFinding(regressed, 'Starlift').text, '1.1.3 does worse than 1.1.2 for players: more crashes and slower frames.');
  // A finding from before the verdict was kept says it from its title.
  assert.equal(plainFinding({ ...mixed, evidence: { previous: { version: '1.1.2' }, current: { version: '1.1.3' } } }, 'Starlift').text, '1.1.3 is better than 1.1.2 in some ways and worse in others.');

  // findings.js gives the verdict and each change: here 1.1.3's players finish more runs, and more of them hit an error.
  const evs = [];
  for (const version of ['1.1.2', '1.1.3'])
    for (let i = 0; i < 12; i++) {
      const id = `${version}_${i}`;
      const ts = WEEK + i * 60_000 + (version === '1.1.3' ? DAY : 0);
      const base = { service: 'starlift', env: 'prod', version, session_id: id, player_id: id, sdk: GODOT, level: null };
      const won = version === '1.1.3' && i < 6;
      evs.push(
        { ...base, type: 'session_start', ts, session_type: 'user', device: { browser: 'Godot', os: 'iOS', gpu_tier: 'high' } },
        { ...base, type: 'level_start', ts: ts + 1000, level: 'voyage_1' },
        { ...base, type: won ? 'level_complete' : 'level_fail', ts: ts + 30_000, level: 'voyage_1', ...(won ? {} : { cause: 'overrun' }) },
        ...(version === '1.1.3' && i < 3 ? [{ ...base, type: 'error', ts: ts + 20_000, kind: 'engine', fingerprint: 'ee55', message: 'boom', fn: 'f', source: 'a.gd', line: 1 }] : []),
      );
    }
  const f = findings(buildContext(evs, { service: 'starlift', from: WEEK, to: WEEK + 7 * DAY, type: 'all' })).find((x) => x.id === 'version-1.1.2-1.1.3');
  assert.ok(f, 'a version finding');
  assert.equal(f.evidence.verdict, 'mixed', f.title);
  assert.deepEqual(f.evidence.changes, [
    { name: 'error-free sessions', worse: true },
    { name: 'level completion', worse: false },
  ]);
  assert.equal(plainFinding(f, 'Starlift').text, '1.1.3 is better than 1.1.2 in some ways and worse in others: more players finishing levels, but more errors.');
});

test("a host's known findings mark the findings it answers, and they come last", async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'gl-known-')));
  const asked = [];
  const app = createApp({ store, known: async (projectId) => (asked.push(projectId), [{ id: 'error-', note: 'all errors are known here', by: 'Owner', at: '2026-11-02T12:00:00.000Z' }]), logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const events = [{ type: 'session_start', ts: now - 60_000, session_type: 'user' }, ...(i < 3 ? [{ type: 'error', ts: now - 50_000, kind: 'error', fingerprint: 'beef01', message: 'boom' }] : [])];
      const res = await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'starlift', env: 'prod', version: '1.1.3', session_id: `s_${i}`, sdk: GODOT, events }) });
      assert.ok(res.ok);
    }
    const body = await (await fetch(`${base}/v1/query/findings?service=starlift&from=${now - 3_600_000}&to=${now}`)).json();
    const f = body.findings.find((x) => x.id === 'error-beef01');
    assert.ok(f, `findings: ${body.findings.map((x) => x.id)}`);
    assert.equal(f.known.note, 'all errors are known here');
    assert.equal(body.findings.at(-1).id, 'error-beef01', 'known ones come last');
    assert.ok(asked.length >= 1 && asked.every((p) => p === asked[0]));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
