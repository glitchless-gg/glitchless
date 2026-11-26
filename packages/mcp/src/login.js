// Signing in to a Glitchless Cloud workspace, for an agent: `npx -y glitchless-mcp login` in a terminal, or the
// glitchless_sign_in tool from inside the agent. Glitchless shows a code and a link; the person approves it in
// the dashboard; the workspace key it hands back is saved to CREDENTIALS_FILE (only readable by you), where the MCP
// server finds it.
//
//   npx -y glitchless-mcp login [--url https://api.glitchless.gg] [--no-browser]
//   npx -y glitchless-mcp whoami
//   npx -y glitchless-mcp logout
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CREDENTIALS_FILE, readCredentials } from './context.js';

export const CLOUD_URL = 'https://api.glitchless.gg';

async function call(url, p, body) {
  const res = await fetch(`${url}/v1/agent${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && p === '/connect') throw new Error(`${url} has no agent sign-in. A self-hosted Glitchless server needs no key; set GLITCHLESS_URL to it instead.`);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Whether page, the approve page a server named, is that server's own: https on its host or its site (the API at
// api.glitchless.gg, the page at app.glitchless.gg), or http on this computer for a server on this computer. Nothing
// else is shown or opened, so a server can't send the person to a page of anyone else's.
const LOOPBACK = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\./.test(h);
export function ownPage(api, page) {
  let a;
  let p;
  try {
    a = new URL(api);
    p = new URL(page);
  } catch {
    return false;
  }
  if (p.username || p.password) return false;
  if (p.protocol === 'http:') return LOOPBACK(p.hostname) && LOOPBACK(a.hostname);
  if (p.protocol !== 'https:') return false;
  const host = a.hostname;
  const site = host.split('.').slice(1).join('.');
  return p.hostname === host || p.hostname.endsWith(`.${host}`) || (site.includes('.') && (p.hostname === site || p.hostname.endsWith(`.${site}`)));
}

// How long a code lasts, in words: "10 minutes".
export const lasts = (seconds) => {
  const m = Math.round(seconds / 60);
  return m >= 1 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.max(1, Math.round(seconds))} seconds`;
};

// → { verification_url, user_code, expires_in, wait() }: wait() resolves with the saved credentials, or rejects when
// the person turns it down or the code expires. Throws when the server's approve page isn't its own (ownPage).
export async function startSignIn({ url = CLOUD_URL, client = `glitchless-mcp on ${os.hostname()}` } = {}) {
  url = url.replace(/\/$/, '');
  const start = await call(url, '/connect', { client });
  if (!ownPage(url, start.verification_url)) throw new Error(`${url} answered with an approve page on another site (${String(start.verification_url).slice(0, 120)}), so it wasn't shown or opened. Sign in only to a Glitchless server you trust, with its own address as url.`);
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = (start.interval || 2) * 1000;
  async function wait() {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const poll = await call(url, '/connect/poll', { device_code: start.device_code });
      if (poll.status === 'slow_down') interval += 1000;
      else if (poll.status === 'denied') throw new Error('The sign-in was turned down in the dashboard.');
      else if (poll.status === 'expired') throw new Error('The sign-in code expired. Start again.');
      else if (poll.status === 'approved') return saveCredentials({ url, token: poll.token, workspace: poll.workspace, scopes: poll.scopes });
    }
    throw new Error('The sign-in code expired before it was approved. Start again.');
  }
  return { verification_url: start.verification_url, user_code: start.user_code, expires_in: start.expires_in, wait };
}

export function saveCredentials(c) {
  const credentials = { ...c, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return credentials;
}

function openBrowser(link) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [link]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : ['xdg-open', [link]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

// The command line: login, whoami, logout. → the exit code.
export async function cli(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (command === 'logout') {
    fs.rmSync(CREDENTIALS_FILE, { force: true });
    console.log('Signed out: the saved workspace key is deleted. Revoke it in Settings → Keys & access if it may have leaked.');
    return 0;
  }
  if (command === 'whoami') {
    const c = readCredentials();
    if (!c) {
      console.log('Not signed in. Run: npx -y glitchless-mcp login');
      return 1;
    }
    console.log(`Signed in to ${c.workspace?.name ?? c.workspace?.id} on ${c.url} (${(c.scopes || []).join(', ')}), since ${c.savedAt}.`);
    return 0;
  }
  const url = flag('url') || process.env.GLITCHLESS_URL || CLOUD_URL;
  const { verification_url, user_code, wait } = await startSignIn({ url });
  console.log(`To connect this agent to Glitchless, open:\n\n  ${verification_url}\n\nand check the page shows the code ${user_code}. Waiting for approval…`);
  if (!rest.includes('--no-browser')) openBrowser(verification_url);
  try {
    const c = await wait();
    console.log(`\nConnected to ${c.workspace?.name ?? 'your workspace'} (${c.scopes.join(', ')}). The key is saved in ${CREDENTIALS_FILE}.\nRestart your agent's Glitchless MCP server (or start a new session) to use it.`);
    return 0;
  } catch (err) {
    console.error(`\n${err.message}`);
    return 1;
  }
}
