// How to add Glitchless to a game, for an agent that has this MCP server (the hosted one at api.glitchless.gg/mcp, or
// glitchless-mcp) and no Glitchless skill: someone who connected Glitchless in claude.ai or ChatGPT, opened a coding
// agent in their game's folder and said "Set up Glitchless for my game in this folder". glitchless_create_game's
// engine and files (tools/workspace.js) answer with the instrument skill cut to the game's engine: where the game
// sends, the skill's settings, that engine's reference with the sections of other references it points to, and the
// game's own metrics. glitchless_dashboard's guide (tools/dashboard.js) answers with the dashboard skill. The text is
// skills.js, the copy scripts/sync-agent-plugin.mjs writes from plugin/glitchless/skills, so every server carries it
// and nothing is fetched. This file only shapes text: the tools look up the game and the connection.
import path from 'node:path';
import { TEXTS } from './skills.js';

const INSTRUMENT = 'plugin/glitchless/skills/instrument/SKILL.md';
const REFS = 'plugin/glitchless/skills/instrument/references/';
const DASHBOARD = 'plugin/glitchless/skills/dashboard/SKILL.md';
const REPO = 'https://github.com/glitchless-gg/glitchless';
const KIT = 'git clone --depth 1 https://github.com/glitchless-gg/glitchless ~/.glitchless';

// The engines, one per reference, in the order of the skill's own table: { id: 'godot', name: 'Godot', ref }.
export const ENGINES = [...new Set([...TEXTS[INSTRUMENT].matchAll(/\]\(references\/(\w+)\.md\)/g)].map((m) => m[1]))]
  .filter((id) => TEXTS[`${REFS}${id}.md`])
  .map((id) => ({ id, name: TEXTS[`${REFS}${id}.md`].match(/^# (.+)$/m)[1], ref: `${REFS}${id}.md` }));

// What an engine's steps need beyond its reference: where its SDK is in the agent kit (a clone of the Glitchless repo
// the references copy from), and for Godot the parts of the addon's README its reference sends the agent to (not
// "Web exports": the reference has what differs there, and the kit has the whole README).
const EXTRAS = {
  godot: { kit: 'godot/addons/glitchless', readme: { path: 'godot/addons/glitchless/README.md', parts: ['Install', 'Use', 'Off in debug builds', "The player's off switch", 'For agents: `--glitchless-measure`'] } },
  unreal: { kit: 'unreal/Plugins/Glitchless' },
  roblox: { kit: 'roblox' },
  gamemaker: { kit: 'gamemaker' },
};

// The signs of each engine in a project's files and package.json dependencies, a native engine's first: its project
// file wins over a package.json kept for tooling. A Reddit app (Devvit Web) comes before them all: its steps (the
// relay) lead, and the engine its client is made with follows (a web game's package, or a Unity or Godot web build).
const SIGNS = [
  ['reddit', /(^|\/)devvit\.(json|yaml)$|^@devvit\/(web|server|client|start)$|^devvit$/],
  ['unreal', /\.uproject$/],
  ['godot', /(^|\/)project\.godot$|\.pck$/],
  ['gamemaker', /\.yyp$/],
  ['unity', /(^|\/)(projectsettings(\/projectversion\.txt)?|projectversion\.txt|packages\/manifest\.json|assembly-csharp\.csproj)$|\.unity(web)?$/],
  ['roblox', /\.project\.json$|(^|\/)wally\.toml$|\.rbxlx?$|\.(server|client)\.luau?$/],
  ['threejs', /^(three|@react-three\/fiber|three(\.module)?(\.min)?\.js)$/],
  ['phaser', /^phaser((\.min)?\.js)?$/],
  ['babylon', /^(@babylonjs\/core|babylonjs|babylon(\.max)?\.js)$/],
  ['playcanvas', /^playcanvas((-stable)?(\.min)?\.js)?$/],
];

// → { engine, sign, also }: the engine a list of files and dependencies names, the entry that named it, and any other
// engine they name too.
export function engineFrom(files = []) {
  const found = new Map();
  for (const raw of files) {
    const file = String(raw).trim().toLowerCase().replace(/\\/g, '/').replace(/^["'`]+|["'`,]+$/g, '');
    const dep = file.match(/^(@?[^@\s:"']+)/)?.[1] ?? file;
    for (const [id, sign] of SIGNS) if (!found.has(id) && [file, dep, path.posix.basename(dep)].some((f) => sign.test(f))) found.set(id, String(raw).trim());
  }
  const [engine, ...also] = SIGNS.map(([id]) => id).filter((id) => found.has(id));
  return { engine: engine ?? null, sign: engine ? found.get(engine) : null, also };
}

// The engine a call names (engine) or its files do: { engine: one of ENGINES or null, sign, also: other engines' names }.
// An engine named with files that name a Reddit app is that app's client: Reddit's steps, then the engine's.
export function pickEngine({ engine, files } = {}) {
  let found = engine ? { engine, sign: null, also: [] } : engineFrom(files);
  const app = engine && engine !== 'reddit' ? engineFrom(files) : null;
  if (app?.engine === 'reddit') found = { engine: 'reddit', sign: app.sign, also: [engine] };
  return { engine: ENGINES.find((e) => e.id === found.engine) ?? null, sign: found.sign, also: found.also.map((id) => ENGINES.find((e) => e.id === id)).filter(Boolean) };
}

// ── Markdown ──────────────────────────────────────────────────────

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const slug = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const body = (md) => md.replace(/^---\n[\s\S]*?\n---\n+/, '');
const nameOf = (p) => TEXTS[p].match(/^# (.+)$/m)?.[1] ?? p;
const resolve = (from, href) => path.posix.normalize(path.posix.join(path.posix.dirname(from), href));

// A file's sections, one per heading outside code: { level, title, slug, text (to the next heading at its level or
// above), intro (to the next heading of any level) }.
function sections(md) {
  const lines = md.split('\n');
  const heads = [];
  let code = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    const m = !code && line.match(/^(#{1,6}) (.+)$/);
    if (m) heads.push({ i, level: m[1].length, title: m[2].trim() });
  });
  return heads.map((h, n) => ({
    level: h.level,
    title: h.title,
    slug: slug(h.title),
    text: lines.slice(h.i, heads.slice(n + 1).find((x) => x.level <= h.level)?.i ?? lines.length).join('\n').trimEnd(),
    intro: lines.slice(h.i, heads[n + 1]?.i ?? lines.length).join('\n').trimEnd(),
  }));
}

// The sections of other files a text points to (Phaser's "as for Three.js, step 4b"), and the ones those point to:
// [{ file, sections }] in each file's own order. `own` are the files the guide carries whole.
function borrowed(from, text, own) {
  const want = new Map();
  const queue = [[from, text]];
  while (queue.length) {
    const [src, md] = queue.shift();
    for (const [, , href] of md.matchAll(LINK)) {
      const [file, hash] = href.split('#');
      if (!file || !hash || /^[a-z]+:/i.test(href)) continue;
      const target = resolve(src, file);
      if (own.has(target) || !TEXTS[target] || want.get(target)?.has(hash)) continue;
      const s = sections(TEXTS[target]).find((x) => x.slug === hash);
      if (!s) continue;
      want.set(target, (want.get(target) ?? new Set()).add(hash));
      queue.push([target, s.text]);
    }
  }
  return [...want].map(([file, slugs]) => ({ file, sections: sections(TEXTS[file]).filter((s) => slugs.has(s.slug)) }));
}

// Links in a text from `from`: one to a file or section the guide carries becomes its words ("As for Three.js"), or
// its heading where the words are a file name; any other goes to GitHub (the agent has no copy of the repo to follow a
// relative link into).
function relink(text, from, carried) {
  return text.replace(LINK, (all, label, href) => {
    if (/^[a-z]+:/i.test(href)) return all;
    const [file, hash = ''] = href.split('#');
    const target = file ? resolve(from, file) : from;
    if (!carried.has(target) && !carried.has(`${target}#${hash}`)) return `[${label}](${REPO}/blob/main/${target}${hash ? `#${hash}` : ''})`;
    if (!/\.md$/.test(label)) return label;
    return `the "${(hash && sections(TEXTS[target]).find((s) => s.slug === hash)?.title) || nameOf(target)}" part of this guide`;
  });
}

// ── The guides ────────────────────────────────────────────────────

// Where the game sends, as the tool found it for this connection:
//   { cloud: true, workspace, intake, game: { name, client_token } or null, others: [names], can_make, blocked, dashboard }
//     Glitchless Cloud, signed in to a workspace: the game the call made or named, or how to get one (blocked: why
//     the game the call named couldn't be made, such as a plan with no room for another);
//   { server: url }  a Glitchless server somewhere else, which this MCP server reads with no workspace;
//   { local: url }   a Glitchless server on this computer.
function sending(where, engine, again = `engine: "${engine.id}"`) {
  const head = '## Where this game sends\n\nThese go where the steps below put the intake URL and client token (their examples show a local server, http://localhost:7777 and gl_pub_dev).';
  const pub = "It's public and can only send data, so it may live in the game's source. A key that starts gl_sk_ or gl_ws_ never goes in the game.";
  if (where.cloud) {
    const here = where.others?.length ? ` Games already here: ${where.others.join(', ')}; to set one of those up, pass game with its name instead.` : '';
    const token = where.game
      ? where.game.client_token
        ? `${where.game.client_token} (${where.game.name}'s). ${pub}`
        : `${where.game.name} has no active client token: ask the person to make one in Glitchless (${where.dashboard ?? 'the dashboard'}, Settings → Keys & access).`
      : where.blocked
        ? `none yet: the game wasn't made (${where.blocked.replace(/\.$/, '')}).${where.others?.length ? ` If this game is one already here (${where.others.join(', ')}), call glitchless_create_game again with game set to its name and ${again}, and the steps come with its client token. Otherwise tell the person why, and ask which they want.` : ' Tell the person why.'}`
        : where.can_make
        ? `none yet. Call glitchless_create_game again with name (the game's name, as players know it) and ${again}: it makes the game and returns these steps with its client token.${here}`
        : `none yet, and this connection may only read, so it can't make the game: ask the person to add it in Glitchless (${where.dashboard ?? 'the dashboard'}), then call this again with game set to its name. Or they connect again with "Create games and share links" ticked.${here}`;
    return [
      head,
      '',
      `Glitchless Cloud${where.workspace ? `, workspace ${where.workspace}` : ''}:`,
      `- intake URL: ${where.intake}`,
      `- client token: ${token}`,
      `- In this server's tools, name the game: game: "${where.game?.name ?? "<the game's name>"}".`,
    ].join('\n');
  }
  if (where.server) {
    return [head, '', `- intake URL: ${where.server}, the Glitchless server this MCP server reads`, `- client token: the game's public one (gl_pub_…): one of that server's GLITCHLESS_CLIENT_TOKENS, or on Glitchless Cloud the one on the game's page in Glitchless. Ask the person for it. ${pub}`].join('\n');
  }
  return [
    head,
    '',
    `This MCP server reads a Glitchless server on this computer (${where.local}) and isn't signed in to Glitchless Cloud.`,
    "- If the person uses Glitchless Cloud (app.glitchless.gg), sign this server in first: glitchless_sign_in (they approve a code in the browser), or `npx -y glitchless-mcp login` in a terminal. Then call glitchless_create_game again, with the game's name and the engine, for the cloud's intake URL and the game's client token.",
    `- Otherwise: intake URL ${where.local}, client token gl_pub_dev. Check that ${where.local}/v1/health answers. If it doesn't, start a server: with Docker, \`docker run -d --name glitchless -p 7777:7777 -v glitchless-data:/data ghcr.io/glitchless-gg/glitchless\` (\`docker start glitchless\` if that container exists); without, in the agent kit (\`${KIT}\`), \`npm install && npm run build\`, then \`npm run server\` in the background.`,
  ].join('\n');
}

// An engine's steps: where the game sends, getting the SDK, the skill's opening and settings with the engine table
// cut to this game, the engine's own reference (with, for Godot, the README parts it sends the agent to), what it
// borrows from other references, and the skill's last sections (the game's own metrics, a jam room, the report).
// picked: what pickEngine answered; where: sending()'s.
export function instrumentGuide({ engine: picked, sign, also = [] }, where) {
  // A game in a Reddit post: Reddit's steps (the relay), then those of the engine its client is made with, if known.
  const reddit = picked.id === 'reddit' ? picked : null;
  const engine = reddit ? (also.find((e) => e.id !== 'reddit') ?? null) : picked;
  if (reddit) also = also.filter((e) => e !== engine);
  const lead = reddit ?? engine;
  const extras = (engine && EXTRAS[engine.id]) ?? {};
  const [top, settings, ...rest] = sections(body(TEXTS[INSTRUMENT])).filter((s) => s.level <= 2);
  const ref = engine ? body(TEXTS[engine.ref]) : '';
  const readme = extras.readme ? sections(TEXTS[extras.readme.path]).filter((s) => extras.readme.parts.includes(s.title)) : [];
  const own = [INSTRUMENT, ...(reddit ? [reddit.ref] : []), ...(engine ? [engine.ref] : [])];
  const lent = engine ? borrowed(engine.ref, ref, new Set(own)) : [];
  const carried = new Set([...own, ...readme.map((s) => `${extras.readme.path}#${s.slug}`), ...lent.flatMap((b) => b.sections.map((s) => `${b.file}#${s.slug}`))]);

  // The skill's table of every engine becomes the one line about this game.
  const lines = settings.text.split('\n');
  const table = lines.findIndex((l) => l.startsWith('|'));
  const end = lines.findIndex((l, i) => i > table && !l.startsWith('|'));
  const order = [...(reddit ? [`"${nameOf(reddit.ref)}"`] : []), ...(readme.length ? ["the addon's README"] : []), ...(engine ? [`"${nameOf(engine.ref)}"`] : [])];
  const what = reddit ? `a game in a Reddit post${engine ? `, its client made with ${engine.name}` : ''}` : engine.name;
  if (table >= 0) lines.splice(table, end - table, `This game: ${what}${sign ? ` (${sign})` : ''}. Its steps follow these settings${order.length > 1 ? `: ${order.slice(0, -1).join(', ')} first, then ${order.at(-1)}` : `, under ${order[0]}`}.`);

  const out = [
    `# Add Glitchless to this ${reddit ? `${reddit.name}${engine ? ` (${engine.name})` : ''}` : engine.name} game`,
    '',
    `These are the steps of Glitchless's instrument skill, the one in the Glitchless plugin for Claude Code, Codex and Cursor, cut to ${reddit ? `a game in a Reddit post${engine ? ` made with ${engine.name}` : ''}` : engine.name}. Work through them in order, in the game's folder. Where they say to follow the \`dashboard\` skill, call glitchless_dashboard with guide: true.`,
    '',
    sending(where, lead, reddit && engine ? `engine: "${engine.id}" and files: ["devvit.json"]` : undefined),
  ];
  if (extras.kit) {
    out.push('', '## Get the SDK', '', `The ${engine.name} steps copy files from the Glitchless agent kit, a copy of the Glitchless repo kept outside the game's folder so it never gets committed. Get it first:`, '', '```bash', KIT, '```', '', `If ~/.glitchless is already there, run \`git -C ~/.glitchless pull\` instead. The ${engine.name} SDK is at ~/.glitchless/${extras.kit}${extras.readme ? `, with its whole README, which the ${engine.name} steps quote below` : ''}.`);
  }
  out.push('', relink(top.intro, INSTRUMENT, carried), '', relink(lines.join('\n'), INSTRUMENT, carried));
  if (reddit) out.push('', relink(body(TEXTS[reddit.ref]), reddit.ref, carried));
  // The README comes before the reference, as the skill's table orders them: it installs the addon and wires the game.
  if (readme.length) {
    out.push('', `# From the ${engine.name} addon's README`, '', `Start here: the parts of ~/.glitchless/${extras.readme.path} that install the addon and wire it into the game. The "${nameOf(engine.ref)}" steps after them add the rest; the file itself has more (Steam, flags, errors, phones).`);
    // "Use" without its subsections: the reference below has the ones that matter, in fewer words.
    for (const s of readme) out.push('', relink(s.title === 'Use' ? s.intro : s.text, extras.readme.path, carried));
  }
  if (engine) out.push('', relink(ref, engine.ref, carried));
  for (const b of lent) {
    out.push('', `# From the ${nameOf(b.file)} steps`, '', `The ${engine.name} steps above point here.`);
    for (const s of b.sections) out.push('', relink(s.text, b.file, carried));
  }
  for (const s of rest) out.push('', relink(s.text, INSTRUMENT, carried));
  if (also.length) out.push('', `(The files also name ${also.map((e) => e.name).join(' and ')}. If this game is made with that instead, call glitchless_create_game again with engine: "${also[0].id}".)`);
  return out.join('\n');
}

// Before the engine is known: the skill's table of what to look for, with each engine's id.
export function findEngine(files) {
  const rows = sections(body(TEXTS[INSTRUMENT])).find((s) => s.level === 2).text.split('\n').filter((l) => l.startsWith('|'));
  const table = rows.map((row, i) => {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const id = i === 0 ? 'engine:' : i === 1 ? '---' : `\`${cells[2].match(/references\/(\w+)\.md/)?.[1]}\``;
    return `| ${cells[0]} | ${cells[1]} | ${id} |`;
  });
  return [
    files?.length ? `None of these names an engine Glitchless has an SDK for: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}. Nothing was made.\n` : '',
    "To add Glitchless to a game, find its engine first. In the game's folder, look for:",
    '',
    ...table,
    '',
    'Then call glitchless_create_game again with engine, or with files: the names of the files at the project\'s root and its package.json dependencies (for example ["project.godot"], or ["package.json", "phaser", "vite"]).',
    '',
    `Glitchless has SDKs for these engines only. For a game made with something else, tell the person so; a game can still send the wire format itself (${REPO}/blob/main/docs/SPEC.md#2-wire-format).`,
  ].join('\n').trimStart();
}

// The dashboard skill, with the references it sends the agent to.
export function dashboardGuide() {
  const refs = Object.keys(TEXTS).filter((p) => p.startsWith(`${path.posix.dirname(DASHBOARD)}/references/`));
  const carried = new Set([DASHBOARD, ...refs]);
  return [
    "# Design this game's Glitchless dashboard",
    '',
    "These are the steps of Glitchless's dashboard skill, the one in the Glitchless plugin, with its references after it. The game should send data first: if it doesn't, call glitchless_create_game with game and engine for the steps that add Glitchless to it.",
    '',
    relink(body(TEXTS[DASHBOARD]), DASHBOARD, carried),
    ...refs.flatMap((p) => ['', relink(body(TEXTS[p]), p, carried)]),
  ].join('\n');
}
