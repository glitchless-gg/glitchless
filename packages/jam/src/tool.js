// The jam's MCP server, with two tools. glitchless_jam is for a maker's agent: it joins a room, publishes the game's
// build (publish.js) or links a version played on itch.io, says how the room and the game are doing, and leaves. glitchless_jam_host is for the jam's
// organiser (host.js): make a room, change, end and delete it, take a game out, set the survey, keep survey templates
// and read the snapshot. The server decides who organises, so a maker's key gets "not an organiser" from the second.
//
// Replies follow glitchless-mcp's: a first line in plain words, then the data as JSON. Errors come back as isError
// with the server's own message.

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VERSION, JamError, connect, request, gameFor, gameIn, remember, roomFor } from './context.js';
import { joinRoom, linkGame, publishBuild } from './publish.js';
import * as host from './host.js';

export function reply(title, data) {
  return { content: [{ type: 'text', text: `${title}\n\n${JSON.stringify(data, null, 2)}` }] };
}

export function fail(err) {
  return { content: [{ type: 'text', text: `Glitchless error: ${err.message}` }], isError: true };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const until = (t) => {
  const min = Math.max(0, Math.round((t - Date.now()) / 60_000));
  return min < 120 ? plural(min, 'minute') : `${Math.round(min / 60)} hours`;
};

const DESCRIPTION = [
  'Take part in a Glitchless jam room as a maker. The organiser shares a room code of 5 letters and digits, like K7Q2M.',
  'action "join": joins the room with this game (room; title and by are what the arcade shows; service is the name the game passes to Glitchless.init; with a Glitchless Cloud sign-in, game names the workspace game).',
  'action "publish": checks the built folder (dir: what the build makes, such as dist, built with relative paths, `vite build --base ./`) and uploads it, joining the room first if needed. It answers with the game\'s link, its version and a QR code drawn in text: show the person the link and the QR code, so they can play it on their phone. Each publish needs a new version: bump the one passed to Glitchless.init before publishing a fix. A build is at most 25 MB, 400 files and 4 MB a file.',
  'action "link": for a game played on its itch.io page (an online jam\'s games usually are), instead of publishing: registers a version, joining the room first if needed. Nothing is uploaded: the room counts that version\'s plays from now, and its arcade sends players to the page. First export the game for the web, zip the folder with index.html at the root of the zip, and have the person upload it to the game\'s itch.io page as HTML5 (kind of project: HTML, played in the browser); then link it with url, the page (https://<name>.itch.io/<game>, nothing after it: no other site, not the itch.zone frame, not a draft\'s secret link; later links reuse it), and version, the one the game passes to Glitchless.init (read from dir, the export\'s folder, when it\'s in its scripts; Godot and Unity exports need it given). Each link needs a new version. The game must send to a Glitchless address its players can reach (Glitchless Cloud, or a server on the internet), never localhost. A game either publishes its builds or links them, not both.',
  'Publishing and linking: at most 60 versions a game in a room and 12 an hour, until the jam ends.',
  'action "status": the room\'s games and their plays, which games need players, and this game\'s plays by version with the share that hit a problem; after the jam ends, the awards and the survey link to give the person.',
  'action "leave": takes the game out of the room.',
  'The tool remembers the room and the game after join, publish or link. To find what hurt players in a version, use glitchless-mcp\'s glitchless_triage and glitchless_compare_versions where they are connected.',
].join(' ');

const SCHEMA = {
  action: z.enum(['join', 'publish', 'link', 'status', 'leave']).describe('What to do: join the room, publish a build, link a version played on itch.io, read the status, or leave'),
  room: z.string().optional().describe('The room code the organiser shared, like K7Q2M (default: the room last joined, or GLITCHLESS_ROOM)'),
  dir: z.string().optional().describe('publish: the built folder, such as dist, relative to the working directory; link: the web export\'s folder, to read the version from'),
  url: z.string().optional().describe('link: the game\'s page on itch.io, https://<name>.itch.io/<game> (default: the page linked before)'),
  version: z.string().optional().describe('publish, link: the version (default: the one the build passes to Glitchless.init)'),
  game: z.string().optional().describe('With a Glitchless Cloud sign-in: the workspace game, by name or id (default: the only one)'),
  title: z.string().optional().describe('join, publish, link: the title the arcade shows (default: the page\'s title)'),
  by: z.string().optional().describe('join, publish, link: who made it, as the arcade shows it (a name or handle, never an email)'),
  service: z.string().optional().describe('join, publish, link: the service the game passes to Glitchless.init (default: the one in the build)'),
};

const HOST_DESCRIPTION = [
  "For a jam's organiser, not its makers: the server answers a maker's key with \"not an organiser\" (on Glitchless Cloud, organisers are allow-listed workspaces; on a self-hosted server, whoever holds its key).",
  'action "create" makes a room ({title, about?, hours?, max_games?, template?, online?}) and answers with its code, the arcade, big-screen and join links and the arcade\'s QR code as text: show the person the QR code, and open the big screen on the projector.',
  'online: true makes an online room, for a jam over days whose games are often on itch.io (makers link each version there with glitchless_jam): it runs up to 504 hours (21 days) instead of 168 (7 days), and stays 7 days after it ends instead of 1. It can\'t change later.',
  '"list" lists the organiser\'s rooms and past jams. "update" changes a room ({room, title?, about?, hours?: it closes that many hours from now, joining?: false stops new games joining}).',
  '"end" ends the jam now: publishing and voting stop, the awards are given and the survey opens. "remove_game" takes a game out for good ({room, game: its title or the end of its link}). "delete" deletes a room with its games, votes, survey answers and snapshot.',
  '"survey" sets the survey people answer when the jam ends ({room, template} or {room, heading?, intro?, questions?}; "{room}" in the heading or intro is the room\'s title; it can change until its first answer, even after the end), and with nothing to change shows it as people will see it.',
  '"templates" lists the organiser\'s survey templates (the built-in default first); "save_template" saves one ({id?, name, heading?, intro?, questions?, from_room?: copy a room\'s survey}); "delete_template" deletes one ({id}).',
  '"report" reads a jam\'s snapshot after it ends: the games, plays, awards and survey answers, in plain words and then as JSON.',
  'end, delete, remove_game and delete_template can\'t be undone: ask the person before using them.',
].join(' ');

const QUESTION = z.object({
  id: z.string().optional().describe('1 to 32 of a-z, 0-9 and _ (default q1, q2…)'),
  kind: z.enum(['scale', 'choice', 'text']).describe('scale: 1 to 5; choice: one of its options; text: written, up to 1,000 characters'),
  text: z.string().describe('The question, up to 200 characters'),
  options: z.array(z.string()).optional().describe('choice: 2 to 8 options'),
});

const HOST_SCHEMA = {
  action: z.enum(['create', 'list', 'update', 'end', 'remove_game', 'delete', 'survey', 'templates', 'save_template', 'delete_template', 'report']).describe('What to do (end, delete, remove_game and delete_template can\'t be undone)'),
  room: z.string().optional().describe('The room code, like K7Q2M (update, end, remove_game, delete, survey, report)'),
  title: z.string().optional().describe('create, update: the room\'s title, up to 80 characters'),
  about: z.string().optional().describe('create, update: a line about the jam for the arcade, up to 280 characters'),
  hours: z.number().optional().describe('create: how long the jam is on (default 24, at most 168, or 504 for an online room); update: it closes this many hours from now, up to 7 days (21 online) after the room was made'),
  online: z.boolean().optional().describe('create: an online jam over days, whose games may be linked on itch.io: up to 21 days, kept 7 days after the end'),
  max_games: z.number().int().optional().describe('create: the most games the room takes (default 60, up to 200)'),
  template: z.string().optional().describe('create, survey: the survey template to use, by id ("default" is the built-in one)'),
  joining: z.boolean().optional().describe('update: false stops new games joining; the games already in the room still publish'),
  game: z.string().optional().describe('remove_game: the game, by its title on the arcade or the end of its link'),
  heading: z.string().optional().describe('survey, save_template: the survey\'s heading, up to 120 characters; "{room}" is the room\'s title'),
  intro: z.string().optional().describe('survey, save_template: a line under the heading, up to 400 characters ("" removes it)'),
  questions: z.array(QUESTION).nullable().optional().describe('survey, save_template: 1 to 10 questions (survey: null puts back the default ones)'),
  id: z.string().optional().describe('save_template, delete_template: the template\'s id, 1 to 32 of a-z, 0-9 and - (save_template: default, from the name)'),
  name: z.string().optional().describe('save_template: the template\'s name, up to 60 characters'),
  from_room: z.string().optional().describe('save_template: copy this room\'s survey as it is set now'),
};

const HOST_ACTIONS = {
  create: (c, a) => host.createRoom(c, a),
  list: (c) => host.listRooms(c),
  update: (c, a) => host.updateRoom(c, a.room, a),
  end: (c, a) => host.endRoom(c, a.room),
  remove_game: (c, a) => host.removeGame(c, a.room, a.game),
  delete: (c, a) => host.deleteRoom(c, a.room),
  survey: (c, a) => host.roomSurvey(c, a.room, { heading: a.heading, intro: a.intro, questions: a.questions, template: a.template }),
  templates: (c) => host.listTemplates(c),
  save_template: (c, a) => host.saveTemplate(c, a),
  delete_template: (c, a) => host.deleteTemplate(c, a.id),
  report: (c, a) => host.roomReport(c, a.room),
};

// A server with both tools. connection: what every call runs with (default: from the environment and the saved
// sign-in, read on each call, so a sign-in in a terminal works without a restart).
export function createServer({ connection = null, env = process.env } = {}) {
  const server = new McpServer(
    { name: 'glitchless-jam', title: 'Glitchless jam', version: VERSION, websiteUrl: 'https://www.glitchless.gg' },
    { instructions: "glitchless_jam joins a Glitchless jam room, publishes the game's build to it (or, for a game on itch.io, links each version) and answers with a link and a QR code to show the person, and reads how the room's games are doing. glitchless_jam_host is for the jam's organiser: making and ending rooms, the survey and the report. Players play the games from the room's arcade on their phones, and the room counts their plays." },
  );
  // Each call runs with a fresh connection that names the MCP client (x-glitchless-client).
  const run = (fn) => async (args = {}) => {
    const c = connection ?? connect(env, { client: 'mcp' });
    const client = server.server.getClientVersion?.()?.name;
    if (client) c.client = client;
    try {
      return await fn(c, args);
    } catch (err) {
      return fail(err);
    }
  };
  server.registerTool(
    'glitchless_jam',
    {
      title: 'Jam room',
      description: DESCRIPTION,
      inputSchema: z.object(SCHEMA),
      // Publishing puts the game on a public link, and leaving deletes its files from the room.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run((c, args) => ACTIONS[args.action](c, args, env)),
  );
  server.registerTool(
    'glitchless_jam_host',
    {
      title: 'Host a jam room',
      description: HOST_DESCRIPTION,
      inputSchema: z.object(HOST_SCHEMA),
      // Annotations are the tool's, not each action's: end, delete, remove_game and delete_template destroy, and a
      // room's pages are public.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run(async (c, args) => {
      const { text, data } = await HOST_ACTIONS[args.action](c, args);
      return reply(text, data);
    }),
  );
  return server;
}

const ACTIONS = {
  async join(c, args, env) {
    const room = roomFor(c, args.room, env);
    const entry = await joinRoom(c, room, { game: args.game, title: args.title, by: args.by, service: args.service });
    const last = entry.uploads?.at(-1);
    const head = last
      ? entry.site
        ? `In room ${room} with "${entry.title}" (${entry.slug}), linked as ${last.version}: it plays on ${entry.site} at ${entry.url}. Link again with a new version after a fix.`
        : `In room ${room} with "${entry.title}" (${entry.slug}), published as ${last.version}: it plays at ${entry.url}. Publish again with a new version after a fix.`
      : entry.online
        ? `Joined room ${room} with "${entry.title}" (${entry.slug}), an online jam. If the game is on itch.io: export it for the web, zip the folder for the person to upload to its itch.io page as HTML5, then link that version (action "link", url: the page). Or build it with relative paths (\`vite build --base ./\`) and publish the build's folder: it will play at ${entry.url}.`
        : `Joined room ${room} with "${entry.title}" (${entry.slug}). Build the game with relative paths (\`vite build --base ./\`), then publish the build's folder: it will play at ${entry.url}.`;
    return reply(head, { room, slug: entry.slug, title: entry.title, by: entry.by, url: entry.url, site: entry.site ?? null, service: entry.service, published: (entry.uploads ?? []).map((u) => u.version), links: entry.links, online: entry.online === true, ended: entry.ended });
  },

  async publish(c, args, env) {
    if (!args.dir) throw new JamError('Give dir: the folder the build makes, such as dist.');
    const room = roomFor(c, args.room, env);
    const out = await publishBuild(c, room, args.dir, { version: args.version, service: args.service, game: args.game, title: args.title, by: args.by });
    const head = [
      `Published "${out.title}" ${out.version} to room ${room}. Show the person this link and the QR code below, so they can play it on their phone:`,
      out.url,
      '',
      out.qr_text,
      '',
      `Everyone plays the room's games from its arcade: ${out.arcade}`,
      ...out.warnings.map((w) => `Warning: ${w}`),
      'Before publishing a fix, bump the version passed to Glitchless.init, so the room can tell the versions apart.',
    ].join('\n');
    return reply(head, { room, slug: out.slug, title: out.title, url: out.url, version: out.version, upload: out.n, arcade: out.arcade, qr_svg: out.qr_svg, files: out.files, bytes: out.bytes, service: out.service, sourcemaps: out.sourcemaps, warnings: out.warnings });
  },

  async link(c, args, env) {
    const room = roomFor(c, args.room, env);
    const out = await linkGame(c, room, { url: args.url, version: args.version, dir: args.dir, service: args.service, game: args.game, title: args.title, by: args.by });
    const head = [
      `Linked "${out.title}" ${out.version} in room ${room}: the room counts players' plays of ${out.version} from now, and its arcade sends them to ${out.url}. Show the person the link to the arcade: ${out.arcade}`,
      ...out.warnings.map((w) => `Warning: ${w}`),
      'Before linking a fix, bump the version passed to Glitchless.init, export and zip it again, have the person upload it to the same itch.io page, then link the new version.',
    ].join('\n');
    return reply(head, { room, slug: out.slug, title: out.title, url: out.url, site: out.site, version: out.version, n: out.n, arcade: out.arcade, qr_svg: out.qr_svg, service: out.service, warnings: out.warnings });
  },

  async status(c, args, env) {
    const room = roomFor(c, args.room, env);
    const live = await request(c, 'GET', `/v1/rooms/${room}/live`, { anon: true });
    const r = live.room;
    const lines = [];
    const t = live.totals;
    lines.push(`Room "${r.title}" (${room}): ${r.ended ? 'the jam has ended' : `on, closes in ${until(r.closes_at)}`}. ${plural(t.games, 'game')} published, ${t.building} still building, ${plural(t.plays, 'play')} in all${t.playing_now ? `, ${t.playing_now} playing now` : ''}.`);
    const titleOf = (slug) => live.games.find((g) => g.slug === slug)?.title ?? slug;
    const playsOf = (slug) => live.games.find((g) => g.slug === slug)?.plays ?? 0;
    if (!r.ended && live.needs_players.length) lines.push(`Need players most: ${live.needs_players.slice(0, 3).map((s) => `${titleOf(s)} (${plural(playsOf(s), 'play')})`).join(', ')}.`);

    // This computer's own game, from its maker's view: its plays by version and the share that hit a problem.
    const mine = gameIn(c, room);
    let yours = null;
    if (!mine) lines.push(`This computer hasn't joined room ${room}: join it or publish to it, and status shows the game's plays here.`);
    else {
      try {
        const ws = await gameFor(c, args.game || mine.project);
        const g = await request(c, 'GET', `/v1/rooms/${room}/games/${encodeURIComponent(mine.slug)}`, { project: ws?.id });
        const n = g.numbers;
        const versions = n.versions.map((v) => ({ version: v.version, plays: v.plays, with_problem: v.with_problem, problem_pct: v.plays ? Math.round((v.with_problem / v.plays) * 100) : null, problems: v.problems }));
        yours = { slug: g.slug, title: g.title, url: g.url, site: g.site ?? null, version: g.version, uploads: g.uploads.map((u) => ({ n: u.n, version: u.version, published_at: iso(u.published_at), files: u.files, bytes: u.bytes, ...(u.link ? { link: u.link } : {}) })), plays: n.plays, players: n.players, minutes_played: n.minutes_played, phone_plays: n.phone_plays, by_version: versions };
        if (!g.uploads.length) lines.push(`Your game "${g.title}" has joined but isn't published yet: publish its build${g.online ? ', or link its version on itch.io' : ''}.`);
        else {
          const byVersion = versions.map((v) => `${v.version}: ${plural(v.plays, 'play')}${v.plays ? `, ${v.with_problem ? `${v.with_problem} hit a problem (${v.problem_pct}%)` : 'none hit a problem'}` : ''}`).join('; ');
          lines.push(`Your game "${g.title}" (${g.url}): ${plural(n.plays, 'play')}${n.players != null ? ` by ${plural(n.players, 'player')}` : ''}, ${plural(n.minutes_played, 'minute')} played. By version: ${byVersion}.`);
        }
      } catch (err) {
        if (err.status !== 404 && err.status !== 403) throw err;
        lines.push(`Your game "${mine.slug}" isn't in room ${room} any more (${err.message}).`);
        remember(c, { room, slug: null, project: mine.project });
      }
    }

    if (r.ended) {
      if (live.awards?.length) lines.push(`Awards: ${live.awards.map((a) => `${a.title}: ${a.text}`).join('. ')}.`);
      lines.push(`The survey asks everyone how the jam went, for 7 days: give the person this link, ${r.links.survey}`);
    }
    return reply(lines.join('\n'), {
      room: { code: r.code, title: r.title, ended: r.ended, closes_at: iso(r.closes_at), ended_at: iso(r.ended_at), links: r.links },
      totals: t,
      games: live.games.map((g) => ({ slug: g.slug, title: g.title, by: g.by, url: g.url, version: g.version, plays: g.plays, players: g.players, minutes_played: g.minutes_played, phone_plays: g.phone_plays, playing_now: g.playing_now, ...(g.votes != null ? { votes: g.votes } : {}) })),
      needs_players: live.needs_players,
      most_played: live.most_played,
      yours,
      ...(r.ended ? { awards: live.awards ?? [], survey: r.links.survey } : {}),
    });
  },

  async leave(c, args, env) {
    const room = roomFor(c, args.room, env);
    const mine = gameIn(c, room);
    if (!mine) throw new JamError(`This computer has no game in room ${room} to take out.`);
    const ws = await gameFor(c, args.game || mine.project);
    await request(c, 'DELETE', `/v1/rooms/${room}/games/${encodeURIComponent(mine.slug)}`, { project: ws?.id });
    remember(c, { room, slug: null, project: mine.project });
    return reply(`Took "${mine.slug}" out of room ${room}: it's off the arcade and its files are deleted. Publishing to the room again joins it again.`, { room, removed: mine.slug });
  },
};
