// The organiser's side of a jam room, for the glitchless_jam_host tool (tool.js) and the CLI's host commands (cli.js)
// alike: make a room, change, end and delete it, take a game out, set the survey people answer when the jam ends (by
// hand or from a template), keep survey templates, and read the snapshot. Each answers { text, data }: what happened in
// plain words, and the server's answer. The server decides who organises (resolveOrganiser); a maker's key is refused.

import { request, normalRoom } from './context.js';

const when = (t) => (t == null ? '' : new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const duration = (min) => (min < 60 ? plural(min, 'minute') : `${plural(Math.floor(min / 60), 'hour')}${min % 60 ? ` ${plural(min % 60, 'minute')}` : ''}`);

// A template's id from its name, as the server makes a room's game names: "Meetup, longer" → "meetup-longer".
export const templateId = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

export async function createRoom(c, { title, about, hours, max_games, template } = {}) {
  if (!title) throw new Error('a room needs a title, such as "GenAI DC mini jam"');
  const body = { title, ...(about ? { about } : {}), ...(hours != null ? { hours: Number(hours) } : {}), ...(max_games != null ? { max_games: Number(max_games) } : {}), ...(template ? { template } : {}) };
  const r = await request(c, 'POST', '/v1/rooms', { body });
  const text = `Made room ${r.code}: "${r.title}", on until ${when(r.closes_at)}. Open the big screen on the projector: ${r.links.live}

  Big screen, for the projector: ${r.links.live}
  Arcade, where everyone plays:  ${r.links.arcade}
  Join page, for makers:         ${r.links.join}

The arcade's QR code, for people to open it on their phones:

${r.qr_text}

Makers add glitchless-jam to their agent (claude mcp add glitchless-jam -- npx -y glitchless-jam) and tell it to join room ${r.code}. The survey people answer when the jam ends is ${template && template !== 'default' ? `from the template ${template}` : 'the default one'}.`;
  return { text, data: r };
}

export async function listRooms(c) {
  const { rooms, past } = await request(c, 'GET', '/v1/rooms');
  const lines = [];
  if (!rooms.length && !past.length) lines.push('No jam rooms yet: create makes one.');
  if (rooms.length) lines.push('Your jam rooms:');
  for (const r of rooms) lines.push(`  ${r.code}  "${r.title}": ${r.ended ? `ended ${when(r.ended_at)}` : `on until ${when(r.closes_at)}`}, ${plural(r.games.length, 'game')} published, ${r.games_joined} joined. Arcade: ${r.links.arcade}`);
  if (past.length) lines.push('Past jams, whose snapshots stay (report reads one):');
  for (const s of past) lines.push(`  ${s.code}  "${s.title}": ended ${when(s.ended_at)}, ${plural(s.games, 'game')}`);
  return { text: lines.join('\n'), data: { rooms, past } };
}

// { title?, about?, hours? (closes that many hours from now), joining? }
export async function updateRoom(c, room, { title, about, hours, joining } = {}) {
  const code = normalRoom(room);
  const body = { ...(title != null ? { title } : {}), ...(about != null ? { about } : {}), ...(hours != null ? { closes_at: Date.now() + Number(hours) * 3600e3 } : {}), ...(joining != null ? { joining } : {}) };
  if (!Object.keys(body).length) throw new Error('give what to change: title, about, hours (it closes that many hours from now) or joining');
  const r = await request(c, 'PATCH', `/v1/rooms/${code}`, { body });
  return { text: `Room ${code} is "${r.title}", on until ${when(r.closes_at)}, ${r.joining ? 'taking new games' : 'not taking new games (the games already in it still publish)'}.`, data: r };
}

export async function endRoom(c, room) {
  const code = normalRoom(room);
  const r = await request(c, 'PATCH', `/v1/rooms/${code}`, { body: { end: true } });
  const live = await request(c, 'GET', `/v1/rooms/${code}/live`, { anon: true });
  const lines = [`Ended "${r.title}" (${code}): publishing and voting have stopped. The big screen shows the awards and the survey's QR code now: ${r.links.live}`];
  for (const a of live.awards ?? []) lines.push(`  ${a.title}: ${a.text}`);
  lines.push(`The survey is open for 7 days at ${r.links.survey}. The room and its games are deleted 24 hours after the end; its snapshot (report) stays.`);
  return { text: lines.join('\n'), data: { room: r, awards: live.awards ?? [] } };
}

// game: its slug (the end of its link), or its title as the arcade shows it.
export async function removeGame(c, room, game) {
  const code = normalRoom(room);
  if (!game) throw new Error('name the game: its title on the arcade, or the end of its link');
  const want = String(game).trim();
  const { games } = await request(c, 'GET', `/v1/rooms/${code}`, { anon: true });
  const hit = games.find((g) => g.slug === want.toLowerCase()) ?? games.find((g) => g.title.toLowerCase() === want.toLowerCase());
  const slug = hit?.slug ?? want.toLowerCase();
  await request(c, 'DELETE', `/v1/rooms/${code}/games/${encodeURIComponent(slug)}?by=organiser`);
  return { text: `Took ${hit ? `"${hit.title}" (${slug})` : slug} out of room ${code} for good: it's off the arcade and the big screen, its files are deleted, and it can't join again.`, data: { room: code, removed: slug } };
}

export async function deleteRoom(c, room) {
  const code = normalRoom(room);
  const out = await request(c, 'DELETE', `/v1/rooms/${code}`);
  return { text: `Deleted room ${code}: its games, their files, the votes, the survey's answers and the snapshot are gone.`, data: out };
}

// The questions as a list in words: "1. How was the jam? (1 to 5)".
const questionLines = (questions) => questions.map((q, i) => `  ${i + 1}. ${q.text} (${q.kind === 'scale' ? '1 to 5' : q.kind === 'choice' ? q.options.join(' / ') : 'written'})`);

// The room's survey. changes: { heading?, intro?, questions? (null: the default ones), template? }; with none, it only
// shows the survey as people will see it.
export async function roomSurvey(c, room, changes = {}) {
  const code = normalRoom(room);
  const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  if (set.template != null && Object.keys(set).length > 1) throw new Error('set the survey from a template, or by hand (heading, intro, questions), not both at once');
  if (Object.keys(set).length) await request(c, 'PATCH', `/v1/rooms/${code}/survey`, { body: set });
  const [arcade, s] = await Promise.all([request(c, 'GET', `/v1/rooms/${code}`, { anon: true }), request(c, 'GET', `/v1/rooms/${code}/survey`, { anon: true })]);
  const how = set.template != null ? `Set the survey for "${arcade.title}" (${code}) from the template ${set.template}.` : Object.keys(set).length ? `Set the survey for "${arcade.title}" (${code}).` : `The survey for "${arcade.title}" (${code}).`;
  const lines = [`${how} People see it at ${arcade.links.survey} ${s.open ? `until ${when(s.closes_at)}` : s.closes_at ? `(closed ${when(s.closes_at)})` : 'once the jam ends'}, and the big screen shows its QR code then:`, '', `  ${s.heading}`];
  if (s.intro) lines.push(`  ${s.intro}`);
  lines.push(...questionLines(s.questions), '', 'It can change until its first answer.');
  return { text: lines.join('\n'), data: { room: code, link: arcade.links.survey, open: s.open, heading: s.heading, intro: s.intro, questions: s.questions } };
}

export async function listTemplates(c) {
  const { templates } = await request(c, 'GET', '/v1/rooms/templates');
  const lines = ['Survey templates (a room takes one when it is made, or later with survey):'];
  for (const t of templates) lines.push(`  ${t.id}: "${t.name}", ${plural(t.questions.length, 'question')}, heading "${t.heading}"${t.builtin ? ' (built in)' : ''}`);
  return { text: lines.join('\n'), data: { templates } };
}

// { id? (default: from the name), name, heading?, intro?, questions?, from_room? (take that room's survey) }
export async function saveTemplate(c, { id, name, heading, intro, questions, from_room } = {}) {
  const slug = id || templateId(name);
  if (!slug) throw new Error('give the template a name, such as "Meetup"');
  const body = { name, ...(heading !== undefined ? { heading } : {}), ...(intro !== undefined ? { intro } : {}), ...(questions != null ? { questions } : {}), ...(from_room ? { from_room: normalRoom(from_room) } : {}) };
  const t = await request(c, 'PUT', `/v1/rooms/templates/${encodeURIComponent(slug)}`, { body });
  const lines = [`Saved the survey template ${t.id} ("${t.name}")${from_room ? `, from room ${normalRoom(from_room)}'s survey` : ''}. Make a room with it (template "${t.id}"), or set a room's survey from it:`, '', `  ${t.heading}`];
  if (t.intro) lines.push(`  ${t.intro}`);
  lines.push(...questionLines(t.questions ?? []));
  return { text: lines.join('\n'), data: t };
}

export async function deleteTemplate(c, id) {
  if (!id) throw new Error('give the id of the template to delete (templates lists them)');
  const out = await request(c, 'DELETE', `/v1/rooms/templates/${encodeURIComponent(id)}`);
  return { text: `Deleted the survey template ${id}. Rooms made with it keep their surveys.`, data: out };
}

// What the survey's answers add up to: a scale's average, a choice's counts, how many wrote an answer.
function answerLines(questions, answers) {
  return questions.map((q) => {
    const given = answers.map((a) => a.answers?.[q.id]).filter((v) => v != null && v !== '');
    if (!given.length) return `  ${q.text}: no answers`;
    if (q.kind === 'scale') return `  ${q.text}: ${Math.round((given.reduce((n, v) => n + v, 0) / given.length) * 10) / 10} on average (1 to 5), from ${plural(given.length, 'answer')}`;
    if (q.kind === 'choice') return `  ${q.text}: ${q.options.map((o) => `${o} ${given.filter((v) => v === o).length}`).join(', ')}`;
    return `  ${q.text}: ${plural(given.length, 'written answer')} (in the JSON)`;
  });
}

// The snapshot in plain words first: how long it ran, the games' funnel, plays and votes, the awards, the survey.
export async function roomReport(c, room) {
  const code = normalRoom(room);
  const snap = await request(c, 'GET', `/v1/rooms/${code}/snapshot`);
  const live = snap.games.filter((g) => !g.removed);
  const f = snap.funnel;
  const plays = live.reduce((n, g) => n + g.numbers.plays, 0);
  const minutes = live.reduce((n, g) => n + g.numbers.minutes_played, 0);
  const removed = snap.games.length - live.length;
  const answers = snap.survey.answers ?? [];
  const lines = [
    `"${snap.title}" (${snap.code}) ran ${duration(snap.minutes)} and ended ${when(snap.ended_at)}.`,
    `Games: ${f.joined} joined, ${f.published} published, ${f.sending} had plays, ${f.improved} published a second version, and ${f.fixed} had fewer problems in a later version${removed ? ` (${removed} taken out)` : ''}.`,
    `${plural(plays, 'play')} in all, ${plural(minutes, 'minute')} played. ${plural(snap.votes.voters, 'person', 'people')} voted.`,
    `Awards: ${snap.awards.map((a) => `${a.title}: ${a.text}`).join('. ')}.`,
    `Survey: ${plural(answers.length, 'answer')}${Date.now() < snap.survey.closes_at ? `, open until ${when(snap.survey.closes_at)}` : ', closed'}.`,
    ...(answers.length ? answerLines(snap.survey.questions, answers) : []),
  ];
  return { text: lines.join('\n'), data: snap };
}
