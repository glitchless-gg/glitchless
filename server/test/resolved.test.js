// Resolved errors (resolved.js): issues a game's owner has dealt with. Lists keep them, marked, after the rest; triage,
// the overview and the weekly summary leave them out; one that fires again in a later version is back, first, and new
// to the new_error alert, while stragglers on the old builds don't bring it back. Built on Starlift at the start of
// November 2026: a SwiftShader error on Google Play's test phones, resolved in 1.1.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, errorList, overview, versionNewer } from '../src/analytics.js';
import { findings } from '../src/findings.js';
import { resolvedMark } from '../src/resolved.js';
import { weeklySummary, weeklyMessage, evaluate, alertMessage, weekStart } from '../src/alerts.js';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/stores/file.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const RESOLVED_AT = NOW - 2 * DAY;
const GODOT = 'glitchless-godot/0.6.0';
const SHADER = '9803ec1a';
const OTHER = 'cc33dd44';

// One player's session on `version` at `ts`, with the errors given (each a fingerprint).
function session(i, version, ts, errors = []) {
  const base = { service: 'starlift', env: 'prod', version, session_id: `s_${i}`, player_id: `s_${i}`, sdk: GODOT, level: null };
  return [
    { ...base, type: 'session_start', ts, session_type: 'user', device: { browser: 'Godot', os: 'Android', gpu_tier: 'low' } },
    ...errors.map((fp, n) => ({ ...base, type: 'error', ts: ts + 1000 + n, kind: 'engine', fingerprint: fp, message: fp === SHADER ? 'active uniforms exceed GL_MAX_FRAGMENT_UNIFORM_VECTORS (261)' : 'Condition "!is_inside_tree()" is true.', fn: '_compile', source: 'shader_gles3.cpp', line: 241, level: 'endless_normal' })),
    { ...base, type: 'session_end', ts: ts + 60_000, reason: 'quit' },
  ];
}

// Five days before it was resolved: the shader error in 1.1.1 and 1.1.2, the other in 1.1.2. Then what `after` adds.
function week(after = []) {
  const evs = [];
  let i = 0;
  for (let d = 5; d >= 3; d--) {
    for (let k = 0; k < 4; k++) evs.push(...session(i++, k < 2 ? '1.1.1' : '1.1.2', NOW - d * DAY + k * HOUR, k % 2 ? [SHADER] : [SHADER, OTHER]));
  }
  for (const [version, n] of after) for (let k = 0; k < n; k++) evs.push(...session(i++, version, NOW - DAY + k * HOUR, [SHADER]));
  // Players on 1.1.3 without the error, so the newest version is known before it came back.
  for (let k = 0; k < 6; k++) evs.push(...session(i++, '1.1.3', NOW - 2.5 * DAY + k * HOUR));
  return evs;
}

const ENTRY = { fingerprint: SHADER, note: "Google Play's test phones on SwiftShader", by: 'Owner', at: new Date(RESOLVED_AT).toISOString(), version: '1.1.2' };
const ctxOf = (evs, resolved = [ENTRY], extra = {}) => Object.assign(buildContext(evs, { service: 'starlift', from: NOW - 7 * DAY, to: NOW, type: 'all' }), resolved ? { resolved: { entries: resolved, ...extra } } : {});

test('a resolved error is marked and listed last, its finding and its place in the top errors gone', () => {
  const ctx = ctxOf(week());
  const list = errorList(ctx);
  assert.deepEqual(list.map((i) => i.fingerprint), [OTHER, SHADER], 'the open one first, though the resolved one hit more sessions');
  assert.deepEqual(list[1].resolved, { at: ENTRY.at, version: '1.1.2', note: ENTRY.note, by: 'Owner' });
  assert.equal(list[0].resolved, undefined);
  const ids = findings(ctx).map((f) => f.id);
  assert.ok(ids.includes(`error-${OTHER}`) && !ids.includes(`error-${SHADER}`), `findings: ${ids}`);
  assert.deepEqual(overview(ctx).top_errors.map((i) => i.fingerprint), [OTHER]);
  // Without the list, the same issue is open and has its finding.
  assert.ok(findings(ctxOf(week(), null)).some((f) => f.id === `error-${SHADER}`));
});

test('stragglers on the old builds after it was resolved leave it resolved', () => {
  const list = errorList(ctxOf(week([['1.1.2', 3], ['1.1.1', 2]])));
  const issue = list.find((i) => i.fingerprint === SHADER);
  assert.ok(issue.resolved && !issue.came_back, JSON.stringify(issue.came_back));
  assert.equal(list.at(-1).fingerprint, SHADER);
});

test('it comes back when it fires in a later version, first in the list, with a finding that says so', () => {
  const ctx = ctxOf(week([['1.1.2', 2], ['1.1.3', 3]]));
  const list = errorList(ctx);
  assert.equal(list[0].fingerprint, SHADER, 'back first');
  const back = list[0].came_back;
  assert.equal(back.version, '1.1.3');
  assert.equal(back.since, NOW - DAY + 1000, 'the first time it fired in 1.1.3');
  assert.deepEqual(back.resolved, { at: ENTRY.at, version: '1.1.2', note: ENTRY.note, by: 'Owner' });
  assert.equal(list[0].resolved, undefined);
  const f = findings(ctx).find((x) => x.id === `error-${SHADER}`);
  assert.ok(f, 'its finding is back');
  assert.deepEqual(f.came_back, { resolved: SHADER, note: ENTRY.note, version: '1.1.3', why: 'came back in 1.1.3 on 2026-11-01, after it was resolved in 1.1.2 on 2026-10-31' });
});

test('resolved for any version, it comes back on the old builds too', () => {
  const list = errorList(ctxOf(week([['1.1.2', 1]]), [{ ...ENTRY, any: true }]));
  const issue = list.find((i) => i.fingerprint === SHADER);
  assert.equal(issue.came_back.version, '1.1.2');
  assert.equal(issue.came_back.resolved.any_version, true);
  // Not firing at all after it was resolved, it stays resolved.
  assert.ok(errorList(ctxOf(week(), [{ ...ENTRY, any: true }])).find((i) => i.fingerprint === SHADER).resolved);
});

test('versions are later by the store\'s first sighting, else by number; names without a sighting by when it first fired', () => {
  assert.equal(versionNewer('1.10.0', '1.9.2'), true);
  assert.equal(versionNewer('1.1.2', '1.1.3'), false);
  assert.equal(versionNewer('2026.11', '2026.10'), true);
  assert.equal(versionNewer('blue', 'red'), null);
  assert.equal(versionNewer('blue', 'red', new Map([['red', 1], ['blue', 2]])), true);
  assert.equal(versionNewer('1.2', '1.10', { '1.2': 9, '1.10': 3 }), true, 'a sighting wins over the numbers, as in releaseOrder');
  const at = Date.parse(ENTRY.at);
  const e = { ...ENTRY, version: 'red' };
  assert.ok(resolvedMark({ last: at + 5, versions: { red: at - 10 } }, e).resolved, 'only the old name');
  assert.equal(resolvedMark({ last: at + 5, versions: { red: at - 10, blue: at + 5 } }, e).came_back.version, 'blue', 'a name first seen with it after it was resolved');
  assert.ok(resolvedMark({ last: at + 5, versions: { red: at - 10, blue: at - 5 } }, e).resolved, 'a name it fired in before it was resolved');
  // Resolved before it was ever seen with a version: any firing after brings it back.
  assert.ok(resolvedMark({ last: at + 5, versions: { red: at - 10 } }, { ...ENTRY, version: null }).came_back);
});

test("a share link's reader sees resolved and came back without the note or who", () => {
  const list = errorList(ctxOf(week([['1.1.3', 1]]), [ENTRY, { ...ENTRY, fingerprint: OTHER }], { share: true }));
  assert.deepEqual(list[0].came_back.resolved, { at: ENTRY.at, version: '1.1.2' });
  assert.deepEqual(list[1].resolved, { at: ENTRY.at, version: '1.1.2' });
  const f = findings(ctxOf(week([['1.1.3', 3]]), [ENTRY], { share: true })).find((x) => x.id === `error-${SHADER}`);
  assert.equal(f.came_back.note, null);
});

test('the weekly summary leaves a resolved error out, and says when one came back', async () => {
  const end = weekStart(NOW);
  const store = (evs) => ({ query: async (projectId, q) => evs.filter((e) => e.ts >= q.from && e.ts < q.to), rollups: async () => null });
  // The same days a week earlier, so they fall in the summary's week.
  const shift = (evs) => evs.map((e) => ({ ...e, ts: e.ts - (NOW - end) - DAY }));
  const at = new Date(RESOLVED_AT - (NOW - end) - DAY).toISOString();
  const plain = await weeklySummary(store(shift(week())), 'p', { service: 'starlift', name: 'Starlift', now: NOW });
  assert.ok(plain.fixes.some((f) => f.id === `error-${SHADER}`), plain.fixes.map((f) => f.id).join());
  const w = await weeklySummary(store(shift(week())), 'p', { service: 'starlift', name: 'Starlift', now: NOW, resolved: [{ ...ENTRY, at }] });
  assert.ok(!w.fixes.some((f) => f.id === `error-${SHADER}`), w.fixes.map((f) => f.id).join());
  const back = await weeklySummary(store(shift(week([['1.1.3', 4]]))), 'p', { service: 'starlift', name: 'Starlift', now: NOW, resolved: [{ ...ENTRY, at }] });
  const fix = back.fixes.find((f) => f.id === `error-${SHADER}`);
  assert.ok(fix, back.fixes.map((f) => f.id).join());
  assert.match(fix.text, /It was resolved, and came back in 1\.1\.3\.$/);
  assert.ok(weeklyMessage(back, { link: () => null }).fixes.some((f) => f.text === fix.text));
});

test('the new_error alert skips a resolved error and treats one that came back as new, once per version', () => {
  const rules = { new_error: true, crashes: false, release: false, quiet: false, store: false };
  const run = (evs, seen) => {
    const ctx = ctxOf(evs);
    const errors = errorList(ctx).map((i) => ({ ...i, players: 12 }));
    return evaluate({ now: NOW, errors, seen, settings: { rules }, enabledAt: NOW - 30 * DAY }).signals.filter((s) => s.rule === 'new_error');
  };
  // Seen for days: neither is new, and the resolved one isn't even weighed.
  const seen = { [SHADER]: [NOW - 5 * DAY, NOW - 3 * DAY], [OTHER]: [NOW - 5 * DAY, NOW - 3 * DAY] };
  assert.deepEqual(run(week([['1.1.2', 3]]), seen).map((s) => s.key), [`error-${OTHER}`]);
  const [back] = run(week([['1.1.3', 3]]), seen).filter((s) => s.issue.fingerprint === SHADER);
  assert.equal(back.key, `error-${SHADER}-back-1.1.3`);
  assert.equal(back.finding, `error-${SHADER}`);
  assert.equal(back.holds, true, 'it came back within the last day and reached 12 players');
  const m = alertMessage({ ...back, service: 'starlift', at: NOW }, { name: 'Starlift' });
  assert.equal(m.title, 'An error you resolved in 1.1.2 came back in Starlift 1.1.3: 12 players hit it in the last day.');
  assert.match(m.big.normal, /^Resolved on 2026-10-31: "Google Play's test phones on SwiftShader"$/);
  assert.ok(m.agent.some((l) => l === 'It came back in 1.1.3 on 2026-11-01, after it was resolved in 1.1.2 on 2026-10-31.'), m.agent.join(' | '));
});

test("a host's resolved errors mark the errors query and a board's errors panel, and leave triage", async () => {
  const store = new FileStore(mkdtempSync(join(tmpdir(), 'gl-resolved-')));
  const asked = [];
  const app = createApp({ store, resolved: async (projectId) => (asked.push(projectId), [{ ...ENTRY, at: new Date(Date.now() - DAY).toISOString() }]), logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const events = [{ type: 'session_start', ts: now - 2 * DAY, session_type: 'user' }, { type: 'error', ts: now - 2 * DAY + 1000, kind: 'engine', fingerprint: i < 3 ? SHADER : OTHER, message: 'boom' }];
      assert.ok((await fetch(`${base}/v1/intake?token=gl_pub_dev`, { method: 'POST', body: JSON.stringify({ service: 'starlift', env: 'prod', version: '1.1.2', session_id: `s_${i}`, sdk: GODOT, events }) })).ok);
    }
    const q = (name, extra = '') => fetch(`${base}/v1/query/${name}?service=starlift&from=${now - 3 * DAY}&to=${now}${extra}`).then((r) => r.json());
    const { issues } = await q('errors');
    assert.deepEqual(issues.map((i) => [i.fingerprint, Boolean(i.resolved)]), [[OTHER, false], [SHADER, true]]);
    assert.equal(issues[1].resolved.note, ENTRY.note);
    assert.ok(!(await q('findings')).findings.some((f) => f.id === `error-${SHADER}`));
    const board = await fetch(`${base}/v1/dashboard?service=starlift`, { method: 'PUT', body: JSON.stringify({ pages: [{ id: 'errs', title: 'Errors', panels: [{ type: 'errors' }] }] }) });
    assert.ok(board.ok, await board.text());
    const panel = (await q('board', '&page=errs')).board.panels[0];
    assert.deepEqual(panel.issues.map((i) => [i.fingerprint, i.resolved?.version ?? null]), [[OTHER, null], [SHADER, '1.1.2']]);
    assert.ok(asked.length >= 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
