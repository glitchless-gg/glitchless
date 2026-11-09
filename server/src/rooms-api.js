// The jam rooms API (SPEC §3j) under /v1/rooms, served by createApp (app.js) for a host that gives it rooms (rooms.js).
//
// Who may do what comes from the host's auth hooks (auth.js):
//   anyone       the arcade, the big screen, QR codes and the survey's questions; cached and rate limited per address
//   organisers   auth.resolveOrganiser(req) → { owner, limits? }: make rooms, change, end and delete their own, remove a
//                game, set the survey and keep survey templates, read the snapshot. Without the hook, whoever passes
//                resolveReader
//   makers       resolveReader with the dashboard scope on the game's project: join, publish or link, leave
//   voters       auth.resolveVoter(req) → { voter, owns(projectId), person?, email? }: vote, and answer the survey.
//                Without the hook, a browser's own random x-glitchless-voter token: one vote a browser, and no way to
//                tell a maker's own game
import { RoomError, LIMITS } from './rooms.js';
import { qrSvg, qrText } from './qr.js';
import { AuthError, RateLimiter, isProjectId } from './auth.js';

const MAX_JSON = 256 * 1024;
// A room's phones often share one address (the venue's Wi-Fi), so reads are limited loosely per address, and votes and
// answers per person.
const PUBLIC_RPS = 20;
const VOTER_RPS = 5;
const ADDRESS_WRITE_RPS = 20;
const FILE_RPS = 50;

export function createRoomsApi({ rooms, auth, clientAddress = (req) => req.socket?.remoteAddress, maxFile = LIMITS.fileBytes }) {
  const limiter = new RateLimiter();

  // 429 once an address (or key) has used its rate; false while it hasn't.
  const limited = (res, key, rps) => {
    const wait = limiter.take(key, rps);
    if (!wait) return false;
    res.setHeader('Retry-After', String(wait));
    json(res, 429, { error: 'too many requests: slow down' });
    return true;
  };

  async function maker(req) {
    const reader = await auth.resolveReader(req);
    if (!isProjectId(reader?.projectId)) throw new Error('auth hook returned no valid projectId');
    if (!reader.scopes?.includes('dashboard')) throw new AuthError(403, 'joining a jam room and publishing to it need a key with the dashboard scope');
    return { projectId: reader.projectId, person: reader.person ?? null, client: String(req.headers['x-glitchless-client'] || '').slice(0, 40) || null };
  }

  async function organiser(req) {
    if (auth.resolveOrganiser) return auth.resolveOrganiser(req);
    const reader = await auth.resolveReader(req);
    return { owner: reader.projectId };
  }

  async function voter(req) {
    if (auth.resolveVoter) return auth.resolveVoter(req);
    const token = String(req.headers['x-glitchless-voter'] || '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new AuthError(401, 'send this browser\'s own random token in x-glitchless-voter');
    return { voter: `b:${token}`, owns: () => false };
  }

  const optionalVoter = (req) => voter(req).catch((err) => (err instanceof AuthError && err.status === 401 ? null : Promise.reject(err)));

  async function route(req, res, url) {
    const parts = url.pathname.split('/').slice(3); // after /v1/rooms
    const [code, sub, slug, kind, n, verb] = parts;
    const m = req.method;
    const addr = String(clientAddress(req) ?? 'unknown');

    // An organiser's survey templates: GET lists them (the default first), PUT /{id} saves one, DELETE /{id} removes it.
    if (code === 'templates') {
      if (!sub && m === 'GET') return json(res, 200, await rooms.templates(await organiser(req)));
      if (sub && !slug && m === 'PUT') return json(res, 200, await rooms.saveTemplate(await organiser(req), sub, await body(req)));
      if (sub && !slug && m === 'DELETE') return json(res, 200, await rooms.deleteTemplate(await organiser(req), sub));
      return json(res, 405, { error: 'GET /v1/rooms/templates, or PUT or DELETE /v1/rooms/templates/{id}' });
    }

    if (!code) {
      if (m === 'POST') {
        const made = await rooms.create(await organiser(req), await body(req));
        return json(res, 201, { ...made, qr_text: qrText(made.links.arcade) });
      }
      if (m === 'GET') return json(res, 200, await rooms.list(await organiser(req)));
      return json(res, 405, { error: 'GET or POST' });
    }

    if (!sub) {
      if (m === 'GET') {
        if (limited(res, `public\n${addr}`, PUBLIC_RPS)) return;
        return json(res, 200, await rooms.arcade(code), { 'Cache-Control': 'public, max-age=10' });
      }
      if (m === 'PATCH') return json(res, 200, await rooms.update(await organiser(req), code, await body(req)));
      if (m === 'DELETE') return json(res, 200, await rooms.remove(await organiser(req), code));
      return json(res, 405, { error: 'GET, PATCH or DELETE' });
    }

    if (sub === 'live' && m === 'GET' && !slug) {
      if (limited(res, `public\n${addr}`, PUBLIC_RPS)) return;
      return json(res, 200, await rooms.live(code), { 'Cache-Control': 'public, max-age=15' });
    }

    if (sub === 'qr.svg' && m === 'GET' && !slug) {
      if (limited(res, `qr\n${addr}`, PUBLIC_RPS * 3)) return;
      const room = await rooms.arcade(code);
      const game = url.searchParams.get('game');
      const link = game ? room.games.find((g) => g.slug === game)?.url : room.links.arcade;
      if (!link) return json(res, 404, { error: 'no game with that name in this room' });
      return send(res, 200, qrSvg(link), 'image/svg+xml', { 'Cache-Control': 'public, max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
    }

    if (sub === 'vote' && !slug) {
      if (m === 'GET') return json(res, 200, await rooms.myVote(code, await voter(req)));
      if (m === 'PUT') {
        const who = await voter(req);
        if (limited(res, `write\n${addr}`, ADDRESS_WRITE_RPS) || limited(res, `voter\n${who.voter}`, VOTER_RPS)) return;
        const input = await body(req);
        return json(res, 200, await rooms.vote(code, who, input.slug ?? null));
      }
      return json(res, 405, { error: 'GET or PUT' });
    }

    if (sub === 'survey') {
      if (slug) return json(res, 404, { error: 'not found' });
      // The organiser sets it: { heading?, intro?, questions? } or { template }.
      if (m === 'PATCH') return json(res, 200, await rooms.setSurvey(await organiser(req), code, await body(req)));
      if (m === 'GET') return json(res, 200, await rooms.survey(code, await optionalVoter(req)));
      if (m === 'PUT') {
        const who = await voter(req);
        if (limited(res, `write\n${addr}`, ADDRESS_WRITE_RPS) || limited(res, `voter\n${who.voter}`, VOTER_RPS)) return;
        return json(res, 200, await rooms.answer(code, who, (await body(req)).answers));
      }
      return json(res, 405, { error: 'GET, PUT (answers) or PATCH (the organiser sets it)' });
    }

    if (sub === 'snapshot' && m === 'GET' && !slug) {
      const snap = await rooms.snapshot(await organiser(req), code);
      if (url.searchParams.get('format') === 'csv') return send(res, 200, snapshotCsv(snap), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="jam-${snap.code}.csv"`, 'Cache-Control': 'no-store' });
      return json(res, 200, snap);
    }

    if (sub !== 'games') return json(res, 404, { error: 'not found' });
    if (!slug) {
      if (m === 'POST') return json(res, 201, await rooms.join(code, await maker(req), await body(req)));
      return json(res, 405, { error: 'POST' });
    }
    if (!kind) {
      if (m === 'GET') return json(res, 200, await rooms.gameStatus(code, slug, await maker(req)));
      if (m === 'PATCH') return json(res, 200, await rooms.editGame(code, slug, await maker(req), await body(req)));
      if (m === 'DELETE') {
        // ?by=organiser: the organiser takes the game out (it can't come back); otherwise its maker leaves.
        if (url.searchParams.get('by') === 'organiser') return json(res, 200, await rooms.takeOut(await organiser(req), code, slug));
        return json(res, 200, await rooms.leave(code, slug, await maker(req)));
      }
      return json(res, 405, { error: 'GET, PATCH or DELETE' });
    }
    // A version of a game played on its itch.io page: { version, url?, service? } (rooms.js link).
    if (kind === 'links') {
      if (n) return json(res, 404, { error: 'not found' });
      if (m !== 'POST') return json(res, 405, { error: 'POST' });
      return json(res, 200, withQr(await rooms.link(code, slug, await maker(req), await body(req)), code, slug));
    }
    if (kind !== 'uploads') return json(res, 404, { error: 'not found' });
    if (!n) {
      if (m === 'POST') return json(res, 201, await rooms.startUpload(code, slug, await maker(req), await body(req)));
      return json(res, 405, { error: 'POST' });
    }
    if (verb === 'publish' && parts.length === 6 && m === 'POST') {
      return json(res, 200, withQr(await rooms.publish(code, slug, n, await maker(req)), code, slug));
    }
    if (verb === 'files' && parts.length > 6 && m === 'PUT') {
      const who = await maker(req);
      if (limited(res, `files\n${who.projectId}`, FILE_RPS)) return;
      let file;
      try {
        file = parts.slice(6).map(decodeURIComponent).join('/');
      } catch {
        return json(res, 400, { error: 'bad file path' });
      }
      return json(res, 201, await rooms.putFile(code, slug, n, file, await readBody(req, maxFile), who));
    }
    return json(res, 404, { error: 'not found' });
  }

  route.rooms = rooms;
  return route;
}

// A publish's or a link's answer with the game's QR code, as text for a terminal and as the SVG's address.
const withQr = (done, code, slug) => ({ ...done, qr_text: qrText(done.url), qr_svg: `${new URL(done.arcade).origin}/v1/rooms/${code.toUpperCase()}/qr.svg?game=${slug}` });

// One row a game: what the CSV download of a snapshot holds.
export function snapshotCsv(snap) {
  const cols = ['slug', 'title', 'by', 'joined_at', 'removed', 'uploads', 'versions', 'agents', 'plays', 'players', 'minutes_played', 'phone_plays', 'phone_frames_on_time_pct', 'most_at_once', 'first_version_problem_pct', 'last_version_problem_pct', 'votes', 'awards', 'link'];
  const pct = (v) => (v?.plays ? Math.round((v.with_problem / v.plays) * 100) : '');
  const rows = snap.games.map((g) => {
    const vs = g.numbers.versions.filter((v) => v.plays > 0);
    return {
      slug: g.slug,
      title: g.title,
      by: g.by ?? '',
      joined_at: new Date(g.joined_at).toISOString(),
      removed: g.removed ? 'yes' : '',
      uploads: g.uploads.length,
      versions: g.uploads.map((u) => u.version).join(' '),
      agents: [...new Set(g.uploads.map((u) => u.agent).filter(Boolean))].join(' '),
      plays: g.numbers.plays,
      players: g.numbers.players ?? '',
      minutes_played: g.numbers.minutes_played,
      phone_plays: g.numbers.phone_plays,
      phone_frames_on_time_pct: g.numbers.phone_frames_on_time_pct ?? '',
      most_at_once: g.numbers.most_at_once,
      first_version_problem_pct: pct(vs[0]),
      last_version_problem_pct: vs.length > 1 ? pct(vs.at(-1)) : '',
      votes: g.votes,
      awards: snap.awards.filter((a) => a.games.includes(g.slug)).map((a) => a.title).join(' '),
      link: g.link ?? '',
    };
  });
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

function json(res, status, body, headers = {}) {
  send(res, status, JSON.stringify(body), 'application/json', { 'Cache-Control': 'no-store', ...headers });
}

function send(res, status, body, type, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
}

async function body(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new RoomError(400, 'invalid JSON');
  }
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let refused = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) return void chunks.push(c);
      if (!refused) {
        refused = true;
        chunks.length = 0;
        reject(new RoomError(413, `too large: at most ${Math.round(max / 1e5) / 10} MB`));
      }
      if (size > max * 2) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
