// Jam rooms (rooms.js, rooms-api.js, play.js; SPEC §3j): a room and its code, games joining and publishing their built
// files, the arcade and big screen counting players' plays (never bots), votes that can't go to your own game and show
// no counts until the end, the end's awards, snapshot and survey, every upload limit, and the sweep that deletes a
// room a day after it ends. Every events store runs the numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Sketch } from '../../packages/sdk/src/sketch.js';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth.js';
import { roomsOptions } from '../src/config.js';
import { createPlay, playHeaders } from '../src/play.js';
import { FileRoomStore, DirFiles } from '../src/stores/rooms-file.js';
import { slugify, checkPath, checkHtml, withBase, awardsOf, gameNumbers, withLiveStarts, LIMITS, CODE_RE } from '../src/rooms.js';
import { STORES } from './helpers/stores.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const quiet = { warn() {}, error() {}, info() {} };

// Two makers in their own projects (as on Glitchless Cloud), an organiser, a viewer, and voters.
const READERS = {
  ana: { projectId: 'pa', scopes: ['read', 'dashboard'], person: 'u_ana' },
  bo: { projectId: 'pb', scopes: ['read', 'dashboard'], person: 'u_bo' },
  viewer: { projectId: 'pa', scopes: ['read'] },
};
const ORGANISERS = { org: { owner: 'ws_org' }, other: { owner: 'ws_other' } };
const VOTERS = { ana: { voter: 'u_ana', person: 'u_ana', project: 'pa', email: 'ana@example.com' }, bo: { voter: 'u_bo', person: 'u_bo', project: 'pb' }, cy: { voter: 'u_cy', person: 'u_cy', project: null }, di: { voter: 'u_di', project: null }, ed: { voter: 'u_ed', project: null } };
const auth = {
  resolveIngest: (token) => ({ projectId: { gl_pub_a: 'pa', gl_pub_b: 'pb' }[token] ?? 'pa' }),
  resolveReader(req) {
    const r = READERS[req.headers['x-test-reader']];
    if (!r) throw new AuthError(401, 'no key');
    return r;
  },
  resolveOrganiser(req) {
    const o = ORGANISERS[req.headers['x-test-organiser']];
    if (!o) throw new AuthError(401, 'not an organiser');
    return o;
  },
  resolveVoter(req) {
    const v = VOTERS[req.headers['x-test-voter']];
    if (!v) throw new AuthError(401, 'sign in to vote');
    return { ...v, owns: async (projectId) => projectId === v.project };
  },
};

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A server with rooms, its games' port, and a caller. clock: a function the rooms read the time from.
async function setup({ make = STORES.file, clock = Date.now, roomsAuth = auth, requireService = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-rooms-'));
  const events = await make({ legacyProject: null });
  const files = new DirFiles(path.join(dir, 'files'));
  const rooms = { store: new FileRoomStore(path.join(dir, 'rooms')), files, urls: { app: 'https://app.example', play: 'https://play.example/r/' }, abuse: 'abuse@example.com', requireService, followUp: !requireService, now: clock, notify: (type, data) => told.push({ type, ...data }) };
  const told = [];
  const app = createApp({ store: events.store, auth: roomsAuth, rooms, logger: quiet });
  const api = await listen(app);
  const play = await listen(createPlay({ files, intake: ['https://api.example'], https: true }));
  const call = async (method, p, who = {}, body, type = 'application/json') => {
    const headers = { 'x-glitchless-client': who.client ?? 'test', 'content-type': type };
    if (who.reader) headers['x-test-reader'] = who.reader;
    if (who.organiser) headers['x-test-organiser'] = who.organiser;
    if (who.voter) headers['x-test-voter'] = who.voter;
    if (who.token) headers['x-glitchless-voter'] = who.token;
    const res = await fetch(api.base + p, { method, headers, ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, json, text };
  };
  const intake = async (token, payload) => {
    const res = await fetch(`${api.base}/v1/intake?token=${token}`, { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(res.status, 202, await res.text());
  };
  const close = async () => {
    api.server.close();
    play.server.close();
    await events.close?.();
  };
  return { app, call, intake, play: play.base, files, rooms, told, settle: events.settle ?? (async () => {}), close, dir };
}

// One play: two minutes of frames on one level, on a phone or a laptop, with stutter (40 of every 300 frames late) or
// an error if asked, as a player or a bot.
function playOf(service, version, n, start, { phone = false, stutter = false, error = false, type = 'user' } = {}) {
  const base = { service, env: 'prod', version, session_id: `s_${service}_${version}_${n}`, player_id: `s_${service}_${version}_${n}`, sdk: 'glitchless-browser/0.7.0' };
  const events = [{ type: 'session_start', ts: start, level: null, session_type: type, device: phone ? { browser: 'Safari', os: 'iOS', mobile: true } : { browser: 'Chrome', os: 'macOS', mobile: false } }, { type: 'level_start', ts: start + 500, level: 'one' }];
  for (let w = 0; w < 24; w++) {
    const sk = new Sketch();
    for (let f = 0; f < 300; f++) sk.add(stutter && f < 40 ? 40 : 16.6);
    events.push({ type: 'frame_window', ts: start + 1000 + w * 5000, level: 'one', duration_s: 5, frames: 300, fps: 60, budget_ms: 16.67, ft: sk.toJSON(), hitches: 0 });
  }
  if (error) events.push({ type: 'error', ts: start + 30_000, level: 'one', kind: 'js', message: 'boom', fingerprint: 'boom1' });
  events.push({ type: 'session_end', ts: start + 121_000, level: 'one', reason: 'quit', duration_s: 121 });
  return { ...base, events };
}

const GAME = { 'index.html': '<!doctype html><html><head><title>Neon Dash</title><script type="module" src="./assets/main.js"></script></head><body></body></html>', 'assets/main.js': 'Glitchless.init({service:"neon-dash",version:"1.0.0"})', 'assets/ship.png': '\x89PNG fake' };

// Start an upload, send its files, publish it.
async function publish(call, code, slug, who, version, files = GAME) {
  const list = Object.entries(files).map(([p, c]) => ({ path: p, bytes: Buffer.byteLength(c), sha256: sha(c) }));
  const start = await call('POST', `/v1/rooms/${code}/games/${slug}/uploads`, who, { version, files: list });
  if (start.status !== 201) return start;
  for (const [p, c] of Object.entries(files)) {
    const put = await call('PUT', `/v1/rooms/${code}/games/${slug}/uploads/${start.json.n}/files/${p.split('/').map(encodeURIComponent).join('/')}`, who, Buffer.from(c), 'application/octet-stream');
    assert.equal(put.status, 201, put.text);
  }
  return call('POST', `/v1/rooms/${code}/games/${slug}/uploads/${start.json.n}/publish`, who);
}

test('names, paths and pages: slugs from titles, only known file types, no password fields, and the room\'s <base>', () => {
  assert.equal(slugify('Neon Dash!'), 'neon-dash');
  assert.equal(slugify('Ça Va 2'), 'ca-va-2');
  assert.equal(slugify('!'), null);
  assert.equal(checkPath('assets/main.js'), null);
  for (const bad of ['../x.js', 'a/../b.js', '.env', 'a/.git/config', 'x.exe', 'run.sh', 'a b.js', '', 'a//b.js']) assert.ok(checkPath(bad), bad);
  assert.ok(checkPath(`${'a'.repeat(201)}.js`));
  assert.match(checkHtml('<form><input name=p type="password"></form>'), /password/);
  assert.match(checkHtml('<head><base href="/x/"></head>'), /<base>/);
  assert.equal(checkHtml('<input type="text">'), null);
  assert.equal(withBase('<!doctype html><html><head lang="en"><title>x</title></head>', '/r/K/g/1/'), '<!doctype html><html><head lang="en"><base href="/r/K/g/1/"><title>x</title></head>');
  assert.equal(withBase('<!DOCTYPE html><p>no head', '/b/'), '<!DOCTYPE html><base href="/b/"><p>no head');
});

test('awards: the minimums, a shared tie for the vote, and the improvement in plain words', () => {
  const v = (version, plays, withProblem) => ({ version, plays, with_problem: withProblem });
  const g = (slug, numbers, votes = 0, removed = false) => ({ slug, title: slug.toUpperCase(), numbers: { plays: 0, minutes_played: 0, phone_plays: 0, phone_frames_on_time_pct: null, versions: [], ...numbers }, votes, removed });
  const awards = awardsOf([
    g('a', { plays: 9, minutes_played: 20, phone_plays: 4, phone_frames_on_time_pct: 97.2, versions: [v('1', 5, 4), v('2', 4, 0)] }, 4),
    g('b', { plays: 9, minutes_played: 30, phone_plays: 2, phone_frames_on_time_pct: 100, versions: [v('1', 9, 1)] }, 4),
    g('c', { plays: 50, minutes_played: 90, phone_plays: 9, phone_frames_on_time_pct: 99.9 }, 9, true),
  ]);
  const by = Object.fromEntries(awards.map((a) => [a.id, a]));
  assert.deepEqual(by.crowd_favourite.games, ['a', 'b'], 'a tie for the vote is shared; a removed game wins nothing');
  assert.equal(by.crowd_favourite.text, 'A and B: 4 votes each, a tie');
  assert.deepEqual(by.most_played.games, ['b'], 'the same plays: more minutes played wins');
  assert.equal(by.biggest_improvement.text, 'A: before the fix, 4 of 5 plays hit a problem; after it, 0 of 4');
  assert.deepEqual(by.smoothest_on_phones.games, ['a'], 'b had too few plays on phones');
  const none = Object.fromEntries(awardsOf([g('x', { plays: 2, versions: [v('1', 2, 2)] }, 2)]).map((a) => [a.id, a]));
  assert.deepEqual(Object.values(none).map((a) => a.games.length), [0, 0, 0, 0]);
  assert.equal(none.most_played.text, 'No game had 3 plays');
});

test("plays a host saw start at intake count before its store has them: once each, players only, the room's versions", () => {
  const entry = { uploads: [{ version: '1.0', published_at: 1_000 }] };
  const stored = [{ session_id: 's1', session_type: 'user', version: '1.0', start: 2_000, device: { os: 'Windows' }, cell: { sec: 60 } }];
  const starts = [
    { session_id: 's1', at: 2_000, version: '1.0', session_type: 'user', os: 'Windows' }, // the store has it: one play
    { session_id: 's2', at: 3_500, version: '1.0', session_type: 'user', os: 'iOS' }, // not yet: a play, on a phone
    { session_id: 's2', at: 3_000, version: '1.0', session_type: 'user', os: 'iOS' }, // the same session again
    { session_id: 's3', at: 4_000, version: '1.0', session_type: 'synthetic', os: 'Linux' }, // a bot: no play
    { session_id: 's4', at: 5_000, version: '0.9', session_type: 'user', os: 'Android' }, // not a version in the room
    { session_id: 's5', at: 500, version: '1.0', session_type: 'user', os: 'Android' }, // before the first publish
  ];
  const merged = withLiveStarts(stored, starts);
  assert.deepEqual(merged.map((s) => s.session_id), ['s1', 's5', 's2', 's3', 's4']);
  assert.equal(merged.find((s) => s.session_id === 's2').start, 3_000, 'a session starts at its first start');
  const n = gameNumbers(entry, merged, 10_000);
  assert.equal(n.plays, 2);
  assert.equal(n.phone_plays, 1);
  assert.equal(n.minutes_played, gameNumbers(entry, stored, 10_000).minutes_played, "minutes come with the store's own session");
  assert.equal(withLiveStarts(stored, []), stored);
});

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind} store: a jam from start to end: two games publish, players (not bots) count, votes, awards, the snapshot and the survey`, async (t) => {
    // The jam starts an hour ago, so its plays are over by the time the big screen counts them.
    let clock = Date.now() - HOUR;
    const s = await setup({ make, clock: () => clock });
    t.after(s.close);
    const { call } = s;
    const org = { organiser: 'org' };
    const ana = { reader: 'ana', client: 'claude-code' };
    const bo = { reader: 'bo', client: 'cursor-vscode' };

    // The organiser makes a room; anyone sees its arcade by its code, in any case.
    const made = await call('POST', '/v1/rooms', org, { title: 'GenAI DC mini jam', about: 'Make a game in 90 minutes' });
    assert.equal(made.status, 201, made.text);
    const code = made.json.code;
    assert.match(code, CODE_RE);
    assert.match(made.json.qr_text, /█/, "the arcade's QR code, for an organiser's terminal");
    assert.deepEqual(made.json.links, { arcade: `https://app.example/jam/${code}`, live: `https://app.example/jam/${code}/live`, join: `https://app.example/jam/${code}/join`, survey: `https://app.example/jam/${code}/survey` });
    assert.equal((await call('GET', `/v1/rooms/${code.toLowerCase()}`)).json.title, 'GenAI DC mini jam');
    assert.equal((await call('GET', '/v1/rooms/ZZZZ1')).status, 404);
    assert.equal((await call('POST', '/v1/rooms', {}, { title: 'x' })).status, 401, 'only organisers make rooms');

    // Makers join. Joining needs the dashboard scope; joining again answers the same game; a title taken gets -2.
    assert.equal((await call('POST', `/v1/rooms/${code}/games`, { reader: 'viewer' }, { title: 'Neon Dash' })).status, 403);
    const neon = await call('POST', `/v1/rooms/${code}/games`, ana, { title: 'Neon Dash', by: 'Ana', service: 'neon-dash' });
    assert.equal(neon.status, 201, neon.text);
    assert.equal(neon.json.slug, 'neon-dash');
    assert.equal((await call('POST', `/v1/rooms/${code}/games`, ana, { title: 'Neon Dash' })).json.slug, 'neon-dash', 'the same game joins once');
    const bo1 = await call('POST', `/v1/rooms/${code}/games`, bo, { title: 'Neon Dash' });
    assert.equal(bo1.json.slug, 'neon-dash-2');
    assert.equal((await call('PATCH', `/v1/rooms/${code}/games/neon-dash-2`, bo, { title: 'Tap Tower' })).json.title, 'Tap Tower');
    assert.equal((await call('PATCH', `/v1/rooms/${code}/games/neon-dash-2`, ana, { title: 'Mine now' })).status, 404, "another maker's game");
    let arcade = (await call('GET', `/v1/rooms/${code}`)).json;
    assert.equal(arcade.games.length, 0, 'a game shows once it publishes');
    assert.equal(arcade.building, 2);

    // Ana publishes 1.0.0: the game's address plays its index.html with the room's <base>, its files are cached for good.
    const pub = await publish(call, code, 'neon-dash', ana, '1.0.0');
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.json.url, `https://play.example/r/${code}/neon-dash/`);
    assert.match(pub.json.qr_text, /█/);
    assert.equal(pub.json.qr_svg, `https://app.example/v1/rooms/${code}/qr.svg?game=neon-dash`);
    const page = await fetch(`${s.play}/r/${code}/neon-dash/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(await page.text(), new RegExp(`<head><base href="/r/${code}/neon-dash/1/"><title>`));
    const js = await fetch(`${s.play}/r/${code}/neon-dash/1/assets/main.js`);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(js.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(js.headers.get('content-security-policy'), /connect-src 'self' data: blob: https:\/\/cdn\.jsdelivr\.net .* https:\/\/api\.example; .*form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests/);
    assert.equal((await fetch(`${s.play}/r/${code}/neon-dash`, { redirect: 'manual' })).status, 301);
    assert.equal((await fetch(`${s.play}/r/${code}/neon-dash/1/.env`)).status, 404);
    assert.equal((await fetch(`${s.play}/r/${code}/nobody/`)).status, 404);
    assert.equal((await publish(call, code, 'neon-dash', ana, '1.0.0')).status, 409, 'a version publishes once: bump it first');
    assert.equal((await publish(call, code, 'neon-dash-2', bo, '0.1.0')).status, 200);

    arcade = (await call('GET', `/v1/rooms/${code}`)).json;
    assert.deepEqual(arcade.games.map((g) => [g.slug, g.title, g.by, g.version, g.new]), [['neon-dash', 'Neon Dash', 'Ana', '1.0.0', true], ['neon-dash-2', 'Tap Tower', null, '0.1.0', true]]);
    assert.equal(arcade.report, 'abuse@example.com');
    for (const leak of ['"pa"', '"pb"', 'u_ana', 'ws_org', 'service', 'project', 'people']) assert.ok(!JSON.stringify(arcade).includes(leak), `the arcade leaves out ${leak}`);
    const qr = await call('GET', `/v1/rooms/${code}/qr.svg?game=neon-dash`);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.match(qr.text, /^<svg /);

    // Plays come in: Neon Dash gets 4 players' plays on 1.0.0 (3 on phones: 2 stutter, 1 errors) and a bot's, which
    // never counts. Tap Tower gets one play, and a play of a version it never published, which doesn't count either.
    const t0 = clock + MINUTE;
    await s.intake('gl_pub_a', playOf('neon-dash', '1.0.0', 1, t0, { phone: true, stutter: true }));
    await s.intake('gl_pub_a', playOf('neon-dash', '1.0.0', 2, t0 + 1000, { phone: true, stutter: true }));
    await s.intake('gl_pub_a', playOf('neon-dash', '1.0.0', 3, t0 + 2000, { phone: true, error: true }));
    await s.intake('gl_pub_a', playOf('neon-dash', '1.0.0', 4, t0 + 3000));
    await s.intake('gl_pub_a', playOf('neon-dash', '1.0.0', 5, t0 + 4000, { type: 'synthetic' }));
    await s.intake('gl_pub_b', playOf('neon-dash-2', '0.1.0', 1, t0));
    await s.intake('gl_pub_b', playOf('neon-dash-2', '0.0.9', 2, t0));
    // And 3 clean plays on 1.0.1, half an hour later, which count once 1.0.1 is published below. They're all sent before
    // the big screen first reads: a store may keep an hour it has read once that hour is over (in real use plays arrive as
    // they happen), so plays dated into an hour already read wouldn't be seen.
    for (let i = 0; i < 3; i++) await s.intake('gl_pub_a', playOf('neon-dash', '1.0.1', 10 + i, t0 + 30 * MINUTE + i * 1000, { phone: true }));
    await s.settle();
    clock = Date.now() - 30 * MINUTE;
    // Tap Tower's sessions are filed under the service its game sends; its maker never named one, so it publishes it.
    // (On Glitchless Cloud the jam tool names it from the build.)
    let live = (await call('GET', `/v1/rooms/${code}/live`)).json;
    const row = (slug) => live.games.find((g) => g.slug === slug);
    assert.equal(row('neon-dash').plays, 4);
    assert.equal(row('neon-dash').phone_plays, 3);
    assert.equal(row('neon-dash').players, null, 'anonymous mode keeps no player ID: plays, not players');
    assert.ok(row('neon-dash').minutes_played >= 7, `${row('neon-dash').minutes_played} minutes`);
    assert.equal(row('neon-dash-2').plays, 0, 'its maker never named its service, so nothing counts yet');
    assert.deepEqual(live.needs_players, ['neon-dash-2', 'neon-dash'], 'the fewest plays first');
    assert.deepEqual(live.most_played, ['neon-dash']);
    assert.equal(live.totals.games, 2);
    assert.equal(live.awards, null, 'no awards before the end');
    assert.ok(!JSON.stringify(live).includes('"votes"'), 'no vote counts before the end');

    // Bo's next upload names the service; Ana fixes the stutter in 1.0.1 and it gets 3 clean plays.
    const fix = { ...GAME, 'assets/main.js': 'Glitchless.init({service:"tap-tower",version:"0.2.0"})' };
    const list = Object.entries(fix).map(([p, c]) => ({ path: p, bytes: Buffer.byteLength(c), sha256: sha(c) }));
    assert.equal((await call('POST', `/v1/rooms/${code}/games/neon-dash-2/uploads`, bo, { version: '0.2.0', service: 'neon-dash-2', files: list })).status, 201);
    assert.equal((await publish(call, code, 'neon-dash', ana, '1.0.1')).status, 200);
    clock = Date.now();

    // Votes: one a person, never for your own game, and no counts until the end.
    assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, {}, { slug: 'neon-dash' })).status, 401);
    assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'ana' }, { slug: 'neon-dash' })).status, 403, "you can't vote for your own game");
    assert.deepEqual((await call('GET', `/v1/rooms/${code}/vote`, { voter: 'ana' })).json, { vote: null, own: ['neon-dash'], open: true });
    assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'ana' }, { slug: 'neon-dash-2' })).status, 200);
    for (const v of ['bo', 'cy', 'di']) assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, { voter: v }, { slug: 'neon-dash' })).status, 200, v);
    await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'ed' }, { slug: 'neon-dash-2' });
    await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'ed' }, { slug: 'neon-dash' });
    assert.equal((await call('GET', `/v1/rooms/${code}/vote`, { voter: 'ed' })).json.vote, 'neon-dash', 'voting again moves the vote');
    assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'cy' }, { slug: 'nobody' })).status, 404);

    // The survey opens at the end; the snapshot is written then.
    assert.equal((await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'cy' }, { answers: { rating: 5 } })).status, 409);
    assert.equal((await call('GET', `/v1/rooms/${code}/snapshot`, org)).status, 409);
    assert.equal((await call('PATCH', `/v1/rooms/${code}`, { organiser: 'other' }, { end: true })).status, 404, "another organiser's room");

    // The organiser ends the jam: the awards appear, publishing and voting stop.
    const ended = await call('PATCH', `/v1/rooms/${code}`, org, { end: true });
    assert.equal(ended.json.ended, true);
    live = (await call('GET', `/v1/rooms/${code}/live`)).json;
    const awards = Object.fromEntries(live.awards.map((a) => [a.id, a]));
    assert.deepEqual(awards.crowd_favourite.games, ['neon-dash']);
    assert.equal(awards.crowd_favourite.text, 'Neon Dash: 4 votes');
    assert.deepEqual(awards.most_played.games, ['neon-dash']);
    assert.equal(awards.biggest_improvement.text, 'Neon Dash: before the fix, 3 of 4 plays hit a problem; after it, 0 of 3');
    assert.deepEqual(awards.smoothest_on_phones.games, ['neon-dash']);
    assert.match(awards.smoothest_on_phones.text, /^Neon Dash: \d+ of every 100 frames on time, over 6 plays on phones$/);
    assert.equal(live.games.find((g) => g.slug === 'neon-dash').votes, 4, 'counts show once it has ended');
    assert.equal((await publish(call, code, 'neon-dash', ana, '1.0.2')).status, 409);
    assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, { voter: 'cy' }, { slug: 'neon-dash-2' })).status, 409);
    assert.equal((await call('POST', `/v1/rooms/${code}/games`, { reader: 'ana' }, { title: 'Late' })).status, 409);

    // The snapshot: what each game did, the funnel, the votes by game but never who voted for what.
    const snap = (await call('GET', `/v1/rooms/${code}/snapshot`, org)).json;
    assert.deepEqual(snap.funnel, { joined: 2, published: 2, sending: 2, improved: 1, fixed: 1 }, "Tap Tower's play counts once its next upload named its service");
    const neonSnap = snap.games.find((g) => g.slug === 'neon-dash');
    assert.deepEqual(neonSnap.uploads.map((u) => [u.version, u.agent]), [['1.0.0', 'Claude Code'], ['1.0.1', 'Claude Code']]);
    assert.deepEqual(neonSnap.numbers.versions.map((v) => [v.version, v.plays, v.with_problem, v.problems.stutter, v.problems.errors]), [['1.0.0', 4, 3, 2, 1], ['1.0.1', 3, 0, 0, 0]]);
    assert.equal(neonSnap.votes, 4);
    assert.equal(snap.games.find((g) => g.slug === 'neon-dash-2').uploads[0].agent, 'Cursor');
    assert.equal(snap.votes.voters, 5);
    for (const leak of ['u_ana', 'u_bo', 'u_cy', '"pa"', '"pb"']) assert.ok(!JSON.stringify(snap).includes(leak), `the snapshot keeps no ${leak}`);
    const csv = await call('GET', `/v1/rooms/${code}/snapshot?format=csv`, org);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(csv.text.split('\n')[1], /^neon-dash,Neon Dash,Ana,.*,2,1\.0\.0 1\.0\.1,Claude Code,7,,\d+,6,/);
    assert.equal((await call('GET', `/v1/rooms/${code}/snapshot`, { organiser: 'other' })).status, 404);

    // The survey: the questions, a maker's agent suggested, one set of answers a person, email only with a yes.
    const q = (await call('GET', `/v1/rooms/${code}/survey`, { voter: 'ana' })).json;
    assert.equal(q.open, true);
    assert.equal(q.questions.length, 7);
    assert.deepEqual(q.suggested, { agent: 'Claude Code' });
    assert.equal((await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'ana' }, { answers: { rating: 9 } })).status, 400);
    assert.equal((await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'ana' }, { answers: { rating: 4, liked: 'Playing on phones', follow_up: 'Yes' } })).status, 200);
    assert.equal((await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'ana' }, { answers: { rating: 5, liked: 'Everything', follow_up: 'Yes' } })).status, 200);
    await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'cy' }, { answers: { make_more: 'Yes, a new one', follow_up: 'No' } });
    const answers = (await call('GET', `/v1/rooms/${code}/snapshot`, org)).json.survey.answers;
    assert.equal(answers.length, 2, 'answering again replaces the answers');
    assert.deepEqual(answers.map((a) => [a.answers.rating ?? null, a.made, a.email ?? null]), [[5, ['neon-dash'], 'ana@example.com'], [null, [], null]]);
    assert.deepEqual((await call('GET', `/v1/rooms/${code}/survey`, { voter: 'ana' })).json.answers, { rating: 5, liked: 'Everything', follow_up: 'Yes' });

    // What the host was told, for its own emails and analytics.
    assert.deepEqual([...new Set(s.told.map((x) => x.type))].sort(), ['answered', 'ended', 'joined', 'published', 'voted']);
    assert.equal(s.told.find((x) => x.type === 'joined').person, 'u_ana');
  });
}

test('every upload limit is checked from the list before a byte is sent, and again as each file arrives', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { call } = s;
  const code = (await call('POST', '/v1/rooms', { organiser: 'org' }, { title: 'Limits' })).json.code;
  const ana = { reader: 'ana' };
  await call('POST', `/v1/rooms/${code}/games`, ana, { title: 'Big', service: 'bigg' });
  const again = await call('POST', `/v1/rooms/${code}/games`, ana, { service: 'big' });
  assert.deepEqual([again.json.slug, again.json.service], ['big', 'big'], 'one project is one game: the latest service named counts');
  const start = (files, version = '1') => call('POST', `/v1/rooms/${code}/games/big/uploads`, ana, { version, files });
  const f = (p, bytes = 10) => ({ path: p, bytes, sha256: sha('x') });
  assert.equal((await start([f('main.js')])).status, 400, 'index.html at the root');
  assert.equal((await start([f('index.html'), f('virus.exe')])).status, 415);
  assert.equal((await start([f('index.html'), f('a/../b.js')])).status, 415);
  assert.equal((await start([f('index.html', LIMITS.fileBytes + 1)])).status, 413);
  assert.equal((await start([f('index.html'), ...Array.from({ length: 7 }, (_, i) => f(`big${i}.bin`, LIMITS.fileBytes))])).status, 413, 'over 25 MB');
  assert.equal((await start(Array.from({ length: LIMITS.uploadFiles + 1 }, (_, i) => f(i ? `f${i}.js` : 'index.html')))).status, 413);
  assert.equal((await start([f('index.html'), f('index.html')])).status, 400);
  assert.equal((await start([f('index.html')], null)).status, 400, 'a version is required');

  // Files must be what the list said, and pages may not ask for a password.
  const page = '<html><head></head><body><input type=password></body></html>';
  const up = await start([{ path: 'index.html', bytes: Buffer.byteLength(page), sha256: sha(page) }], '2');
  assert.equal(up.status, 201);
  const put = (n, p, bytes) => call('PUT', `/v1/rooms/${code}/games/big/uploads/${n}/files/${p}`, ana, Buffer.from(bytes), 'application/octet-stream');
  assert.equal((await put(up.json.n, 'index.html', page)).status, 422);
  assert.equal((await put(up.json.n, 'index.html', 'other bytes')).status, 400);
  assert.equal((await put(up.json.n, 'other.js', 'x')).status, 404);
  assert.equal((await put(99, 'index.html', page)).status, 404);
  assert.equal((await call('POST', `/v1/rooms/${code}/games/big/uploads/${up.json.n}/publish`, ana)).status, 409, 'a file never sent');
  // At most 12 uploads an hour (the starts above count: 2 reached the server's later checks).
  let status;
  for (let i = 0; i < 15 && status !== 429; i++) status = (await start([f('index.html')], `v${i}`)).status;
  assert.equal(status, 429);
});

test('the sweep: a room ends at its closing time, an upload never published is dropped, and a day after the end the room is deleted but its snapshot stays a year', async (t) => {
  let clock = Date.now();
  const s = await setup({ clock: () => clock });
  t.after(s.close);
  const { call } = s;
  const code = (await call('POST', '/v1/rooms', { organiser: 'org' }, { title: 'Short', hours: 2 })).json.code;
  const ana = { reader: 'ana' };
  await call('POST', `/v1/rooms/${code}/games`, ana, { title: 'Quick', service: 'quick' });
  assert.equal((await publish(call, code, 'quick', ana, '1')).status, 200);
  const extra = 'x';
  await call('POST', `/v1/rooms/${code}/games/quick/uploads`, ana, { version: '2', files: [{ path: 'index.html', bytes: 1, sha256: sha(extra) }] });
  await call('PUT', `/v1/rooms/${code}/games/quick/uploads/2/files/index.html`, ana, Buffer.from(extra), 'application/octet-stream');
  assert.ok(await s.files.stat(`${code}/quick/2/index.html`));

  clock += 31 * MINUTE;
  assert.deepEqual(await s.app.rooms.sweep(), { ended: 0, deleted: 0, dropped: 1, snapshots: 0 });
  assert.equal(await s.files.stat(`${code}/quick/2/index.html`), null, 'the unpublished upload is gone');
  clock += 2 * HOUR;
  assert.deepEqual(await s.app.rooms.sweep(), { ended: 1, deleted: 0, dropped: 0, snapshots: 0 });
  assert.equal((await call('GET', `/v1/rooms/${code}`)).json.ended, true);
  assert.equal((await call('GET', `/v1/rooms/${code}/survey`)).json.open, true);
  clock += DAY;
  assert.deepEqual(await s.app.rooms.sweep(), { ended: 0, deleted: 1, dropped: 0, snapshots: 0 });
  assert.equal((await call('GET', `/v1/rooms/${code}`)).status, 404, 'the room is gone a day after the end');
  assert.equal(await s.files.stat(`${code}/quick/index.html`), null, 'and its files');
  assert.equal((await fetch(`${s.play}/r/${code}/quick/`)).status, 404);
  assert.equal((await call('GET', `/v1/rooms/${code}/snapshot`, { organiser: 'org' })).json.games[0].slug, 'quick', 'the snapshot stays');
  assert.equal((await call('GET', `/v1/rooms/${code}/survey`)).json.open, true, 'the survey stays open its 7 days');
  assert.equal((await call('GET', '/v1/rooms', { organiser: 'org' })).json.past[0].code, code);
  clock += 7 * DAY;
  assert.equal((await call('PUT', `/v1/rooms/${code}/survey`, { voter: 'cy' }, { answers: { rating: 3 } })).status, 409, 'the survey has closed');
  clock += 365 * DAY;
  assert.equal((await s.app.rooms.sweep()).snapshots, 1);
  assert.equal((await call('GET', `/v1/rooms/${code}/snapshot`, { organiser: 'org' })).status, 404);
});

test('taking a game out: the organiser removes one for good, a maker can leave, and both disappear from the arcade', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { call } = s;
  const org = { organiser: 'org' };
  const code = (await call('POST', '/v1/rooms', org, { title: 'Moderated' })).json.code;
  await call('POST', `/v1/rooms/${code}/games`, { reader: 'ana' }, { title: 'Spam', service: 'spam' });
  await publish(call, code, 'spam', { reader: 'ana' }, '1');
  await call('POST', `/v1/rooms/${code}/games`, { reader: 'bo' }, { title: 'Fine', service: 'fine' });
  await publish(call, code, 'fine', { reader: 'bo' }, '1');
  assert.equal((await call('DELETE', `/v1/rooms/${code}/games/spam?by=organiser`, { organiser: 'other' })).status, 404);
  assert.equal((await call('DELETE', `/v1/rooms/${code}/games/spam?by=organiser`, org)).status, 200);
  assert.match(await (await fetch(`${s.play}/r/${code}/spam/`)).text(), /taken down/);
  assert.equal((await fetch(`${s.play}/r/${code}/spam/1/index.html`)).status, 404, 'its files are deleted');
  assert.equal((await call('POST', `/v1/rooms/${code}/games`, { reader: 'ana' }, { title: 'Spam again', service: 'spam' })).status, 403, "a removed game can't come back");
  assert.equal((await call('DELETE', `/v1/rooms/${code}/games/fine`, { reader: 'bo' })).status, 200);
  assert.match(await (await fetch(`${s.play}/r/${code}/fine/`)).text(), /left the room/);
  assert.deepEqual((await call('GET', `/v1/rooms/${code}`)).json.games, []);
  // Rooms on at once, per organiser.
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/v1/rooms', org, { title: `R${i}` })).status, 201);
  assert.equal((await call('POST', '/v1/rooms', org, { title: 'Too many' })).status, 429);
  assert.equal((await call('POST', '/v1/rooms', org, { title: 'Long', hours: 24 * 8 })).status, 400);
  assert.equal((await call('DELETE', `/v1/rooms/${code}`, org)).status, 200);
  assert.equal((await call('GET', `/v1/rooms/${code}`)).status, 404);
});

test("the open-source defaults: organisers and makers are whoever holds the server's key, games are told apart by their service, and a browser's own token votes", async (t) => {
  const open = { resolveIngest: () => ({ projectId: 'default' }), resolveReader: () => ({ projectId: 'default', scopes: ['read', 'delete', 'dashboard', 'sourcemaps'] }) };
  const s = await setup({ roomsAuth: open, requireService: true });
  t.after(s.close);
  const { call } = s;
  const code = (await call('POST', '/v1/rooms', {}, { title: 'Meetup' })).json.code;
  assert.equal((await call('POST', `/v1/rooms/${code}/games`, {}, { title: 'No name' })).status, 400, 'the service names the game');
  assert.equal((await call('POST', `/v1/rooms/${code}/games`, {}, { title: 'One', service: 'one' })).json.slug, 'one');
  assert.equal((await call('POST', `/v1/rooms/${code}/games`, {}, { title: 'Two', service: 'two' })).json.slug, 'two', 'another service is another game');
  await publish(call, code, 'one', {}, '1');
  assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, {}, { slug: 'one' })).status, 401);
  const token = { token: 'browser-token-0123456789' };
  assert.equal((await call('PUT', `/v1/rooms/${code}/vote`, token, { slug: 'one' })).status, 200);
  assert.equal((await call('GET', `/v1/rooms/${code}/vote`, token)).json.vote, 'one');
  assert.equal((await call('GET', '/v1/rooms', {})).json.rooms[0].code, code);
  assert.deepEqual((await call('GET', '/v1/rooms', {})).json.rooms[0].joined.map((g) => [g.slug, g.published]), [['one', true], ['two', false]], 'the organiser sees games still being made');
  const setUp = (await call('GET', '/v1/rooms', {})).json.rooms[0].survey;
  assert.deepEqual([setUp.heading, setUp.default, setUp.answers, setUp.questions.length], ['How was {room}?', true, 0, 6], "the organiser reads the survey as set, before it's filled in");
  assert.ok(!(await call('GET', `/v1/rooms/${code}/survey`, token)).json.questions.some((q) => q.id === 'follow_up'), 'no email question where no email is known');
  // After the jam, a past jam's snapshot can be deleted once the room itself is gone.
  await call('PATCH', `/v1/rooms/${code}`, {}, { end: true });
  assert.equal((await call('GET', `/v1/rooms/${code}`)).json.games[0].new, false, 'nothing is new once the jam has ended');
  await s.rooms.store.deleteRoom(code);
  assert.equal((await call('DELETE', `/v1/rooms/${code}`, {})).status, 200);
  assert.equal((await call('GET', `/v1/rooms/${code}/survey`)).status, 404);
});

test('the games port sends the same headers Glitchless Cloud puts on CloudFront, and a server without rooms says so', async () => {
  const h = playHeaders(['https://api.glitchless.gg']);
  assert.match(h['Content-Security-Policy'], /^default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com https:\/\/cdnjs\.cloudflare\.com https:\/\/esm\.sh;/);
  assert.match(h['Content-Security-Policy'], /connect-src [^;]*https:\/\/api\.glitchless\.gg;/);
  assert.equal(h['X-Robots-Tag'], 'noindex');
  assert.ok(!playHeaders([], { https: false })['Content-Security-Policy'].includes('upgrade-insecure-requests'), 'a meetup server on plain http keeps its http intake');
  const { server, base } = await listen(createApp({ store: (await STORES.file()).store, auth: { resolveIngest: () => ({ projectId: 'p' }), resolveReader: () => ({ projectId: 'p', scopes: ['read'] }) }, logger: quiet }));
  assert.equal((await fetch(`${base}/v1/rooms/ABCDE`)).status, 404);
  server.close();
});

test("the games port is PORT + 1000, or PORT - 1000 when that would pass 65535, so a server on a test's high free port still starts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-play-port-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (env) => roomsOptions({ GLITCHLESS_DATA_DIR: dir, ...env });
  assert.equal(at({}).playPort, 8777);
  assert.equal(at({ PORT: '64535' }).playPort, 65535);
  assert.equal(at({ PORT: '65100' }).playPort, 64100);
  assert.equal(at({ PORT: '65100', GLITCHLESS_PLAY_PORT: '9000' }).playPort, 9000, 'the setting still wins');
  // A port past 65535 made the play URL invalid, and the rooms threw on it before the server could listen.
  const { rooms } = at({ PORT: '65535' });
  assert.equal(rooms.urls.play, 'http://localhost:64535/r/');
  const { server, base } = await listen(createApp({ store: (await STORES.file()).store, rooms, auth: { resolveIngest: () => ({ projectId: 'p' }), resolveReader: () => ({ projectId: 'p', scopes: ['read'] }) }, logger: quiet }));
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/v1/health`)).status, 200);
});

test("survey templates: an organiser keeps their own beside the default, makes a room with one, and edits the room's survey until its first answer", async (t) => {
  const s = await setup();
  t.after(s.close);
  const { call } = s;
  const org = { organiser: 'org' };
  const listed = (await call('GET', '/v1/rooms/templates', org)).json.templates;
  assert.deepEqual(listed.map((x) => [x.id, x.builtin === true]), [['default', true]]);
  assert.equal(listed[0].heading, 'How was {room}?');
  assert.equal((await call('PUT', '/v1/rooms/templates/default', org, { name: 'Mine' })).status, 400, "the default can't change");
  assert.equal((await call('GET', '/v1/rooms/templates', { organiser: 'other' })).json.templates.length, 1);

  // A meetup's template: its own heading, an intro and two questions.
  const meetup = { name: 'Meetup', heading: 'How was {room}, DC?', intro: 'Two questions, then grab a slice.', questions: [{ id: 'rating', kind: 'scale', text: 'How was it?' }, { id: 'next', kind: 'choice', text: 'Come to the next one?', options: ['Yes', 'Maybe', 'No'] }] };
  const saved = await call('PUT', '/v1/rooms/templates/meetup', org, meetup);
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await call('PUT', '/v1/rooms/templates/bad', org, { ...meetup, questions: [{ id: 'x', kind: 'essay', text: '?' }] })).status, 400);
  assert.equal((await call('GET', '/v1/rooms/templates', { organiser: 'other' })).json.templates.length, 1, "an organiser's templates are their own");
  assert.equal((await call('POST', '/v1/rooms', org, { title: 'Nope', template: 'missing' })).status, 404);

  const room = (await call('POST', '/v1/rooms', org, { title: 'GenAI', template: 'meetup' })).json;
  let survey = (await call('GET', `/v1/rooms/${room.code}/survey`)).json;
  assert.deepEqual([survey.open, survey.heading, survey.intro, survey.questions.map((q) => q.id)], [false, 'How was GenAI, DC?', 'Two questions, then grab a slice.', ['rating', 'next']]);

  // Edited by hand, saved back as a template from the room, then the room goes back to the default.
  const edited = await call('PATCH', `/v1/rooms/${room.code}/survey`, org, { heading: 'Thanks for coming to {room}!', questions: [...meetup.questions, { id: 'idea', kind: 'text', text: 'What should we make next time?' }] });
  assert.equal(edited.json.filled.heading, 'Thanks for coming to GenAI!');
  assert.equal(edited.json.intro, 'Two questions, then grab a slice.', 'what the edit leaves out stays');
  const copy = await call('PUT', '/v1/rooms/templates/meetup-2', org, { name: 'Meetup, longer', from_room: room.code });
  assert.deepEqual(copy.json.questions.map((q) => q.id), ['rating', 'next', 'idea']);
  assert.equal((await call('PATCH', `/v1/rooms/${room.code}/survey`, { organiser: 'other' }, { heading: 'x' })).status, 404);
  assert.equal((await call('PATCH', `/v1/rooms/${room.code}/survey`, org, { template: 'default' })).json.questions.length, 7);
  await call('PATCH', `/v1/rooms/${room.code}/survey`, org, { template: 'meetup-2' });

  // After the end it can still change, until someone answers; then it's fixed.
  await call('PATCH', `/v1/rooms/${room.code}`, org, { end: true });
  assert.equal((await call('PATCH', `/v1/rooms/${room.code}/survey`, org, { intro: 'Scan, answer, done.' })).status, 200);
  survey = (await call('GET', `/v1/rooms/${room.code}/survey`)).json;
  assert.deepEqual([survey.open, survey.intro, survey.questions.length], [true, 'Scan, answer, done.', 3]);
  assert.equal((await call('PUT', `/v1/rooms/${room.code}/survey`, { voter: 'cy' }, { answers: { rating: 5, next: 'Yes', idea: 'Racing' } })).status, 200);
  assert.equal((await call('PATCH', `/v1/rooms/${room.code}/survey`, org, { intro: 'Too late' })).status, 409);
  const snap = (await call('GET', `/v1/rooms/${room.code}/snapshot`, org)).json;
  assert.equal(snap.survey.heading, 'Thanks for coming to {room}!');
  assert.deepEqual(snap.survey.answers[0].answers, { rating: 5, next: 'Yes', idea: 'Racing' });

  assert.equal((await call('DELETE', '/v1/rooms/templates/meetup', org)).status, 200);
  assert.deepEqual((await call('GET', '/v1/rooms/templates', org)).json.templates.map((x) => x.id), ['default', 'meetup-2']);
});
