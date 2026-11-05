// glitchless-jam's command line: signing in, publishing a build from a terminal (the same publish as the maker's
// tool), and the organiser's host commands (the same as the glitchless_jam_host tool; host.js).
//
//   npx -y glitchless-jam login | whoami | logout
//   npx -y glitchless-jam publish <dir> --room K7Q2M [--game <name>] [--version v] [--title t] [--by name] [--service s]
//   npx -y glitchless-jam host create "Title" [--hours 24] [--about …] [--max-games 60] [--template id]
//   npx -y glitchless-jam host list | update CODE … | end CODE | remove CODE GAME | delete CODE | report CODE [--csv]
//   npx -y glitchless-jam host survey CODE [--template id] [--heading …] [--intro …] [--file questions.json]
//   npx -y glitchless-jam host template list | save <id> --name … [--file …] [--heading …] [--intro …] [--from-room CODE] | delete <id>

import fs from 'node:fs';
import { connect, normalRoom, request, roomFor } from './context.js';
import * as host from './host.js';
import { signInCli } from './login.js';
import { publishBuild } from './publish.js';

const USAGE = `glitchless-jam: Glitchless jam rooms, for makers' agents and organisers.

  npx -y glitchless-jam                        the MCP server, for an agent:
                                               claude mcp add glitchless-jam -- npx -y glitchless-jam
  npx -y glitchless-jam login | whoami | logout
                                               sign in to Glitchless Cloud (the same sign-in as glitchless-mcp)
  npx -y glitchless-jam publish <dir> --room K7Q2M [--game name] [--version v] [--title t] [--by name] [--service s]
                                               publish a built game to a room

Organisers:
  npx -y glitchless-jam host create "Title" [--hours 24] [--about text] [--max-games 60] [--template id]
  npx -y glitchless-jam host list
  npx -y glitchless-jam host update K7Q2M [--title t] [--about text] [--hours h] [--joining on|off]
  npx -y glitchless-jam host end K7Q2M
  npx -y glitchless-jam host remove K7Q2M <game>
  npx -y glitchless-jam host delete K7Q2M
  npx -y glitchless-jam host survey K7Q2M [--template id] [--heading text] [--intro text] [--file questions.json]
  npx -y glitchless-jam host template list
  npx -y glitchless-jam host template save <id> --name "Name" [--file template.json] [--heading text] [--intro text] [--from-room K7Q2M]
  npx -y glitchless-jam host template delete <id>
  npx -y glitchless-jam host report K7Q2M [--csv]

GLITCHLESS_URL and GLITCHLESS_API_KEY name a self-hosted server and its key; GLITCHLESS_ROOM a default room.`;

const BOOLEAN = new Set(['csv', 'no-browser', 'help']);

// "--name value" flags and the words around them.
function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args.push(a);
    else if (BOOLEAN.has(a.slice(2))) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return { args, flags };
}

// → the exit code.
export async function cli(argv, { out = console.log, err = console.error, env = process.env } = {}) {
  const [command, ...rest] = argv;
  if (['login', 'whoami', 'logout'].includes(command)) return signInCli(command, rest, { out, err, env });
  const { args, flags } = parse(rest);
  if (!command || command === 'help' || command === '--help' || command === '-h' || flags.help) {
    out(USAGE);
    return command ? 0 : 1;
  }
  const c = connect(env);
  try {
    if (command === 'publish') return await publish(c, args, flags, { out, err, env });
    if (command === 'host') return await hostCommand(c, args, flags, { out });
    err(`glitchless-jam: no command "${command}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    err(`glitchless-jam: ${e.message}`);
    return 1;
  }
}

async function publish(c, args, flags, { out, err, env }) {
  const dir = args[0];
  if (!dir) throw new Error('give the built folder: glitchless-jam publish dist --room K7Q2M');
  const room = roomFor(c, flags.room, env);
  const done = await publishBuild(c, room, dir, { version: flags.version, service: flags.service, game: flags.game, title: flags.title, by: flags.by, log: out });
  out(`\nPublished "${done.title}" ${done.version} to room ${room}:\n\n  ${done.url}\n\n${done.qr_text}\n\nScan it to play on a phone. Everyone plays the room's games at ${done.arcade}`);
  if (done.sourcemaps.sent.length) out(`Source maps sent to Glitchless (not to the room): ${done.sourcemaps.sent.join(', ')}`);
  for (const w of done.warnings) err(`Warning: ${w}`);
  return 0;
}

// A survey or template from a JSON file: a list of questions, or { name?, heading?, intro?, questions? }.
function surveyFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.code === 'ENOENT' ? 'no such file' : `not JSON (${e.message})`}`);
  }
  if (Array.isArray(parsed)) return { questions: parsed };
  if (!parsed || typeof parsed !== 'object') throw new Error(`${file}: give a list of questions, or { name, heading, intro, questions }`);
  return { name: parsed.name, heading: parsed.heading, intro: parsed.intro, questions: parsed.questions };
}

function onOff(v) {
  if (v == null) return undefined;
  if (/^(on|yes|true)$/i.test(v)) return true;
  if (/^(off|no|false)$/i.test(v)) return false;
  throw new Error('--joining is on or off');
}

async function hostCommand(c, [sub, ...args], flags, { out }) {
  const print = ({ text }) => (out(text), 0);
  if (sub === 'create') {
    if (!args[0]) throw new Error('give the room a title: glitchless-jam host create "GenAI DC mini jam"');
    return print(await host.createRoom(c, { title: args[0], about: flags.about, hours: flags.hours, max_games: flags['max-games'], template: flags.template }));
  }
  if (sub === 'list') return print(await host.listRooms(c));
  if (sub === 'template') {
    const [what, id] = args;
    if (what === 'list') return print(await host.listTemplates(c));
    if (what === 'delete') return print(await host.deleteTemplate(c, id));
    if (what === 'save') {
      const file = flags.file ? surveyFile(flags.file) : {};
      return print(await host.saveTemplate(c, { id, name: flags.name ?? file.name, heading: flags.heading ?? file.heading, intro: flags.intro ?? file.intro, questions: file.questions, from_room: flags['from-room'] }));
    }
    throw new Error('host template takes list, save <id> --name … or delete <id>');
  }
  const code = normalRoom(args[0]);
  if (sub === 'update') return print(await host.updateRoom(c, code, { title: flags.title, about: flags.about, hours: flags.hours, joining: onOff(flags.joining) }));
  if (sub === 'end') return print(await host.endRoom(c, code));
  if (sub === 'remove') {
    if (!args[1]) throw new Error(`name the game: glitchless-jam host remove ${code} <game> (its title on the arcade, or the end of its link)`);
    return print(await host.removeGame(c, code, args.slice(1).join(' ')));
  }
  if (sub === 'delete') return print(await host.deleteRoom(c, code));
  if (sub === 'survey') {
    const file = flags.file ? surveyFile(flags.file) : {};
    return print(await host.roomSurvey(c, code, { heading: flags.heading ?? file.heading, intro: flags.intro ?? file.intro, questions: file.questions, template: flags.template }));
  }
  if (sub === 'report') {
    const snap = await request(c, 'GET', `/v1/rooms/${code}/snapshot${flags.csv ? '?format=csv' : ''}`, { text: flags.csv });
    out(flags.csv ? snap.trimEnd() : JSON.stringify(snap, null, 2));
    return 0;
  }
  throw new Error(`host takes create, list, update, end, remove, delete, survey, template or report.\n\n${USAGE}`);
}
