// Jam rooms (SPEC §3j): an organiser makes a room and gets a short code, makers join it with their games and publish
// each game's built files to it, everyone plays every game from the room's arcade, and when the jam ends the room
// hands out awards from what players did and what they voted, keeps a snapshot of it all, and asks how it went.
//
// This file is the model and its rules, with no HTTP (rooms-api.js serves it) and no storage of its own. A host gives
//   store    the rooms' records (stores/rooms-file.js on the open-source server; Glitchless Cloud keeps them in its
//            control table): rooms, games in a room, votes, survey answers, snapshots, and organisers' survey templates
//   files    where games' files go, laid out so any static host can serve them (play.js here; S3 and CloudFront on
//            Glitchless Cloud): put, get, stat, remove(prefix)
//   readGame(projectId, service, from, to) → that game's finalized sessions in the window (app.js, from the store's
//            summaries), and playersNow(projectId, service) → its sessions playing now
//   liveStarts(projectId, service, from, to)  optional: sessions the host saw start at intake, [{ session_id, at,
//            version, session_type, os }], for a store whose summaries run behind (Glitchless Cloud's event lake, a
//            few minutes): each counts as a play as soon as it starts (withLiveStarts)
//   joinable(projectId)  optional: why this project's game can't join a room, or null (Glitchless Cloud: a workspace's
//            demo game, which is sample play, not a game anyone is making)
//   notify(type, data)  optional: what happened, for a host that emails people or counts its own product's use
//
// Nothing is built here: a maker's agent builds the game on their own computer and publishes the folder it made.

import crypto from 'node:crypto';
import { platformOf, hasPlayerId } from './analytics.js';
import { FIXED } from './rollups.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 5 characters without the ones people mix up (0/O, 1/I/L) or that spell words (U): 24 million codes.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const LIMITS = {
  defaultHours: 24,
  maxHours: 7 * 24,
  defaultGames: 60,
  maxGames: 200,
  openRooms: 3,
  uploadBytes: 25_000_000,
  uploadFiles: 400,
  fileBytes: 4_000_000,
  pathLength: 200,
  uploadsPerHour: 12,
  uploadsPerGame: 60,
  roomBytes: 2_000_000_000,
  pendingMs: 30 * MINUTE,
  // A room is deleted this long after it ends; its snapshot stays SNAPSHOT_DAYS.
  keepAfterEndMs: DAY,
  surveyDays: 7,
  snapshotDays: 365,
  // A game is "new" on the arcade this long after a publish.
  newMs: 10 * MINUTE,
  minPlays: 3,
  minVotes: 3,
  minDrop: 10,
};

// The file types a game may upload, by extension, and the type each is served with (never the uploader's).
export const FILE_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  ktx2: 'image/ktx2',
  hdr: 'application/octet-stream',
  wasm: 'application/wasm',
  pck: 'application/octet-stream',
  data: 'application/octet-stream',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  webm: 'video/webm',
  mp4: 'video/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  tmj: 'application/json',
  tsj: 'application/json',
  tmx: 'application/xml',
  tsx: 'application/xml',
  atlas: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8',
};
export const typeOf = (p) => FILE_TYPES[String(p).split('.').pop().toLowerCase()] ?? null;

// The survey (§7c): a heading and an intro over its questions. An organiser sets a room's from one of their templates
// or by hand, until its first answer; "{room}" in the heading or intro is the room's title. These are the defaults.
export const DEFAULT_HEADING = 'How was {room}?';
export const DEFAULT_SURVEY = [
  { id: 'rating', kind: 'scale', text: 'How was the jam?' },
  { id: 'liked', kind: 'text', text: 'What did you like most?' },
  { id: 'hard', kind: 'text', text: 'What got in the way?' },
  { id: 'make_more', kind: 'choice', text: 'Do you want to make a game after this?', options: ["Yes, I'll keep building this one", 'Yes, a new one', 'Maybe', 'No'] },
  { id: 'use_glitchless', kind: 'choice', text: 'Would you use Glitchless on your next game?', options: ['Yes', 'Maybe', 'No'] },
  { id: 'agent', kind: 'choice', text: 'Which coding agent did you use?', options: ['Claude Code', 'Codex', 'Cursor', 'goose', 'Another'] },
];
// Asked too by a host that knows respondents' emails (createRooms followUp): a yes keeps the email with the answers.
export const FOLLOW_UP = { id: 'follow_up', kind: 'choice', text: 'May Glitchless email you about your answers?', options: ['Yes', 'No'] };
const SURVEY_MAX = 10;
const TEXT_MAX = 1000;
// An organiser keeps at most this many survey templates.
const TEMPLATES_MAX = 20;
const TEMPLATE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// The awards, in the order they're shown (§7).
export const AWARDS = [
  { id: 'crowd_favourite', title: 'Crowd favourite' },
  { id: 'most_played', title: 'Most played' },
  { id: 'biggest_improvement', title: 'Biggest improvement' },
  { id: 'smoothest_on_phones', title: 'Smoothest on phones' },
];

export class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const refuse = (status, message) => {
  throw new RoomError(status, message);
};

export const isCode = (v) => CODE_RE.test(String(v ?? '').toUpperCase());
export const normalCode = (v) => String(v ?? '').toUpperCase();
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 22);
const clean = (v, max, what) => {
  if (v == null) return null;
  if (typeof v !== 'string') refuse(400, `${what} must be text`);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) refuse(400, `${what} is at most ${max} characters`);
  return s || null;
};

// Turn a title into the part of a game's address: "Neon Dash!" → "neon-dash".
export function slugify(title) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : null;
}

// A path a game's files may have: segments of [A-Za-z0-9._-], none starting with a dot, no "..", a known type.
export function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.pathLength) return `a path is 1 to ${LIMITS.pathLength} characters`;
  const parts = p.split('/');
  if (parts.some((s) => !s || s.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(s))) return `"${p}": paths use letters, digits, . _ and - only, with no hidden files or ..`;
  if (!typeOf(p)) return `"${p}": .${p.split('.').pop()} files aren't served (allowed: ${Object.keys(FILE_TYPES).join(', ')})`;
  return null;
}

// An HTML file a game uploads: a password field is refused (games never need one; phishing pages always do), and a
// <base> of its own would break the address the room gives its files.
export function checkHtml(text) {
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(text)) return 'pages with a password field are refused: a game never needs one';
  if (/<base\b/i.test(text)) return 'remove the <base> tag: the room sets where the game\'s files are';
  return null;
}

// index.html with the room's <base>, so the game's relative paths resolve inside its upload's folder.
export function withBase(html, href) {
  const tag = `<base href="${href}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  return doctype ? html.slice(0, doctype.index + doctype[0].length) + tag + html.slice(doctype.index + doctype[0].length) : tag + html;
}

// The agent that published, in the survey's words: from the MCP client's name, or the CLI.
export function agentName(client) {
  const c = String(client || '').toLowerCase();
  if (c.includes('claude')) return 'Claude Code';
  if (c.includes('codex')) return 'Codex';
  if (c.includes('cursor')) return 'Cursor';
  if (c.includes('goose')) return 'goose';
  return c ? (c === 'cli' ? 'the CLI' : 'Another') : null;
}

// ─────────────────────────── a game's numbers ───────────────────────────

const PHONES = new Set(['iOS', 'Android']);
const isPhone = (s) => PHONES.has(platformOf(s.device));
const frames = (s) => s.cell?.ft?.n ?? 0;
const late = (s) => s.cell?.over ?? 0;

// What went wrong in a play: an error, a crash, stutter (more than 1 in 10 frames late for its screen), a rage quit.
export function problemsOf(s) {
  const out = [];
  if (s.errors > 0) out.push('errors');
  if (s.crashed) out.push('crashes');
  if (frames(s) && late(s) / frames(s) > 0.1) out.push('stutter');
  if (s.rage_quit) out.push('rage_quits');
  return out;
}

// One game's numbers in a room, from its sessions: plays (players' sessions on the versions it published to the room,
// from its first publish until `to`), players where it keeps an ID, minutes played, plays on phones and their frames on
// time, the most playing at once, and per version its plays and how many hit a problem.
// A game's sessions with those the host saw start at intake but its store doesn't have yet (liveStarts): each is a
// play from its start, on the device it started on, with nothing yet about how it went (minutes, frames, problems),
// which arrive with the store's own session. One session is one play, whichever has it.
export function withLiveStarts(sessions, starts = []) {
  if (!starts?.length) return sessions;
  const known = new Set(sessions.map((s) => s.session_id));
  const early = [];
  for (const s of [...starts].sort((a, b) => a.at - b.at)) {
    if (!s?.session_id || !Number.isFinite(s.at) || known.has(s.session_id)) continue;
    known.add(s.session_id);
    early.push({ session_id: s.session_id, session_type: s.session_type ?? 'user', version: s.version ?? null, start: s.at, device: s.os ? { os: s.os } : {} });
  }
  return early.length ? [...sessions, ...early] : sessions;
}

export function gameNumbers(entry, sessions, to) {
  const uploads = entry.uploads ?? [];
  if (!uploads.length) return emptyNumbers();
  const from = uploads[0].published_at;
  const versions = uploads.map((u) => u.version);
  const plays = sessions.filter((s) => s.session_type === 'user' && versions.includes(s.version) && (s.start ?? s.first_ts) >= from && (s.start ?? s.first_ts) < to);
  const withIds = plays.filter(hasPlayerId);
  const phones = plays.filter(isPhone);
  const phoneFrames = phones.reduce((n, s) => n + frames(s), 0);
  const byVersion = new Map(versions.map((v) => [v, { version: v, plays: 0, with_problem: 0, problems: { errors: 0, crashes: 0, stutter: 0, rage_quits: 0 } }]));
  for (const s of plays) {
    const v = byVersion.get(s.version);
    v.plays++;
    const found = problemsOf(s);
    if (found.length) v.with_problem++;
    for (const k of found) v.problems[k]++;
  }
  return {
    plays: plays.length,
    players: withIds.length ? new Set(withIds.map((s) => s.player_id)).size : null,
    minutes_played: Math.round(plays.reduce((n, s) => n + (s.cell?.sec ?? 0), 0) / FIXED.sec / 60),
    phone_plays: phones.length,
    phone_frames_on_time_pct: phoneFrames ? Math.round(((phoneFrames - phones.reduce((n, s) => n + late(s), 0)) / phoneFrames) * 1000) / 10 : null,
    most_at_once: mostAtOnce(plays),
    versions: [...byVersion.values()],
  };
}

function emptyNumbers() {
  return { plays: 0, players: null, minutes_played: 0, phone_plays: 0, phone_frames_on_time_pct: null, most_at_once: 0, versions: [] };
}

function mostAtOnce(plays) {
  const edges = [];
  for (const s of plays) {
    const start = s.start ?? s.first_ts;
    edges.push([start, 1], [s.end ?? start + (s.duration_s ?? 0) * 1000, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let most = 0;
  for (const [, d] of edges) most = Math.max(most, (now += d));
  return most;
}

// ─────────────────────────── awards ───────────────────────────

const ofN = (a, b) => `${a} of ${b}`;
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The awards from the games' frozen numbers and the vote counts (§7). Each game: { slug, title, numbers, votes }.
export function awardsOf(games) {
  const live = games.filter((g) => !g.removed);
  const out = [];
  const best = (list, score, tie) => {
    const sorted = list.sort((a, b) => score(b) - score(a) || tie(b) - tie(a));
    return sorted.length ? sorted[0] : null;
  };

  const votes = live.filter((g) => g.votes >= LIMITS.minVotes);
  const top = Math.max(0, ...votes.map((g) => g.votes));
  const favourites = votes.filter((g) => g.votes === top);
  out.push(award('crowd_favourite', favourites, favourites.length ? `${favourites.map((g) => g.title).join(' and ')}: ${count(top, 'vote')}${favourites.length > 1 ? ' each, a tie' : ''}` : `No game had ${LIMITS.minVotes} votes`));

  const played = best(
    live.filter((g) => g.numbers.plays >= LIMITS.minPlays),
    (g) => g.numbers.plays,
    (g) => g.numbers.minutes_played,
  );
  out.push(award('most_played', played ? [played] : [], played ? `${played.title}: ${count(played.numbers.plays, 'play')}, ${count(played.numbers.minutes_played, 'minute')} played` : `No game had ${LIMITS.minPlays} plays`));

  const improved = live
    .map((g) => {
      const vs = g.numbers.versions.filter((v) => v.plays >= LIMITS.minPlays);
      if (vs.length < 2) return null;
      const [first, last] = [vs[0], vs[vs.length - 1]];
      const drop = (first.with_problem / first.plays - last.with_problem / last.plays) * 100;
      return drop >= LIMITS.minDrop ? { g, first, last, drop } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.drop - a.drop || b.last.plays - a.last.plays)[0];
  out.push(
    award(
      'biggest_improvement',
      improved ? [improved.g] : [],
      improved
        ? `${improved.g.title}: before the fix, ${ofN(improved.first.with_problem, improved.first.plays)} plays hit a problem; after it, ${ofN(improved.last.with_problem, improved.last.plays)}`
        : `No game cut its problems by ${LIMITS.minDrop} points between two versions with ${LIMITS.minPlays} plays each`,
    ),
  );

  const smooth = best(
    live.filter((g) => g.numbers.phone_plays >= LIMITS.minPlays && g.numbers.phone_frames_on_time_pct != null),
    (g) => g.numbers.phone_frames_on_time_pct,
    (g) => g.numbers.phone_plays,
  );
  out.push(award('smoothest_on_phones', smooth ? [smooth] : [], smooth ? `${smooth.title}: ${Math.round(smooth.numbers.phone_frames_on_time_pct)} of every 100 frames on time, over ${smooth.numbers.phone_plays} plays on phones` : `No game had ${LIMITS.minPlays} plays on phones`));
  return out;
}

function award(id, games, text) {
  return { id, title: AWARDS.find((a) => a.id === id).title, games: games.map((g) => g.slug), text };
}

// ─────────────────────────── the rooms ───────────────────────────

// urls: { app, play, jam? } (the dashboard's origin, where games are served, and where the jam's own pages are: the
// arcade, the big screen, the survey, the join page and the organiser's; default <app>/jam/; each ending in /), and
// abuse: an address for the
// Report link, or null. requireService: games are told apart by the name they send (the open-source server's one
// project holds every game), so joining names it. followUp: the host knows respondents' emails (resolveVoter's email),
// so the default survey also asks whether Glitchless may email them.
export function createRooms({ store, files, readGame, playersNow = async () => 0, liveStarts = null, joinable = null, notify = null, urls, abuse = null, requireService = false, followUp = false, now = Date.now, logger = console }) {
  const defaultSurvey = followUp ? [...DEFAULT_SURVEY, FOLLOW_UP] : DEFAULT_SURVEY;
  // The template every organiser has, which can't be changed: the default survey.
  const builtIn = { id: 'default', name: 'Glitchless default', heading: DEFAULT_HEADING, intro: null, questions: defaultSurvey, builtin: true };
  // A room's survey, whole: what it was set to, else the default.
  const surveyOf = (r) => ({ heading: r.survey?.heading ?? DEFAULT_HEADING, intro: r.survey?.intro ?? null, questions: (Array.isArray(r.survey) ? r.survey : r.survey?.questions) ?? defaultSurvey });
  const fill = (text, title) => (text == null ? null : String(text).replaceAll('{room}', title));
  const playBase = urls.play.endsWith('/') ? urls.play : `${urls.play}/`;
  const playPath = new URL(playBase).pathname;
  const jamBase = urls.jam ? (urls.jam.endsWith('/') ? urls.jam : `${urls.jam}/`) : `${urls.app}/jam/`;
  const links = (code) => ({ arcade: `${jamBase}${code}`, live: `${jamBase}${code}/live`, join: `${jamBase}${code}/join`, survey: `${jamBase}${code}/survey` });
  const gameUrl = (code, slug) => `${playBase}${code}/${slug}/`;
  const ended = (room) => room.ended_at != null || room.closes_at <= now();
  const tell = (type, data) => {
    if (!notify) return;
    (async () => notify(type, data))().catch((err) => logger.warn('[rooms] notify', type, err.message));
  };
  const nowPlaying = async (g) => {
    try {
      return g.service ? Number(await playersNow(g.project, g.service)) || 0 : 0;
    } catch {
      return 0;
    }
  };
  // Live numbers are made at most once every 15 seconds a room.
  const cache = new Map();
  const forget = (code) => {
    for (const k of cache.keys()) if (k.startsWith(`${code}\n`)) cache.delete(k);
  };

  async function room(code, { settle = false } = {}) {
    if (!isCode(code)) refuse(404, 'no room with that code');
    let r = await store.getRoom(normalCode(code));
    if (!r) refuse(404, 'no room with that code');
    // A room past its closing time ends the first time anyone asks, if the hourly sweep hasn't ended it yet.
    if (r.ended_at == null && r.closes_at <= now() && settle) r = await end(r, 'closed');
    return r;
  }

  const visible = (games) => games.filter((g) => !g.removed && !g.left);
  const published = (games) => visible(games).filter((g) => g.uploads?.length);

  // ── organisers ──
  async function create(owner, input = {}) {
    const title = clean(input.title, 80, 'title') ?? refuse(400, 'a room needs a title');
    const about = clean(input.about, 280, 'about');
    const hours = input.hours == null ? LIMITS.defaultHours : Number(input.hours);
    if (!(hours >= 1 && hours <= LIMITS.maxHours)) refuse(400, `a room is on for 1 to ${LIMITS.maxHours} hours`);
    const maxGames = input.max_games == null ? LIMITS.defaultGames : Number(input.max_games);
    if (!(Number.isInteger(maxGames) && maxGames >= 2 && maxGames <= LIMITS.maxGames)) refuse(400, `a room takes 2 to ${LIMITS.maxGames} games`);
    const template = input.template == null ? null : await templateOf(owner, input.template);
    const mine = (await store.rooms(owner.owner)).filter((r) => !ended(r));
    if (mine.length >= (owner.limits?.openRooms ?? LIMITS.openRooms)) refuse(429, `at most ${owner.limits?.openRooms ?? LIMITS.openRooms} rooms can be on at once: end one first`);
    const at = now();
    for (let tries = 0; tries < 8; tries++) {
      let code = '';
      while (code.length < 5) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      const r = { code, title, about, owner: owner.owner, created_at: at, closes_at: at + hours * HOUR, ended_at: null, joining: true, max_games: maxGames, survey: template && !template.builtin ? { heading: template.heading, intro: template.intro, questions: template.questions } : null };
      if (await store.claimRoom(r)) return publicRoom(r, []);
    }
    throw new Error('no free room code after 8 tries');
  }

  async function organised(owner, code) {
    const r = await room(code, { settle: true });
    if (r.owner !== owner.owner) refuse(404, 'no room with that code');
    return r;
  }

  async function update(owner, code, input = {}) {
    let r = await organised(owner, code);
    if (input.end === true) return publicRoom(ended(r) ? r : await end(r, 'ended'), await store.games(r.code));
    if (ended(r)) refuse(409, 'this jam has ended');
    const next = { ...r };
    if ('title' in input) next.title = clean(input.title, 80, 'title') ?? refuse(400, 'a room needs a title');
    if ('about' in input) next.about = clean(input.about, 280, 'about');
    if ('joining' in input) next.joining = input.joining === true;
    if ('closes_at' in input) {
      const t = typeof input.closes_at === 'string' ? Date.parse(input.closes_at) : Number(input.closes_at);
      if (!Number.isFinite(t) || t <= now() || t > r.created_at + LIMITS.maxHours * HOUR) refuse(400, `closes_at is a time from now to ${LIMITS.maxHours / 24} days after the room was made`);
      next.closes_at = t;
    }
    await store.putRoom(next);
    forget(r.code);
    return publicRoom(next, await store.games(r.code));
  }

  // The room's survey: { heading?, intro?, questions? } (questions: null is the default ones), or { template } to take
  // one of the organiser's. Until its first answer; after the end, the snapshot's survey changes with it.
  async function setSurvey(owner, code, input = {}) {
    const r = await organised(owner, code);
    if ((await store.answers(r.code)).length) refuse(409, "the survey has answers already, so it can't change now");
    let next;
    if (input.template != null) {
      const t = await templateOf(owner, input.template);
      next = t.builtin ? null : { heading: t.heading, intro: t.intro, questions: t.questions };
    } else {
      const current = surveyOf(r);
      next = checkSurvey({ heading: current.heading, intro: current.intro, questions: r.survey ? current.questions : null, ...input });
    }
    await store.putRoom({ ...r, survey: next });
    const whole = surveyOf({ survey: next });
    if (r.ended_at != null) {
      const snap = await store.getSnapshot(r.code);
      if (snap) await store.putSnapshot(r.code, { ...snap, survey: { ...whole, closes_at: snap.survey.closes_at } });
    }
    return { ...whole, filled: { heading: fill(whole.heading, r.title), intro: fill(whole.intro, r.title) } };
  }

  // ── survey templates: an organiser's own, beside the default ──
  async function templates(owner) {
    const own = (await store.templates(owner.owner)).sort((a, b) => a.name.localeCompare(b.name));
    return { templates: [builtIn, ...own] };
  }

  async function templateOf(owner, id) {
    if (String(id) === 'default') return builtIn;
    return (await store.templates(owner.owner)).find((t) => t.id === String(id)) ?? refuse(404, `no survey template "${id}": your templates are default${(await store.templates(owner.owner)).map((t) => `, ${t.id}`).join('')}`);
  }

  // Saves a template (a new one, or a change to one): { name, heading?, intro?, questions }, or { from_room } to take a
  // room's survey as it is set.
  async function saveTemplate(owner, id, input = {}) {
    const slug = String(id ?? slugify(input.name) ?? '');
    if (slug === 'default') refuse(400, "the default template can't change: save yours under another name");
    if (!TEMPLATE_RE.test(slug)) refuse(400, 'a template\'s id is 1 to 32 of a-z, 0-9 and -');
    const name = clean(input.name, 60, 'name') ?? refuse(400, 'a template needs a name');
    let base = { heading: DEFAULT_HEADING, intro: null, questions: defaultSurvey };
    if (input.from_room != null) base = surveyOf(await organised(owner, input.from_room));
    const survey = checkSurvey({ ...base, ...input, questions: input.questions ?? base.questions });
    const all = await store.templates(owner.owner);
    if (!all.some((t) => t.id === slug) && all.length >= TEMPLATES_MAX) refuse(429, `at most ${TEMPLATES_MAX} survey templates: delete one first`);
    const template = { id: slug, name, ...survey, updated_at: now() };
    await store.putTemplate(owner.owner, template);
    return template;
  }

  async function deleteTemplate(owner, id) {
    if (String(id) === 'default') refuse(400, "the default template can't be deleted");
    if (!(await store.templates(owner.owner)).some((t) => t.id === String(id))) refuse(404, `no survey template "${id}"`);
    await store.deleteTemplate(owner.owner, String(id));
    return { deleted: String(id) };
  }

  async function list(owner) {
    const rooms = await store.rooms(owner.owner);
    const out = [];
    for (const r of rooms) {
      const games = await store.games(r.code);
      // Every game that joined, published or not, for the organiser to see and take out.
      const joined = games.filter((g) => !g.left).map((g) => ({ slug: g.slug, title: g.title, by: g.by ?? null, joined_at: g.joined_at, uploads: g.uploads.length, published: g.uploads.length > 0, removed: g.removed === true }));
      // The survey as set (with "{room}" as written), whether it's the default, and its answers so far (none: it can change).
      const survey = { ...surveyOf(r), default: r.survey == null, answers: (await store.answers(r.code)).length };
      out.push({ ...publicRoom(r, games), games_joined: visible(games).length, joined, survey });
    }
    const past = (await store.snapshots(owner.owner)).filter((s) => !rooms.some((r) => r.code === s.code));
    return { rooms: out.sort((a, b) => b.created_at - a.created_at), past: past.map((s) => ({ code: s.code, title: s.title, created_at: s.created_at, ended_at: s.ended_at, games: s.games.length })).sort((a, b) => b.ended_at - a.ended_at) };
  }

  // The room and its snapshot; once the room is gone (a day after the end), its snapshot alone.
  async function remove(owner, code) {
    const code5 = normalCode(code);
    const r = isCode(code5) ? await store.getRoom(code5) : null;
    if (!r) {
      const snap = isCode(code5) ? await store.getSnapshot(code5) : null;
      if (!snap || snap.owner !== owner.owner) refuse(404, 'no room with that code');
      await store.deleteSnapshot(code5);
      return { deleted: code5 };
    }
    if (r.owner !== owner.owner) refuse(404, 'no room with that code');
    await deleteRoom(r, { snapshot: true });
    return { deleted: r.code };
  }

  // The organiser takes a game out of their room.
  async function takeOut(owner, code, slug) {
    const r = await organised(owner, code);
    return removeGame(r.code, slug, 'organiser');
  }

  async function removeGame(code, slug, by) {
    const r = await room(code);
    const g = (await store.getGame(r.code, slug)) ?? refuse(404, 'no game with that name in this room');
    await files.remove(`${r.code}/${slug}/`);
    // The organiser's removal keeps a record, so the game can't come back; a maker who leaves can join again.
    const next = by === 'organiser' ? { ...g, removed: true, removed_at: now(), pending: null } : { ...g, left: true, pending: null };
    await files.put(`${r.code}/${slug}/index.html`, Buffer.from(GONE_PAGE(by)), { type: FILE_TYPES.html, cache: 'no-cache' });
    if (by === 'organiser') await store.putGame(r.code, next);
    else await store.deleteGame(r.code, slug);
    forget(r.code);
    return { removed: slug };
  }

  // ── makers ──
  // maker: { projectId, person?, service? } from the reader. A game joins once a room; joining again answers the same entry.
  async function join(code, maker, input = {}) {
    const r = await room(code, { settle: true });
    if (ended(r)) refuse(409, 'this jam has ended');
    const games = await store.games(r.code);
    const service = clean(input.service, 128, 'service')?.toLowerCase() ?? null;
    if (requireService && !service) refuse(400, 'name the game: service is the name it passes to Glitchless.init');
    // A game joins once. On the open-source server every game is in one project, so a game is its service; on a host
    // with a project a game, its project, whatever service it names (the latest one named counts).
    const mine = games.find((g) => g.project === maker.projectId && !g.left && (!requireService || g.service === service));
    if (mine?.removed) refuse(403, 'the organiser took this game out of the room');
    if (mine) {
      const next = { ...mine, ...(input.title != null ? { title: clean(input.title, 60, 'title') ?? mine.title } : {}), ...('by' in input ? { by: clean(input.by, 40, 'by') } : {}), service: requireService ? mine.service : (service ?? mine.service), people: union(mine.people, maker.person) };
      await store.putGame(r.code, next);
      forget(r.code);
      return gameForMaker(r, next);
    }
    if (!r.joining) refuse(403, 'this room has stopped taking new games');
    if (visible(games).length >= r.max_games) refuse(409, `this room is full: ${r.max_games} games`);
    const why = joinable ? await joinable(maker.projectId) : null;
    if (why) refuse(400, why);
    const title = clean(input.title, 60, 'title') ?? service ?? refuse(400, 'a game needs a title');
    const base = slugify(input.slug ?? title) ?? slugify(service) ?? 'game';
    if (input.slug != null && !SLUG_RE.test(String(input.slug))) refuse(400, 'slug is 2 to 32 of a-z, 0-9 and -');
    for (let i = 1; i < 100; i++) {
      const slug = i === 1 ? base : `${base.slice(0, 29)}-${i}`;
      const g = { slug, title, by: clean(input.by, 40, 'by'), project: maker.projectId, service, joined_at: now(), uploads: [], current: null, pending: null, starts: [], people: maker.person ? [maker.person] : [] };
      if (await store.putGame(r.code, g, { create: true })) {
        forget(r.code);
        tell('joined', { room: r, game: g, person: maker.person ?? null });
        return gameForMaker(r, g);
      }
    }
    refuse(409, 'no free name for this game in the room');
  }

  async function makersGame(code, slug, maker, { settle = true } = {}) {
    const r = await room(code, { settle });
    const g = await store.getGame(r.code, slug);
    if (!g || g.project !== maker.projectId || g.left) refuse(404, 'no game of yours with that name in this room');
    if (g.removed) refuse(403, 'the organiser took this game out of the room');
    return { r, g };
  }

  async function editGame(code, slug, maker, input = {}) {
    const { r, g } = await makersGame(code, slug, maker);
    const next = { ...g, ...('title' in input ? { title: clean(input.title, 60, 'title') ?? refuse(400, 'a game needs a title') } : {}), ...('by' in input ? { by: clean(input.by, 40, 'by') } : {}) };
    await store.putGame(r.code, next);
    forget(r.code);
    return gameForMaker(r, next);
  }

  async function gameStatus(code, slug, maker) {
    const { r, g } = await makersGame(code, slug, maker);
    const numbers = await numbersOf(r, g);
    return { ...gameForMaker(r, g), numbers };
  }

  // Start an upload: the list of files is checked against every limit before a byte is sent.
  async function startUpload(code, slug, maker, input = {}) {
    const { r, g } = await makersGame(code, slug, maker);
    if (ended(r)) refuse(409, 'this jam has ended: publishing has stopped');
    const version = clean(input.version, 64, 'version') ?? refuse(400, 'version is required: the version the game passes to Glitchless.init');
    if (g.uploads.some((u) => u.version === version)) refuse(409, `${version} is already published here: bump the version passed to Glitchless.init, or both uploads' players count as one version`);
    if (g.uploads.length >= LIMITS.uploadsPerGame) refuse(429, `a game publishes at most ${LIMITS.uploadsPerGame} times in a room`);
    const starts = (g.starts ?? []).filter((t) => t > now() - HOUR);
    if (starts.length >= LIMITS.uploadsPerHour) refuse(429, `a game publishes at most ${LIMITS.uploadsPerHour} times an hour`);
    const list = Array.isArray(input.files) ? input.files : refuse(400, 'files: [{ path, bytes, sha256 }] is required');
    if (!list.length || list.length > LIMITS.uploadFiles) refuse(413, `an upload is 1 to ${LIMITS.uploadFiles} files`);
    const manifest = {};
    let total = 0;
    for (const f of list) {
      const bad = checkPath(f?.path);
      if (bad) refuse(415, bad);
      if (manifest[f.path]) refuse(400, `"${f.path}" is listed twice`);
      if (!(Number.isInteger(f.bytes) && f.bytes >= 0)) refuse(400, `"${f.path}": bytes must be its size`);
      if (f.bytes > LIMITS.fileBytes) refuse(413, `"${f.path}" is ${mb(f.bytes)}: a file is at most ${mb(LIMITS.fileBytes)}`);
      if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) refuse(400, `"${f.path}": sha256 must be its SHA-256 in hex`);
      manifest[f.path] = { bytes: f.bytes, sha256: f.sha256 };
      total += f.bytes;
    }
    if (!manifest['index.html']) refuse(400, 'index.html must be at the root of the upload');
    if (total > LIMITS.uploadBytes) refuse(413, `this upload is ${mb(total)}: an upload is at most ${mb(LIMITS.uploadBytes)}`);
    const roomBytes = (await store.games(r.code)).reduce((n, x) => n + (x.uploads ?? []).reduce((m, u) => m + u.bytes, 0), 0);
    if (roomBytes + total > LIMITS.roomBytes) refuse(413, 'this room is out of space');
    // A newer upload replaces one that was never published.
    if (g.pending) await files.remove(`${r.code}/${slug}/${g.pending.n}/`);
    const n = (g.uploads.at(-1)?.n ?? 0) + 1;
    const service = clean(input.service, 128, 'service')?.toLowerCase() ?? null;
    const pending = { n, version, manifest, bytes: total, agent: clean(maker.client, 40, 'client') ?? null, expires_at: now() + LIMITS.pendingMs, started_at: now() };
    await store.putGame(r.code, { ...g, service: requireService ? g.service : (service ?? g.service), pending, starts: [...starts, now()] });
    return { n, version, send: Object.keys(manifest), expires_at: pending.expires_at, limits: { file_bytes: LIMITS.fileBytes } };
  }

  async function pendingOf(code, slug, n, maker) {
    const { r, g } = await makersGame(code, slug, maker);
    const p = g.pending;
    if (!p || p.n !== Number(n) || p.expires_at <= now()) refuse(404, 'no upload in progress with that number: start one again');
    return { r, g, p };
  }

  async function putFile(code, slug, n, filePath, bytes, maker) {
    const { r, p } = await pendingOf(code, slug, n, maker);
    const want = p.manifest[filePath] ?? refuse(404, `"${filePath}" isn't in this upload's list`);
    if (bytes.length !== want.bytes) refuse(400, `"${filePath}" is ${bytes.length} bytes, the list said ${want.bytes}`);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== want.sha256) refuse(400, `"${filePath}" doesn't match its SHA-256 in the list`);
    if (/\.html?$/i.test(filePath)) {
      const bad = checkHtml(bytes.toString('utf8'));
      if (bad) refuse(422, `${filePath}: ${bad}`);
    }
    await files.put(`${r.code}/${slug}/${p.n}/${filePath}`, bytes, { type: typeOf(filePath), cache: 'immutable' });
    return { path: filePath, bytes: bytes.length };
  }

  async function publish(code, slug, n, maker) {
    const { r, g, p } = await pendingOf(code, slug, n, maker);
    if (ended(r)) refuse(409, 'this jam has ended: publishing has stopped');
    const missing = [];
    for (const [file, want] of Object.entries(p.manifest)) if ((await files.stat(`${r.code}/${slug}/${p.n}/${file}`))?.bytes !== want.bytes) missing.push(file);
    if (missing.length) refuse(409, `${missing.length} file${missing.length === 1 ? '' : 's'} not sent yet: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
    const index = (await files.get(`${r.code}/${slug}/${p.n}/index.html`)).toString('utf8');
    await files.put(`${r.code}/${slug}/index.html`, Buffer.from(withBase(index, `${playPath}${r.code}/${slug}/${p.n}/`)), { type: FILE_TYPES.html, cache: 'no-cache' });
    const upload = { n: p.n, version: p.version, files: Object.keys(p.manifest).length, bytes: p.bytes, published_at: now(), agent: p.agent };
    const next = { ...g, uploads: [...g.uploads, upload], current: p.n, pending: null, people: union(g.people, maker.person) };
    await store.putGame(r.code, next);
    forget(r.code);
    tell('published', { room: r, game: next, upload, person: maker.person ?? null });
    return { url: gameUrl(r.code, slug), version: p.version, n: p.n, arcade: links(r.code).arcade };
  }

  async function leave(code, slug, maker) {
    await makersGame(code, slug, maker, { settle: false });
    return removeGame(code, slug, 'maker');
  }

  // ── what anyone sees ──
  function publicGame(r, g) {
    const last = g.uploads.at(-1);
    return { slug: g.slug, title: g.title, by: g.by ?? null, url: gameUrl(r.code, g.slug), version: last?.version ?? null, published_at: last?.published_at ?? null, new: last && !ended(r) ? now() - last.published_at < LIMITS.newMs : false };
  }

  function publicRoom(r, games) {
    const done = ended(r);
    return {
      code: r.code,
      title: r.title,
      about: r.about ?? null,
      created_at: r.created_at,
      closes_at: r.closes_at,
      ended: done,
      ended_at: r.ended_at ?? (done ? r.closes_at : null),
      joining: r.joining && !done,
      links: links(r.code),
      ...(abuse ? { report: abuse } : {}),
      games: published(games)
        .map((g) => publicGame(r, g))
        .sort((a, b) => a.published_at - b.published_at),
      building: visible(games).filter((g) => !g.uploads?.length).length,
    };
  }

  function gameForMaker(r, g) {
    return { room: r.code, ...publicGame(r, g), service: g.service ?? null, joined_at: g.joined_at, uploads: g.uploads, links: links(r.code), ended: ended(r) };
  }

  async function arcade(code) {
    const r = await room(code, { settle: true });
    return publicRoom(r, await store.games(r.code));
  }

  // The game's numbers now (or frozen at the end, from the snapshot).
  async function numbersOf(r, g, to = Math.min(now(), r.ended_at ?? Infinity)) {
    if (!g.uploads?.length || !g.service) return emptyNumbers();
    try {
      const from = g.uploads[0].published_at;
      const sessions = await readGame(g.project, g.service, from, to);
      const starts = liveStarts
        ? await liveStarts(g.project, g.service, from, to).catch((err) => {
            logger.warn('[rooms] live starts', r.code, g.slug, err.message);
            return [];
          })
        : [];
      return gameNumbers(g, withLiveStarts(sessions, starts), to);
    } catch (err) {
      logger.warn('[rooms] numbers', r.code, g.slug, err.message);
      return emptyNumbers();
    }
  }

  // The big screen: every published game's numbers, the fewest plays first; after the end, the awards (§6).
  async function live(code) {
    const r = await room(code, { settle: true });
    if (ended(r)) {
      const snap = await store.getSnapshot(r.code);
      if (snap) return liveFromSnapshot(r, snap);
    }
    const key = `${r.code}\nlive`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < 15_000) return hit.body;
    const games = await store.games(r.code);
    const rows = [];
    for (const g of published(games)) {
      const numbers = await numbersOf(r, g);
      rows.push({ ...publicGame(r, g), ...liveNumbers(numbers), playing_now: await nowPlaying(g) });
    }
    const body = liveBody(r, games, rows, null);
    cache.set(key, { at: now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return body;
  }

  function liveNumbers(n) {
    return { plays: n.plays, players: n.players, minutes_played: n.minutes_played, phone_plays: n.phone_plays };
  }

  function liveBody(r, games, rows, awards) {
    const plays = rows.reduce((n, g) => n + g.plays, 0);
    const phones = rows.reduce((n, g) => n + g.phone_plays, 0);
    return {
      room: { ...publicRoom(r, games), games: undefined },
      totals: { games: rows.length, building: visible(games).filter((g) => !g.uploads?.length).length, plays, minutes_played: rows.reduce((n, g) => n + g.minutes_played, 0), phone_pct: plays ? Math.round((phones / plays) * 100) : null, playing_now: rows.reduce((n, g) => n + (g.playing_now ?? 0), 0) },
      games: rows,
      needs_players: [...rows].sort((a, b) => a.plays - b.plays || a.published_at - b.published_at).map((g) => g.slug),
      most_played: [...rows]
        .filter((g) => g.plays > 0)
        .sort((a, b) => b.plays - a.plays || b.minutes_played - a.minutes_played)
        .slice(0, 3)
        .map((g) => g.slug),
      awards,
      updated_at: now(),
    };
  }

  function liveFromSnapshot(r, snap) {
    const rows = snap.games.filter((g) => !g.removed && g.uploads.length).map((g) => ({ slug: g.slug, title: g.title, by: g.by, url: gameUrl(r.code, g.slug), version: g.uploads.at(-1).version, published_at: g.uploads.at(-1).published_at, new: false, ...liveNumbers(g.numbers), playing_now: 0, votes: g.votes }));
    return liveBody(r, [], rows, snap.awards);
  }

  // ── votes ──
  // voter: { voter, owns(projectId) } from the host. One vote a person; none for their own games; no counts until the end.
  async function myVote(code, voter) {
    const r = await room(code, { settle: true });
    const games = await store.games(r.code);
    const own = [];
    for (const g of published(games)) if (await voter.owns(g.project)) own.push(g.slug);
    const v = (await store.votes(r.code)).find((x) => x.voter === hash(voter.voter));
    return { vote: v?.slug ?? null, own, open: !ended(r) };
  }

  async function vote(code, voter, slug) {
    const r = await room(code, { settle: true });
    if (ended(r)) refuse(409, 'voting has closed: this jam has ended');
    if (slug != null) {
      const g = await store.getGame(r.code, String(slug));
      if (!g || g.removed || g.left || !g.uploads?.length) refuse(404, 'no game with that name in this room');
      if (await voter.owns(g.project)) refuse(403, "you can't vote for your own game");
    }
    await store.putVote(r.code, hash(voter.voter), slug == null ? null : String(slug));
    tell('voted', { room: r, person: voter.person ?? null });
    return { vote: slug ?? null };
  }

  // ── ending, the snapshot and the survey ──
  async function end(r, why) {
    if (r.ended_at != null) return r;
    const at = Math.min(now(), r.closes_at);
    const done = { ...r, ended_at: at, joining: false };
    await store.putRoom(done);
    forget(r.code);
    const snapshot = await snapshotOf(done);
    await store.putSnapshot(r.code, snapshot);
    for (const g of await store.games(r.code)) if (g.pending) await files.remove(`${r.code}/${g.slug}/${g.pending.n}/`);
    logger.info?.(`[rooms] ${r.code} ${why}: ${snapshot.games.length} games`);
    tell('ended', { room: done, snapshot });
    return done;
  }

  async function snapshotOf(r) {
    const games = await store.games(r.code);
    const tally = new Map();
    const votes = await store.votes(r.code);
    for (const v of votes) if (v.slug) tally.set(v.slug, (tally.get(v.slug) ?? 0) + 1);
    const rows = [];
    for (const g of games.filter((x) => !x.left)) {
      const numbers = g.removed ? emptyNumbers() : await numbersOf(r, g, r.ended_at);
      rows.push({ slug: g.slug, title: g.title, by: g.by ?? null, joined_at: g.joined_at, removed: g.removed === true, uploads: g.uploads.map(({ n, version, files: count, bytes, published_at, agent }) => ({ n, version, files: count, bytes, published_at, agent: agentName(agent) })), numbers, votes: g.removed ? 0 : (tally.get(g.slug) ?? 0) });
    }
    const live = rows.filter((g) => !g.removed);
    const versionsWithPlays = (g) => g.numbers.versions.filter((v) => v.plays > 0);
    return {
      code: r.code,
      title: r.title,
      about: r.about ?? null,
      owner: r.owner,
      created_at: r.created_at,
      ended_at: r.ended_at,
      minutes: Math.round((r.ended_at - r.created_at) / MINUTE),
      games: rows,
      funnel: {
        joined: live.length,
        published: live.filter((g) => g.uploads.length).length,
        sending: live.filter((g) => g.numbers.plays > 0).length,
        improved: live.filter((g) => g.uploads.length > 1).length,
        fixed: live.filter((g) => {
          const vs = versionsWithPlays(g);
          return vs.length > 1 && vs.at(-1).with_problem / vs.at(-1).plays < vs[0].with_problem / vs[0].plays;
        }).length,
      },
      votes: { voters: votes.filter((v) => v.slug).length },
      awards: awardsOf(rows),
      survey: { ...surveyOf(r), closes_at: r.ended_at + LIMITS.surveyDays * DAY },
    };
  }

  async function snapshot(owner, code) {
    const code5 = normalCode(code);
    const snap = isCode(code5) ? await store.getSnapshot(code5) : null;
    if (!snap || snap.owner !== owner.owner) {
      // A room that hasn't ended has no snapshot yet; say so to its organiser.
      const r = isCode(code5) ? await store.getRoom(code5) : null;
      if (r && r.owner === owner.owner) refuse(409, 'the snapshot is written when the jam ends');
      refuse(404, 'no room with that code');
    }
    return { ...snap, survey: { ...snap.survey, answers: (await store.answers(code5)).sort((a, b) => a.at - b.at) } };
  }

  // The survey's questions, and the respondent's own answers (and the agent they published with, as a suggestion).
  async function survey(code, respondent) {
    const code5 = normalCode(code);
    const r = isCode(code5) ? await store.getRoom(code5) : null;
    if (r && !ended(r)) {
      const s = surveyOf(r);
      return { open: false, opens: 'when the jam ends', title: r.title, heading: fill(s.heading, r.title), intro: fill(s.intro, r.title), questions: s.questions };
    }
    if (r && r.ended_at == null) await end(r, 'closed');
    const snap = isCode(code5) ? await store.getSnapshot(code5) : null;
    if (!snap) refuse(404, 'no room with that code');
    const mine = respondent ? (await store.answers(code5)).find((a) => a.respondent === hash(respondent.voter)) : null;
    const made = respondent ? await madeBy(snap, respondent) : [];
    const agent = made.map((slug) => snap.games.find((g) => g.slug === slug)?.uploads.at(-1)?.agent).find((a) => a && a !== 'the CLI');
    const s = snap.survey;
    return { open: now() < s.closes_at, closes_at: s.closes_at, title: snap.title, heading: fill(s.heading ?? DEFAULT_HEADING, snap.title), intro: fill(s.intro ?? null, snap.title), questions: s.questions, answers: mine?.answers ?? null, ...(agent ? { suggested: { agent } } : {}) };
  }

  // The games in a snapshot the respondent made (their workspace's), by slug. The snapshot keeps no projects, so it's
  // read from the room's games while they last, else nothing.
  async function madeBy(snap, respondent) {
    const out = [];
    for (const g of await store.games(snap.code).catch(() => [])) if (!g.left && (await respondent.owns(g.project))) out.push(g.slug);
    return out;
  }

  async function answer(code, respondent, answers) {
    const code5 = normalCode(code);
    const r = isCode(code5) ? await store.getRoom(code5) : null;
    if (r && !ended(r)) refuse(409, 'the survey opens when the jam ends');
    if (r && r.ended_at == null) await end(r, 'closed');
    const snap = isCode(code5) ? await store.getSnapshot(code5) : null;
    if (!snap) refuse(404, 'no room with that code');
    if (now() >= snap.survey.closes_at) refuse(409, 'the survey has closed');
    const checked = checkAnswers(snap.survey.questions, answers);
    const made = await madeBy(snap, respondent);
    const record = { respondent: hash(respondent.voter), at: now(), made, answers: checked, ...(checked.follow_up === 'Yes' && respondent.email ? { email: respondent.email } : {}) };
    await store.putAnswers(code5, record.respondent, record);
    tell('answered', { room: { code: snap.code, title: snap.title }, person: respondent.person ?? null, answers: checked, questions: snap.survey.questions });
    return { answers: checked };
  }

  // ── the sweep (hourly on the open-source server, every 15 minutes on Glitchless Cloud) ──
  // Ends rooms past their closing time, drops uploads never published, deletes rooms a day after they end and
  // snapshots after a year.
  async function sweep() {
    const t = now();
    const done = { ended: 0, deleted: 0, dropped: 0, snapshots: 0 };
    for (let r of await store.allRooms()) {
      try {
        if (r.ended_at == null && r.closes_at <= t) {
          r = await end(r, 'closed');
          done.ended++;
        }
        if (r.ended_at != null && r.ended_at + LIMITS.keepAfterEndMs <= t) {
          await deleteRoom(r, { snapshot: false });
          done.deleted++;
          continue;
        }
        for (const g of await store.games(r.code)) {
          if (!g.pending || g.pending.expires_at > t) continue;
          await files.remove(`${r.code}/${g.slug}/${g.pending.n}/`);
          await store.putGame(r.code, { ...g, pending: null });
          done.dropped++;
        }
      } catch (err) {
        logger.warn('[rooms] sweep', r.code, err.message);
      }
    }
    for (const s of await store.allSnapshots()) {
      if (s.ended_at + LIMITS.snapshotDays * DAY > t) continue;
      await store.deleteSnapshot(s.code);
      done.snapshots++;
    }
    return done;
  }

  async function deleteRoom(r, { snapshot: alsoSnapshot }) {
    await files.remove(`${r.code}/`);
    await store.deleteRoom(r.code);
    if (alsoSnapshot) await store.deleteSnapshot(r.code);
    forget(r.code);
    tell('deleted', { room: r });
  }

  return { create, list, update, setSurvey, templates, saveTemplate, deleteTemplate, remove, takeOut, join, editGame, gameStatus, startUpload, putFile, publish, leave, arcade, live, myVote, vote, snapshot, survey, answer, sweep, gameUrl, links, ended };
}

function union(list, item) {
  const out = [...(list ?? [])];
  if (item && !out.includes(item)) out.push(item);
  return out;
}

const mb = (n) => `${Math.round((n / 1e6) * 10) / 10} MB`;

// A survey as an organiser sets it: a heading (≤ 120), an intro (≤ 400) and its questions (null: the default ones).
function checkSurvey({ heading, intro, questions }) {
  return {
    heading: clean(heading, 120, 'heading') ?? DEFAULT_HEADING,
    intro: clean(intro, 400, 'intro'),
    questions: questions == null ? null : checkQuestions(questions),
  };
}

function checkQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > SURVEY_MAX) refuse(400, `a survey has 1 to ${SURVEY_MAX} questions`);
  const ids = new Set();
  return questions.map((q, i) => {
    const id = String(q?.id ?? `q${i + 1}`);
    if (!/^[a-z0-9_]{1,32}$/.test(id) || ids.has(id)) refuse(400, `question ${i + 1}: id is 1 to 32 of a-z, 0-9 and _, each its own`);
    ids.add(id);
    const kind = ['scale', 'choice', 'text'].includes(q.kind) ? q.kind : refuse(400, `question ${i + 1}: kind is scale, choice or text`);
    const text = clean(q.text, 200, `question ${i + 1}`) ?? refuse(400, `question ${i + 1} has no text`);
    if (kind !== 'choice') return { id, kind, text };
    const options = Array.isArray(q.options) ? q.options.map((o) => clean(o, 80, 'an option')).filter(Boolean) : [];
    if (options.length < 2 || options.length > 8) refuse(400, `question ${i + 1}: a choice has 2 to 8 options`);
    return { id, kind, text, options };
  });
}

function checkAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') refuse(400, 'answers: { question: answer } is required');
  const out = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (a == null || a === '') continue;
    if (q.kind === 'scale') {
      if (!(Number.isInteger(a) && a >= 1 && a <= 5)) refuse(400, `"${q.text}" is 1 to 5`);
      out[q.id] = a;
    } else if (q.kind === 'choice') {
      if (!q.options.includes(a)) refuse(400, `"${q.text}": pick one of ${q.options.join(', ')}`);
      out[q.id] = a;
    } else {
      out[q.id] = clean(a, TEXT_MAX, `"${q.text}"`);
    }
  }
  return out;
}

const GONE_PAGE = (by) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here</title><body style="font:16px/1.6 system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.4rem">${by === 'organiser' ? 'This game was taken down' : 'This game left the room'}</h1><p>It isn't in this jam room any more.</p></body>`;
