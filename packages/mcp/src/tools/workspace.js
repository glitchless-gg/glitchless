// A workspace's games, for an agent signed in with a workspace key (glitchless_sign_in, or `glitchless-mcp login`):
// sign in, create a game, and make or revoke share links. Listing games, reading any of them and saving their
// dashboards are the other tools, with `game`.
import { z } from 'zod';
import { server, BASE, isWorkspace, agent, workspaceGames, projectFor, resolveService, reply, fail, useCredentials, readCredentials } from '../context.js';
import { startSignIn, CLOUD_URL } from '../login.js';

const act = (name, description, inputSchema, handler, annotations = {}) =>
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: false, ...annotations } }, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err);
    }
  });

let signingIn = null;

act(
  'glitchless_sign_in',
  "Connect this agent to a Glitchless Cloud workspace, so it can create games, read any of them, design their dashboards and make share links. Returns a link and a code: show both to the person and ask them to approve it in the browser. Then call this tool again (or any other) — once it's approved, this server uses the workspace key right away, and keeps it for later sessions.",
  { url: z.string().optional().describe(`The Glitchless API (default ${CLOUD_URL})`) },
  async ({ url }) => {
    if (isWorkspace()) {
      const c = readCredentials();
      return reply(`Already signed in to ${c?.workspace?.name ?? 'a workspace'} on ${BASE}.`, { games: (await workspaceGames(true)).map((g) => g.name) });
    }
    if (signingIn?.done) {
      const c = signingIn.done;
      signingIn = null;
      useCredentials(c);
      return reply(`Signed in to ${c.workspace?.name ?? 'the workspace'} (${c.scopes.join(', ')}).`, { games: (await workspaceGames(true)).map((g) => g.name) });
    }
    if (signingIn?.error) {
      const err = signingIn.error;
      signingIn = null;
      throw err;
    }
    if (signingIn) return reply(`Still waiting for approval. Ask the person to open ${signingIn.verification_url} and approve the code ${signingIn.user_code}.`, {});
    const started = await startSignIn({ url: url || (BASE.includes('localhost') ? CLOUD_URL : BASE) });
    signingIn = { verification_url: started.verification_url, user_code: started.user_code };
    started.wait().then(
      (c) => {
        signingIn = { ...signingIn, done: c };
        useCredentials(c);
      },
      (err) => (signingIn = { ...signingIn, error: err }),
    );
    return reply(`Ask the person to open this link and approve the code ${started.user_code}:\n${started.verification_url}\nThe code works for 10 minutes. This server switches to the workspace as soon as it's approved.`, {});
  },
  { openWorldHint: true },
);

act(
  'glitchless_create_game',
  "Create a game in the signed-in workspace. Returns its client token (gl_pub_…, the public key game builds send with) and the intake URL to put in the game's Glitchless.init; the instrument skill says where for each engine. Later calls can name it with game.",
  { name: z.string().describe("The game's name, as players know it") },
  async ({ name }) => {
    const made = await agent('POST', '/games', { name });
    await workspaceGames(true);
    await projectFor(made.game.id);
    return reply(`Created ${made.game.name}. Initialise Glitchless with this client token and intake:`, made);
  },
);

act(
  'glitchless_share_board',
  "Make a read-only share link to one board page of a game: for a dev log, Discord, a publisher, or a game's own \"Live stats\" link. Anyone with it sees that board and nothing else, signed out. No expiry unless days is set; sums (revenue, totals) show only with sums: true. The link is shown once.",
  {
    service: z.string().optional().describe("The game's service (default: its most recently active one)"),
    page: z.string().describe("The board page's id (glitchless_dashboard lists them)"),
    name: z.string().optional().describe('What the link is for, e.g. "Dev log"'),
    days: z.number().optional().describe('Expire after 1, 7, 30, 90 or 365 days'),
    sums: z.boolean().optional().describe('Show sums such as revenue'),
  },
  async ({ service, page, name, days, sums, game }) => {
    const pid = await projectFor(game);
    const svc = await resolveService(service);
    const out = await agent('POST', `/games/${pid}/shares`, { service: svc, page, name, days, sums: sums === true });
    return reply(`Share link to ${svc}'s "${page}" page (shown once):\n${out.url}`, out.share);
  },
);

act(
  'glitchless_list_share_links',
  "A game's share links: which page each shows, when it expires, and whether it's revoked.",
  {},
  async ({ game }) => {
    const pid = await projectFor(game);
    return reply('Share links:', (await agent('GET', `/games/${pid}/shares`)).shares);
  },
  { readOnlyHint: true },
);

act(
  'glitchless_revoke_share_link',
  'Revoke a share link: it stops working at once, for everyone who has it.',
  { id: z.string().describe("The link's id from glitchless_list_share_links") },
  async ({ id, game }) => {
    const pid = await projectFor(game);
    await agent('DELETE', `/games/${pid}/shares/${encodeURIComponent(id)}`);
    return reply(`Revoked ${id}.`, {});
  },
  { destructiveHint: true },
);
