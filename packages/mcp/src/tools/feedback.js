// glitchless_feedback: an agent tells the Glitchless team (the people who make Glitchless) about a bug, a dead end,
// something missing or an idea, while it works. The one tool of its own outside a game's areas, as asked for on 26
// November 2026: it belongs to no game, so no other tool owns it. Signed in to a Glitchless Cloud workspace, it sends
// the report (POST /v1/agent/feedback, SPEC §3g) and answers with its ID; on any other connection (a self-hosted
// server, or a key for one game) it sends nothing and answers with a GitHub issue filled in with the report, for the
// person to read and send.
import { z } from 'zod';
import { define, isWorkspace, isRemote, agent, clientApp, feedbackConsent, reply, VERSION } from '../context.js';

// What a report is, as Glitchless Cloud checks it too: its type, its impact, at most `chars` characters in all (message,
// task, expected, actual, tool and engine together), at most `perDay` a day (UTC) from one workspace.
export const FEEDBACK = {
  types: ['bug', 'friction', 'missing', 'idea'],
  impacts: ['blocked', 'worked_around', 'minor'],
  fields: ['message', 'task', 'expected', 'actual', 'tool', 'engine'],
  chars: 4000,
  perDay: 20,
  // tool and engine are a name each, on one line.
  short: { tool: 100, engine: 40 },
};

// Secrets an agent might paste with an error, replaced with [key removed] before a report goes anywhere: by this
// server before it makes a GitHub link or sends the report, and by Glitchless Cloud again when it keeps one.
// Glitchless's own keys (all but a game's public client token, gl_pub_), even run into a name (KEY_gl_ws_…); Stripe's
// and RevenueCat's sk_/rk_ keys and Stripe's webhook secrets; Anthropic's, OpenAI's and npm's tokens; AWS's access key
// IDs, and secret access keys named as such or standing alone (40 characters with both cases and a digit, / or +: never
// a hex hash or a long name); GitHub's
// and Slack's tokens; Discord and Slack webhook addresses; JWTs and bearer tokens; and private keys.
const NOT_KEY = '(?<![A-Za-z0-9])';
const GONE = '[key removed]';
// [pattern, what it becomes]: one with a name before the secret (secret_access_key=, Bearer) keeps the name.
export const SECRETS = [
  [new RegExp(`${NOT_KEY}gl_(?!pub_)[a-z]{2,6}_[A-Za-z0-9_-]{12,}`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}(?:sk|rk)_[A-Za-z0-9_-]{16,}`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}whsec_[A-Za-z0-9_-]{16,}`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}npm_[A-Za-z0-9]{20,}`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`, 'g'), GONE],
  [/((?:aws_)?secret_?access_?key|AWS_SECRET[A-Z_]*)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{30,}/gi, `$1$2${GONE}`],
  [/(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, GONE],
  [new RegExp(`${NOT_KEY}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g'), GONE],
  [new RegExp(`${NOT_KEY}xox[abposr]-[A-Za-z0-9-]{10,}`, 'g'), GONE],
  [/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>)]+/gi, GONE],
  [/https?:\/\/hooks\.slack\.com\/[^\s"'<>)]+/gi, GONE],
  [new RegExp(`${NOT_KEY}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, 'g'), GONE],
  [/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${GONE}`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, GONE],
];
export const blank = (s) => (typeof s === 'string' ? SECRETS.reduce((out, [re, to]) => out.replace(re, to), s) : s);

const ISSUES = 'https://github.com/glitchless-gg/glitchless/issues/new';
// GitHub refuses a new-issue address much longer than this, so a long report's body is cut to fit.
const LINK_MAX = 6000;
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// The report as sent: each field trimmed, its keys blanked, empty ones left out. → { report, chars }
function reportOf(args) {
  const report = { type: args.type, impact: args.impact };
  let chars = 0;
  for (const f of FEEDBACK.fields) {
    const v = typeof args[f] === 'string' ? args[f].trim() : '';
    if (!v) continue;
    report[f] = blank(v);
    chars += v.length;
  }
  return { report, chars };
}

// A new GitHub issue on glitchless-gg/glitchless, filled in with the report, for the person to read and submit.
export function issueLink(report, sender) {
  const title = `${report.type}: ${report.message.split('\n')[0].slice(0, 80)}`;
  let words = [report.message, ...[['task', 'What the person wanted'], ['expected', 'Expected'], ['actual', 'What happened']].filter(([f]) => report[f]).flatMap(([f, label]) => ['', `**${label}:** ${report[f]}`])].join('\n');
  const about = [
    `type: ${report.type} · impact: ${report.impact}${report.tool ? ` · tool: ${report.tool}` : ''}${report.engine ? ` · engine: ${report.engine}` : ''}`,
    `glitchless-mcp ${sender.mcp.version} (${sender.mcp.transport})${sender.app.name ? ` in ${sender.app.name}${sender.app.version ? ` ${sender.app.version}` : ''}` : ''}, sent with glitchless_feedback`,
  ];
  const url = (cut) => `${ISSUES}?${new URLSearchParams({ title, body: [words, '', '---', ...about, ...(cut ? ['(Cut short to fit the link.)'] : [])].join('\n') })}`;
  let link = url(false);
  // Each pass cuts the text; it stops when a cut no longer shortens it (what's left is the rest of the report).
  while (link.length > LINK_MAX && words.length > 1) {
    words = `${words.slice(0, Math.floor(words.length * 0.85))}…`;
    const next = url(true);
    if (next.length >= link.length) break;
    link = next;
  }
  return link;
}

define(
  'glitchless_feedback',
  {
    title: 'Send feedback',
    description: `Tell the Glitchless team (the people who make Glitchless, not the game's developer or its players) about a bug, a dead end, something missing or an idea, while you work. Send one when a Glitchless tool answered an error you couldn't get around, a setup step didn't work in this engine, the person asked for something Glitchless can't do, or an answer misled you. ${feedbackConsent()} One report a problem, in plain words: what happened (message), what the person wanted (task), what you expected and what happened instead (expected, actual), and the Glitchless tool or setup step it was on (tool). Leave out secrets and keys, player data (names, IDs, what players wrote), and the person's code beyond a few lines. A report is at most ${FEEDBACK.chars.toLocaleString('en-US')} characters in all, and a workspace sends at most ${FEEDBACK.perDay} a day (UTC). Signed in to a Glitchless Cloud workspace, it's sent at once and kept a year, with which app and glitchless-mcp version sent it, hosted or local, and the ids of the workspace and account: never a name, an email address, a game, its data or keys, and keys pasted in by mistake are removed. It answers with the report's ID: at the end of your turn, tell the person what you sent and the ID, and that they can write to support@glitchless.gg if they want an answer. On any other connection (a self-hosted server, a key for one game) nothing is sent: it answers with a link to a GitHub issue filled in with the report, for the person to read and submit. Players' own bug reports are glitchless_bug_reports.`,
    inputSchema: {
      message: z.string().min(1).max(FEEDBACK.chars).describe('What happened, or the idea, in plain words'),
      type: z.enum(FEEDBACK.types).describe("bug: Glitchless did something wrong; friction: it worked, the long way round; missing: the person wanted something Glitchless can't do; idea: a suggestion"),
      impact: z.enum(FEEDBACK.impacts).describe("blocked: you couldn't finish; worked_around: you finished another way; minor: it got in the way a little"),
      tool: z.string().max(FEEDBACK.short.tool).optional().describe('The Glitchless tool (e.g. "glitchless_create_game") or setup step it was on'),
      task: z.string().max(FEEDBACK.chars).optional().describe('What the person wanted done'),
      expected: z.string().max(FEEDBACK.chars).optional().describe('What you expected'),
      actual: z.string().max(FEEDBACK.chars).optional().describe('What happened instead (an error message as it came)'),
      engine: z.string().max(FEEDBACK.short.engine).optional().describe("The game's engine, e.g. godot"),
    },
    // It sends the report beyond the workspace, to the Glitchless team, and each call is a report of its own.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args) => {
    const { report, chars } = reportOf(args);
    if (!report.message) throw new Error('say what happened in message');
    if (chars > FEEDBACK.chars) throw new Error(`This report is ${chars.toLocaleString('en-US')} characters, and one is at most ${FEEDBACK.chars.toLocaleString('en-US')} in all. Shorten it (a few lines of code at most) and send it again.`);
    // The app's name and version are what it said connecting: cut to a line each, as Glitchless Cloud keeps them, and
    // blanked like the report (an app can name itself anything).
    const app = clientApp();
    const sender = { app: { name: blank(app.name)?.slice(0, 80) ?? null, version: blank(app.version)?.slice(0, 40) ?? null }, mcp: { version: VERSION, transport: isRemote() ? 'http' : 'stdio' } };
    let lead = isRemote() ? "Nothing was sent: this connection isn't signed in to a Glitchless Cloud workspace." : "Nothing was sent: this connection isn't signed in to a Glitchless Cloud workspace (glitchless_sign_in connects one, and then reports go straight to the team).";
    if (isWorkspace()) {
      try {
        const sent = await agent('POST', '/feedback', { ...report, app: sender.app, mcp: sender.mcp });
        return reply(`Sent to the Glitchless team as ${sent.id}. At the end of your turn, tell the person what you sent and this ID, and that they can write to support@glitchless.gg if they want an answer.`, { id: sent.id, type: report.type, impact: report.impact });
      } catch (err) {
        // A server that doesn't take reports (an older Glitchless Cloud, or another server) or a workspace past today's
        // reports: the person can still send it.
        if (err.code === 'TOO_MANY_REPORTS') lead = `Nothing was sent: ${err.message}`;
        else if (err.code === 'NOT_FOUND') lead = "Nothing was sent: this Glitchless server doesn't take feedback.";
        else throw err;
      }
    }
    return text(`${lead} Give the person this link instead: it opens a new GitHub issue on glitchless-gg/glitchless with the report filled in, for them to read and submit. The issue is public, so they should take out anything private first.\n\n${issueLink(report, sender)}`);
  },
  { scope: 'read' },
);
