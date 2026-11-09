// A workspace's games, for an agent signed in with a workspace key (glitchless_sign_in, `glitchless-mcp login`, or
// OAuth over HTTP): sign in, create, set up or rename a game, make, list and revoke share links, mark findings known
// and the team's own play as testers, resolve errors, and read and change a game's alerts. Listing games, reading any
// of them and saving their dashboards are the other tools, with `game`.
import { z } from 'zod';
import { define, base, isWorkspace, agent, workspaceGames, workspaceIntake, projectFor, resolveService, reply, useCredentials, readCredentials } from '../context.js';
import { startSignIn, CLOUD_URL } from '../login.js';
import { ENGINES, pickEngine, instrumentGuide, findEngine } from '../setup-guide.js';

// A tool that needs the manage scope. opts: { title, annotations, scope, local }.
const act = (name, description, inputSchema, handler, { title, annotations, ...opts } = {}) => define(name, { title, description, inputSchema, annotations }, handler, { scope: 'manage', ...opts });

let signingIn = null;

act(
  'glitchless_sign_in',
  "Connect this agent to a Glitchless Cloud workspace, so it can create games, read any of them, design their dashboards and make share links. Returns a link and a code: show both to the person and ask them to approve it in the browser. Then call this tool again (or any other) — once it's approved, this server uses the workspace key right away, and keeps it for later sessions.",
  { url: z.string().optional().describe(`The Glitchless API (default ${CLOUD_URL})`) },
  async ({ url }) => {
    if (isWorkspace()) {
      const c = readCredentials();
      return reply(`Already signed in to ${c?.workspace?.name ?? 'a workspace'} on ${base()}.`, { games: (await workspaceGames(true)).map((g) => g.name) });
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
    const started = await startSignIn({ url: url || (base().includes('localhost') ? CLOUD_URL : base()) });
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
  // Over HTTP the person signs in with OAuth before any tool runs, so this one is for stdio only.
  { title: 'Sign in', annotations: { openWorldHint: true }, scope: 'read', local: true },
);

// The game a workspace already has under a name, however it's capitalised.
const named = (list, name) => list.find((g) => g.name.trim().toLowerCase() === String(name).trim().toLowerCase());
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// glitchless_create_game with engine or files: the steps that add Glitchless to a game's code for its engine
// (setup-guide.js), with where this connection's game sends. The game is the one the call makes (name), one already
// in the workspace (name or game), or none yet, and then the steps say how to get its client token. Nothing is made
// until the engine is known. Without a workspace (the open-source server), the steps name that server.
async function setUp({ name, engine, files, game }) {
  const picked = pickEngine({ engine, files });
  if (!picked.engine) return text(findEngine(files));
  if (!isWorkspace()) return text(instrumentGuide(picked, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base()) ? { local: base() } : { server: base() }));
  const [list, who] = await Promise.all([workspaceGames(true), agent('GET', '/whoami').catch(() => null)]);
  const canMake = !who || who.scopes?.includes('manage');
  let hit = null;
  let lead = '';
  let blocked = null;
  if (name) {
    hit = named(list, name) ?? null;
    if (hit) lead = `${hit.name} is already in this workspace, so nothing was made: these steps use its client token.`;
    else if (canMake) {
      // The Free plan has room for one game, and many people name theirs on the connect page under another name
      // than their agent picks. The steps still come, saying why and which games are here.
      try {
        const made = await agent('POST', '/games', { name });
        await workspaceGames(true);
        hit = { id: made.game.id, name: made.game.name, client_token: made.client_token };
        lead = `Created ${made.game.name}.`;
      } catch (err) {
        blocked = err.message;
        lead = `${name} wasn't made: ${blocked}`;
      }
    }
  } else if (game) {
    const pid = await projectFor(game);
    hit = list.find((g) => g.id === pid) ?? null;
  }
  if (hit?.demo) throw new Error(`${hit.name} is the demo game: sample play, with no code to add Glitchless to. Give the person's own game (name for a new one, game for one already here)`);
  // Later calls keep the game.
  if (hit) await projectFor(hit.id);
  const where = {
    cloud: true,
    workspace: who?.workspace?.name ?? null,
    intake: workspaceIntake() ?? who?.intake ?? base(),
    game: hit ? { name: hit.name, client_token: hit.client_token } : null,
    others: list.filter((g) => !g.demo).map((g) => g.name),
    can_make: canMake,
    blocked,
    dashboard: who?.dashboard ?? null,
  };
  return text(`${lead ? `${lead}\n\n` : ''}${instrumentGuide(picked, where)}`);
}

act(
  'glitchless_create_game',
  "Create a game in the signed-in workspace, or set one up: call this first when asked to set up, add or install Glitchless (or performance monitoring, analytics or telemetry with it) in a game, before changing the game's code. Returns the game's client token (gl_pub_…, the public key game builds send with) and the intake URL to put in the game's Glitchless.init. With engine, or with files (what you find in the game's folder, when you don't know the engine), it also returns the steps that add Glitchless to the game's code for that engine, with the intake URL and client token in them: getting the SDK, privacy, levels and events, the game's own metrics, bug reports, the player's off switch, multiplayer, and checking that data arrives. They are the instrument skill of the Glitchless plugin, for an agent without it, up to 50,000 characters. Give name for a new game or game for one already in the workspace; with neither, the steps say how to get a client token, and when files name no engine nothing is made and the answer says what to look for. On a server with no workspace (the open-source server), the steps name that server. A name that's already in the workspace returns that game, not a second one. Later calls can name it with game. With demo: true it makes the demo game instead: Zoomies with a week of sample play (findings, levels, errors, sessions and a dashboard), for trying every tool before a real game sends data. A workspace has one demo game, and it takes no room from the plan's games. With rename (and game naming which one), renames a game instead, as players know it (a jam game renamed before release): the dashboard, share links and emails show the new name, and its client token, its service (what the game sends as service in Glitchless.init) and its data stay as they are, so the game's code needn't change. Later calls name it by its new name. Ask the person before renaming their game.",
  {
    name: z.string().optional().describe("The game's name, as players know it (not needed with demo). One already in the workspace is returned, not made again"),
    demo: z.boolean().optional().describe('Make the demo game, with a week of sample play'),
    rename: z.string().optional().describe("Instead of making a game: the new name (60 characters at most) of the game that game names"),
    engine: z.enum(ENGINES.map((e) => e.id)).optional().describe("Also return the steps that add Glitchless to the game's code, for its engine: unity, godot, unreal, threejs (React Three Fiber too), roblox, phaser, babylon, playcanvas or gamemaker"),
    files: z.array(z.string()).max(500).optional().describe("Or, when you don't know the engine: what you find in the game's folder, which names it. File names at its root (project.godot, MyGame.uproject, Game.yyp, ProjectSettings/ProjectVersion.txt, default.project.json, package.json) and package.json dependencies (three, phaser, @babylonjs/core, playcanvas)"),
  },
  async ({ name, demo, rename, engine, files, game }) => {
    if (rename != null) {
      if (name || demo || engine || files) throw new Error('rename renames the game that game names; leave out name, demo, engine and files');
      const pid = await projectFor(game);
      const before = (await workspaceGames()).find((g) => g.id === pid)?.name ?? pid;
      const { game: renamed } = await agent('PATCH', `/games/${pid}`, { name: rename });
      await workspaceGames(true);
      return reply(`Renamed ${before} to ${renamed.name}. Later calls name it game: "${renamed.name}"; its client token and service are unchanged.`, renamed);
    }
    if (engine || files) {
      if (demo) throw new Error("the demo game is sample play, with no code to add Glitchless to: leave out demo, and give the person's own game (name for a new one, game for one already here)");
      return setUp({ name, engine, files, game });
    }
    if (!demo && !name) throw new Error("give the game's name, or demo: true for the demo game");
    // The game the person named on the connect page is the one to send to: a second game of the same name would
    // take the data and leave theirs empty.
    const here = demo ? null : named(await workspaceGames(true), name);
    if (here) {
      await projectFor(here.id);
      return reply(`${here.name} is already in this workspace, so nothing was made. Initialise Glitchless with its client token and intake (engine or files add the steps for the game's engine); a second game needs a name of its own:`, { game: { id: here.id, name: here.name, ...(here.demo ? { demo: true } : {}) }, client_token: here.client_token, intake: workspaceIntake(), dashboard: here.dashboard });
    }
    const made = await agent('POST', '/games', demo ? { demo: true } : { name }).catch(async (err) => {
      // A plan with no room for another game (Free has one): name the ones here, since the game is often among them.
      const others = demo ? [] : (await workspaceGames().catch(() => [])).filter((g) => !g.demo).map((g) => g.name);
      throw new Error(`${err.message}${others.length ? ` Games already here: ${others.join(', ')}. To add Glitchless to one of them, call this with game set to its name and engine (or files).` : ''}`);
    });
    await workspaceGames(true);
    await projectFor(made.game.id);
    if (demo) return reply(`Made the demo game, ${made.game.name}: a week of sample play from Zoomies, readable a few minutes from now. Then try glitchless_triage on it.`, made);
    return reply(`Created ${made.game.name}. Initialise Glitchless with this client token and intake (call again with game: "${made.game.name}" and engine, or files, for the steps for its engine):`, made);
  },
  { title: 'Create, set up or rename game', annotations: { destructiveHint: false, idempotentHint: false } },
);

act(
  'glitchless_share_links',
  "A game's read-only share links to its boards: for a dev log, Discord, a publisher, or a game's own \"Live stats\" link. With page: makes one to that board page, which anyone with it sees, and nothing else, signed out; no expiry unless days is set; sums (revenue, totals) show only with sums: true; the link is shown once. With revoke: that link stops working at once, for everyone who has it. With neither: lists them, with the page each shows, when it expires, when it was last opened (to about ten minutes) and whether it's revoked. Ask the person before making or revoking one.",
  {
    page: z.string().optional().describe("Make a link to this board page (glitchless_dashboard lists their ids)"),
    service: z.string().optional().describe("With page: the game's service (default: its most recently active one)"),
    name: z.string().optional().describe('With page: what the link is for, e.g. "Dev log"'),
    days: z.number().optional().describe('With page: expire after 1, 7, 30, 90 or 365 days'),
    sums: z.boolean().optional().describe('With page: show sums such as revenue'),
    revoke: z.string().optional().describe("Revoke the link with this id (from the list)"),
  },
  async ({ page, service, name, days, sums, revoke, game }) => {
    const pid = await projectFor(game);
    if (page && revoke) throw new Error('make a link (page) or revoke one (revoke), not both at once');
    if (revoke) {
      await agent('DELETE', `/games/${pid}/shares/${encodeURIComponent(revoke)}`);
      return reply(`Revoked ${revoke}: it stopped working for everyone who has it.`, {});
    }
    if (!page) return reply('Share links:', (await agent('GET', `/games/${pid}/shares`)).shares);
    const svc = await resolveService(service);
    const out = await agent('POST', `/games/${pid}/shares`, { service: svc, page, name, days, sums: sums === true });
    return reply(`Share link to ${svc}'s "${page}" page (shown once):\n${out.url}`, out.share);
  },
  // A link is public, signed out (it publishes beyond the workspace), and revoking one ends it for everyone.
  { title: 'Share links', annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true } },
);

act(
  'glitchless_mark_known',
  "Mark a standing finding as known, so the weekly summary email stops listing it: the game's owner has looked at it and accepts it (a slow first launch they chose, a freeze they can't avoid). glitchless_triage still shows it, after the rest, with `known` and the note. finding is a finding's id from glitchless_triage, or the start of one (\"perf-level-tutorial_1_\" covers those levels). until (YYYY-MM-DD) brings it back the day after; until_worse brings it back if it gets a quarter worse than over the last 7 days (its severity, the share of sessions it hits or its key number), and needs the finding to show now. clear: true removes the mark. Without finding, lists the game's known findings. Only the person's say-so makes a finding known: ask before marking one. Needs an Owner's or Admin's key, as alert settings do. With player or session instead of finding, marks the game's team's own play (the developer's playtest, a friend trying a build), so every read tool counts it as session type tester instead of user, its past sessions too: players' numbers, findings, the weekly summary, alerts and share links leave it out, and session_type \"tester\" finds it. player is the player_id glitchless_session gives (every session that player sent, before and after); session a session_id, for a game in anonymous mode (no player IDs). Ask the person first. With none of them, lists the known findings and the testers.",
  {
    finding: z.string().optional().describe('A finding id from glitchless_triage, e.g. "load-ttff", or the start of one, e.g. "perf-level-tutorial_1_"'),
    player: z.string().optional().describe("Or a player_id, from glitchless_session: that player's play is the team's own (a tester)"),
    session: z.string().optional().describe('Or a session_id (s_…): that one session is the team\'s own'),
    note: z.string().optional().describe('Why it is accepted, or who the tester is, in a few words (200 characters at most), e.g. "First launch compiles shaders; accepted" or "Me, playtesting on my laptop"'),
    until: z.string().optional().describe('YYYY-MM-DD: known through that day, listed again from the day after'),
    until_worse: z.boolean().optional().describe('Known only while it is no worse than it is now'),
    clear: z.boolean().optional().describe('Remove the mark: the weekly summary lists the finding again, or the tester\'s sessions count as they were sent'),
  },
  async ({ finding, player, session, note, until, until_worse, clear, game }) => {
    const pid = await projectFor(game);
    if ([finding, player, session].filter(Boolean).length > 1) throw new Error('mark a finding, a player or a session, one at a time');
    if (player || session) return markTester(pid, { player, session, note, clear });
    if (!finding) {
      const [{ known }, { testers }] = await Promise.all([agent('GET', `/games/${pid}/known`), agent('GET', `/games/${pid}/testers`)]);
      const lines = [
        known.length ? `${known.length} known finding(s), left out of the weekly summary.` : 'No known findings: the weekly summary lists every finding worth fixing.',
        testers.length ? `${testers.length} tester(s): their sessions read as session type tester in every tool, and players' numbers leave them out.` : "No testers marked: every session counts as its SDK sent it (a player's as user).",
      ];
      return reply(lines.join('\n'), { known, testers });
    }
    if (!clear && !note) throw new Error('say why it is known in note (a few words), or pass clear: true to remove the mark');
    const { known } = await agent('POST', `/games/${pid}/known`, clear ? { finding, clear: true } : { finding, note, until, until_worse });
    return reply(clear ? `${finding} is no longer known: the weekly summary lists it again when it is worth fixing.` : `Marked ${finding} as known. The weekly summary leaves it out; glitchless_triage shows it after the rest, with the note. Known findings:`, known);
  },
  // It replaces an entry's note, clear removes one, and a tester changes what every read tool counts as players.
  { title: 'Mark known', annotations: { destructiveHint: true, idempotentHint: true } },
);

// A player or session marked as (or cleared from) the team's own play, for glitchless_mark_known.
async function markTester(pid, { player, session, note, clear }) {
  const who = player ? `player ${player}` : `session ${session}`;
  const { testers } = await agent('POST', `/games/${pid}/testers`, { ...(player ? { player } : { session }), ...(clear ? { clear: true } : { note }) });
  if (clear) return reply(`Unmarked ${who}: its sessions count as they were sent again. Testers:`, testers);
  const e = testers.find((x) => (player ? x.player === player : x.session === session));
  return reply(`Marked ${who} as the team's own play: ${e?.sessions ?? 'its'} session(s) over the last 30 days, and any later ones, read as tester; players' numbers leave them out. Testers:`, testers);
}

act(
  'glitchless_resolve_error',
  "Resolve an error issue, as in Sentry: the game's owner has fixed it or accepts it (a GPU driver's error on test phones, one the newest build fixed). The Errors page hides it, glitchless_get_error lists it apart, and glitchless_triage, the overview and the weekly summary leave it out. It comes back by itself if players hit it again in a version later than the newest players had hit it in (any_version: in any version, the old builds included), first in the list and new to the new_error alert. Store test phones (Google Play runs each upload on its own before release), bots, testers and dev builds don't bring it back unless all_sessions is true. fingerprint is the issue's from glitchless_get_error or glitchless_triage (error-<fingerprint>), or the start of one. Resolving one again (one that came back) starts over from now. clear: true unresolves it. Without fingerprint, lists the game's resolved errors. Only the person's say-so resolves an error: ask before resolving one. Needs an Owner's or Admin's key, as alert settings do.",
  {
    fingerprint: z.string().optional().describe('The issue\'s fingerprint, e.g. "9803ec1a", or the start of one'),
    note: z.string().optional().describe('Why, in a few words (200 characters at most), e.g. "Google Play\'s test phones on SwiftShader"'),
    any_version: z.boolean().optional().describe('Come back if it fires again in any version, not only a later one'),
    all_sessions: z.boolean().optional().describe("Come back when any session fires it (store test phones, bots, testers, dev builds), not only a player's"),
    clear: z.boolean().optional().describe('Unresolve it'),
  },
  async ({ fingerprint, note, any_version, all_sessions, clear, game }) => {
    const pid = await projectFor(game);
    if (!fingerprint) {
      const { resolved } = await agent('GET', `/games/${pid}/resolved`);
      return reply(resolved.length ? `${resolved.length} resolved error(s), hidden on the Errors page and left out of triage until they come back:` : 'No resolved errors.', resolved);
    }
    const fp = fingerprint.replace(/^error-/, '');
    const { resolved } = await agent('POST', `/games/${pid}/resolved`, clear ? { fingerprint: fp, clear: true } : { fingerprint: fp, note, any_version, all_sessions });
    if (clear) return reply(`${fp} is open again: the Errors page and glitchless_triage show it.`, resolved);
    const e = resolved.find((x) => x.fingerprint.startsWith(fp));
    const who = e.all_sessions ? 'any session fires it' : 'a player hits it';
    return reply(`Resolved ${e.fingerprint}. It comes back if ${who} again ${e.any ? 'in any version' : e.version ? `in a version after ${e.version}` : 'at all'}. Resolved errors:`, resolved);
  },
  // Resolving again starts it over, and clear unresolves one.
  { title: 'Resolve error', annotations: { destructiveHint: true, idempotentHint: false } },
);

// What each alert rule tells the team (server/src/alerts.js ALERT_RULES).
const RULES = {
  crashes: 'more players crash in the last 6 hours than usual for those hours',
  new_error: 'a new error is spreading',
  release: 'the newest version stutters or crashes for more players than the one before',
  quiet: 'the game went quiet (and a note when sessions are back)',
  store: "a store limit that cuts the game's visibility (Google Play's bad-behaviour thresholds)",
  plan: "the plan's play sessions for the month reach 80% and 100%",
};

// A game's alert settings (GET /v1/agent/games/:game/alerts) in a few lines.
function alertLines({ alerts: a, log = [] }) {
  const channels = [a.webhook && `${a.webhook.format} webhook (${a.webhook.host}, ${a.webhook.hint})`, a.email && `email to ${a.emailRecipients} member(s)`].filter(Boolean);
  const rules = Object.keys(RULES).map((r) => `  ${a.rules[r] ? 'on ' : 'off'} ${r}: ${RULES[r]}`);
  const sent = log.slice(0, 5).map((x) => `  ${x.at ? new Date(x.at).toISOString().slice(0, 16).replace('T', ' ') : '?'} ${x.test ? '(test) ' : ''}${x.title} → ${(x.sent ?? []).map((s) => `${s.channel} ${s.ok ? 'ok' : `failed: ${s.error ?? '?'}`}`).join(', ') || 'nowhere'}`);
  return [
    `Alerts are ${a.on ? 'on' : 'off'}${a.on ? '' : channels.length ? ': every rule and the weekly summary are off' : ': nowhere to send yet (a webhook is added in Settings → Alerts; email: glitchless_set_alerts email: true)'}.`,
    `Channels: ${channels.join(' and ') || 'none'}.`,
    `Rules:\n${rules.join('\n')}`,
    `Weekly summary (Mondays, the findings worth fixing): ${a.weekly ? 'on' : 'off'}. Sessions counted: ${a.env ? `env ${a.env}` : 'any env'}. Known findings left out of it: ${a.known?.length ?? 0} (glitchless_mark_known); resolved errors: ${a.resolved?.length ?? 0} (glitchless_resolve_error).`,
    `Last sends:\n${sent.join('\n') || '  none yet'}`,
  ].join('\n');
}

define(
  'glitchless_alerts',
  {
    title: 'Alerts',
    description:
      "A game's alerts: where they go (a Discord or Slack webhook, email to the workspace's members), which rules are on (crashes, new_error, release, quiet, store, plan), the weekly summary of findings worth fixing, the env they count, how many findings are marked known, and the last sends with what each channel answered. glitchless_set_alerts changes them.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ game }) => {
    const pid = await projectFor(game);
    const view = await agent('GET', `/games/${pid}/alerts`);
    return reply(alertLines(view), view);
  },
);

act(
  'glitchless_set_alerts',
  "Change a game's alerts: turn rules on or off (crashes: more players crash than usual; new_error: a new error spreading; release: the newest version worse than the one before; quiet: the game went quiet; store: a store limit that cuts visibility; plan: the plan's play sessions running out), the weekly summary, email to the workspace's members, the env alerts count (\"\" for any), remove the webhook, or send a test alert to every channel. Only what you pass changes. A webhook URL can't be added here: the person pastes it in Settings → Alerts, as it's a secret. To stop the weekly summary listing one finding, use glitchless_mark_known instead of turning it off. Ask the person before changing their alerts. Needs an Owner's or Admin's key.",
  {
    rules: z
      .object(Object.fromEntries(Object.entries(RULES).map(([r, what]) => [r, z.boolean().optional().describe(what)])))
      .partial()
      .optional()
      .describe('Rules to turn on (true) or off (false); the rest stay as they are'),
    weekly: z.boolean().optional().describe('The weekly summary on Mondays: how the week went and the findings worth fixing'),
    email: z.boolean().optional().describe("Email every active member of the workspace"),
    env: z.string().optional().describe('Count only sessions from this env (as the game passes it to init, e.g. "prod"); "" for any'),
    remove_webhook: z.boolean().optional().describe('Remove the Discord or Slack webhook'),
    test: z.boolean().optional().describe('Then send a test alert to every channel, to check they arrive'),
  },
  async ({ rules, weekly, email, env, remove_webhook, test, game }) => {
    const pid = await projectFor(game);
    const change = { ...(rules && Object.keys(rules).length ? { rules } : {}), ...(weekly !== undefined ? { weekly } : {}), ...(email !== undefined ? { email } : {}), ...(env !== undefined ? { env } : {}), ...(remove_webhook ? { webhook: null } : {}) };
    if (!Object.keys(change).length && !test) throw new Error('pass what to change (rules, weekly, email, env, remove_webhook) or test: true; glitchless_alerts reads the settings');
    const view = Object.keys(change).length ? await agent('POST', `/games/${pid}/alerts`, change) : await agent('GET', `/games/${pid}/alerts`);
    if (!test) return reply(`Saved.\n${alertLines(view)}`, view);
    const { sent } = await agent('POST', `/games/${pid}/alerts/test`);
    // Read again, so the last sends include the test.
    const after = await agent('GET', `/games/${pid}/alerts`);
    return reply(`${Object.keys(change).length ? 'Saved, and sent' : 'Sent'} a test alert: ${sent.map((s) => `${s.channel} ${s.ok ? 'ok' : `failed (${s.error ?? '?'})`}`).join(', ')}.\n${alertLines(after)}`, { ...after, sent });
  },
  // It replaces settings, removes a webhook, and a test posts to Discord, Slack or email.
  { title: 'Change alerts', annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true } },
);
