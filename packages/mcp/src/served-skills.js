// The Glitchless skills over MCP's Skills extension (io.modelcontextprotocol/skills, SEP-2640): a client that loads
// skills from its MCP servers lists them with skills/list and reads their files as skill:// resources, so an agent
// connected to the hosted server or to glitchless-mcp gets the skills the Claude Code plugin carries, without the
// plugin. Claude Code shows them as /<server>:<skill> (/glitchless:triage; a claude.ai connector's as
// /claude_ai_Glitchless:triage). The text and the list of skills are skills.js, the copy
// scripts/sync-agent-plugin.mjs writes from plugin/glitchless/skills, so the hosted server reads nothing from disk.
//
// A connection is served the skills whose tools it has (SKILLS: instrument needs manage, dashboard the dashboard
// scope) and, only on this computer, the ones that act on it (deck). Every set a connection can get is built once,
// when this module loads, and serves every server createServer() builds (one per HTTP request): a catalog keeps each
// file's size and digest, which clients check every file they read against. Clients without the extension never ask
// for skills, and get the same text from glitchless_create_game's engine and glitchless_dashboard's guide.
//
// The skills never hold the tools up: if the SDK refuses a skill, or a later SDK changed how catalogs load or attach,
// the server serves none and says why on stderr.
import { SKILLS, TEXTS } from './skills.js';

const FROM = 'plugin/glitchless/skills/';
const SCOPES = ['read', 'dashboard', 'manage'];

// The skills a connection is served: remote and scopes as createServer's.
export function skillsFor({ remote = false, scopes = null } = {}, skills = SKILLS) {
  return Object.entries(skills)
    .filter(([, s]) => s.scope && !(remote && s.local) && (!scopes || scopes.includes(s.scope)))
    .map(([name]) => name);
}

// A set of skills' files, keyed by their path in the skills folder ("triage/SKILL.md").
const filesOf = (skills, texts) =>
  Object.fromEntries(
    Object.entries(texts)
      .filter(([p]) => skills.some((s) => p.startsWith(`${FROM}${s}/`)))
      .map(([p, text]) => [p.slice(FROM.length), text]),
  );

const warn = (what, err, log = console.error) => log(`glitchless-mcp: serving no skills: ${what}: ${err?.problems?.map((p) => `${p.path}: ${p.message}`).join('; ') || err?.message || err}`);

// Every set a connection can be served, by its skills' names (here and remote, with every combination of scopes), as
// a catalog: Map { 'instrument,dashboard,triage' → catalog }. strict: a skill the extension would otherwise skip with a
// warning fails the load (the sync script refuses one first). Any failure gives an empty Map and a warning, never a
// throw.
export async function buildCatalogs({ skills = SKILLS, texts = TEXTS, log } = {}) {
  const catalogs = new Map();
  try {
    // Imported here, so an SDK without the extension serves no skills rather than stopping the server loading.
    const { SkillsExtension, memorySkillFiles } = await import('@modelcontextprotocol/server/ext/skills');
    const sets = new Map();
    for (const remote of [false, true])
      for (const scopes of [null, ...Array.from({ length: 2 ** SCOPES.length }, (_, n) => SCOPES.filter((_, i) => n & (1 << i)))]) {
        const set = skillsFor({ remote, scopes }, skills);
        if (set.length) sets.set(set.join(), set);
      }
    for (const [key, set] of sets) catalogs.set(key, await SkillsExtension.load(memorySkillFiles(filesOf(set, texts)), { strict: true }));
  } catch (err) {
    catalogs.clear();
    warn('the skills did not load', err, log);
  }
  return catalogs;
}
const catalogs = await buildCatalogs();

// The skills a server built with these options serves: { uri, frontmatter, resources }, as skills/list answers.
export const skillEntries = (options) => catalogs.get(skillsFor(options).join())?.entries ?? [];

// Serves a connection's skills on its server, before it connects. They never change while it runs, so it says no
// resource-list changes come (attaching would say they do): as with tools (createServer), a client that is promised
// them opens a stream and waits on it. A connection with no skills to serve gets no extension and no resources.
export function serveSkills(server, options = {}, { from = catalogs, log } = {}) {
  const catalog = from.get(skillsFor(options).join());
  if (!catalog) return;
  try {
    server.server.registerCapabilities({ resources: { listChanged: false } });
    catalog.attach(server);
  } catch (err) {
    warn('attaching them failed', err, log);
  }
}
